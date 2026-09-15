import assert from "node:assert/strict";
import { after, test } from "node:test";
import { loadLocalEnv } from "../scripts/load-env";

loadLocalEnv();
const explorer = import("../lib/db/explorer");
after(async () => { const { pool } = await import("../lib/db/client"); await pool.end(); });

test("source snapshots and source catalogs are browsable in the database console", async () => {
  const { listTables } = await explorer;
  const publicTables = (await listTables("public")).map(t => t.name);
  assert.ok(publicTables.includes("pending_school_communities"), `public 表应含 pending_school_communities（原 catalog.school_communities，2026-09-15 迁入），实际 ${publicTables.join(",")}`);

});

test("removed ingest schema is no longer browsable or writable through generic row controls", async () => {
  const { listTables, insertRow } = await explorer;
  // ingest schema 已于 2026-09-15 删除：既不可浏览也不在白名单（比原来的审计表保护更强）
  assert.deepEqual(await listTables("ingest"), []);
  await assert.rejects(insertRow("ingest", "extracted_records", {}), /whitelist/);
});
