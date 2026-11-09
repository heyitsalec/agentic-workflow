// The system-database loader against a real Postgres (tdd_system_test, or $TDD_TEST_DATABASE_URL). Each test loads a
// snapshot of the two real packets taken when the file starts (meta.json, build/content.json, build/lint.json, the page
// and build/eval copied into a temp tree with the same <repo>/system-design/<slug> layout), so a rebuild of a live
// packet while the tests run cannot change what they see. Counts are asserted against those copied inputs.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { applySchema, recordPublish, writePlan } from "../../src/db/load";
import { packetStatus, parseDecisionStatus, planLoad, type Plan } from "../../src/db/plan";

type J = Record<string, any>;
const TEST_URL = process.env["TDD_TEST_DATABASE_URL"] ?? "postgres://localhost/tdd_system_test";
const CLI = join(import.meta.dir, "..", "..");
const SOURCES = {
  ref: join(homedir(), ".system-design/vitalizecare-web-app/system-design/open-shift-ranking"),
  arch: join(homedir(), ".system-design/house/system-design/tdd-system"),
};
const TABLES = ["publication", "eval_run", "lint_finding", "citation", "reference_link", "decision", "revision", "packet", "schema_version"];

if (!new URL(TEST_URL).pathname.endsWith("_test")) throw new Error(`refusing to reset ${TEST_URL}: the test database name must end in _test`);
const reachable = await (async () => {
  const db = new SQL(TEST_URL);
  try { await db`SELECT 1`; return true; } catch { return false; } finally { await db.close(); }
})();
const havePackets = existsSync(join(SOURCES.ref, "build/content.json")) && existsSync(join(SOURCES.arch, "build/content.json"));
if (!reachable) console.warn(`load-db tests skipped: ${TEST_URL} is not reachable (createdb tdd_system_test)`);
if (!havePackets) console.warn("load-db tests skipped: the two real packets are not on this machine");

const readJ = (p: string): J => JSON.parse(readFileSync(p, "utf8"));
const writeJ = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 1));
const root = mkdtempSync(join(tmpdir(), "tdd-load-db-"));

