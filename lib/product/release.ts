// 发布批次（R4）：Ops 管理员把 catalog.relations 中 accepted 的条目组成批次，
// 事务内 upsert 到 public.school_communities（幂等，靠唯一索引 uq_school_communities_pair），
// 回写来源层 published_at/release_batch_id，catalog.release_batches 记账。
// 状态机：draft → published → rolled_back。
import pg from "pg";

export type ReleaseBatch = {
  id: number;
  name: string;
  status: "draft" | "published" | "rolled_back";
  summary: Record<string, unknown>;
  createdAt: string;
  publishedAt: string | null;
  rolledBackAt: string | null;
};

export type ReleaseBatchDetail = ReleaseBatch & { entryCount: number };

export type CreateBatchInput = { name: string; district?: string; sourceName?: string; year?: number; includeUnmatched?: boolean };

async function pool() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  return new pg.Pool({ connectionString: url, max: 1 });
}

const BATCH_COLUMNS = `id,name,status,summary,created_at "createdAt",published_at "publishedAt",rolled_back_at "rolledBackAt"`;

export async function listReleaseBatches(): Promise<ReleaseBatchDetail[]> {
  const p = await pool();
  try {
    const rows = await p.query<ReleaseBatchDetail & { entryCount: string }>(
      `select b.id,b.name,b.status,b.summary,b.created_at "createdAt",b.published_at "publishedAt",b.rolled_back_at "rolledBackAt",
         (select count(*)::int from catalog.relations r where r.release_batch_id=b.id) "entryCount"
       from catalog.release_batches b order by b.id desc limit 100`,
    );
    return rows.rows;
  } finally {
    await p.end();
  }
}

/** 创建 draft 批次：按条件筛选 accepted 关系，先计数（空批次拒绝创建）。
 *  默认只收"学校和小区都匹配上"的条目（发布可落地的）；includeUnmatched=true 时收全部 accepted
 *  （未匹配条目发布时自动跳过，留在批次里供人工补匹配）。 */
export async function createReleaseBatch(input: CreateBatchInput): Promise<ReleaseBatchDetail> {
  if (!input.name || !input.name.trim()) throw new Error("name is required");
  // where 片段同时用于 SELECT（带 r 别名）与 UPDATE（无别名）——别名由调用方提供
  const conditions = ["review_status='accepted'"];
  if (!input.includeUnmatched) conditions.push("school_id is not null and catalog_community_id is not null");
  const values: unknown[] = [];
  if (input.district) {
    values.push(input.district);
    conditions.push(`district=$${values.length}`);
  }
  if (input.sourceName) {
    values.push(input.sourceName);
    conditions.push(`source_name=$${values.length}`);
  }
  if (input.year) {
    values.push(input.year);
    conditions.push(`source_year=$${values.length}`);
  }
  const where = conditions.join(" and ");
  const p = await pool();
  const client = await p.connect();
  try {
    await client.query("begin");
    const count = Number((await client.query(`select count(*) c from catalog.relations r where ${where}`, values)).rows[0].c);
    if (count === 0) throw new Error("no accepted relations match the filters");
    const filters: Record<string, unknown> = {};
    if (input.district) filters.district = input.district;
    if (input.sourceName) filters.sourceName = input.sourceName;
    if (input.year) filters.year = input.year;
    // 先插入批次，再单独 UPDATE 认领关系（CTE 中未被引用的 UPDATE 不会执行）
    const inserted = await client.query<{ id: number }>(
      `insert into catalog.release_batches(name,status,summary)
       values($1,'draft',$2::jsonb) returning id`,
      [input.name.trim(), JSON.stringify({ filters, matchedCount: count, createdAt: new Date().toISOString() })],
    );
    const batchId = inserted.rows[0].id;
    await client.query(
      `update catalog.relations set release_batch_id=$${values.length + 1} where ${where} and release_batch_id is null`,
      [...values, batchId],
    );
    const row = await client.query<ReleaseBatchDetail & { entryCount: string }>(
      `select id,name,status,summary,created_at "createdAt",published_at "publishedAt",rolled_back_at "rolledBackAt",
         (select count(*)::int from catalog.relations r where r.release_batch_id=$1) "entryCount"
       from catalog.release_batches where id=$1`,
      [batchId],
    );
    if (!row.rowCount) throw new Error("failed to create release batch");
    await client.query("commit");
    return row.rows[0];
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
    await p.end();
  }
}

