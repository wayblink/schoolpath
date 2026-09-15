import { pool } from "@/lib/db/client";

// ── Vendor-neutral types (mirrors caishen-data schemas/db_explorer.py) ──

export type ObjectKind = "table" | "view" | "materialized_view" | "other";

export interface DatabaseInfo {
  kind: string;
  version: string;
  defaultSchema: string;
  schemas: string[];
}

export interface TableInfo {
  schema: string;
  name: string;
  kind: ObjectKind;
  comment: string;
  rowCount: number;
  sizeBytes: number | null;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  default: string | null;
  isPrimaryKey: boolean;
  comment: string;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
}

export interface TableDetail {
  schema: string;
  name: string;
  kind: ObjectKind;
  comment: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  indexes: IndexInfo[];
}

export interface RowPage {
  schema: string;
  table: string;
  columns: string[];
  rows: unknown[][];
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  statement: string;
}

export interface RowQueryOptions {
  page?: number;
  pageSize?: number;
  search?: string | null;
  orderBy?: string | null;
  orderDir?: string;
  /** Per-column "contains" filters: column name → substring (ILIKE on text-cast). */
  filters?: Record<string, string> | null;
}

// ── Errors ──

export class DatabaseExplorerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseExplorerError";
  }
}

export class ReadOnlyViolation extends DatabaseExplorerError {
  constructor(message: string) {
    super(message);
    this.name = "ReadOnlyViolation";
  }
}

// ── Constants (mirrors postgres.py) ──

const SYSTEM_SCHEMAS = new Set(["information_schema", "pg_catalog", "pg_toast"]);
const BROWSABLE_RELATIONS = new Map<string, Set<string>>([
  [
    "public",
    new Set([
      "schools",
      "district_boundaries",

      "communities",
      "school_communities",
      "community_price_snapshots",
      "community_price_sources",
      "policy_documents",
      "web_data_source",
      "districts",
      "entity_match_candidates",
      "field_conflicts",
    ]),
  ],
]);
const ALLOWED_LEAD_KEYWORDS = new Set(["select", "with", "explain", "show", "table", "values"]);
const FORBIDDEN_KEYWORDS = [
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "create",
  "truncate",
  "grant",
  "revoke",
  "vacuum",
  "analyze",
  "comment",
  "copy",
  "lock",
  "reindex",
  "refresh",
  "cluster",
];
const ALLOWED_ORDER_DIR = new Set(["asc", "desc"]);
const RELKIND_MAP: Record<string, ObjectKind> = {
  r: "table",
  p: "table",
  f: "table",
  v: "view",
  m: "materialized_view",
};
const TEXT_LIKE_TYPES = ["char", "text", "string", "uuid", "json", "varchar"];
const MAX_PAGE_SIZE = 500;
const MAX_QUERY_ROWS = 5000;

// ── Helpers ──

