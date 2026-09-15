// Ops 全表 CRUD 引擎：白名单 9 张 public 活跃表的查看/新增/更新/删除。
// 列元数据动态获取（information_schema），FK 列查询时 join 出显示名，删除遇 FK 依赖时返回友好错误。
import pg from "pg";

export const OPS_TABLES = [
  { key: "schools", label: "学校", icon: "school" },
  { key: "communities", label: "小区", icon: "community" },
  { key: "school_communities", label: "对口关系", icon: "link" },
  { key: "policy_documents", label: "政策公示", icon: "policy" },
  { key: "web_data_source", label: "信息源", icon: "source" },
  { key: "districts", label: "区县", icon: "district" },
  { key: "community_price_snapshots", label: "小区价格快照", icon: "price" },
  { key: "community_price_sources", label: "小区价格来源", icon: "price" },
  { key: "district_boundaries", label: "学区边界", icon: "boundary" },
  { key: "school_pathways", label: "升学路径", icon: "pathway" },
] as const;

export type OpsTableKey = (typeof OPS_TABLES)[number]["key"];

const TABLE_KEYS = new Set<string>(OPS_TABLES.map((t) => t.key));
const SCHEMA = "public";

// FK 列的显示关联：查询时 left join 拿可读名称（表单仍填 id）
const FK_DISPLAY: Record<string, { table: string; column: string; label: string }> = {
  school_id: { table: "schools", column: "name", label: "学校" },
  community_id: { table: "communities", column: "name", label: "小区" },
  district_id: { table: "districts", column: "canonical_name", label: "区县" },
  public_school_id: { table: "schools", column: "name", label: "学校" },
  primary_school_id: { table: "schools", column: "name", label: "小学" },
  middle_school_id: { table: "schools", column: "name", label: "初中" },
};

export type ColumnMeta = {
  name: string;
  dataType: string;
  isNullable: boolean;
  hasDefault: boolean;
  fk?: { table: string; column: string; label: string };
};

function assertTable(table: string): asserts table is OpsTableKey {
  if (!TABLE_KEYS.has(table)) throw new Error(`table ${table} is not in ops whitelist`);
}

function quote(name: string): string {
  return JSON.stringify(name);
}

async function pool() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  return new pg.Pool({ connectionString: url, max: 2 });
}

export async function getColumns(table: string): Promise<ColumnMeta[]> {
  assertTable(table);
  const p = await pool();
  try {
    const { rows } = await p.query<{ name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name AS name, data_type AS data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [SCHEMA, table],
    );
    return rows.map((r) => ({
      name: r.name,
      dataType: r.data_type,
      isNullable: r.is_nullable === "YES",
      hasDefault: r.column_default !== null,
      fk: FK_DISPLAY[r.name],
    }));
  } finally {
    await p.end();
  }
}

export async function listRows(table: string, opts: { page?: number; pageSize?: number; q?: string } = {}) {
  assertTable(table);
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(Math.max(opts.pageSize ?? 30, 1), 200);
  const offset = (page - 1) * pageSize;
  const p = await pool();
  try {
    const columns = await getColumns(table);
    // FK 显示列：left join 取名称
    const fkCols = columns.filter((c) => c.fk);
    const selectCols = columns.map((c) => `t.${quote(c.name)}`);
    const fkAliases = fkCols.map((c, i) => `fk${i}.${quote(c.fk!.column)} AS ${quote("__fk_" + c.name)}`);
    const joins = fkCols.map((c, i) =>
      `left join ${SCHEMA}.${quote(c.fk!.table)} fk${i} on fk${i}.id = t.${quote(c.name)}`,
    );
    // 搜索：跨文本列 ilike
    const searchable = columns.filter((c) => ["text", "character varying"].includes(c.dataType));
    const where: string[] = [];
    const values: unknown[] = [];
    if (opts.q && opts.q.trim() && searchable.length > 0) {
      values.push(`%${opts.q.trim()}%`);
      where.push(`(${searchable.map((c) => `t.${quote(c.name)}::text ilike $${values.length}`).join(" or ")})`);
    }
    values.push(pageSize, offset);
    const limitParam = values.length - 1;
    const offsetParam = values.length;
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const countSql = `select count(*)::int c from ${SCHEMA}.${quote(table)} t ${whereSql}`;
    const countValues = values.slice(0, values.length - 2);
    const [{ rows: countRows }, { rows }] = await Promise.all([
      p.query(countSql, countValues),
      p.query(
        `select ${[...selectCols, ...fkAliases].join(", ")}
         from ${SCHEMA}.${quote(table)} t
         ${joins.join(" ")}
         ${whereSql}
         order by t.id desc
         limit $${limitParam} offset $${offsetParam}`,
        values,
      ),
    ]);
    const total = Number(countRows[0]?.c ?? 0);
    return {
      rows: rows.map((r) => {
        const row: Record<string, unknown> = {};
        for (const c of columns) row[c.name] = r[c.name] ?? null;
        for (const c of fkCols) row[`__fk_${c.name}`] = r[`__fk_${c.name}`] ?? null;
        return row;
      }),
      columns,
      total,
      page,
      pageSize,
    };
  } finally {
    await p.end();
  }
}

