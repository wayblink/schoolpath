import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import pg from "pg";
import { loadLocalEnv } from "./load-env";
import { occurrenceKey, parseShgovSearchHtml, SHGOV_PARSER_VERSION, type ShgovManifest } from "../lib/ingest/shgov-search";

export type ImportClient = { query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const PREFIX = "shgov_search_v1";
export async function importShgovSearch(manifestInput: string, options: { client: ImportClient; apply?: boolean; writeReport?: boolean; reportDir?: string }) {
  const manifestPath = path.resolve(manifestInput); const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ShgovManifest;
  if (manifest.version !== 1 || manifest.source !== "search.sh.gov.cn") throw new Error("Invalid Shanghai government search manifest");
  const root = path.dirname(manifestPath); const expected: Array<{ type: string; key: string; district: null; raw: Record<string, unknown>; resource: ShgovManifest["resources"][number] }> = [];
  const failures = manifest.resources.filter((resource) => !resource.status || resource.status < 200 || resource.status >= 300 || resource.error);
  for (const resource of manifest.resources) {
    const file = resource.file ? path.resolve(root, resource.file) : null;
    if (file && !file.startsWith(root + path.sep)) throw new Error(`Snapshot path escapes manifest directory: ${resource.file}`);
    const successful = Boolean(resource.status && resource.status >= 200 && resource.status < 300 && !resource.error);
    if (successful && (!file || !resource.sha256)) throw new Error(`Successful snapshot is missing raw body metadata: ${resource.url}`);
    const bytes = file ? readFileSync(file) : Buffer.alloc(0);
    if (resource.sha256 && (sha(bytes) !== resource.sha256 || bytes.length !== resource.bytes)) throw new Error(`Snapshot hash mismatch: ${resource.url}`);
    const resourceKey = `${PREFIX}:resource:${encodeURIComponent(resource.keyword)}:p${resource.pageNo}:${resource.kind}`;
    expected.push({ type: `${PREFIX}:resource`, key: resourceKey, district: null, raw: { ...resource, rawPath: resource.file, body: file ? bytes.toString("utf8") : null }, resource });
    if (successful && file) {
      const parsed = parseShgovSearchHtml(bytes.toString("utf8"));
      for (const result of parsed.results) expected.push({ type: `${PREFIX}:result`, key: occurrenceKey(resource.keyword, resource.pageNo, result.index), district: null, raw: { keyword: resource.keyword, pageNo: resource.pageNo, totalSize: resource.totalSize, total: resource.total, fetchKey: resource.fetchKey, ...result }, resource });
    }
  }
  const reportDir = path.resolve(options.reportDir ?? path.join(root, `import-${Date.now()}`)); mkdirSync(reportDir, { recursive: true });
  const report = { mode: options.apply ? "apply" : "dry-run", manifestPath, failures: failures.map((resource) => ({ keyword: resource.keyword, pageNo: resource.pageNo, url: resource.url, status: resource.status, error: resource.error ?? null })), rows: expected.length, added: 0, unchanged: 0, conflicts: 0, reconciled: 0, byKeyword: {} as Record<string, { fetchedPages: number; resultCount: number; failures: number; added: number; unchanged: number; conflicts: number }> };
  for (const keyword of manifest.keywords) report.byKeyword[keyword] = { fetchedPages: manifest.resources.filter((r) => r.keyword === keyword).length, resultCount: expected.filter((r) => r.raw.keyword === keyword && r.type.endsWith(":result")).length, failures: failures.filter((r) => r.keyword === keyword).length, added: 0, unchanged: 0, conflicts: 0 };
  const client = options.client; await client.query(options.apply ? "BEGIN" : "BEGIN READ ONLY");
  try {
    if (options.apply) await client.query("SELECT pg_advisory_xact_lock(9260910)");
    let sourceId = (await client.query("SELECT id FROM ingest.sources WHERE source_key='shgov-search'")).rows[0]?.id;
    if (!sourceId && options.apply) sourceId = (await client.query("INSERT INTO ingest.sources(source_key,name,base_url,source_kind) VALUES ('shgov-search','上海市政府搜索','https://search.sh.gov.cn/search','official_search_index') RETURNING id")).rows[0].id;
    const byHash = new Map<string, typeof expected>();
    for (const row of expected) {
      const resource = row.resource;
      // Every resource row and its parsed occurrences share the response content identity.
      // This keeps URL/page provenance in the crawl metadata while allowing identical
      // response bodies to reuse the existing immutable crawl run.
      const hash = resource.sha256 ?? sha(JSON.stringify({ keyword: resource.keyword, pageNo: resource.pageNo, kind: resource.kind, status: resource.status, error: resource.error ?? null }));
      const list = byHash.get(hash) ?? [];
      list.push(row);
      byHash.set(hash, list);
    }
    for (const [hash, rows] of byHash) {
      const firstResource = rows[0].resource;
      let runId = sourceId ? (await client.query("SELECT id FROM ingest.crawl_runs WHERE source_id=$1 AND content_hash=$2", [sourceId, hash])).rows[0]?.id : undefined;
      if (!runId && options.apply) runId = (await client.query("INSERT INTO ingest.crawl_runs(source_id,source_url,fetched_at,http_status,content_hash,parser_version,page_title,stats,raw_path) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING id", [sourceId, firstResource?.url ?? "https://search.sh.gov.cn/searchResult", firstResource?.fetchedAt ?? manifest.startedAt, firstResource?.status ?? 0, hash, SHGOV_PARSER_VERSION, firstResource?.keyword ?? null, JSON.stringify({ keyword: firstResource?.keyword, pageNo: firstResource?.pageNo, totalSize: firstResource?.totalSize, total: firstResource?.total, recordCount: rows.length }), firstResource?.file ?? null])).rows[0].id;
      const existing = runId ? (await client.query("SELECT record_type,source_key,district,raw FROM ingest.extracted_records WHERE crawl_run_id=$1", [runId])).rows : [];
      const map = new Map(existing.map((row) => [`${row.record_type}:${row.source_key}`, row]));
      const added = rows.filter((row) => { const found = map.get(`${row.type}:${row.key}`); if (!found) { report.added++; if (row.raw.keyword) report.byKeyword[String(row.raw.keyword)].added++; return true; } if (found.district === row.district && isDeepStrictEqual(found.raw, row.raw)) { report.unchanged++; if (row.raw.keyword) report.byKeyword[String(row.raw.keyword)].unchanged++; return false; } report.conflicts++; if (row.raw.keyword) report.byKeyword[String(row.raw.keyword)].conflicts++; throw new Error(`Immutable source record conflict: ${row.key}`); });
      if (options.apply && added.length) await client.query("INSERT INTO ingest.extracted_records(crawl_run_id,record_type,source_key,district,raw) SELECT $1,x.type,x.key,x.district,x.raw FROM jsonb_to_recordset($2::jsonb) x(type text,key text,district text,raw jsonb)", [runId, JSON.stringify(added)]);
      if (options.apply) { const stored = (await client.query("SELECT record_type,source_key,district,raw FROM ingest.extracted_records WHERE crawl_run_id=$1", [runId])).rows; const actual = new Map(stored.map((row) => [`${row.record_type}:${row.source_key}`, row])); for (const row of rows) { const found = actual.get(`${row.type}:${row.key}`); if (!found || found.district !== row.district || !isDeepStrictEqual(found.raw, row.raw)) throw new Error(`Round-trip mismatch: ${row.key}`); report.reconciled++; } }
    }
    await client.query(options.apply ? "COMMIT" : "ROLLBACK"); if (options.writeReport !== false) writeFileSync(path.join(reportDir, "report.json"), JSON.stringify({ ...report, reportDir }, null, 2)); return { ...report, reportDir };
  } catch (error) { await client.query("ROLLBACK"); if (options.writeReport !== false) writeFileSync(path.join(reportDir, "failure.json"), JSON.stringify({ ...report, error: String(error) }, null, 2)); throw error; }
}

async function main() {
  const args = process.argv.slice(2); const manifest = args.find((arg) => arg.startsWith("--manifest="))?.slice(11); if (!manifest) throw new Error("--manifest=<path> is required");
  loadLocalEnv(); if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required"); const client = new pg.Client({ connectionString: process.env.DATABASE_URL }); await client.connect(); try { console.log(JSON.stringify(await importShgovSearch(manifest, { client, apply: args.includes("--apply") }), null, 2)); } finally { await client.end(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main().catch((error) => { console.error(error); process.exitCode = 1; });