function quoteIdent(identifier: string): string {
  // Double-quote identifier, escaping embedded quotes. Callers must still
  // whitelist the identifier against the real catalog before reaching here.
  return `"${identifier.replace(/"/g, '""')}"`;
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

function toJsonable(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (Array.isArray(value)) return value.map(toJsonable);
  if (typeof value === "object") {
    // pg already parses json/jsonb into objects; keep them as-is for the client.
    return value;
  }
  return String(value);
}

function isBrowsableRelation(schema: string, name: string): boolean {
  return BROWSABLE_RELATIONS.get(schema)?.has(name) ?? false;
}

async function assertObjectExists(schema: string, name: string): Promise<void> {
  if (SYSTEM_SCHEMAS.has(schema)) {
    throw new DatabaseExplorerError(`Schema '${schema}' is not browsable.`);
  }
  if (!isBrowsableRelation(schema, name)) {
    throw new DatabaseExplorerError(`Object is not in the database console whitelist: ${schema}.${name}`);
  }
  const { rows } = await pool.query(
    `SELECT 1 FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','p','f')`,
    [schema, name],
  );
  if (rows.length === 0) {
    throw new DatabaseExplorerError(`Object not found: ${schema}.${name}`);
  }
}

// ── Public API ──

export async function getDatabaseInfo(): Promise<DatabaseInfo> {
  const versionRes = await pool.query<{ version: string }>("SELECT version()");
  const schemas = [...BROWSABLE_RELATIONS.keys()].sort();
  const rawVersion = versionRes.rows[0]?.version ?? "";
  return {
    kind: "postgres",
    version: rawVersion.split(" on ")[0].trim(),
    defaultSchema: "public",
    schemas,
  };
}

export async function listTables(schema?: string | null): Promise<TableInfo[]> {
  const allowedEntries = schema
    ? ([[schema, BROWSABLE_RELATIONS.get(schema)]] as Array<[string, Set<string> | undefined]>)
    : [...BROWSABLE_RELATIONS.entries()];
  const allowedNames = allowedEntries
    .filter((entry): entry is [string, Set<string>] => entry[1] !== undefined)
    .flatMap(([schemaName, names]) => [...names].map((name) => ({ schema: schemaName, name })));

  if (allowedNames.length === 0) return [];

  const params: unknown[] = [];
  const allowedClauses = allowedNames.map(({ schema: schemaName, name }) => {
    params.push(schemaName, name);
    return `(n.nspname = $${params.length - 1} AND c.relname = $${params.length})`;
  });
  let where = `c.relkind IN ('r','p','f') AND (${allowedClauses.join(" OR ")})`;
  if (schema) {
    params.push(schema);
    where += ` AND n.nspname = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT
       n.nspname AS schema_name,
       c.relname AS name,
       c.relkind AS relkind,
       COALESCE(c.reltuples, 0)::bigint AS estimated_rows,
       CASE WHEN c.relkind IN ('r','m','p') THEN pg_total_relation_size(c.oid) ELSE NULL END AS size_bytes,
       obj_description(c.oid, 'pg_class') AS comment
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE ${where}
     ORDER BY n.nspname, c.relname`,
    params,
  );
  const list = rows.map((row) => {
    const estimated = Number(row.estimated_rows ?? 0);
    return {
      schema: row.schema_name as string,
      name: row.name as string,
      kind: RELKIND_MAP[row.relkind as string] ?? "other",
      rowCount: Math.max(0, Number.isFinite(estimated) ? estimated : 0),
      sizeBytes: row.size_bytes != null ? Number(row.size_bytes) : null,
      comment: (row.comment as string) ?? "",
    } satisfies TableInfo;
  });

  // Replace the stale reltuples estimate with an exact COUNT(*) so the sidebar
  // matches the row browser's footer. Counts run in parallel; on failure the
  // estimate is kept as a fallback.
  await Promise.all(
    list.map(async (t) => {
      try {
        const r = await pool.query<{ c: string }>(
          `SELECT count(*)::bigint AS c FROM ${quoteIdent(t.schema)}.${quoteIdent(t.name)}`,
        );
        t.rowCount = Number(r.rows[0]?.c ?? t.rowCount);
      } catch {
        // keep the estimate
      }
    }),
  );

  return list;
}

export async function getTableDetail(schema: string, name: string): Promise<TableDetail> {
  await assertObjectExists(schema, name);

  const relkindRes = await pool.query<{ relkind: string }>(
    `SELECT c.relkind FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, name],
  );
  const relkind = relkindRes.rows[0]?.relkind ?? "r";

  const commentRes = await pool.query<{ comment: string | null }>(
    `SELECT obj_description(c.oid, 'pg_class') AS comment
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, name],
  );

  const columnsRes = await pool.query(
    `SELECT
       a.attname AS name,
       format_type(a.atttypid, a.atttypmod) AS data_type,
       NOT a.attnotnull AS nullable,
       pg_get_expr(ad.adbin, ad.adrelid) AS default_expr,
       col_description(a.attrelid, a.attnum) AS comment,
       a.attnum AS ordinal
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
     WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`,
    [schema, name],
  );

  // Indexes (plus primary-key flag).
  const indexRes = await pool.query(
    `SELECT
       i.relname AS index_name,
       ix.indisunique AS is_unique,
       ix.indisprimary AS is_primary,
       array_agg(a.attname::text ORDER BY k.ord) AS columns
     FROM pg_index ix
     JOIN pg_class i ON i.oid = ix.indexrelid
     JOIN pg_class t ON t.oid = ix.indrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
     JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
     WHERE n.nspname = $1 AND t.relname = $2
     GROUP BY i.relname, ix.indisunique, ix.indisprimary
     ORDER BY ix.indisprimary DESC, i.relname`,
    [schema, name],
  );

  const pkColumns =
    indexRes.rows.find((r) => r.is_primary)?.columns ?? ([] as string[]);
  const pkSet = new Set<string>(pkColumns as string[]);

  const columns: ColumnInfo[] = columnsRes.rows.map((col) => ({
    name: col.name as string,
    dataType: col.data_type as string,
    nullable: Boolean(col.nullable),
    default: col.default_expr != null ? String(col.default_expr) : null,
    isPrimaryKey: pkSet.has(col.name as string),
    comment: (col.comment as string) ?? "",
  }));

  const indexes: IndexInfo[] = indexRes.rows.map((idx) => ({
    name: idx.index_name as string,
    columns: (idx.columns as string[]) ?? [],
    isUnique: Boolean(idx.is_unique),
    isPrimary: Boolean(idx.is_primary),
  }));

  return {
    schema,
    name,
    kind: RELKIND_MAP[relkind] ?? "other",
    comment: commentRes.rows[0]?.comment ?? "",
    columns,
    primaryKey: pkColumns as string[],
    indexes,
  };
}

