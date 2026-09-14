"use client";
import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, Layers, TriangleAlert, X } from "lucide-react";

type MatchCandidate = {
  id: number;
  status: string;
  matchMethod: string;
  matchScore: number;
  sourceName: string | null;
  explanation: string | null;
  publicSchoolName: string | null;
};
type FieldConflict = {
  id: number;
  fieldName: string;
  currentValue: unknown;
  proposedValue: unknown;
  status: string;
  publicSchoolName: string | null;
};

const FIELD_LABEL: Record<string, string> = { coordinates: "坐标", tier: "梯队" };
const PAGE_SIZE = 15;

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.lat === "number" && typeof v.lng === "number") return `${v.lat.toFixed(6)}, ${v.lng.toFixed(6)}`;
    return JSON.stringify(value);
  }
  return String(value);
}

/** 质量队列（R3）：实体匹配候选与字段冲突的可处理工作队列。 */
export function QualityQueue({ matches, conflicts }: { matches: Array<{ status: string; count: number }>; conflicts: Array<{ fieldName: string; status: string; count: number }> }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const countOf = (fieldName?: string) =>
    conflicts.filter((c) => c.status === "pending" && (!fieldName || c.fieldName === fieldName)).reduce((s, c) => s + Number(c.count), 0);

  return (
    <section className="ops-quality">
      <div className="ops-panel-head">
        <div>
          <span className="ops-section-kicker">DATA QUALITY</span>
          <h2>质量队列</h2>
          <p>需要人工确认或补充的数据。展开逐条处理，处理后自动刷新计数。</p>
        </div>
        <TriangleAlert size={18} />
      </div>

      <MatchGroup
        title="实体匹配"
        hint="来源学校名与产品库学校的匹配建议，确认后建立关联"
        rows={matches.filter((m) => m.status === "pending" || m.status === "suggested")}
        busy={busy}
        setBusy={setBusy}
        setMessage={setMessage}
      />

      {conflicts.filter((c) => c.status === "pending").length > 0 && (
        <ConflictGroup
          title="字段冲突"
          hint="匹配上的学校里，来源值与产品层现值打架，需决定留哪个"
          rows={conflicts.filter((c) => c.status === "pending")}
          fieldLabel={(f) => FIELD_LABEL[f] || f}
          busy={busy}
          setBusy={setBusy}
          setMessage={setMessage}
        />
      )}

      {message && <div className="ops-message">{message}</div>}
    </section>
  );
}

