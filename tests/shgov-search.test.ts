import assert from "node:assert/strict";
import test from "node:test";
import { collectShgovSearch, occurrenceKey, parseShgovSearchHtml } from "../lib/ingest/shgov-search";
import { importShgovSearch } from "../scripts/import-shgov-search";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const fixture = `<input type="hidden" name="fetchKey" value="fk"/><input type="hidden" name="totalSize" value="2"/><input type="hidden" name="total" value="9"/><div class="result result-elm"><span class="tag">政策</span><a class="restitle" href="/detail?token=abc" title="标题">标题</a><span class="mobile-result-date">2026-09-10</span><div class="restcont"><div class="content search-result-summary">摘要 <EM>学校</EM></div><div class="other"><a class="url" href="https://edu.sh.gov.cn/a">edu.sh.gov.cn</a></div></div></div><div class="result result-elm"><a class="restitle" href="/detail?token=def">重复标题</a><div class="restcont"><div class="content search-result-summary">第二条</div></div></div>`;

test("parses search metadata and lossless result occurrences", () => {
  const parsed = parseShgovSearchHtml(fixture);
  assert.deepEqual(parsed.meta, { fetchKey: "fk", totalSize: 2, total: 9 });
  assert.equal(parsed.results.length, 2);
  assert.equal(parsed.results[0].token, "abc");
  assert.equal(parsed.results[0].targetUrl, "https://edu.sh.gov.cn/a");
  assert.equal(parsed.results[0].summary, "摘要 学校");
  assert.equal(parsed.results[0].channel, "政策");
  assert.equal(parsed.results[1].index, 1);
});

test("normalizes relative result targets without losing the original href", () => {
  const parsed = parseShgovSearchHtml(`<div class="result result-elm"><a class="restitle" href="/detail?token=x">标题</a><a class="url" href="/policy/1">原文</a></div>`, "https://search.sh.gov.cn");
  assert.equal(parsed.results[0].targetUrl, "/policy/1");
  assert.equal(parsed.results[0].sourceSite, "search.sh.gov.cn");
});

test("keeps malformed result URLs as raw fields without aborting page parsing", () => {
  const parsed = parseShgovSearchHtml(`<div class="result result-elm"><a class="restitle" href="http://[invalid">标题</a><a class="url" href="http://[invalid">原文</a></div>`);
  assert.equal(parsed.results.length, 1);
  assert.equal(parsed.results[0].detailUrl, null);
  assert.equal(parsed.results[0].sourceSite, null);
  assert.equal(parsed.results[0].targetUrl, "http://[invalid");
});

test("occurrence keys retain keyword, page and result index", () => {
  assert.equal(occurrenceKey("学区", 3, 7), "shgov-search-v1:%E5%AD%A6%E5%8C%BA:p3:r7");
  assert.notEqual(occurrenceKey("学校", 1, 0), occurrenceKey("学校", 2, 0));
});

