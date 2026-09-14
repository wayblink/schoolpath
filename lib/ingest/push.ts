// 固定导入接口（R2）：外部采集/导入项目通过 POST /api/ingest/records 推送。
// 只写 ingest 候选池（ingest.sources / ingest.crawl_runs / ingest.extracted_records），
// 绝不写 catalog 或 public——进产品必须走 Ops 发布批次。
// 幂等键：extracted_records 唯一索引 (crawl_run_id, record_type, source_key)。
import pg from "pg";

export type IngestRecord = { recordType: string; sourceKey: string; district?: string | null; raw: unknown };
export type IngestPayload = { sourceKey: string; sourceName: string; sourceKind?: string; records: IngestRecord[] };

export type IngestResult = { sourceKey: string; runId: number; received: number; added: number; unchanged: number };

const MAX_RECORDS = 2000;

function assertPayload(payload: unknown): asserts payload is IngestPayload {
  if (!payload || typeof payload !== "object") throw new Error("body must be a JSON object");
  const p = payload as Partial<IngestPayload>;
  if (!p.sourceKey || typeof p.sourceKey !== "string" || !/^[a-z0-9._-]{1,64}$/.test(p.sourceKey)) {
    throw new Error("sourceKey must match /^[a-z0-9._-]{1,64}$/");
  }
  if (!p.sourceName || typeof p.sourceName !== "string") throw new Error("sourceName is required");
  if (!Array.isArray(p.records) || p.records.length === 0) throw new Error("records must be a non-empty array");
  if (p.records.length > MAX_RECORDS) throw new Error(`records exceeds ${MAX_RECORDS} per request`);
  for (const [i, r] of p.records.entries()) {
    if (!r || typeof r !== "object") throw new Error(`records[${i}] must be an object`);
    if (!r.recordType || typeof r.recordType !== "string") throw new Error(`records[${i}].recordType is required`);
    if (!r.sourceKey || typeof r.sourceKey !== "string") throw new Error(`records[${i}].sourceKey is required`);
    if (r.raw === undefined) throw new Error(`records[${i}].raw is required`);
    try {
      JSON.stringify(r.raw);
    } catch {
      throw new Error(`records[${i}].raw is not JSON-serializable`);
    }
  }
}

/** 幂等写入：重复推送同一 (sourceKey, recordType, sourceKey) 返回 added=0。 */
export async function ingestRecords(payload: unknown): Promise<IngestResult> {
  assertPayload(payload);
  const sourceKind = payload.sourceKind ?? "external_push";
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    // 1) 登记来源（幂等；base_url NOT NULL 无默认值，用 push:// 占位标识来源为接口推送）
    await client.query(
      `insert into ingest.sources(source_key,name,base_url,source_kind) values($1,$2,$3,$4) on conflict(source_key) do nothing`,
      [payload.sourceKey, payload.sourceName, `push://${payload.sourceKey}`, sourceKind],
    );
    // 2) 登记采集批次：按内容 hash 复用同一 run（同批次重复推送不产生新 run）
    const contentHash = require("node:crypto").createHash("sha256")
      .update(JSON.stringify(payload.records.map((r) => [r.recordType, r.sourceKey])))
      .digest("hex");
    let runId = (
      await client.query(
        `select cr.id from ingest.crawl_runs cr join ingest.sources s on s.id=cr.source_id
         where s.source_key=$1 and cr.content_hash=$2 order by cr.id desc limit 1`,
        [payload.sourceKey, contentHash],
      )
    ).rows[0]?.id as number | undefined;
    if (runId == null) {
      const sourceId = (
        await client.query(`select id from ingest.sources where source_key=$1`, [payload.sourceKey])
      ).rows[0].id as number;
      runId = (
        await client.query(
          `insert into ingest.crawl_runs(source_id,source_url,fetched_at,http_status,content_hash,parser_version,page_title,stats)
           values($1,$2,now(),200,$3,1,$4,jsonb_build_object('recordCount',$5::int)) returning id`,
          [sourceId, `push://${payload.sourceKey}`, contentHash, `push:${payload.sourceKey}`, payload.records.length],
        )
      ).rows[0].id as number;
    }
    // 3) 写入候选记录（幂等键 crawl_run_id,record_type,source_key）
    let added = 0;
    for (let offset = 0; offset < payload.records.length; offset += 200) {
      const batch = payload.records.slice(offset, offset + 200);
      const res = await client.query(
        `insert into ingest.extracted_records(crawl_run_id,record_type,source_key,district,raw)
         select $1,r."recordType",r."sourceKey",r.district,r.raw from jsonb_to_recordset($2::jsonb)
         as r("recordType" text,"sourceKey" text,district text,raw jsonb)
         on conflict(crawl_run_id,record_type,source_key) do nothing`,
        [runId, JSON.stringify(batch)],
      );
      added += res.rowCount ?? 0;
    }
    await client.query("commit");
    return { sourceKey: payload.sourceKey, runId, received: payload.records.length, added, unchanged: payload.records.length - added };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}