export async function getTableRows(
  schema: string,
  name: string,
  options: RowQueryOptions = {},
): Promise<RowPage> {
  await assertObjectExists(schema, name);

  // Real column set + text-like columns, used both for output and to whitelist
  // the order-by identifier.
  const colsRes = await pool.query<{ name: string; data_type: string }>(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS data_type
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`,
    [schema, name],
  );

  const page = Math.max(1, Math.floor(options.page ?? 1));
  const pageSize = Math.max(1, Math.min(Math.floor(options.pageSize ?? 50), MAX_PAGE_SIZE));
  const columnNames = colsRes.rows.map((c) => c.name);

  if (columnNames.length === 0) {
    return { schema, table: name, columns: [], rows: [], page, pageSize, totalRows: 0, totalPages: 0 };
  }

  const textColumns = colsRes.rows
    .filter((c) => TEXT_LIKE_TYPES.some((t) => c.data_type.toLowerCase().includes(t)))
    .map((c) => c.name);

  let orderDir = (options.orderDir ?? "asc").toLowerCase();
  if (!ALLOWED_ORDER_DIR.has(orderDir)) orderDir = "asc";

  const orderBy = options.orderBy;
  if (orderBy && !columnNames.includes(orderBy)) {
    throw new DatabaseExplorerError(`Unknown order column: ${orderBy}`);
  }
  const orderClause = orderBy ? `ORDER BY ${quoteIdent(orderBy)} ${orderDir.toUpperCase()}` : "";

  const qualified = `${quoteIdent(schema)}.${quoteIdent(name)}`;
  const selectCols = columnNames.map(quoteIdent).join(", ");

  const search = options.search?.trim();
  const conditions: string[] = [];
  const filterParams: unknown[] = [];

  // Global search: OR across all text-like columns.
  if (search && textColumns.length > 0) {
    filterParams.push(`%${search}%`);
    const idx = filterParams.length;
    const ors = textColumns
      .map((col) => `CAST(${quoteIdent(col)} AS TEXT) ILIKE $${idx}`)
      .join(" OR ");
    conditions.push(`(${ors})`);
  }

  // Per-column filters: AND of CAST-to-text ILIKE, column whitelisted.
  const columnSet = new Set(columnNames);
  for (const [col, raw] of Object.entries(options.filters ?? {})) {
    const value = raw?.trim();
    if (!value || !columnSet.has(col)) continue;
    filterParams.push(`%${value}%`);
    conditions.push(`CAST(${quoteIdent(col)} AS TEXT) ILIKE $${filterParams.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countRes = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::bigint AS count FROM ${qualified} ${whereClause}`,
    filterParams,
  );
  const totalRows = Number(countRes.rows[0]?.count ?? 0);
  const totalPages = totalRows ? Math.ceil(totalRows / pageSize) : 0;

  // Data query: filter params first, then limit/offset.
  const dataParams: unknown[] = [...filterParams];
  const limitIdx = dataParams.push(pageSize);
  const offsetIdx = dataParams.push((page - 1) * pageSize);
  const dataRes = await pool.query(
    `SELECT ${selectCols} FROM ${qualified} ${whereClause} ${orderClause} LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    dataParams,
  );

  const rows = dataRes.rows.map((row) =>
    columnNames.map((col) => toJsonable((row as Record<string, unknown>)[col])),
  );

  return { schema, table: name, columns: columnNames, rows, page, pageSize, totalRows, totalPages };
}

export async function executeQuery(sql: string, maxRows = 200): Promise<QueryResult> {
  if (!sql || !sql.trim()) {
    throw new ReadOnlyViolation("Empty SQL.");
  }
  const cleaned = stripSqlComments(sql).trim().replace(/;+\s*$/, "");
  if (cleaned.includes(";")) {
    throw new ReadOnlyViolation("Multiple statements are not allowed.");
  }
  const leadMatch = cleaned.match(/^\s*(\w+)/);
  if (!leadMatch) {
    throw new ReadOnlyViolation("Could not parse SQL.");
  }
  const lead = leadMatch[1].toLowerCase();
  if (!ALLOWED_LEAD_KEYWORDS.has(lead)) {
    throw new ReadOnlyViolation(`Only read-only statements are allowed (got '${lead.toUpperCase()}').`);
  }
  const lowered = cleaned.toLowerCase();
  for (const token of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${token}\\b`).test(lowered)) {
      throw new ReadOnlyViolation(`Statement contains forbidden keyword '${token}'.`);
    }
  }

  const cappedRows = Math.max(1, Math.min(Math.floor(maxRows), MAX_QUERY_ROWS));
  const started = performance.now();
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const result = await client.query({ text: cleaned, rowMode: "array" });
    await client.query("ROLLBACK");

    const columns = (result.fields ?? []).map((f) => f.name);
    const allRows = (result.rows ?? []) as unknown[][];
    const truncated = allRows.length > cappedRows;
    const sliced = truncated ? allRows.slice(0, cappedRows) : allRows;
    const rows = sliced.map((row) => row.map(toJsonable));
    const durationMs = Math.round(performance.now() - started);
    return { columns, rows, rowCount: rows.length, truncated, durationMs, statement: cleaned };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback failure
    }
    if (err instanceof DatabaseExplorerError) throw err;
    const message = (err as Error).message?.split("\n", 1)[0] ?? String(err);
    throw new DatabaseExplorerError(`${(err as Error).name ?? "Error"}: ${message}`);
  } finally {
    client.release();
  }
}

// ── Writes (row-level CRUD, strong guardrails) ──

export interface WriteResult {
  row: Record<string, unknown> | null;
}

interface TableMeta {
  relkind: string;
  columns: string[];
  pk: string[];
}

interface ReferencingColumn {
  schema: string;
  table: string;
  column: string;
}

interface ReferenceBlocker {
  schema: string;
  table: string;
  column: string;
  count: number;
}

type PgError = Error & {
  code?: string;
  constraint?: string;
  table?: string;
  detail?: string;
};

/**
 * Fetch the real column set, primary-key columns, and relkind for a table,
 * after asserting it exists and is not in a system schema. Used to whitelist
 * identifiers and to reject writes to views / PK-less tables.
 */
async function getTableMeta(schema: string, name: string): Promise<TableMeta> {
  await assertObjectExists(schema, name);

  const relkindRes = await pool.query<{ relkind: string }>(
    `SELECT c.relkind FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, name],
  );
  const relkind = relkindRes.rows[0]?.relkind ?? "r";

  const colsRes = await pool.query<{ name: string }>(
    `SELECT a.attname AS name
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`,
    [schema, name],
  );

  const pkRes = await pool.query<{ columns: string[] }>(
    `SELECT array_agg(a.attname::text ORDER BY k.ord) AS columns
     FROM pg_index ix
     JOIN pg_class t ON t.oid = ix.indrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
     JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
     WHERE n.nspname = $1 AND t.relname = $2 AND ix.indisprimary
     GROUP BY ix.indexrelid`,
    [schema, name],
  );

  return {
    relkind,
    columns: colsRes.rows.map((r) => r.name),
    pk: pkRes.rows[0]?.columns ?? [],
  };
}

