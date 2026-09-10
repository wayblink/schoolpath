"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Database, MapPin, Search, Table2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { SchoolLocationBackfillPanel } from "@/components/admin/SchoolLocationBackfillPanel";
import { TableDataView } from "@/components/db/TableDataView";
import { SqlRunner } from "@/components/db/SqlRunner";
import { formatBytes, formatCount, type DatabaseInfo, type TableInfo } from "@/components/db/types";
import { ProductShell } from "@/components/product/ProductShell";

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `请求失败 (${res.status})`);
  }
  return res.json() as Promise<T>;
}

type Tab = "data" | "sql" | "maintenance";

export default function DbConsolePage() {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<TableInfo | null>(null);
  const [tab, setTab] = useState<Tab>("data");

  const infoQuery = useQuery({
    queryKey: ["db-info"],
    queryFn: () => fetchJson<DatabaseInfo>("/api/db/info"),
  });

  const tablesQuery = useQuery({
    queryKey: ["db-tables"],
    queryFn: () => fetchJson<TableInfo[]>("/api/db/tables"),
  });

  // Group tables by schema, applying the name filter.
  const grouped = useMemo(() => {
    const tables = tablesQuery.data ?? [];
    const needle = filter.trim().toLowerCase();
    const map = new Map<string, TableInfo[]>();
    for (const t of tables) {
      if (needle && !t.name.toLowerCase().includes(needle)) continue;
      const list = map.get(t.schema) ?? [];
      list.push(t);
      map.set(t.schema, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [tablesQuery.data, filter]);

  return (
    <ProductShell active="/db"><main className="flex h-[calc(100vh-68px)] min-h-0 flex-col bg-[var(--color-bg)]">
      <div className="absolute inset-x-0 top-0 h-1 bg-[image:var(--color-theme-strip)]" aria-hidden />

      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--color-panel-border)] bg-[var(--color-header-bg)] px-4">
        <Link
          href="/"
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] px-2.5 text-[12px] text-[var(--color-text-dim)] hover:bg-[var(--color-control-hover)]"
        >
          <ArrowLeft size={14} />
          返回
        </Link>
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-md bg-[var(--color-panel-accent)] text-white ring-1 ring-[var(--color-accent-border)]/70">
            <Database size={16} />
          </div>
          <div className="leading-none">
            <div className="text-[15px] font-semibold text-[var(--color-text)]">数据库控制台</div>
            <div className="mt-1 font-mono-tiny text-[10px] text-[var(--color-text-muted)]">
              {infoQuery.data ? infoQuery.data.version : "连接中…"}
            </div>
          </div>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)]">
        {/* Sidebar */}
        <aside className="flex min-h-0 flex-col border-r border-[var(--color-panel-border)] bg-[var(--color-panel-bg)]">
          <div className="border-b border-[var(--color-panel-border)] p-2.5">
            <div className="relative">
              <Search
                size={13}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
              />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="筛选表名…"
                className="h-8 w-full rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] pl-8 pr-2 text-[12px] text-[var(--color-text)] focus:border-[var(--color-card-hover-border)] focus:outline-none focus:ring-2 focus:ring-[var(--color-selected-ring)]"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-2">
            {tablesQuery.isError ? (
              <div className="px-2 py-3 text-[12px] text-[var(--color-danger)]">
                {(tablesQuery.error as Error).message}
              </div>
            ) : tablesQuery.isLoading ? (
              <div className="px-2 py-3 text-[12px] text-[var(--color-text-muted)]">加载表列表…</div>
            ) : grouped.length === 0 ? (
              <div className="px-2 py-3 text-[12px] text-[var(--color-text-muted)]">无匹配的表</div>
            ) : (
              grouped.map(([schema, tables]) => (
                <div key={schema} className="mb-3">
                  <div className="px-2 pb-1 pt-1 text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">
                    {schema}
                  </div>
                  <div className="space-y-0.5">
                    {tables.map((t) => {
                      const active = selected?.schema === t.schema && selected?.name === t.name;
                      return (
                        <button
                          key={`${t.schema}.${t.name}`}
                          type="button"
                          onClick={() => {
                            setSelected(t);
                            setTab("data");
                          }}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors",
                            active
                              ? "bg-[var(--color-list-row-selected)] text-[var(--color-text)] ring-1 ring-[var(--color-selected-ring)]"
                              : "text-[var(--color-text-dim)] hover:bg-[var(--color-list-row-hover)]",
                          )}
                        >
                          <Table2
                            size={13}
                            className={cn(
                              "shrink-0",
                              t.kind === "table"
                                ? "text-[var(--color-text-muted)]"
                                : "text-[var(--color-accent)]",
                            )}
                          />
                          <span className="min-w-0 flex-1 truncate font-mono-tiny">{t.name}</span>
                          <span className="shrink-0 font-mono-tiny text-[10px] text-[var(--color-text-muted)]">
                            {formatCount(t.rowCount)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>

          {tablesQuery.data && (
            <div className="border-t border-[var(--color-panel-border)] px-3 py-2 font-mono-tiny text-[10px] text-[var(--color-text-muted)]">
              {tablesQuery.data.length} 个对象
              {selected?.sizeBytes != null && ` · ${selected.name} ${formatBytes(selected.sizeBytes)}`}
            </div>
          )}
        </aside>

        {/* Main */}
        <section className="flex min-h-0 flex-col">
          {/* Tabs */}
          <div className="flex shrink-0 items-center gap-1 border-b border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] px-3 py-1.5">
            <TabButton active={tab === "data"} onClick={() => setTab("data")} disabled={!selected}>
              数据
            </TabButton>
            <TabButton active={tab === "sql"} onClick={() => setTab("sql")}>
              SQL 查询
            </TabButton>
            <TabButton active={tab === "maintenance"} onClick={() => setTab("maintenance")}>
              <span className="inline-flex items-center gap-1.5">
                <MapPin size={13} />
                数据维护
              </span>
            </TabButton>
          </div>

          <div className="min-h-0 flex-1">
            {tab === "maintenance" ? (
              <SchoolLocationBackfillPanel />
            ) : tab === "sql" ? (
              <SqlRunner />
            ) : selected ? (
              <TableDataView key={`${selected.schema}.${selected.name}`} table={selected} />
            ) : (
              <div className="grid h-full place-items-center px-6 text-center text-[13px] text-[var(--color-text-muted)]">
                <div>
                  <Database size={28} className="mx-auto mb-3 opacity-40" />
                  从左侧选择一张表查看结构与数据，或切到「SQL 查询」运行只读查询。
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </main></ProductShell>
  );
}

function TabButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded-md px-3 py-1 text-[12px] transition-colors disabled:opacity-40",
        active
          ? "bg-[var(--color-control-active)] text-[var(--color-accent)] shadow-sm"
          : "text-[var(--color-text-dim)] hover:bg-[var(--color-control-hover)] hover:text-[var(--color-text)]",
      )}
    >
      {children}
    </button>
  );
}