test("collector performs bootstrap then paged result requests with the required form protocol", async () => {
  const calls: Array<{ url: string; body: string; cookie?: string }> = [];
  const bootstrap = `<form><input type="hidden" name="text" value="学区"></form>`;
  const result = `<input type="hidden" name="fetchKey" value="fk"/><input type="hidden" name="totalSize" value="2"/><input type="hidden" name="total" value="2"/><div class="result result-elm"><a class="restitle" href="/detail?token=x">学校</a></div>`;
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: String(init?.body), cookie: String((init?.headers as Record<string, string>)?.cookie ?? "") });
    return new Response(calls.length === 1 ? bootstrap : result, { status: 200, headers: calls.length === 1 ? { "set-cookie": "JSESSIONID=test; Path=/" } : {} });
  };
  const dir = mkdtempSync(path.join(tmpdir(), "shgov-search-"));
  try {
    const output = await collectShgovSearch({ keywords: ["学区"], outputDir: dir, maxPages: 1, pageSize: 1, delayMs: 0, fetchImpl });
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/search$/); assert.match(calls[1].url, /\/searchResult$/);
    for (const field of ["text", "pageNo", "newsPageNo", "pageSize", "resourceType", "channel", "category1", "category2", "category3", "category4", "category6", "category7", "sortMode", "searchMode", "timeRange", "accurateMode", "district", "street", "stealthy", "showItemAgency"]) assert.match(calls[0].body, new RegExp(`${field}=`));
    assert.equal(output.manifest.resources[1].totalSize, 2);
    assert.equal(JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")).resources.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("collector marks an unknown-total run incomplete at the page limit", async () => {
  const fetchImpl: typeof fetch = async (input) => new Response(String(input).endsWith("/search") ? "<html></html>" : `<div class="result result-elm"><a class="restitle" href="/detail">结果</a></div>`, { status: 200 });
  const dir = mkdtempSync(path.join(tmpdir(), "shgov-search-limit-"));
  try {
    const output = await collectShgovSearch({ keywords: ["学区"], outputDir: dir, maxPages: 1, pageSize: 1, delayMs: 0, fetchImpl });
    assert.equal(output.manifest.complete, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("import groups a resource and its occurrences by response hash and rolls back reconciliation failures", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "shgov-search-import-"));
  const body = `<input type="hidden" name="totalSize" value="1"/><div class="result result-elm"><a class="restitle" href="/detail?token=x">结果</a></div>`;
  const bytes = Buffer.from(body);
  const manifestPath = path.join(dir, "manifest.json");
  const resource = { kind: "result" as const, keyword: "学区", pageNo: 1, url: "https://search.sh.gov.cn/searchResult", finalUrl: "https://search.sh.gov.cn/searchResult", status: 200, fetchedAt: "2026-09-10T00:00:00.000Z", file: "result.html", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), totalSize: 1, total: 1, fetchKey: "fk" };
  writeFileSync(path.join(dir, "result.html"), bytes);
  writeFileSync(manifestPath, JSON.stringify({ version: 1, source: "search.sh.gov.cn", sourceKind: "official_search_index", runId: "run", startedAt: resource.fetchedAt, finishedAt: resource.fetchedAt, complete: true, keywords: ["学区"], limits: { pageSize: 1, maxPages: 1, timeoutMs: 1000, delayMs: 0 }, resources: [resource] }));
  const stored: Array<Record<string, unknown>> = [];
  const crawlInserts: unknown[][] = [];
  const transactionStatements: string[] = [];
  let runExists = false;
  let failReconciliation = true;
  const client = {
    async query(sql: string, values: unknown[] = []) {
      transactionStatements.push(sql);
      if (sql === "SELECT id FROM ingest.sources WHERE source_key='shgov-search'") return { rows: [{ id: 1 }] };
      if (sql.startsWith("SELECT id FROM ingest.crawl_runs")) return { rows: runExists ? [{ id: 1 }] : [] };
      if (sql.startsWith("INSERT INTO ingest.crawl_runs")) { crawlInserts.push(values); runExists = true; return { rows: [{ id: 1 }] }; }
      if (sql.startsWith("SELECT record_type,source_key,district,raw FROM ingest.extracted_records")) return { rows: failReconciliation ? [] : stored };
      if (sql.startsWith("INSERT INTO ingest.extracted_records")) {
        const rows = JSON.parse(String(values[1])) as Array<{ type: string; key: string; district: null; raw: Record<string, unknown> }>;
        stored.push(...rows.map((row) => ({ record_type: row.type, source_key: row.key, district: row.district, raw: row.raw })));
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  try {
    const missingBodyManifest = path.join(dir, "missing-body.json");
    writeFileSync(missingBodyManifest, JSON.stringify({ version: 1, source: "search.sh.gov.cn", sourceKind: "official_search_index", runId: "run", startedAt: resource.fetchedAt, finishedAt: resource.fetchedAt, complete: true, keywords: ["学区"], limits: { pageSize: 1, maxPages: 1, timeoutMs: 1000, delayMs: 0 }, resources: [{ ...resource, file: null }] }));
    await assert.rejects(() => importShgovSearch(missingBodyManifest, { client, apply: true, writeReport: false }), /missing raw body metadata/);
    await assert.rejects(() => importShgovSearch(manifestPath, { client, apply: true, writeReport: false }), /Round-trip mismatch/);
    assert.equal(crawlInserts.length, 1);
    assert.equal(stored.length, 2);
    assert.ok(transactionStatements.includes("ROLLBACK"));
    failReconciliation = false;
    const repeat = await importShgovSearch(manifestPath, { client, apply: true, writeReport: false });
    assert.equal(repeat.added, 0);
    assert.equal(repeat.unchanged, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