function assertWritable(meta: TableMeta, schema: string, name: string): void {
  if (schema === "ingest" || schema === "catalog") {
    throw new DatabaseExplorerError(`${schema}.${name} 是来源审计表，请通过来源导入流程更新。`);
  }
  // Only ordinary / partitioned / foreign base tables accept row writes.
  if (!["r", "p", "f"].includes(meta.relkind)) {
    throw new DatabaseExplorerError(`${schema}.${name} 不是基表，禁止写入。`);
  }
}

/** Keep only entries whose key is a real column of the table. */
function pickRealColumns(
  values: Record<string, string | null>,
  columns: string[],
): Array<[string, string | null]> {
  const allowed = new Set(columns);
  return Object.entries(values).filter(([col]) => allowed.has(col));
}

export async function insertRow(
  schema: string,
  name: string,
  values: Record<string, string | null>,
): Promise<WriteResult> {
  const meta = await getTableMeta(schema, name);
  assertWritable(meta, schema, name);

  const entries = pickRealColumns(values, meta.columns);
  const qualified = `${quoteIdent(schema)}.${quoteIdent(name)}`;

  let text: string;
  let params: unknown[] = [];
  if (entries.length === 0) {
    // All columns left to their defaults.
    text = `INSERT INTO ${qualified} DEFAULT VALUES RETURNING *`;
  } else {
    const cols = entries.map(([col]) => quoteIdent(col)).join(", ");
    const placeholders = entries.map((_, i) => `$${i + 1}`).join(", ");
    params = entries.map(([, v]) => v);
    text = `INSERT INTO ${qualified} (${cols}) VALUES (${placeholders}) RETURNING *`;
  }

  try {
    const result = await pool.query(text, params);
    return { row: jsonableRow(result.rows[0]) };
  } catch (err) {
    throw wrapDbError(err);
  }
}