/** 执行发布：事务内 upsert 产品层 + 回写来源层 + 批次置 published。 */
export async function publishReleaseBatch(id: number): Promise<ReleaseBatchDetail> {
  if (!Number.isInteger(id) || id <= 0) throw new Error("invalid batch id");
  const p = await pool();
  const client = await p.connect();
  try {
    await client.query("begin");
    await client.query("select id from catalog.release_batches where id=$1 for update", [id]);
    const batch = (await client.query<ReleaseBatch>(`select ${BATCH_COLUMNS} from catalog.release_batches where id=$1`, [id])).rows[0];
    if (!batch) throw new Error("batch not found");
    if (batch.status !== "draft") throw new Error(`batch is ${batch.status}, only draft can be published`);
    const entries = await client.query<{ schoolId: number | null; catalogCommunityId: number | null; committeeName: string | null; sourceYear: number | null; sourceName: string; sourceUrl: string | null; id: number }>(
      `select id,school_id "schoolId",catalog_community_id "catalogCommunityId",committee_name "committeeName",
         source_year "sourceYear",source_name "sourceName",source_url "sourceUrl"
       from catalog.relations where release_batch_id=$1`,
      [id],
    );
    const publishable = entries.rows.filter((r) => r.schoolId != null && r.catalogCommunityId != null);
    const skipped = entries.rowCount! - publishable.length;
    let upserted = 0;
    for (let offset = 0; offset < publishable.length; offset += 200) {
      const batchRows = publishable.slice(offset, offset + 200);
      const res = await client.query(
        `insert into public.school_communities(school_id,community_id,committee_name,year,source_name,source_url,source_date,verified,release_batch_id)
         select r."schoolId",r."catalogCommunityId",r."committeeName",coalesce(r."sourceYear",2026),r."sourceName",r."sourceUrl",
           coalesce(r."sourceYear",2026)::text,false,$1
         from jsonb_to_recordset($2::jsonb)
         as r("schoolId" int,"catalogCommunityId" int,"committeeName" text,"sourceYear" int,"sourceName" text,"sourceUrl" text)
         on conflict(school_id,community_id) do nothing`,
        [id, JSON.stringify(batchRows)],
      );
      upserted += res.rowCount ?? 0;
    }
    const updated = await client.query<ReleaseBatchDetail & { entryCount: string }>(
      `with done as (
         update catalog.release_batches set status='published',published_at=now(),
           summary = summary || jsonb_build_object('upserted',$2::int,'skipped',$3::int)
         where id=$1 and status='draft' returning *
       )
       select done.id,done.name,done.status,done.summary,done.created_at "createdAt",done.published_at "publishedAt",
         done.rolled_back_at "rolledBackAt",
         (select count(*)::int from catalog.relations r where r.release_batch_id=done.id) "entryCount"
       from done`,
      [id, upserted, skipped],
    );
    if (!updated.rowCount) throw new Error("batch was modified concurrently");
    await client.query("commit");
    return updated.rows[0];
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
    await p.end();
  }
}

/** 回滚：删除本批次写入的产品层行 + 来源层 published_at 清空 + 批次置 rolled_back。 */
export async function rollbackReleaseBatch(id: number): Promise<ReleaseBatchDetail> {
  if (!Number.isInteger(id) || id <= 0) throw new Error("invalid batch id");
  const p = await pool();
  const client = await p.connect();
  try {
    await client.query("begin");
    await client.query("select id from catalog.release_batches where id=$1 for update", [id]);
    const batch = (await client.query<ReleaseBatch>(`select ${BATCH_COLUMNS} from catalog.release_batches where id=$1`, [id])).rows[0];
    if (!batch) throw new Error("batch not found");
    if (batch.status !== "published") throw new Error(`batch is ${batch.status}, only published can be rolled back`);
    const removed = await client.query(`delete from public.school_communities where release_batch_id=$1`, [id]);
    // published_at 是 NOT NULL（建表 default now()），回滚不清空时间戳，只解除批次归属（可重新组成新批次）
    await client.query(`update catalog.relations set release_batch_id=null where release_batch_id=$1`, [id]);
    const updated = await client.query<ReleaseBatchDetail & { entryCount: string }>(
      `update catalog.release_batches set status='rolled_back',rolled_back_at=now(),
         summary = summary || jsonb_build_object('removedRows',$2::int)
       where id=$1 returning id,name,status,summary,created_at "createdAt",published_at "publishedAt",rolled_back_at "rolledBackAt",
         (select count(*)::int from catalog.relations r where r.release_batch_id=catalog.release_batches.id) "entryCount"`,
      [id, removed.rowCount ?? 0],
    );
    await client.query("commit");
    return updated.rows[0];
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
    await p.end();
  }
}
