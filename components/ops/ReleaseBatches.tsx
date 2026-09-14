"use client";
import { useCallback, useEffect, useState } from "react";
import { PackageCheck, RotateCcw, Send } from "lucide-react";

type Batch = {
  id: number;
  name: string;
  status: "draft" | "published" | "rolled_back";
  summary: Record<string, unknown>;
  createdAt: string;
  publishedAt: string | null;
  rolledBackAt: string | null;
  entryCount: number;
};

const STATUS_LABEL: Record<string, string> = { draft: "草稿", published: "已发布", rolled_back: "已回滚" };
const DISTRICTS = ["浦东新区", "徐汇区", "黄浦区", "长宁区", "静安区", "虹口区", "杨浦区", "闵行区", "宝山区", "嘉定区", "松江区", "青浦区", "奉贤区", "金山区", "崇明区"];

export function ReleaseBatches() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [name, setName] = useState("");
  const [district, setDistrict] = useState("");
  const [includeUnmatched, setIncludeUnmatched] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch("/api/v2/ops/release-batches")
      .then((r) => r.json())
      .then((d) => setBatches(d.batches ?? []))
      .catch(() => setBatches([]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch("/api/v2/ops/release-batches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name || `批次 ${new Date().toLocaleString("zh-CN")}`,
          district: district || undefined,
          includeUnmatched,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `创建失败 (${res.status})`);
      setMessage(`批次已创建：#${body.id} · ${body.entryCount} 条（${body.summary?.matchedCount ?? body.entryCount} 条匹配）`);
      setName("");
      load();
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function act(id: number, action: "publish" | "rollback") {
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch(`/api/v2/ops/release-batches/${id}/${action}`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `${action} 失败 (${res.status})`);
      const extra = action === "publish" ? `· 新增 ${body.summary?.upserted ?? 0} 行，跳过 ${body.summary?.skipped ?? 0}` : `· 移除 ${body.summary?.removedRows ?? 0} 行`;
      setMessage(`批次 #${id} ${STATUS_LABEL[body.status] ?? body.status} ${extra}`);
      load();
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ops-release" id="ops-release">
      <div className="ops-panel-head">
        <div>
          <span className="ops-section-kicker">RELEASE BATCHES</span>
          <h2>发布批次</h2>
          <p>把已审核的来源关系组成批次，发布到产品层（用户端 /schools 可见）。默认只收学校和小区都匹配上的条目。</p>
        </div>
        <PackageCheck size={18} />
      </div>

      <div className="ops-release-create">
        <label>
          <span>批次名称</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`批次 ${new Date().toLocaleDateString("zh-CN")}`}
          />
        </label>
        <label>
          <span>区域筛选</span>
          <select value={district} onChange={(e) => setDistrict(e.target.value)}>
            <option value="">全部区域</option>
            {DISTRICTS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="ops-release-check">
          <input type="checkbox" checked={includeUnmatched} onChange={(e) => setIncludeUnmatched(e.target.checked)} />
          <span>含未匹配条目（发布时自动跳过，留待补匹配）</span>
        </label>
        <button type="button" className="ops-release-create-btn" disabled={busy} onClick={create}>
          <Send size={13} /> 创建草稿批次
        </button>
      </div>

      {message && <div className="ops-message">{message}</div>}

      <div className="ops-release-list">
        {batches.length === 0 ? (
          <div className="empty-state">还没有发布批次。创建草稿后执行发布。</div>
        ) : (
          batches.map((b) => (
            <article className="ops-release-row" key={b.id}>
              <div className="ops-release-row-main">
                <b>
                  #{b.id} {b.name}
                </b>
                <span className={`ops-badge is-${b.status}`}>{STATUS_LABEL[b.status] ?? b.status}</span>
                <small>
                  {b.entryCount} 条 · 创建于 {new Date(b.createdAt).toLocaleString("zh-CN")}
                  {b.publishedAt ? ` · 发布于 ${new Date(b.publishedAt).toLocaleString("zh-CN")}` : ""}
                  {b.rolledBackAt ? ` · 回滚于 ${new Date(b.rolledBackAt).toLocaleString("zh-CN")}` : ""}
                </small>
              </div>
              <div className="ops-release-actions">
                <button type="button" disabled={busy || b.status !== "draft"} onClick={() => act(b.id, "publish")} title={b.status !== "draft" ? "只有草稿可发布" : "执行发布"}>
                  <Send size={12} /> 发布
                </button>
                <button type="button" className="reject" disabled={busy || b.status !== "published"} onClick={() => act(b.id, "rollback")} title={b.status !== "published" ? "只有已发布可回滚" : "回滚本批次写入的产品行"}>
                  <RotateCcw size={12} /> 回滚
                </button>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