function MatchGroup({
  title, hint, rows, busy, setBusy, setMessage,
}: {
  title: string;
  hint: string;
  rows: Array<{ status: string; count: number }>;
  busy: boolean;
  setBusy: (v: boolean) => void;
  setMessage: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("pending");
  const [items, setItems] = useState<MatchCandidate[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  const load = useCallback(() => {
    fetch(`/api/v2/ops/match-candidates?status=${status}&page=${page}&pageSize=${PAGE_SIZE}`)
      .then((r) => r.json())
      .then((d) => {
        setItems(d.candidates ?? []);
        setTotal(d.total ?? 0);
      })
      .catch(() => setItems([]));
  }, [status, page]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function review(id: number, action: "confirm" | "reject") {
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch(`/api/v2/ops/match-candidates/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "处理失败");
      setMessage(`候选 #${id} 已${action === "confirm" ? "确认匹配" : "标记不匹配"}`);
      await load();
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const pendingCount = rows.reduce((s, r) => s + Number(r.count), 0);

  return (
    <details className="ops-quality-group" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        <ChevronDown size={15} className="ops-quality-chevron" />
        <b>{title}</b>
        <small>{hint}</small>
        <span className="ops-quality-count">{pendingCount.toLocaleString()}</span>
      </summary>
      <div className="ops-quality-body">
        <div className="ops-quality-filter">
          <label>
            <span>状态</span>
            <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="pending">待处理</option>
              <option value="suggested">待建议</option>
              <option value="accepted">已确认</option>
              <option value="rejected">已拒绝</option>
            </select>
          </label>
          <span>共 {total.toLocaleString()} 条 · 第 {page} / {Math.max(1, Math.ceil(total / PAGE_SIZE))} 页</span>
        </div>
        <div className="ops-quality-list">
          {items.length === 0 ? (
            <div className="empty-state">没有该状态的候选。</div>
          ) : (
            items.map((item) => (
              <article className="ops-quality-row" key={item.id}>
                <div className="ops-quality-row-main">
                  <b>{item.sourceName ?? "（无来源名）"}</b>
                  <span className="ops-quality-arrow">→ {item.publicSchoolName ?? "未关联学校"}</span>
                  <small>
                    {item.matchMethod} · 相似度 {(item.matchScore * 100).toFixed(1)}%
                    {item.explanation ? ` · ${item.explanation}` : ""}
                  </small>
                </div>
                {item.status === "pending" || item.status === "suggested" ? (
                  <div className="ops-quality-actions">
                    <button type="button" disabled={busy || !item.publicSchoolName} title={!item.publicSchoolName ? "未关联学校无法确认" : "确认此匹配"} onClick={() => review(item.id, "confirm")}>
                      <Check size={12} /> 确认
                    </button>
                    <button type="button" className="reject" disabled={busy} title="标记为不匹配" onClick={() => review(item.id, "reject")}>
                      <X size={12} /> 拒绝
                    </button>
                  </div>
                ) : (
                  <span className="ops-quality-done">{item.status === "accepted" ? "已确认" : "已拒绝"}</span>
                )}
              </article>
            ))
          )}
        </div>
        {total > PAGE_SIZE && (
          <div className="ops-pagination">
            <span>
              第 {page} / {Math.max(1, Math.ceil(total / PAGE_SIZE))} 页
            </span>
            <div>
              <button disabled={page <= 1} onClick={() => setPage((v) => v - 1)}>
                上一页
              </button>
              <button disabled={page >= Math.ceil(total / PAGE_SIZE)} onClick={() => setPage((v) => v + 1)}>
                下一页
              </button>
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

function ConflictGroup({
  title, hint, rows, fieldLabel, busy, setBusy, setMessage,
}: {
  title: string;
  hint: string;
  rows: Array<{ fieldName: string; status: string; count: number }>;
  fieldLabel: (f: string) => string;
  busy: boolean;
  setBusy: (v: boolean) => void;
  setMessage: (m: string) => void;
}) {
  const [field, setField] = useState(rows[0]?.fieldName ?? "");
  const [items, setItems] = useState<FieldConflict[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  const load = useCallback(() => {
    if (!field) return;
    fetch(`/api/v2/ops/field-conflicts?field=${encodeURIComponent(field)}&status=pending&page=${page}&pageSize=${PAGE_SIZE}`)
      .then((r) => r.json())
      .then((d) => {
        setItems(d.conflicts ?? []);
        setTotal(d.total ?? 0);
      })
      .catch(() => setItems([]));
  }, [field, page]);

  useEffect(() => {
    void load();
  }, [load]);

  async function review(id: number, action: "keep_current" | "take_source") {
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch(`/api/v2/ops/field-conflicts/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "处理失败");
      setMessage(`冲突 #${id} 已${action === "keep_current" ? "保留产品层现值" : "采纳来源值"}（裁决已记录）`);
      await load();
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="ops-quality-group">
      <summary>
        <ChevronDown size={15} className="ops-quality-chevron" />
        <b>{title}</b>
        <small>{hint}</small>
        <span className="ops-quality-count">{rows.reduce((s, r) => s + Number(r.count), 0).toLocaleString()}</span>
      </summary>
      <div className="ops-quality-body">
        <div className="ops-quality-filter">
          <label>
            <span>冲突字段</span>
            <select value={field} onChange={(e) => { setField(e.target.value); setPage(1); }}>
              {rows.map((r) => (
                <option key={r.fieldName} value={r.fieldName}>
                  {fieldLabel(r.fieldName)}（{Number(r.count)}）
                </option>
              ))}
            </select>
          </label>
          <span>共 {total.toLocaleString()} 条 · 第 {page} / {Math.max(1, Math.ceil(total / PAGE_SIZE))} 页</span>
        </div>
        <div className="ops-quality-list">
          {items.length === 0 ? (
            <div className="empty-state">没有该字段的待处理冲突。</div>
          ) : (
            items.map((item) => (
              <article className="ops-quality-row" key={item.id}>
                <div className="ops-quality-row-main">
                  <b>{item.publicSchoolName ?? "未关联学校"}</b>
                  <span className="ops-quality-values">
                    <em>产品层</em> {displayValue(item.currentValue)}
                    <em>来源值</em> {displayValue(item.proposedValue)}
                  </span>
                  <small>{fieldLabel(item.fieldName)}冲突</small>
                </div>
                <div className="ops-quality-actions">
                  <button type="button" disabled={busy} title="保留产品层现值（裁决记录在案）" onClick={() => review(item.id, "keep_current")}>
                    保留现值
                  </button>
                  <button type="button" className="reject" disabled={busy} title="采纳来源值（裁决记录在案，产品层字段变更仍走发布批次）" onClick={() => review(item.id, "take_source")}>
                    采纳来源
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
        {total > PAGE_SIZE && (
          <div className="ops-pagination">
            <span>第 {page} / {Math.max(1, Math.ceil(total / PAGE_SIZE))} 页</span>
            <div>
              <button disabled={page <= 1} onClick={() => setPage((v) => v - 1)}>
                上一页
              </button>
              <button disabled={page >= Math.ceil(total / PAGE_SIZE)} onClick={() => setPage((v) => v + 1)}>
                下一页
              </button>
            </div>
          </div>
        )}
      </div>
    </details>
  );
}
