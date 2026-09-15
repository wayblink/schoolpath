// 固定导入接口（外部采集项目的导入契约）：POST /api/ingest/records 推送，直写待审池
// public.pending_school_communities（review_status='pending'）——外部项目推结构化数据，Ops 审核后走发布批次。
// ingest schema 已于 2026-09-15 删除（raw 归档层取消；原始数据由外部采集项目自留）。
// 幂等：按 (source_name, school_name_raw, committee_name, year) 应用层查重跳过已存在行。
import { createHash } from "node:crypto";
import pg from "pg";

export type IngestRecord = { recordType: string; sourceKey: string; district?: string | null; raw: unknown };
export type IngestPayload = { sourceKey: string; sourceName: string; sourceKind?: string; records: IngestRecord[] };

export type IngestResult = { sourceKey: string; received: number; added: number; unchanged: number };

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

/** 从 raw 提取结构化字段（宽松映射：优先中文键，兼容英文键，兜底 sourceKey）。 */
function extractFields(record: IngestRecord) {
  const raw = (record.raw && typeof record.raw === "object" ? record.raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const schoolNameRaw = str(raw.schoolName) ?? str(raw["学校"]) ?? str(raw["学校名"]) ?? record.sourceKey;
  const committeeName = str(raw.committee) ?? str(raw.committeeName) ?? str(raw["片区"]) ?? str(raw["居委"]) ?? str(raw["小区"]);
  const district = record.district ?? str(raw.district) ?? str(raw["区县"]);
  const yearRaw = raw.year ?? raw["年份"];
  const year = Number.isFinite(Number(yearRaw)) && Number(yearRaw) > 2000 ? Number(yearRaw) : null;
  return { schoolNameRaw, committeeName, district, year };
}

/** 幂等写入：重复推送同一 (source_name, school_name_raw, committee_name, year) 返回 added=0。 */
export async function ingestRecords(payload: unknown): Promise<IngestResult> {
  assertPayload(payload);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    const rows = payload.records.map((record) => {
      const { schoolNameRaw, committeeName, district, year } = extractFields(record);
      return {
        sourceName: payload.sourceKey,
        schoolNameRaw,
        committeeName,
        district,
        year,
        sourceUrl: null as string | null,
        notes: `raw=${JSON.stringify(record.raw)}`,
      };
    });
    // 应用层查重：请求内先去重，再查库中已存在的 identity
    const seen = new Set<string>();
    const fresh = rows.filter((r) => {
      const key = `${r.sourceName}|${r.schoolNameRaw}|${r.committeeName ?? ""}|${r.year ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const existing = await client.query(
      `select source_name, school_name_raw, committee_name, year from public.pending_school_communities
       where source_name = $1`,
      [payload.sourceKey],
    );
    const existingKeys = new Set(
      existing.rows.map((r) => `${r.source_name}|${r.school_name_raw}|${r.committee_name ?? ""}|${r.year ?? ""}`),
    );
    const toInsert = fresh.filter((r) => !existingKeys.has(`${r.sourceName}|${r.schoolNameRaw}|${r.committeeName ?? ""}|${r.year ?? ""}`));
    if (toInsert.length > 0) {
      const placeholders = toInsert.map(
        (_, i) => `($${i * 6 + 1}, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}, $${i * 6 + 6}, 'pending')`,
      );
      const values = toInsert.flatMap((r) => [r.schoolNameRaw, r.district, r.committeeName, r.year, r.sourceName, r.notes]);
      await client.query(
        `insert into public.pending_school_communities(school_name_raw, district, committee_name, year, source_name, notes, review_status)
         values ${placeholders.join(", ")}`,
        values,
      );
    }
    await client.query("commit");
    return {
      sourceKey: payload.sourceKey,
      received: payload.records.length,
      added: toInsert.length,
      unchanged: payload.records.length - toInsert.length,
    };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

/** 内容哈希（供外部项目推送前去重或调试追溯）。 */
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