/** Copy a packet's loader inputs into <root>/<tag>/<repo>/system-design/<slug>, lint.json pointing at the copy. */
function snapshot(src: string, tag: string, slug = basename(src)): string {
  const dst = join(root, tag, basename(dirname(dirname(src))), "system-design", slug);
  mkdirSync(join(dst, "build", "eval"), { recursive: true });
  copyFileSync(join(src, "meta.json"), join(dst, "meta.json"));
  copyFileSync(join(src, "build/content.json"), join(dst, "build/content.json"));
  if (existsSync(join(src, "build/tdd.html"))) copyFileSync(join(src, "build/tdd.html"), join(dst, "build/tdd.html"));
  const lintSrc = existsSync(join(src, "build/lint.json")) ? join(src, "build/lint.json") : join(src, "build/eval/lint.json");
  const lint = readJ(lintSrc);
  writeJ(join(dst, "build/lint.json"), { ...lint, packet: dst, build: join(dst, "build") });
  const ev = join(src, "build/eval");
  if (existsSync(ev)) {
    for (const f of readdirSync(ev)) if (/^output\..+\.json$|^push\.json$|^history\.jsonl$/.test(f)) copyFileSync(join(ev, f), join(dst, "build/eval", f));
  }
  touchOrder(dst);
  return dst;
}
/** content.json first, lint.json a second later: the order the D24 gate wants. */
function touchOrder(dst: string, lintFirst = false) {
  const t = Date.now() / 1000 - 60;
  utimesSync(join(dst, "build/content.json"), t, lintFirst ? t + 1 : t);
  utimesSync(join(dst, "build/lint.json"), t, lintFirst ? t : t + 1);
}
/** Make the copied eval outputs score this build (label and history), as a fresh eval run would. Returns the score count. */
function alignEval(dst: string): number {
  const meta = readJ(join(dst, "meta.json")), content = readJ(join(dst, "build/content.json"));
  const label = `${basename(dirname(dirname(dst)))}/${basename(dst)}@rev${meta.rev}`;
  let n = 0;
  for (const f of readdirSync(join(dst, "build/eval")).filter((x) => x.startsWith("output."))) {
    const o = readJ(join(dst, "build/eval", f));
    n += o.scores.length;
    writeJ(join(dst, "build/eval", f), { ...o, packet: label });
  }
  writeFileSync(join(dst, "build/eval/history.jsonl"), JSON.stringify({ packet: label, content_generated: content.generated }) + "\n");
  return n;
}
function mustPlan(dst: string, build?: string): Plan {
  const p = planLoad(dst, { build });
  if (!p.ok) throw new Error(`refused: ${p.reason}`);
  return p;
}
function cli(...args: string[]) {
  const r = Bun.spawnSync(["bun", "bin/tdd.ts", "load-db", ...args], { cwd: CLI, env: { ...process.env, DATABASE_URL: TEST_URL } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

let db: SQL;
const snaps: Record<"ref" | "arch", string> = { ref: "", arch: "" };
const counts = async (): Promise<Record<string, number>> => {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = Number((await db`SELECT count(*)::int AS n FROM ${db(t)}`)[0].n);
  return out;
};
const byRev = async (table: string, revisionId: string) =>
  Number((await db`SELECT count(*)::int AS n FROM ${db(table)} WHERE revision_id = ${revisionId}`)[0].n);

describe.skipIf(!reachable || !havePackets)("tdd load-db", () => {
  beforeAll(async () => {
    db = new SQL(TEST_URL);
    await db.unsafe(`SET client_min_messages = warning; ${TABLES.map((t) => `DROP TABLE IF EXISTS ${t} CASCADE;`).join(" ")}`);
    snaps.ref = snapshot(SOURCES.ref, "base");
    snaps.arch = snapshot(SOURCES.arch, "base");
  });
  afterAll(async () => {
    await db?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("schema applies twice and keeps one schema_version row", async () => {
    expect(await applySchema(db)).toBe(1);
    expect(await applySchema(db)).toBe(1);
    const rows = await db`SELECT version FROM schema_version`;
    expect(rows.length).toBe(1);
    const cols = await db`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'revision' AND column_name = 'published_at'`;
    expect(cols[0].is_nullable).toBe("YES");
  });

  for (const which of ["ref", "arch"] as const) {
    test(`${which}: rows equal the inputs, and a second load writes no duplicates`, async () => {
      const dst = snaps[which];
      const content = readJ(join(dst, "build/content.json")), lint = readJ(join(dst, "build/lint.json")), meta = readJ(join(dst, "meta.json"));
      const plan = mustPlan(dst);
      const first = await writePlan(db, plan);
      const rid = first.revisionId;
      const [pk] = await db`SELECT p.id, p.repo_slug, p.slug FROM packet p JOIN revision r ON r.packet_id = p.id WHERE r.id = ${rid}`;
      expect(`${pk.repo_slug}/${pk.slug}`).toBe(`${basename(dirname(dirname(SOURCES[which])))}/${basename(SOURCES[which])}`);

      const decisions = Number((await db`SELECT count(*)::int AS n FROM decision WHERE packet_id = ${pk.id}`)[0].n);
      expect(decisions).toBe(content.decisions.length);
      const links = Array.isArray(content.refs.links) ? content.refs.links.length : null;
      if (links === null) expect(first.reference_link).toBeNull();
      else {
        expect(await byRev("reference_link", rid)).toBe(links);
        // the compiler's own count: linked + unlinked, where refs.links lists every linked token occurrence
        const linkedRows = Number((await db`SELECT count(*)::int AS n FROM reference_link WHERE revision_id = ${rid} AND linked`)[0].n);
        expect(linkedRows).toBe(content.refs.links.filter((l: J) => l.linked).length);
        const unl = await db`SELECT DISTINCT token FROM reference_link WHERE revision_id = ${rid} AND NOT linked ORDER BY token`;
        expect(unl.map((r: J) => r.token)).toEqual([...content.refs.unlinked].sort());
      }
      expect(await byRev("citation", rid)).toBe(content.cites.length);
      expect(await byRev("lint_finding", rid)).toBe(lint.findings.length);
      expect(await byRev("publication", rid)).toBe((meta.artifact_url ? 1 : 0) + (meta.notion_url ? 1 : 0));
      const [rv] = await db`SELECT * FROM revision WHERE id = ${rid}`;
      expect([rv.rev, rv.decisions, rv.prs, rv.sections, rv.diagrams, rv.schema_tables, rv.citations])
        .toEqual([meta.rev, content.stats.decisions, content.stats.prs, content.stats.sections, content.stats.diagrams, content.schema.length, content.cites.length]);
      expect(new Date(rv.generated).toISOString()).toBe(new Date(content.generated).toISOString());
      expect(rv.lint_errors).toBe(lint.counts.errors);
      const fits = typeof meta.published === "string" && meta.published >= String(content.generated).slice(0, 10);
      expect(rv.published_at === null).toBe(!fits);

      const before = await counts();
      const second = await writePlan(db, mustPlan(dst));
      expect(second.revisionId).toBe(rid);
      expect(await counts()).toEqual(before);
      const revs = Number((await db`SELECT count(*)::int AS n FROM revision WHERE packet_id = ${pk.id}`)[0].n);
      expect(revs).toBe(1);
    });
  }

  test("eval_run rows equal the scores across output.*.json once the outputs scored this build", async () => {
    for (const which of ["ref", "arch"] as const) {
      const dst = snapshot(SOURCES[which], `eval-${which}`);
      const plain = mustPlan(dst);
      const expected = alignEval(dst);
      const plan = mustPlan(dst);
      expect(plan.evalRuns.length).toBe(expected);
      const res = await writePlan(db, plan);
      expect(await byRev("eval_run", res.revisionId)).toBe(expected);
      if (plain.evalRuns.length === 0 && expected > 0) expect(plain.notes.join(" ")).toContain("did not score this build");
      const statuses = await db`SELECT DISTINCT status FROM eval_run WHERE revision_id = ${res.revisionId}`;
      for (const s of statuses) expect(["ok", "not_run", "error"]).toContain(s.status);
      const meta = readJ(join(dst, "meta.json"));
      const push = existsSync(join(dst, "build/eval/push.json")) ? readJ(join(dst, "build/eval/push.json")) : { experiments: [] };
      const exp = `${basename(dst)}-rev${meta.rev}-artifact`;
      const [art] = await db`SELECT braintrust_experiment FROM eval_run WHERE revision_id = ${res.revisionId} AND kind = 'artifact' LIMIT 1`;
      expect(art.braintrust_experiment).toBe(push.experiments.some((e: J) => e.name === exp) ? exp : null);
      // a reload replaces, never appends
      await writePlan(db, plan);
      expect(await byRev("eval_run", res.revisionId)).toBe(expected);
    }
  });

  test("decisions keep the compiler's quote verbatim and take who and when from the dated status segment", async () => {
    const arch = readJ(join(snaps.arch, "build/content.json"));
    const d17 = arch.decisions.find((d: J) => d.id === "D17");
    const [row] = await db`SELECT d.* FROM decision d JOIN packet p ON p.id = d.packet_id WHERE p.slug = 'tdd-system' AND d.token = 'D17'`;
    if (typeof d17.quote === "string" && d17.quote) {
      expect(row.quote).toBe(d17.quote);
      expect(row.quote).toContain("can  keep");
    } else expect(row.quote).toBeNull();
    expect(row.decided_by).toBe("Alec");
    expect(new Date(row.decided_on).toISOString().slice(0, 10)).toBe("2026-11-09");
    expect(parseDecisionStatus("Deferred · Alec, 2026-11-06")).toEqual({ by: "Alec", on: "2026-11-06", source: null });
    expect(parseDecisionStatus("Alec, 2026-11-09 · comment on this page")).toEqual({ by: "Alec", on: "2026-11-09", source: "comment on this page" });
    expect(parseDecisionStatus("Open · investigated, needs Virtua")).toEqual({ by: null, on: null, source: null });
    const open = await db`SELECT d.decided_by, d.decided_on FROM decision d JOIN packet p ON p.id = d.packet_id WHERE p.slug = 'open-shift-ranking' AND d.state = 'open'`;
    for (const o of open) expect([o.decided_by, o.decided_on]).toEqual([null, null]);
    expect(packetStatus("Draft for review")).toBe("in_review");
    expect(packetStatus("As built")).toBe("as_built");
  });

  test("a later build of the same rev is its own revision row; decisions move in place to the newest build only", async () => {
    const later = snapshot(SOURCES.arch, "later");
    const c = readJ(join(later, "build/content.json"));
    const stamp = new Date(Date.parse(c.generated) + 3600_000).toISOString().replace(".000Z", "Z");
    writeJ(join(later, "build/content.json"), { ...c, generated: stamp });
    touchOrder(later);
    const res = await writePlan(db, mustPlan(later));
    expect(res.newest).toBe(true);
    const [pk] = await db`SELECT packet_id FROM revision WHERE id = ${res.revisionId}`;
    const revs = await db`SELECT rev, generated FROM revision WHERE packet_id = ${pk.packet_id} ORDER BY generated`;
    expect(revs.length).toBe(2);
    const n = Number((await db`SELECT count(*)::int AS n FROM decision WHERE packet_id = ${pk.packet_id}`)[0].n);
    expect(n).toBe(c.decisions.length);
    const owners = await db`SELECT DISTINCT revision_id FROM decision WHERE packet_id = ${pk.packet_id}`;
    expect(owners.map((r: J) => r.revision_id)).toEqual([res.revisionId]);
    // reloading the older build does not take the decisions back
    const older = await writePlan(db, mustPlan(snaps.arch));
    expect(older.newest).toBe(false);
    const after = await db`SELECT DISTINCT revision_id FROM decision WHERE packet_id = ${pk.packet_id}`;
    expect(after.map((r: J) => r.revision_id)).toEqual([res.revisionId]);
  });

  test("--published records a publish on the latest build of the rev, and a reload keeps it", async () => {
    const later = join(root, "later", "house", "system-design", "tdd-system");
    const url = "https://example.com/tdd-system-mirror";
    const r = cli(later, "--published", "notion", url, "--json");
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.status).toBe("published");
    const [rv] = await db`SELECT id, published_at FROM revision WHERE id = ${out.revision_id}`;
    expect(rv.published_at).not.toBeNull();
    const [latest] = await db`SELECT r.id FROM revision r JOIN packet p ON p.id = r.packet_id WHERE p.slug = 'tdd-system' ORDER BY r.generated DESC LIMIT 1`;
    expect(latest.id).toBe(out.revision_id);
    await writePlan(db, mustPlan(later));
    const pubs = await db`SELECT surface, url, published_at FROM publication WHERE revision_id = ${out.revision_id} ORDER BY surface`;
    expect(pubs.find((p: J) => p.surface === "notion")?.url).toBe(url);
    const [rv2] = await db`SELECT published_at FROM revision WHERE id = ${out.revision_id}`;
    expect(rv2.published_at).not.toBeNull();
    const miss = await recordPublish(db, { repo_slug: "house", slug: "no-such-packet", rev: 1, surface: "artifact", url });
    expect(miss.ok).toBe(false);
  });

  test("refuses a build without a current lint.json, and writes nothing", async () => {
    const before = await counts();
    const noLint = snapshot(SOURCES.ref, "nolint");
    rmSync(join(noLint, "build/lint.json"));
    const p1 = planLoad(noLint);
    expect(p1.ok).toBe(false);
    if (!p1.ok) expect(p1.reason).toContain("lint.json is missing");
    const r1 = cli(noLint);
    expect(r1.code).toBe(1);
    expect(r1.err).toContain("refused");
    expect(r1.err).toContain("D24");

    const stale = snapshot(SOURCES.ref, "stale");
    touchOrder(stale, true);
    const p2 = planLoad(stale);
    expect(p2.ok).toBe(false);
    if (!p2.ok) expect(p2.reason).toContain("older than content.json");
    expect(cli(stale, "--json").code).toBe(1);

    const other = snapshot(SOURCES.ref, "other");
    const lint = readJ(join(other, "build/lint.json"));
    writeJ(join(other, "build/lint.json"), { ...lint, build: join(snaps.arch, "build") });
    touchOrder(other);
    const p3 = planLoad(other);
    expect(p3.ok).toBe(false);
    if (!p3.ok) expect(p3.reason).toContain("another");
    expect(await counts()).toEqual(before);
  });

  test("tolerates an older compiler and linter: no refs.links, no quotes, no lint citations", async () => {
    const old = snapshot(SOURCES.arch, "old", "tdd-system-older-producers");
    const c = readJ(join(old, "build/content.json"));
    const { links: _links, ...refs } = c.refs;
    writeJ(join(old, "build/content.json"), {
      ...c, refs: { ...refs, linked: c.refs.linked ?? 0 },
      decisions: c.decisions.map(({ quote: _q, reading: _r, decidedOn: _o, decidedBy: _b, ...d }: J) => d),
    });
    const lint = readJ(join(old, "build/lint.json"));
    delete lint.citations;
    writeJ(join(old, "build/lint.json"), lint);
    touchOrder(old);
    const plan = mustPlan(old);
    expect(plan.referenceLinks).toBeNull();
    expect(plan.notes.join(" ")).toContain("reference_link: skipped");
    expect(plan.decisions.every((d) => d.quote === null)).toBe(true);
    expect(plan.citations.every((x) => x.resolved_at === "unknown")).toBe(true);
    const res = await writePlan(db, plan);
    expect(res.reference_link).toBeNull();
    expect(await byRev("reference_link", res.revisionId)).toBe(0);
    expect(await byRev("citation", res.revisionId)).toBe(c.cites.length);
  });

  test("usage errors exit 2; a dry run never connects", () => {
    expect(cli().code).toBe(2);
    expect(cli(snaps.ref, "--bogus").code).toBe(2);
    expect(cli(snaps.ref, "--published", "wiki", "https://example.com/x").code).toBe(2);
    expect(cli(snaps.ref, snaps.arch).code).toBe(2);
    const dry = cli(snaps.ref, "--dry-run", "--database-url", "postgres://localhost:1/unreachable");
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("dry run, nothing written");
  });
});
