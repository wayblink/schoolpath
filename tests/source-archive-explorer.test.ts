import assert from "node:assert/strict";
import { after, test } from "node:test";
import { loadLocalEnv } from "../scripts/load-env";

loadLocalEnv();
const explorer = import("../lib/db/explorer");
after(async () => { const { pool } = await import("../lib/db/client"); await pool.end(); });

test("source snapshots and source catalogs are browsable in the database console", async () => {
  const { listTables, getTableDetail } = await explorer;
  const tables = await listTables("ingest");
  assert.deepEqual(tables.map(t => t.name).sort(), ["crawl_runs", "extracted_records", "sources"]);
  const detail = await getTableDetail("ingest", "extracted_records");
  assert.ok(detail.columns.some(c => c.name === "raw" && c.dataType === "jsonb"));
  const catalog = await listTables("catalog");
  assert.deepEqual(catalog.map(t => t.name).sort(), ["school_district_relations", "source_schools"]);
});

test("source archives cannot be accidentally edited through generic row controls", async () => {
  const { insertRow } = await explorer;
  await assert.rejects(insertRow("ingest", "extracted_records", {}), /来源审计表/);
});
