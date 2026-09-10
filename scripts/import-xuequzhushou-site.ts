import { createHash, randomUUID } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import pg from "pg";
import { loadLocalEnv } from "./load-env";
import { parseXuequzhushouSiteResource, type SiteManifest } from "../lib/ingest/xuequzhushou-site";
import { siteRecords, type SiteRecord } from "../lib/ingest/xuequzhushou-site-records";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const PARSER_NAMESPACE = "xuequzhushou_site_v1";

export type ImportQueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
export type ImportClient = { query: (text: string, values?: unknown[]) => Promise<ImportQueryResult> };
export type SiteImportOptions = { client: ImportClient; apply?: boolean; reportDir?: string; writeReport?: boolean };

export async function importXuequzhushouSite(manifestPathInput: string, options: SiteImportOptions) {
  const { client, apply = false } = options;
  const manifestPath = path.resolve(manifestPathInput);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SiteManifest;
  if (manifest.version !== 1 || manifest.source !== "xuequzhushou.cn" || !Array.isArray(manifest.resources)) throw new Error("Invalid site manifest");
  const documents = new Map<string, { url: string; status: number; file: string | null; hash: string; rows: SiteRecord[] }>();
  for (const resource of manifest.resources) {
    if (new URL(resource.url).origin !== "https://xuequzhushou.cn" || new URL(resource.finalUrl).origin !== "https://xuequzhushou.cn") throw new Error("Unexpected source origin");
    const file = resource.file ? path.resolve(path.dirname(manifestPath), resource.file) : null;
    if (file && !file.startsWith(path.dirname(manifestPath) + path.sep)) throw new Error("Resource escapes snapshot directory");
    const bytes = file ? readFileSync(file) : Buffer.alloc(0);
    if (file && (sha(bytes) !== resource.sha256 || bytes.length !== resource.bytes)) throw new Error(`Snapshot hash mismatch: ${resource.url}`);
    const successful = resource.status !== null && resource.status >= 200 && resource.status < 300 && !resource.partial && !resource.error;
    if (successful && (!file || !resource.sha256 || resource.bytes < 0)) {
      throw new Error(`Successful resource has no complete raw snapshot: ${resource.url}`);
    }
    // Successful runs are identified by the exact response bytes. Failed
    // requests have no body identity, so retain a deterministic metadata key.
    const hash = successful
      ? resource.sha256!
      : sha(JSON.stringify([resource.finalUrl, resource.status, resource.sha256, resource.error ?? null]));
    const resourcePrefix = `${encodeURIComponent(resource.url)}:`;
    const text = bytes.toString("utf8");
    const textContent = /text|json|javascript|xml/.test(resource.contentType ?? "") || /\.(html?|json|geojson|js|txt|xml)$/.test(new URL(resource.finalUrl).pathname);
    const rows: SiteRecord[] = [{
      type: "site_resource", key: `${resourcePrefix}resource`, district: null,
      raw: { requestedUrl: resource.url, url: resource.finalUrl, discoveredFrom: resource.discoveredFrom,
        parseIssues: resource.parseIssues ?? [], status: resource.status, contentType: resource.contentType,
        sha256: resource.sha256, bytes: resource.bytes, encoding: textContent ? "utf8" : "base64",
        body: textContent ? text : bytes.toString("base64"), error: resource.error ?? null, partial: resource.partial ?? false },
    }];
    if (successful && file) {
      const parsed = parseXuequzhushouSiteResource(text, resource.finalUrl, resource.contentType ?? "");
      const names = new Map<string, number>();
      for (const document of parsed.documents) {
        const occurrence = names.get(document.name) ?? 0;
        names.set(document.name, occurrence + 1);
        for (const row of siteRecords(resource.finalUrl, document.value)) {
          rows.push({ ...row, key: `${resourcePrefix}${encodeURIComponent(document.name)}:${occurrence}${row.key}` });
        }
      }
    }
    const prior = documents.get(hash);
    if (prior) prior.rows.push(...rows);
    else documents.set(hash, { url: resource.finalUrl, status: resource.status ?? 0, file, hash, rows });
  }
  const reportDir = options.reportDir ? path.resolve(options.reportDir) : path.join(path.dirname(manifestPath), `import-${randomUUID()}`);
  mkdirSync(reportDir);
  const summary = { mode: apply ? "apply" : "dry-run", sourceComplete: manifest.complete, manifestPath,
    fetchedResources: manifest.resources.length, uniqueResources: documents.size,
    failures: manifest.resources.filter(r => r.status === null || r.status < 200 || r.status >= 300 || r.partial || r.error).map(r => ({ url: r.url, status: r.status, error: r.error ?? null })),
    rows: 0, added: 0, unchanged: 0, conflicts: 0, reconciled: 0, byType: {} as Record<string, number>, runs: [] as string[] };
  try {
    await client.query(apply ? "BEGIN" : "BEGIN READ ONLY");
    if (apply) await client.query("SELECT pg_advisory_xact_lock(9260909)");
    let sourceId = (await client.query("SELECT id FROM ingest.sources WHERE source_key='xuequzhushou'")).rows[0]?.id;
    if (!sourceId && apply) sourceId = (await client.query("INSERT INTO ingest.sources(source_key,name,base_url,source_kind) VALUES ('xuequzhushou','学区助手','https://xuequzhushou.cn/','third_party') RETURNING id")).rows[0].id;
    for (const document of documents.values()) {
      let runId = sourceId ? (await client.query("SELECT id FROM ingest.crawl_runs WHERE source_id=$1 AND content_hash=$2", [sourceId, document.hash])).rows[0]?.id : undefined;
      if (!runId && apply) runId = (await client.query(`INSERT INTO ingest.crawl_runs(source_id,source_url,fetched_at,http_status,content_hash,parser_version,page_title,stats,raw_path)
        VALUES($1,$2,$3,$4,$5,2,$6,$7::jsonb,$8) RETURNING id`,
      [sourceId, document.url, manifest.startedAt, document.status, document.hash, decodeURIComponent(new URL(document.url).pathname), JSON.stringify({ importer: "xuequzhushou-site-v1", recordCount: document.rows.length }), document.file])).rows[0].id;
      if (runId) summary.runs.push(String(runId));
      const existingRows = runId
        ? (await client.query("SELECT record_type,source_key,district,raw FROM ingest.extracted_records WHERE crawl_run_id=$1 AND record_type LIKE $2", [runId, `${PARSER_NAMESPACE}:%`])).rows
        : [];
      const existing = new Map(existingRows.map(row => [`${row.record_type}:${row.source_key}`, row]));
      const added: SiteRecord[] = [];
      const importerRows = document.rows.map(row => ({ ...row, type: `${PARSER_NAMESPACE}:${row.type}` }));
      for (const row of importerRows) {
        summary.rows++;
        summary.byType[row.type] = (summary.byType[row.type] ?? 0) + 1;
        const found = existing.get(`${row.type}:${row.key}`);
        if (!found) { summary.added++; added.push(row); }
        else if (found.district === row.district && isDeepStrictEqual(found.raw, row.raw)) summary.unchanged++;
        else { summary.conflicts++; throw new Error(`Immutable source record conflict: ${document.url} ${row.type}:${row.key}`); }
      }
      if (apply) {
        for (let offset = 0; offset < added.length; offset += 250) {
          await client.query(`INSERT INTO ingest.extracted_records(crawl_run_id,record_type,source_key,district,raw)
            SELECT $1,x.type,x.key,x.district,x.raw FROM jsonb_to_recordset($2::jsonb) AS x(type text,key text,district text,raw jsonb)`, [runId, JSON.stringify(added.slice(offset, offset + 250))]);
        }
        const stored = (await client.query("SELECT record_type,source_key,district,raw FROM ingest.extracted_records WHERE crawl_run_id=$1", [runId])).rows;
        const actual = new Map(stored.map(r => [`${r.record_type}:${r.source_key}`, r]));
        const expectedKeys = new Set(importerRows.map(row => `${row.type}:${row.key}`));
        const actualImporterRows = stored.filter(row => expectedKeys.has(`${row.record_type}:${row.source_key}`));
        if (actualImporterRows.length !== importerRows.length) throw new Error(`Row count mismatch: ${document.url}`);
        for (const row of importerRows) {
          const found = actual.get(`${row.type}:${row.key}`);
          if (!found || found.district !== row.district || !isDeepStrictEqual(found.raw, row.raw)) throw new Error(`Round-trip mismatch: ${document.url} ${row.key}`);
          summary.reconciled++;
        }
      }
    }
    await client.query(apply ? "COMMIT" : "ROLLBACK");
    if (options.writeReport !== false) writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ ...summary, reportDir }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK");
    if (options.writeReport !== false) writeFileSync(path.join(reportDir, "failure.json"), JSON.stringify({ ...summary, error: String(error) }, null, 2));
    throw error;
  }
  return { ...summary, reportDir };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--apply" && !arg.startsWith("--manifest="))) throw new Error("Use --manifest=<path> [--apply]");
  const input = args.find(arg => arg.startsWith("--manifest="))?.slice(11);
  if (!input) throw new Error("--manifest=<path> is required");
  loadLocalEnv();
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try { await importXuequzhushouSite(input, { client, apply: args.includes("--apply") }); }
  finally { await client.end(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main().catch(error => { console.error(error); process.exitCode = 1; });