export async function updateRow(
  schema: string,
  name: string,
  pk: Record<string, string | null>,
  values: Record<string, string | null>,
): Promise<WriteResult> {
  const meta = await getTableMeta(schema, name);
  assertWritable(meta, schema, name);
  assertFullPk(meta, pk);

  const setEntries = pickRealColumns(values, meta.columns).filter(
    ([col]) => !meta.pk.includes(col), // never change PK columns
  );
  if (setEntries.length === 0) {
    throw new DatabaseExplorerError("没有可更新的字段。");
  }

  const qualified = `${quoteIdent(schema)}.${quoteIdent(name)}`;
  const setClause = setEntries.map(([col], i) => `${quoteIdent(col)} = $${i + 1}`).join(", ");
  const params: unknown[] = setEntries.map(([, v]) => v);
  const whereClause = meta.pk
    .map((col, i) => `${quoteIdent(col)} = $${setEntries.length + i + 1}`)
    .join(" AND ");
  meta.pk.forEach((col) => params.push(pk[col] ?? null));

  return runGuardedWrite(
    `UPDATE ${qualified} SET ${setClause} WHERE ${whereClause} RETURNING *`,
    params,
  );
}

function assertFullPk(meta: TableMeta, pk: Record<string, string | null>): void {
  if (meta.pk.length === 0) {
    throw new DatabaseExplorerError("该表没有主键，无法逐行增删改。");
  }
  for (const col of meta.pk) {
    if (!(col in pk)) {
      throw new DatabaseExplorerError(`缺少主键列：${col}`);
    }
  }
}

const MAX_BATCH_DELETE = 1000;

export async function deleteRow(
  schema: string,
  name: string,
  pk: Record<string, string | null>,
): Promise<WriteResult> {
  const meta = await getTableMeta(schema, name);
  assertWritable(meta, schema, name);
  assertFullPk(meta, pk);

  const qualified = `${quoteIdent(schema)}.${quoteIdent(name)}`;
  const whereClause = meta.pk.map((col, i) => `${quoteIdent(col)} = $${i + 1}`).join(" AND ");
  const params = meta.pk.map((col) => pk[col] ?? null);

  await assertNoDeleteReferences(schema, name, meta, [pk]);

  return runGuardedWrite(`DELETE FROM ${qualified} WHERE ${whereClause} RETURNING *`, params);
}

/**
 * Batch delete by primary key. All deletes run in one transaction; every row
 * must match exactly one record and the total must equal the request size,
 * otherwise the whole batch is rolled back (all-or-nothing).
 */
export async function deleteRows(
  schema: string,
  name: string,
  pks: Array<Record<string, string | null>>,
): Promise<{ deleted: number }> {
  if (!Array.isArray(pks) || pks.length === 0) {
    throw new DatabaseExplorerError("未选择要删除的行。");
  }
  if (pks.length > MAX_BATCH_DELETE) {
    throw new DatabaseExplorerError(`一次最多删除 ${MAX_BATCH_DELETE} 行。`);
  }
  const meta = await getTableMeta(schema, name);
  assertWritable(meta, schema, name);
  pks.forEach((pk) => assertFullPk(meta, pk));

  const qualified = `${quoteIdent(schema)}.${quoteIdent(name)}`;
  const whereClause = meta.pk.map((col, i) => `${quoteIdent(col)} = $${i + 1}`).join(" AND ");

  await assertNoDeleteReferences(schema, name, meta, pks);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let deleted = 0;
    for (const pk of pks) {
      const params = meta.pk.map((col) => pk[col] ?? null);
      const res = await client.query(`DELETE FROM ${qualified} WHERE ${whereClause}`, params);
      if (res.rowCount !== 1) {
        await client.query("ROLLBACK");
        throw new DatabaseExplorerError(`某行预期删除 1 行，实际 ${res.rowCount} 行，已全部回滚。`);
      }
      deleted += 1;
    }
    await client.query("COMMIT");
    return { deleted };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback failure
    }
    throw wrapDbError(err);
  } finally {
    client.release();
  }
}

