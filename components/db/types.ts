// Client-side mirror of the shapes returned by /api/db/* routes.
// Kept separate from lib/db/explorer.ts so client components never pull in the
// server-only `pg` pool module.

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

export function formatBytes(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

export function renderCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