const EDITABLE_SKIP = new Set(["id", "created_at", "updated_at"]);

function coerceValue(col: ColumnMeta, value: unknown): unknown {
  if (value === "" || value === undefined) return null;
  if (value === null) return col.isNullable ? null : value;
  switch (col.dataType) {
    case "integer":
    case "bigint":
    case "smallint": {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`${col.name} 必须是数字`);
      return n;
    }
    case "numeric":
    case "double precision":
    case "real": {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`${col.name} 必须是数字`);
      return n;
    }
    case "boolean":
      return value === true || value === "true" || value === "on";
    case "jsonb":
    case "json":
      return typeof value === "string" ? JSON.parse(value) : value;
    default:
      return String(value);
  }
}

export async function insertRow(table: string, values: Record<string, unknown>) {
  assertTable(table);
  const columns = await getColumns(table);
  const p = await pool();
  try {
    const entries = Object.entries(values)
      .filter(([name]) => columns.some((c) => c.name === name) && !EDITABLE_SKIP.has(name))
      .map(([name, value]) => {
        const col = columns.find((c) => c.name === name)!;
        return { name, value: coerceValue(col, value) };
      });
    if (entries.length === 0) throw new Error("没有可写入的字段");
    const placeholders = entries.map((_, i) => `$${i + 1}`).join(", ");
    const { rows } = await p.query(
      `insert into ${SCHEMA}.${quote(table)}(${entries.map((e) => quote(e.name)).join(", ")})
       values (${placeholders}) returning *`,
      entries.map((e) => e.value),
    );
    return rows[0];
  } finally {
    await p.end();
  }
}

export async function updateRow(table: string, id: number, values: Record<string, unknown>) {
  assertTable(table);
  const columns = await getColumns(table);
  const p = await pool();
  try {
    const entries = Object.entries(values)
      .filter(([name]) => columns.some((c) => c.name === name) && !EDITABLE_SKIP.has(name))
      .map(([name, value]) => {
        const col = columns.find((c) => c.name === name)!;
        return { name, value: coerceValue(col, value) };
      });
    if (entries.length === 0) throw new Error("没有可更新的字段");
    const setSql = entries.map((e, i) => `${quote(e.name)} = $${i + 1}`).join(", ");
    const { rows } = await p.query(
      `update ${SCHEMA}.${quote(table)} set ${setSql} where id = $${entries.length + 1} returning *`,
      [...entries.map((e) => e.value), id],
    );
    if (!rows[0]) throw new Error("row not found");
    return rows[0];
  } finally {
    await p.end();
  }
}

export async function deleteRow(table: string, id: number) {
  assertTable(table);
  const p = await pool();
  try {
    const { rowCount } = await p.query(`delete from ${SCHEMA}.${quote(table)} where id = $1`, [id]);
    if (!rowCount) throw new Error("row not found");
    return { deleted: rowCount };
  } finally {
    await p.end();
  }
}
