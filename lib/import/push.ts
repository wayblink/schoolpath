// 固定导入接口（外部采集项目的导入契约）：POST /api/ingest/records 推送，直写产品层
// public.school_communities——外部项目负责采集+解析（推已匹配的 school_id/community_id），
// 本地只做幂等落地，审计靠 committee_name/source_quote/source_url 可追溯。
// 待审池（原 pending_school_communities）与批次发布均已于 2026-09-15 下线（用户决策 B）。
// 幂等：sc 唯一索引 uq_school_communities_pair(school_id, community_id)，ON CONFLICT DO NOTHING。
import pg from "pg";

export type IngestRecord = {
  recordType: string;
  sourceKey: string;
  schoolId?: number;
  communityId?: number;
  committeeName?: string | null;
  year?: number | null;
  sourceUrl?: string | null;
  sourceQuote?: string | null;
  raw?: unknown;
};
export type IngestPayload = { sourceKey: string; sourceName: string; sourceKind?: string; records: IngestRecord[] };

export type IngestResult = { sourceKey: string; received: number; added: number; unchanged: number; skipped: number };

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
    const schoolId = Number(r.schoolId);
    const communityId = Number(r.communityId);
    if (!Number.isInteger(schoolId) || schoolId <= 0) throw new Error(`records[${i}].schoolId must be a positive integer (外部项目需先解析出 public.schools.id)`);
    if (!Number.isInteger(communityId) || communityId <= 0) throw new Error(`records[${i}].communityId must be a positive integer (外部项目需先解析出 public.communities.id)`);
  }
}

/** 幂等写入：重复推送同一 (school_id, community_id) 被唯一索引吃掉（ON CONFLICT DO NOTHING）。 */
export async function ingestRecords(payload: unknown): Promise<IngestResult> {
  assertPayload(payload);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    // 请求内先去重（同 pair 多条只发一条）
    const seen = new Set<string>();
    const fresh: typeof payload.records = [];
    for (const r of payload.records) {
      const key = `${r.schoolId}|${r.communityId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(r);
    }
    const today = new Date().toISOString().slice(0, 10);
    const placeholders = fresh.map((_, i) => `($${i * 8 + 1}, $${i * 8 + 2}, $${i * 8 + 3}, $${i * 8 + 4}, $${i * 8 + 5}, $${i * 8 + 6}, $${i * 8 + 7}, $${i * 8 + 8}, false)`);
    const values = fresh.flatMap((r) => [
      r.schoolId,
      r.communityId,
      r.committeeName ?? null,
      r.year && Number.isFinite(Number(r.year)) && Number(r.year) > 2000 ? Number(r.year) : new Date().getFullYear(),
      payload.sourceKey,
      r.sourceUrl ?? null,
      r.sourceQuote ?? (r.raw !== undefined ? JSON.stringify(r.raw) : null),
      today,
    ]);
    const res = await client.query(
      `insert into public.school_communities(school_id, community_id, committee_name, year, source_name, source_url, source_quote, source_date, verified)
       values ${placeholders.join(", ")}
       on conflict(school_id, community_id) do nothing`,
      values,
    );
    await client.query("commit");
    return {
      sourceKey: payload.sourceKey,
      received: payload.records.length,
      added: res.rowCount ?? 0,
      unchanged: fresh.length - (res.rowCount ?? 0),
      skipped: payload.records.length - fresh.length,
    };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}
