"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Play } from "lucide-react";
import { ResultGrid } from "@/components/db/ResultGrid";
import { formatCount, type QueryResult } from "@/components/db/types";

const MAX_ROWS_OPTIONS = [100, 200, 500, 1000, 5000];

async function runQuery(payload: { sql: string; maxRows: number }): Promise<QueryResult> {
  const res = await fetch("/api/db/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `请求失败 (${res.status})`);
  return body as QueryResult;
}

export function SqlRunner() {
  const [sql, setSql] = useState("SELECT * FROM schools LIMIT 50;");
  const [maxRows, setMaxRows] = useState(200);

  const mutation = useMutation({ mutationFn: runQuery });
  const result = mutation.data;

  const submit = () => {
    if (!sql.trim() || mutation.isPending) return;
    mutation.mutate({ sql, maxRows });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Editor */}
      <div className="shrink-0 border-b border-[var(--color-panel-border)] p-3">
        <textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          spellCheck={false}
          rows={6}
          placeholder="只读查询：SELECT / WITH / EXPLAIN / SHOW …"
          className="w-full resize-y rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] p-3 font-mono-tiny text-[13px] leading-relaxed text-[var(--color-text)] focus:border-[var(--color-card-hover-border)] focus:outline-none focus:ring-2 focus:ring-[var(--color-selected-ring)]"
        />
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={submit}
            disabled={mutation.isPending || !sql.trim()}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--color-panel-accent)] px-3 text-[12px] font-medium text-white shadow-sm ring-1 ring-[var(--color-accent-border)]/70 disabled:opacity-50 hover:opacity-90"
          >
            <Play size={13} />
            {mutation.isPending ? "运行中…" : "运行"}
            <kbd className="ml-1 rounded bg-white/20 px-1 py-0.5 font-mono-tiny text-[10px]">⌘↵</kbd>
          </button>

          <label className="flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)]">
            最多
            <select
              value={maxRows}
              onChange={(e) => setMaxRows(Number(e.target.value))}
              className="rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] px-1.5 py-1 text-[12px] text-[var(--color-text)] focus:outline-none"
            >
              {MAX_ROWS_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n} 行
                </option>
              ))}
            </select>
          </label>

          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]">
            <AlertTriangle size={12} />
            只读模式 · 仅允许查询语句
          </span>
        </div>
      </div>

      {/* Result / error */}
      {mutation.isError && (
        <div className="m-3 flex items-start gap-2 rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-3 py-2 text-[12px] text-[var(--color-danger)]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="font-mono-tiny">{(mutation.error as Error).message}</span>
        </div>
      )}

      {result && (
        <div className="flex items-center gap-3 border-b border-[var(--color-panel-border)] px-3 py-1.5 text-[11px] text-[var(--color-text-muted)]">
          <span>{formatCount(result.rowCount)} 行</span>
          <span>·</span>
          <span>{result.durationMs} ms</span>
          {result.truncated && (
            <span className="rounded bg-[var(--color-warning)]/15 px-1.5 py-0.5 text-[var(--color-warning)]">
              已截断到上限
            </span>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1">
        <ResultGrid
          columns={result?.columns ?? []}
          rows={result?.rows ?? []}
          emptyHint={mutation.isPending ? "运行中…" : "运行一条查询查看结果"}
        />
      </div>
    </div>
  );
}
