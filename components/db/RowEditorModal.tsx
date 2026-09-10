"use client";

import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { renderCell, type ColumnInfo, type TableInfo } from "@/components/db/types";

type Mode = "insert" | "edit";

interface Field {
  value: string;
  isNull: boolean;
}

interface Props {
  table: TableInfo;
  columns: ColumnInfo[];
  primaryKey: string[];
  mode: Mode;
  /** column name → current value, required for edit (prefill + pk). */
  initialValues?: Record<string, unknown>;
  onClose: () => void;
  onSuccess: () => void;
}

const LONG_TEXT_TYPES = ["text", "json", "jsonb"];

function initField(col: ColumnInfo, mode: Mode, initial: Record<string, unknown> | undefined): Field {
  if (mode === "edit" && initial) {
    const v = initial[col.name];
    if (v === null || v === undefined) return { value: "", isNull: true };
    return { value: renderCell(v), isNull: false };
  }
  return { value: "", isNull: false };
}

export function RowEditorModal({
  table,
  columns,
  primaryKey,
  mode,
  initialValues,
  onClose,
  onSuccess,
}: Props) {
  const pkSet = useMemo(() => new Set(primaryKey), [primaryKey]);
  const [fields, setFields] = useState<Record<string, Field>>(() => {
    const init: Record<string, Field> = {};
    for (const col of columns) init[col.name] = initField(col, mode, initialValues);
    return init;
  });

  const setField = (name: string, patch: Partial<Field>) =>
    setFields((prev) => ({ ...prev, [name]: { ...prev[name], ...patch } }));

  const mutation = useMutation({
    mutationFn: async () => {
      // Build the values payload.
      const values: Record<string, string | null> = {};
      for (const col of columns) {
        if (mode === "edit" && pkSet.has(col.name)) continue; // PK is immutable here
        const f = fields[col.name];
        if (f.isNull) {
          values[col.name] = null;
        } else if (mode === "insert" && f.value === "") {
          // leave to default
        } else {
          values[col.name] = f.value;
        }
      }

      const base = { schema: table.schema, name: table.name };
      if (mode === "insert") {
        const res = await fetch("/api/db/row", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...base, values }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `请求失败 (${res.status})`);
        return body;
      }

      // edit → PATCH with full PK
      const pk: Record<string, string | null> = {};
      for (const col of primaryKey) {
        const v = initialValues?.[col];
        pk[col] = v === null || v === undefined ? null : renderCell(v);
      }
      const res = await fetch("/api/db/row", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...base, pk, values }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `请求失败 (${res.status})`);
      return body;
    },
    onSuccess,
  });

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-[var(--color-modal-backdrop)] p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[86vh] w-[640px] max-w-full flex-col overflow-hidden rounded-lg border border-[var(--color-panel-border)] bg-[var(--color-modal-bg)] shadow-[var(--color-card-shadow)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="absolute inset-x-0 top-0 h-1 bg-[image:var(--color-theme-strip)]" aria-hidden />
        <div className="flex items-center justify-between border-b border-[var(--color-panel-border)] px-4 py-3">
          <div className="font-mono text-[13px] font-semibold text-[var(--color-text)]">
            {mode === "insert" ? "新增行" : "编辑行"} · {table.schema}.{table.name}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-control-hover)]"
            aria-label="关闭"
          >
            <X size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="space-y-3">
            {columns.map((col) => {
              const f = fields[col.name];
              const isPkEditLocked = mode === "edit" && pkSet.has(col.name);
              const long = LONG_TEXT_TYPES.some((t) => col.dataType.toLowerCase().includes(t));
              return (
                <div key={col.name} className="grid grid-cols-[180px_1fr] items-start gap-3">
                  <div className="pt-1.5">
                    <div className="flex items-center gap-1 font-mono-tiny text-[12px] text-[var(--color-text)]">
                      {col.name}
                      {col.isPrimaryKey && (
                        <span className="rounded bg-[var(--color-accent-bg)] px-1 text-[9px] text-[var(--color-accent)]">
                          PK
                        </span>
                      )}
                      {!col.nullable && <span className="text-[var(--color-danger)]">*</span>}
                    </div>
                    <div className="font-mono-tiny text-[10px] text-[var(--color-text-muted)]">
                      {col.dataType}
                    </div>
                  </div>

                  <div className="flex items-start gap-2">
                    {long ? (
                      <textarea
                        value={f.isNull ? "" : f.value}
                        disabled={f.isNull || isPkEditLocked}
                        onChange={(e) => setField(col.name, { value: e.target.value })}
                        rows={2}
                        spellCheck={false}
                        placeholder={
                          isPkEditLocked
                            ? "主键不可修改"
                            : mode === "insert" && col.default
                              ? "留空 = 默认值"
                              : ""
                        }
                        className="min-h-[34px] w-full resize-y rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] px-2 py-1.5 font-mono-tiny text-[12px] text-[var(--color-text)] disabled:opacity-50 focus:border-[var(--color-card-hover-border)] focus:outline-none focus:ring-2 focus:ring-[var(--color-selected-ring)]"
                      />
                    ) : (
                      <input
                        value={f.isNull ? "" : f.value}
                        disabled={f.isNull || isPkEditLocked}
                        onChange={(e) => setField(col.name, { value: e.target.value })}
                        placeholder={
                          isPkEditLocked
                            ? "主键不可修改"
                            : mode === "insert" && col.default
                              ? "留空 = 默认值"
                              : ""
                        }
                        className="h-[34px] w-full rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] px-2 font-mono-tiny text-[12px] text-[var(--color-text)] disabled:opacity-50 focus:border-[var(--color-card-hover-border)] focus:outline-none focus:ring-2 focus:ring-[var(--color-selected-ring)]"
                      />
                    )}
                    {col.nullable && !isPkEditLocked && (
                      <button
                        type="button"
                        onClick={() => setField(col.name, { isNull: !f.isNull })}
                        className={cn(
                          "h-[34px] shrink-0 rounded-md border px-2 font-mono-tiny text-[11px] transition-colors",
                          f.isNull
                            ? "border-[var(--color-accent-border)] bg-[var(--color-accent-bg)] text-[var(--color-accent)]"
                            : "border-[var(--color-control-border)] bg-[var(--color-control-bg)] text-[var(--color-text-muted)] hover:bg-[var(--color-control-hover)]",
                        )}
                        title="设为 NULL"
                      >
                        NULL
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {mutation.isError && (
          <div className="mx-4 mb-2 flex items-start gap-2 rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-3 py-2 text-[12px] text-[var(--color-danger)]">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span className="font-mono-tiny">{(mutation.error as Error).message}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-[var(--color-panel-border)] px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] px-3 text-[12px] text-[var(--color-text-dim)] hover:bg-[var(--color-control-hover)]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            className="h-8 rounded-md bg-[var(--color-panel-accent)] px-3 text-[12px] font-medium text-white shadow-sm ring-1 ring-[var(--color-accent-border)]/70 disabled:opacity-50 hover:opacity-90"
          >
            {mutation.isPending ? "保存中…" : mode === "insert" ? "插入" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
