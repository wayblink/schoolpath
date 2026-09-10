"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  KeyRound,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ResultGrid } from "@/components/db/ResultGrid";
import { RowEditorModal } from "@/components/db/RowEditorModal";
import {
  formatCount,
  renderCell,
  type RowPage,
  type TableDetail,
  type TableInfo,
} from "@/components/db/types";

const PAGE_SIZE = 50;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `请求失败 (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export function TableDataView({ table }: { table: TableInfo }) {
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [orderBy, setOrderBy] = useState<string | null>(null);
  const [orderDir, setOrderDir] = useState<"asc" | "desc">("asc");
  const [schemaCollapsed, setSchemaCollapsed] = useState(false);
  // Per-column filters: `columnFilters` is the live input value; `appliedFilters`
  // is the debounced copy actually sent to the API.
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [appliedFilters, setAppliedFilters] = useState<Record<string, string>>({});
  const [editor, setEditor] = useState<{ mode: "insert" | "edit"; values?: Record<string, unknown> } | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<Record<string, unknown> | null>(null);
  // Multi-select: keys are the JSON of a row's PK values; `selectedRecords`
  // keeps the full record so a batch delete can run even across pages.
  const [selectedRecords, setSelectedRecords] = useState<Map<string, Record<string, unknown>>>(
    new Map(),
  );
  const [batchConfirm, setBatchConfirm] = useState(false);

  const queryClient = useQueryClient();

  // View state resets when `table` changes because the parent remounts this
  // component via a `key` on schema.name.

  // Debounce live column-filter edits into appliedFilters (350ms).
  useEffect(() => {
    const timer = setTimeout(() => {
      setAppliedFilters(columnFilters);
      setPage(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [columnFilters]);

  // Only non-empty filters are sent; stable string for the query key.
  const activeFilters: Record<string, string> = {};
  for (const [col, val] of Object.entries(appliedFilters)) {
    if (val.trim()) activeFilters[col] = val.trim();
  }
  const filtersKey = JSON.stringify(activeFilters);

  const detailQuery = useQuery({
    queryKey: ["db-table", table.schema, table.name],
    queryFn: () =>
      fetchJson<TableDetail>(
        `/api/db/table?schema=${encodeURIComponent(table.schema)}&name=${encodeURIComponent(table.name)}`,
      ),
  });

  const rowsQuery = useQuery({
    queryKey: ["db-rows", table.schema, table.name, page, search, orderBy, orderDir, filtersKey],
    placeholderData: keepPreviousData,
    queryFn: () => {
      const params = new URLSearchParams({
        schema: table.schema,
        name: table.name,
        page: String(page),
        pageSize: String(PAGE_SIZE),
      });
      if (search) params.set("search", search);
      if (orderBy) {
        params.set("orderBy", orderBy);
        params.set("orderDir", orderDir);
      }
      if (Object.keys(activeFilters).length > 0) params.set("filters", filtersKey);
      return fetchJson<RowPage>(`/api/db/rows?${params.toString()}`);
    },
  });

  const detail = detailQuery.data;
  const rowPage = rowsQuery.data;

  const canWrite = table.kind === "table" && table.schema !== "ingest" && table.schema !== "catalog";
  const hasPk = (detail?.primaryKey.length ?? 0) > 0;
  const canEditRows = canWrite && hasPk;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["db-rows", table.schema, table.name] });
    queryClient.invalidateQueries({ queryKey: ["db-tables"] });
  };

  // Map a grid row (array aligned to rowPage.columns) into a column→value record.
  const rowToRecord = (row: unknown[]): Record<string, unknown> => {
    const cols = rowPage?.columns ?? [];
    const rec: Record<string, unknown> = {};
    cols.forEach((c, i) => {
      rec[c] = row[i];
    });
    return rec;
  };

  const pkSummary = (record: Record<string, unknown> | null): string => {
    if (!record || !detail) return "";
    return detail.primaryKey.map((c) => `${c}=${renderCell(record[c])}`).join(", ");
  };

  // Stable key for a record from its primary-key values.
  const recordKey = (record: Record<string, unknown>): string =>
    JSON.stringify((detail?.primaryKey ?? []).map((c) => renderCell(record[c])));

  const buildPk = (record: Record<string, unknown>): Record<string, string | null> => {
    const pk: Record<string, string | null> = {};
    for (const c of detail?.primaryKey ?? []) {
      const v = record[c];
      pk[c] = v === null || v === undefined ? null : renderCell(v);
    }
    return pk;
  };

  // Inline single-cell edit: PATCH only the changed column, keyed by PK.
  const handleCellEdit = async (row: unknown[], column: string, newValue: string) => {
    const pk = buildPk(rowToRecord(row));
    const res = await fetch("/api/db/row", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schema: table.schema, name: table.name, pk, values: { [column]: newValue } }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `请求失败 (${res.status})`);
    invalidate();
  };

  const toggleRow = (key: string, row: unknown[]) => {
    setSelectedRecords((prev) => {
      const next = new Map(prev);
      if (next.has(key)) next.delete(key);
      else next.set(key, rowToRecord(row));
      return next;
    });
  };

  const toggleAll = (select: boolean) => {
    setSelectedRecords((prev) => {
      const next = new Map(prev);
      for (const row of rowPage?.rows ?? []) {
        const rec = rowToRecord(row);
        const key = recordKey(rec);
        if (select) next.set(key, rec);
        else next.delete(key);
      }
      return next;
    });
  };

  const deleteMutation = useMutation({
    mutationFn: async (record: Record<string, unknown>) => {
      const res = await fetch("/api/db/row", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schema: table.schema, name: table.name, pk: buildPk(record) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `请求失败 (${res.status})`);
    },
    onSuccess: () => {
      setDeleteTarget(null);
      invalidate();
    },
  });

  const batchDeleteMutation = useMutation({
    mutationFn: async () => {
      const pks = [...selectedRecords.values()].map(buildPk);
      const res = await fetch("/api/db/row", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schema: table.schema, name: table.name, pks }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `请求失败 (${res.status})`);
      return body as { deleted: number };
    },
    onSuccess: () => {
      setBatchConfirm(false);
      setSelectedRecords(new Map());
      invalidate();
    },
  });

  const handleSort = (column: string) => {
    if (orderBy === column) {
      setOrderDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setOrderBy(column);
      setOrderDir("asc");
    }
    setPage(1);
  };

  const submitSearch = () => {
    setSearch(searchInput.trim());
    setPage(1);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Title */}
      <div className="flex items-center gap-2 border-b border-[var(--color-panel-border)] px-4 py-2.5">
        <span className="font-mono text-[14px] font-semibold text-[var(--color-text)]">
          {table.schema}.{table.name}
        </span>
        <span className="rounded border border-[var(--color-control-border)] bg-[var(--color-chip-bg)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
          {table.kind}
        </span>
        {table.comment && (
          <span className="truncate text-[12px] text-[var(--color-text-muted)]">{table.comment}</span>
        )}
        <button
          type="button"
          onClick={() => setSchemaCollapsed((v) => !v)}
          className="ml-auto inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] px-2 text-[11px] text-[var(--color-text-dim)] hover:bg-[var(--color-control-hover)]"
          title={schemaCollapsed ? "展开表结构" : "收起表结构"}
          aria-expanded={!schemaCollapsed}
        >
          {schemaCollapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
          表结构
        </button>
      </div>

      {/* Schema card */}
      {!schemaCollapsed && (
        <div className="max-h-[34%] shrink-0 overflow-auto border-b border-[var(--color-panel-border)] bg-[var(--color-detail-bg)] p-3">
        {detailQuery.isError ? (
          <div className="text-[12px] text-[var(--color-danger)]">
            {(detailQuery.error as Error).message}
          </div>
        ) : !detail ? (
          <div className="text-[12px] text-[var(--color-text-muted)]">加载表结构…</div>
        ) : (
          <div className="space-y-3">
            <div className="overflow-hidden rounded-md border border-[var(--color-card-border)] bg-[var(--color-detail-card-bg)]">
              <table className="w-full border-collapse text-[12px]">
                <thead className="bg-[var(--color-section-label-bg)] text-[var(--color-text-muted)]">
                  <tr>
                    <th className="px-2.5 py-1 text-left font-medium">列</th>
                    <th className="px-2.5 py-1 text-left font-medium">类型</th>
                    <th className="px-2.5 py-1 text-left font-medium">可空</th>
                    <th className="px-2.5 py-1 text-left font-medium">默认</th>
                    <th className="px-2.5 py-1 text-left font-medium">注释</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.columns.map((col) => (
                    <tr key={col.name} className="border-t border-[var(--color-panel-border)]/50">
                      <td className="px-2.5 py-1 font-mono-tiny text-[var(--color-text)]">
                        <span className="inline-flex items-center gap-1">
                          {col.isPrimaryKey && (
                            <KeyRound size={11} className="text-[var(--color-accent)]" />
                          )}
                          {col.name}
                        </span>
                      </td>
                      <td className="px-2.5 py-1 font-mono-tiny text-[var(--color-text-dim)]">
                        {col.dataType}
                      </td>
                      <td className="px-2.5 py-1 text-[var(--color-text-muted)]">
                        {col.nullable ? "✓" : "—"}
                      </td>
                      <td className="px-2.5 py-1 font-mono-tiny text-[var(--color-text-muted)]">
                        {col.default ?? ""}
                      </td>
                      <td className="px-2.5 py-1 text-[var(--color-text-muted)]">{col.comment}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {detail.indexes.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {detail.indexes.map((idx) => (
                  <span
                    key={idx.name}
                    className="inline-flex items-center gap-1 rounded border border-[var(--color-control-border)] bg-[var(--color-chip-bg)] px-2 py-0.5 text-[10px] text-[var(--color-text-muted)]"
                    title={`${idx.name} (${idx.columns.join(", ")})`}
                  >
                    {idx.isPrimary ? "PK" : idx.isUnique ? "UNIQUE" : "INDEX"}
                    <span className="font-mono-tiny text-[var(--color-text-dim)]">
                      {idx.columns.join(", ")}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      )}

      {/* Row browser toolbar */}
      <div className="flex items-center gap-2 border-b border-[var(--color-panel-border)] px-3 py-2">
        <div className="relative">
          <Search
            size={13}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
          />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitSearch()}
            placeholder="搜索文本列…"
            className="h-7 w-56 rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] pl-7 pr-2 text-[12px] text-[var(--color-text)] focus:border-[var(--color-card-hover-border)] focus:outline-none focus:ring-2 focus:ring-[var(--color-selected-ring)]"
          />
        </div>
        <button
          type="button"
          onClick={submitSearch}
          className="h-7 rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] px-2.5 text-[12px] text-[var(--color-text-dim)] hover:bg-[var(--color-control-hover)]"
        >
          搜索
        </button>

        {canWrite && (
          <button
            type="button"
            onClick={() => setEditor({ mode: "insert" })}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-[var(--color-panel-accent)] px-2.5 text-[12px] font-medium text-white shadow-sm ring-1 ring-[var(--color-accent-border)]/70 hover:opacity-90"
          >
            <Plus size={13} />
            新增行
          </button>
        )}
        {canEditRows && selectedRecords.size > 0 && (
          <button
            type="button"
            onClick={() => setBatchConfirm(true)}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-[var(--color-danger)] px-2.5 text-[12px] font-medium text-white shadow-sm hover:opacity-90"
          >
            <Trash2 size={13} />
            批量删除 ({selectedRecords.size})
          </button>
        )}
        {!canEditRows && (
          <span className="text-[11px] text-[var(--color-text-muted)]">
            {table.kind !== "table" ? "视图不可写" : !canWrite ? "来源档案，只读" : "无主键，不可逐行增删改"}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2 text-[12px] text-[var(--color-text-muted)]">
          {Object.keys(activeFilters).length > 0 && (
            <button
              type="button"
              onClick={() => setColumnFilters({})}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] px-2 text-[11px] text-[var(--color-text-dim)] hover:bg-[var(--color-control-hover)]"
              title="清除所有列筛选"
            >
              <X size={12} />
              清除筛选 ({Object.keys(activeFilters).length})
            </button>
          )}
          <span>
            共 {rowPage ? formatCount(rowPage.totalRows) : "…"} 行
            {rowsQuery.isFetching && <span className="ml-1 opacity-60">· 加载中</span>}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="grid h-7 w-7 place-items-center rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] disabled:opacity-40 hover:bg-[var(--color-control-hover)]"
              aria-label="上一页"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="min-w-[64px] text-center font-mono-tiny">
              {page} / {rowPage ? Math.max(1, rowPage.totalPages) : 1}
            </span>
            <button
              type="button"
              disabled={!rowPage || page >= rowPage.totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="grid h-7 w-7 place-items-center rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] disabled:opacity-40 hover:bg-[var(--color-control-hover)]"
              aria-label="下一页"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Rows */}
      <div className={cn("min-h-0 flex-1", rowsQuery.isError && "grid place-items-center")}>
        {rowsQuery.isError ? (
          <div className="px-4 text-[13px] text-[var(--color-danger)]">
            {(rowsQuery.error as Error).message}
          </div>
        ) : (
          <ResultGrid
            columns={rowPage?.columns ?? []}
            rows={rowPage?.rows ?? []}
            orderBy={orderBy}
            orderDir={orderDir}
            onSort={handleSort}
            pkColumns={detail?.primaryKey}
            emptyHint={rowsQuery.isLoading ? "加载中…" : "无数据"}
            columnFilters={columnFilters}
            onColumnFilterChange={(col, value) =>
              setColumnFilters((prev) => ({ ...prev, [col]: value }))
            }
            rowKey={canEditRows ? (row) => recordKey(rowToRecord(row)) : undefined}
            selectedKeys={canEditRows ? new Set(selectedRecords.keys()) : undefined}
            onToggleRow={canEditRows ? toggleRow : undefined}
            onToggleAll={canEditRows ? toggleAll : undefined}
            editableColumns={
              canEditRows && rowPage
                ? new Set(rowPage.columns.filter((c) => !(detail?.primaryKey ?? []).includes(c)))
                : undefined
            }
            onCellEdit={canEditRows ? handleCellEdit : undefined}
            renderRowActions={
              canEditRows
                ? (row) => {
                    const record = rowToRecord(row);
                    return (
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setEditor({ mode: "edit", values: record })}
                          className="grid h-6 w-6 place-items-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-control-hover)] hover:text-[var(--color-text)]"
                          title="编辑"
                          aria-label="编辑"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(record)}
                          className="grid h-6 w-6 place-items-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-danger)]/15 hover:text-[var(--color-danger)]"
                          title="删除"
                          aria-label="删除"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    );
                  }
                : undefined
            }
          />
        )}
      </div>

      {editor && detail && (
        <RowEditorModal
          table={table}
          columns={detail.columns}
          primaryKey={detail.primaryKey}
          mode={editor.mode}
          initialValues={editor.values}
          onClose={() => setEditor(null)}
          onSuccess={() => {
            setEditor(null);
            invalidate();
          }}
        />
      )}

      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-[var(--color-modal-backdrop)] p-6"
          onClick={() => !deleteMutation.isPending && setDeleteTarget(null)}
        >
          <div
            className="w-[420px] max-w-full overflow-hidden rounded-lg border border-[var(--color-panel-border)] bg-[var(--color-modal-bg)] p-4 shadow-[var(--color-card-shadow)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 text-[14px] font-semibold text-[var(--color-text)]">
              <Trash2 size={16} className="text-[var(--color-danger)]" />
              删除这一行？
            </div>
            <p className="mt-2 text-[12px] text-[var(--color-text-muted)]">
              将从 <span className="font-mono-tiny text-[var(--color-text)]">{table.schema}.{table.name}</span>{" "}
              永久删除主键为
            </p>
            <p className="mt-1 break-all rounded bg-[var(--color-section-label-bg)] px-2 py-1 font-mono-tiny text-[12px] text-[var(--color-text)]">
              {pkSummary(deleteTarget)}
            </p>
            <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">的记录，此操作不可撤销。</p>

            {deleteMutation.isError && (
              <div className="mt-2 rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-2.5 py-1.5 font-mono-tiny text-[12px] text-[var(--color-danger)]">
                {(deleteMutation.error as Error).message}
              </div>
            )}

            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={deleteMutation.isPending}
                className="h-8 rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] px-3 text-[12px] text-[var(--color-text-dim)] hover:bg-[var(--color-control-hover)]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => deleteMutation.mutate(deleteTarget)}
                disabled={deleteMutation.isPending}
                className="h-8 rounded-md bg-[var(--color-danger)] px-3 text-[12px] font-medium text-white shadow-sm disabled:opacity-50 hover:opacity-90"
              >
                {deleteMutation.isPending ? "删除中…" : "确认删除"}
              </button>
            </div>
          </div>
        </div>
      )}

      {batchConfirm && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-[var(--color-modal-backdrop)] p-6"
          onClick={() => !batchDeleteMutation.isPending && setBatchConfirm(false)}
        >
          <div
            className="w-[440px] max-w-full overflow-hidden rounded-lg border border-[var(--color-panel-border)] bg-[var(--color-modal-bg)] p-4 shadow-[var(--color-card-shadow)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 text-[14px] font-semibold text-[var(--color-text)]">
              <Trash2 size={16} className="text-[var(--color-danger)]" />
              批量删除 {selectedRecords.size} 行？
            </div>
            <p className="mt-2 text-[12px] text-[var(--color-text-muted)]">
              将从 <span className="font-mono-tiny text-[var(--color-text)]">{table.schema}.{table.name}</span>{" "}
              永久删除选中的 {selectedRecords.size} 条记录（按主键，单事务全删或全不删），此操作不可撤销。
            </p>
            <div className="mt-2 max-h-[160px] overflow-auto rounded bg-[var(--color-section-label-bg)] px-2 py-1">
              {[...selectedRecords.values()].slice(0, 50).map((rec, i) => (
                <div key={i} className="break-all font-mono-tiny text-[11px] text-[var(--color-text-dim)]">
                  {pkSummary(rec)}
                </div>
              ))}
              {selectedRecords.size > 50 && (
                <div className="font-mono-tiny text-[11px] text-[var(--color-text-muted)]">
                  …及其余 {selectedRecords.size - 50} 条
                </div>
              )}
            </div>

            {batchDeleteMutation.isError && (
              <div className="mt-2 rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-2.5 py-1.5 font-mono-tiny text-[12px] text-[var(--color-danger)]">
                {(batchDeleteMutation.error as Error).message}
              </div>
            )}

            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setBatchConfirm(false)}
                disabled={batchDeleteMutation.isPending}
                className="h-8 rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] px-3 text-[12px] text-[var(--color-text-dim)] hover:bg-[var(--color-control-hover)]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => batchDeleteMutation.mutate()}
                disabled={batchDeleteMutation.isPending}
                className="h-8 rounded-md bg-[var(--color-danger)] px-3 text-[12px] font-medium text-white shadow-sm disabled:opacity-50 hover:opacity-90"
              >
                {batchDeleteMutation.isPending ? "删除中…" : `确认删除 ${selectedRecords.size} 行`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
