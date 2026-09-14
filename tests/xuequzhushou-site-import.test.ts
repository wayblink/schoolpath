import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { importXuequzhushouSite, type ImportClient } from "../scripts/import-xuequzhushou-site";

type Row = Record<string, unknown>;
class ArchiveClient implements ImportClient {
  records: Row[] = [{ crawl_run_id: "1", record_type: "school", source_key: "full:v1:legacy", district: null, raw: { keep: true } }];
  runs: Row[] = [];
  queries: string[] = [];
  corruptRead = false;
  private backup: { records: Row[]; runs: Row[] } | null = null;

  async query(sql: string, values: unknown[] = []): Promise<{ rows: Row[] }> {
    this.queries.push(sql);
    if (sql.startsWith("BEGIN")) this.backup = structuredClone({ records: this.records, runs: this.runs });
    else if (sql === "ROLLBACK" && this.backup) Object.assign(this, this.backup);
    else if (sql.startsWith("SELECT id FROM ingest.sources")) return { rows: [{ id: "source" }] };
    else if (sql.startsWith("SELECT id FROM ingest.crawl_runs")) return { rows: this.runs.filter(r => r.hash === values[1]) };
    else if (sql.startsWith("INSERT INTO ingest.crawl_runs")) {
      const row = { id: String(this.runs.length + 1), hash: values[4] };
      this.runs.push(row);
      return { rows: [row] };
    } else if (sql.startsWith("INSERT INTO ingest.extracted_records")) {
      for (const row of JSON.parse(String(values[1]))) this.records.push({ crawl_run_id: values[0], record_type: row.type, source_key: row.key, district: row.district, raw: row.raw });
    } else if (sql.startsWith("SELECT record_type,source_key,district,raw")) {
      const rows = structuredClone(this.records.filter(r => r.crawl_run_id === values[0] && (values.length === 1 || String(r.record_type).startsWith("xuequzhushou_site_v1:"))));
      if (this.corruptRead && values.length === 1 && rows.length) rows[rows.length - 1].raw = { corrupt: true };
      return { rows };
    } else if (sql !== "COMMIT" && sql !== "ROLLBACK" && !sql.startsWith("SELECT pg_advisory_xact_lock")) throw new Error(`Unexpected SQL: ${sql}`);
    return { rows: [] };
  }
}

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "schoolpath-site-import-"));
  const body = JSON.stringify({ districts: { "黄浦区": [{ n: "school", c: [{ n: "same", extra: 1 }, { n: "same", extra: 2 }] }] } });
  const hash = createHash("sha256").update(body).digest("hex");
  writeFileSync(path.join(dir, "data.json"), body);
  const manifest = {
    version: 1, source: "xuequzhushou.cn", complete: true, startedAt: "2026-09-09T12:00:00Z",
    resources: ["a", "b"].map(name => ({ url: `https://xuequzhushou.cn/${name}.json`, finalUrl: "https://xuequzhushou.cn/data.json", status: 200, contentType: "application/json", sha256: hash, file: "data.json", bytes: Buffer.byteLength(body), discoveredFrom: ["https://xuequzhushou.cn/"], parseIssues: [] })),
  };
  const file = path.join(dir, "manifest.json");
  writeFileSync(file, JSON.stringify(manifest));
  return { dir, file, manifest };
}

test("site import plans without writes, preserves URL occurrences and legacy rows, then repeats without additions", async () => {
  const f = fixture();
  try {
    const client = new ArchiveClient();
    const dry = await importXuequzhushouSite(f.file, { client, writeReport: false });
    assert.equal(dry.added, 12);
    assert.equal(client.queries.some(q => /^(INSERT|UPDATE|DELETE|COMMIT)/.test(q)), false);
    const first = await importXuequzhushouSite(f.file, { client, apply: true, writeReport: false });
    assert.equal(first.reconciled, 12);
    assert.equal(client.records.length, 13);
    assert.deepEqual(client.records[0].raw, { keep: true });
    const resources = client.records.filter(r => r.record_type === "xuequzhushou_site_v1:site_resource");
    assert.equal(resources.length, 2);
    assert.deepEqual(resources.map(r => (r.raw as Row).requestedUrl), f.manifest.resources.map(r => r.url));
    assert.deepEqual((resources[0].raw as Row).discoveredFrom, ["https://xuequzhushou.cn/"]);
    const second = await importXuequzhushouSite(f.file, { client, apply: true, writeReport: false });
    assert.equal(second.added, 0);
    assert.equal(second.unchanged, 12);
    assert.equal(second.reconciled, 12);
    assert.equal(client.runs.length, 1);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("site import rejects changed snapshot bytes before opening a transaction", async () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.dir, "data.json"), "tampered");
    const client = new ArchiveClient();
    await assert.rejects(importXuequzhushouSite(f.file, { client, apply: true, writeReport: false }), /hash mismatch/);
    assert.equal(client.queries.length, 0);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("site import rolls back all records when stored JSON fails round-trip validation", async () => {
  const f = fixture();
  try {
    const client = new ArchiveClient();
    client.corruptRead = true;
    await assert.rejects(importXuequzhushouSite(f.file, { client, apply: true, writeReport: false }), /Round-trip mismatch/);
    assert.equal(client.records.length, 1);
    assert.equal(client.runs.length, 0);
    assert.equal(client.queries.at(-1), "ROLLBACK");
    assert.equal(client.queries.includes("COMMIT"), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("HTTP 200 with a resource error is reported as failed and never parsed as data", async () => {
  const f = fixture();
  try {
    const manifest = JSON.parse(readFileSync(f.file, "utf8"));
    manifest.resources = [{ ...manifest.resources[0], error: "incomplete response" }];
    manifest.complete = false;
    writeFileSync(f.file, JSON.stringify(manifest));
    const report = await importXuequzhushouSite(f.file, { client: new ArchiveClient(), writeReport: false });
    assert.equal(report.failures.length, 1);
    assert.equal(report.rows, 1);
    assert.equal(report.byType["xuequzhushou_site_v1:map_community"], undefined);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