async function assertNoDeleteReferences(
  schema: string,
  name: string,
  meta: TableMeta,
  pks: Array<Record<string, string | null>>,
): Promise<void> {
  if (meta.pk.length !== 1) return;

  const ids = [...new Set(pks.map((pk) => pk[meta.pk[0]]).filter((id): id is string => !!id))];
  if (ids.length === 0) return;

  const refs = await getReferencingColumns(schema, name, meta.pk[0]);
  if (refs.length === 0) return;

  const blockers: ReferenceBlocker[] = [];
  for (const ref of refs) {
    const qualified = `${quoteIdent(ref.schema)}.${quoteIdent(ref.table)}`;
    const res = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM ${qualified}
       WHERE ${quoteIdent(ref.column)}::text = ANY($1::text[])`,
      [ids],
    );
    const count = Number(res.rows[0]?.count ?? 0);
    if (count > 0) blockers.push({ ...ref, count });
  }

  if (blockers.length === 0) return;

  const target = `${schema}.${name}`;
  const selected = ids.length > 1 ? `选中的 ${ids.length} 行` : "该行";
  const details = blockers
    .sort((a, b) => b.count - a.count)
    .map((b) => `${b.schema}.${b.table}.${b.column} ${b.count} 条`)
    .join("，");

  throw new DatabaseExplorerError(
    `无法删除 ${target} 的${selected}：仍有关联记录引用它（${details}）。请先把这些引用迁移到保留记录，或清理关联记录后再删除。`,
  );
}

async function getReferencingColumns(
  schema: string,
  name: string,
  pkColumn: string,
): Promise<ReferencingColumn[]> {
  const res = await pool.query<{
    schema: string;
    table: string;
    column: string;
  }>(
    `SELECT kcu.table_schema AS schema, kcu.table_name AS table, kcu.column_name AS column
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.constraint_schema = kcu.constraint_schema
     JOIN information_schema.constraint_column_usage ccu
       ON ccu.constraint_name = tc.constraint_name
      AND ccu.constraint_schema = tc.constraint_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND ccu.table_schema = $1
       AND ccu.table_name = $2
       AND ccu.column_name = $3
     ORDER BY kcu.table_schema, kcu.table_name, kcu.column_name`,
    [schema, name, pkColumn],
  );

  return res.rows;
}

/**
 * Run an UPDATE/DELETE inside a transaction and refuse to commit unless it
 * affects exactly one row — the core guardrail against accidental mass writes.
 */
async function runGuardedWrite(text: string, params: unknown[]): Promise<WriteResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(text, params);
    if (result.rowCount !== 1) {
      await client.query("ROLLBACK");
      throw new DatabaseExplorerError(`预期影响 1 行，实际 ${result.rowCount} 行，已回滚。`);
    }
    await client.query("COMMIT");
    return { row: jsonableRow(result.rows[0]) };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback failure
    }
    throw wrapDbError(err);
  } finally {
    client.release();
  }
}

function jsonableRow(row: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!row) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = toJsonable(v);
  return out;
}

function wrapDbError(err: unknown): DatabaseExplorerError {
  if (err instanceof DatabaseExplorerError) return err;
  const pgErr = err as PgError;
  if (pgErr.code === "23503") {
    const constraint = pgErr.constraint ? `（约束：${pgErr.constraint}）` : "";
    const table = pgErr.table ? `，相关表：${pgErr.table}` : "";
    const detail = pgErr.detail ? ` ${pgErr.detail}` : "";
    return new DatabaseExplorerError(
      `无法删除或修改该行：仍有其他记录通过外键引用它${constraint}${table}。请先迁移或清理关联记录后再操作。${detail}`,
    );
  }
  const message = pgErr.message?.split("\n", 1)[0] ?? String(err);
  return new DatabaseExplorerError(message);
}
