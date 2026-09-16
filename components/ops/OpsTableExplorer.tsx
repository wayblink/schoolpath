"use client";
import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";

type ColumnMeta = {
  name: string;
  dataType: string;
  isNullable: boolean;
  hasDefault: boolean;
  fk?: { table: string; column: string; label: string };
};

type Row = Record<string, unknown>;

const PAGE_SIZE = 30;
const EDITABLE_SKIP = new Set(["id", "created_at", "updated_at"]);

function formatValue(col: ColumnMeta, value: unknown, fkName: unknown): string {
  if (value === null || value === undefined) return "—";
  if (col.fk) return fkName ? `${value}（${fkName}）` : String(value);
  if (typeof value === "object") {
    const text = JSON.stringify(value);
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  }
  const text = String(value);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/** 单表浏览器：查看/新增/更新/删除。 */
export function OpsTableExplorer({ table, label }: { table: string; label: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [columns, setColumns] = useState<ColumnMeta[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState<{ mode: "create" } | { mode: "edit"; row: Row } | null>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (query) params.set("q", query);
    fetch(`/api/v2/ops/tables/${table}?${params}`)
      .then((r) => r.json())
      .then((d) => {
        setRows(d.rows ?? []);
        setColumns(d.columns ?? []);
        setTotal(d.total ?? 0);
      })
      .catch(() => setMessage("加载失败"))
      .finally(() => setLoading(false));
  }, [table, page, query]);

  useEffect(() => { void load(); }, [load]);

  async function remove(id: number) {
    if (!confirm(`确认删除 ${label} #${id}？`)) return;
    setMessage("");
    const res = await fetch(`/api/v2/ops/tables/${table}/${id}`, { method: "DELETE" });
    const body = await res.json();
    if (!res.ok) setMessage(body.error ?? "删除失败");
    else { setMessage(`#${id} 已删除`); load(); }
  }

  const editableColumns = columns.filter((c) => !EDITABLE_SKIP.has(c.name));
  const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section className="ops-table-explorer">
      <div className="ops-table-toolbar">
        <form onSubmit={(e) => { e.preventDefault(); setLoading(true); setPage(1); setQuery(q); }}>
          <label>
            <Search size={14} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索文本列…" />
          </label>
          <button type="submit">搜索</button>
        </form>
        <div className="ops-table-toolbar-actions">
          <button type="button" onClick={() => setEditing({ mode: "create" })}>
            <Plus size={13} /> 新增
          </button>
          <button type="button" onClick={() => { setLoading(true); load(); }} title="刷新">
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {message && <div className="ops-message">{message}</div>}

      {loading ? (
        <div className="empty-state">正在加载…</div>
      ) : rows.length === 0 ? (
        <div className="empty-state">暂无数据{query ? "（尝试调整搜索词）" : ""}。</div>
      ) : (
        <div className="ops-table-scroll">
          <table className="ops-table">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.name}>{c.name}{c.fk ? `（${c.fk.label}）` : ""}</th>
                ))}
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={String(row.id)}>
                  {columns.map((c) => (
                    <td key={c.name} title={formatValue(c, row[c.name], row[`__fk_${c.name}`])}>
                      {formatValue(c, row[c.name], row[`__fk_${c.name}`])}
                    </td>
                  ))}
                  <td className="ops-table-actions">
                    <button type="button" title="编辑" onClick={() => setEditing({ mode: "edit", row })}>
                      <Pencil size={12} />
                    </button>
                    <button type="button" className="reject" title="删除" onClick={() => remove(Number(row.id))}>
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="ops-pagination">
          <span>第 {page} / {maxPage} 页 · 共 {total.toLocaleString()} 行</span>
          <div>
            <button disabled={page <= 1} onClick={() => { setLoading(true); setPage((v) => v - 1); }}>上一页</button>
            <button disabled={page >= maxPage} onClick={() => { setLoading(true); setPage((v) => v + 1); }}>下一页</button>
          </div>
        </div>
      )}

      {editing && (
        <RowForm
          mode={editing.mode}
          row={editing.mode === "edit" ? editing.row : undefined}
          columns={editableColumns}
          table={table}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </section>
  );
}

function RowForm({
  mode, row, columns, table, onClose, onSaved,
}: {
  mode: "create" | "edit";
  row?: Row;
  columns: ColumnMeta[];
  table: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const c of columns) {
      const v = row?.[c.name];
      init[c.name] = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    }
    return init;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const res = mode === "create"
        ? await fetch(`/api/v2/ops/tables/${table}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) })
        : await fetch(`/api/v2/ops/tables/${table}/${row!.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(values) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "保存失败");
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ops-modal-mask" onClick={onClose}>
      <div className="ops-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ops-modal-head">
          <h3>{mode === "create" ? "新增" : `编辑 #${row?.id}`}</h3>
          <button type="button" onClick={onClose}><X size={15} /></button>
        </div>
        <div className="ops-modal-body">
          {error && <div className="ops-message">{error}</div>}
          {columns.map((c) => (
            <label key={c.name} className="ops-field">
              <span>
                {c.name}
                {!c.isNullable && !c.hasDefault ? " *" : ""}
                {c.fk ? `（${c.fk.label} id）` : ""}
                <small>{c.dataType}</small>
              </span>
              {c.dataType === "boolean" ? (
                <input type="checkbox" checked={values[c.name] === "true"} onChange={(e) => setValues({ ...values, [c.name]: e.target.checked ? "true" : "false" })} />
              ) : c.dataType === "jsonb" || c.dataType === "json" ? (
                <textarea rows={3} value={values[c.name]} onChange={(e) => setValues({ ...values, [c.name]: e.target.value })} placeholder="JSON" />
              ) : c.dataType === "integer" || c.dataType === "bigint" || c.dataType === "smallint" || c.dataType === "numeric" || c.dataType === "double precision" ? (
                <input type="number" value={values[c.name]} onChange={(e) => setValues({ ...values, [c.name]: e.target.value })} />
              ) : (
                <input type="text" value={values[c.name]} onChange={(e) => setValues({ ...values, [c.name]: e.target.value })} />
              )}
            </label>
          ))}
        </div>
        <div className="ops-modal-foot">
          <button type="button" onClick={onClose}>取消</button>
          <button type="button" className="primary" disabled={busy} onClick={submit}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
