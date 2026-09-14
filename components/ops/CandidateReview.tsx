"use client";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Check, X } from "lucide-react";
import { PRODUCT_DISTRICTS } from "@/lib/product/districts";

type Relation = {
  id: number;
  district: string;
  schoolName: string;
  committeeName: string;
  catalogSchoolName: string | null;
  catalogCommunityName: string | null;
  catalogCommitteeName: string | null;
  schoolMatchScore: number;
  communityMatchMethod: string;
};

const relationStatuses: Record<string, string> = { pending: "待处理", suggested: "待建议", accepted: "已接受", rejected: "已拒绝" };

/** 候选数据管理：学区关系候选审核（R3）。区域筛选从硬编码 8 区改为 PRODUCT_DISTRICTS 全量。 */
export function CandidateReview() {
  const [relations, setRelations] = useState<Relation[]>([]);
  const [district, setDistrict] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState("pending");
  const pageSize = 30;
  const [message, setMessage] = useState("");

  const loadRelations = useCallback(() => {
    const params = new URLSearchParams({ status, page: String(page), pageSize: String(pageSize) });
    if (district) params.set("district", district);
    return fetch(`/api/v2/ops/relations?${params}`)
      .then((r) => r.json())
      .then((body) => {
        const lastPage = Math.max(1, Math.ceil(body.total / pageSize));
        if (page > lastPage) {
          setPage(lastPage);
          return;
        }
        setRelations(body.relations);
        setTotal(body.total);
      });
  }, [district, page, status]);

  useEffect(() => {
    void loadRelations();
  }, [loadRelations]);

  async function review(id: number, action: "accept" | "reject") {
    setMessage("");
    const response = await fetch(`/api/v2/ops/relations/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const body = await response.json();
    if (!response.ok) {
      setMessage(body.error ?? "审核失败");
      return;
    }
    setMessage(action === "accept" ? `关系 #${id} 已接受，等待发布批次` : `关系 #${id} 已拒绝`);
    await loadRelations();
  }

  return (
    <section className="ops-review" id="ops-candidates">
      <div className="ops-review-head">
        <div>
          <span className="ops-section-kicker">RELATION REVIEW</span>
          <h2>学区关系候选审核</h2>
          <p>将来源中的学校与小区关系，确认后进入待发布队列。只列出学校和小区都匹配上的条目（可直接发布）。</p>
        </div>
        <label>
          <span>审核状态</span>
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="pending">待处理</option>
            <option value="accepted">已接受</option>
            <option value="rejected">已拒绝</option>
          </select>
        </label>
        <label>
          <span>筛选区域</span>
          <select value={district} onChange={(e) => { setDistrict(e.target.value); setPage(1); }}>
            <option value="">全部区域</option>
            {PRODUCT_DISTRICTS.map((d) => (
              <option key={d} value={d}>
                {d === "浦东" ? "浦东新区" : `${d}区`}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="ops-review-guide">
        <span><ArrowRight size={13} /> 来源关系</span>
        <span><ArrowRight size={13} /> 系统候选</span>
        <span><Check size={13} /> 接受后待发布</span>
      </div>
      {message && <div className="ops-message">{message}</div>}
      <div className="ops-review-list">
        {relations.length === 0 ? (
          <div className="empty-state">没有符合当前筛选的候选关系。</div>
        ) : (
          relations.map((relation) => {
            const ready = Boolean(relation.catalogSchoolName && relation.catalogCommunityName);
            return (
              <article className="ops-review-row" key={relation.id}>
                <div>
                  <small>{relation.district} · 来源学校</small>
                  <b>{relation.schoolName}</b>
                  <span><ArrowRight size={12} /> {relation.committeeName}</span>
                </div>
                <div>
                  <small>学校候选{relation.schoolMatchScore > 0 ? ` · 相似度 ${(relation.schoolMatchScore * 100).toFixed(0)}%` : ""}</small>
                  <b>{relation.catalogSchoolName ?? "未找到候选"}</b>
                  <small>小区候选 · {relation.communityMatchMethod.replaceAll("_", " ")}</small>
                  <span>
                    {relation.catalogCommunityName ?? "未唯一匹配"}
                    {relation.catalogCommitteeName ? ` · ${relation.catalogCommitteeName}` : ""}
                  </span>
                </div>
                <div className="ops-review-actions">
                  <button
                    disabled={!ready}
                    title={!ready ? "学校和小区都匹配后才能接受" : "接受此关系"}
                    onClick={() => review(relation.id, "accept")}
                  >
                    <Check size={13} /> 接受
                  </button>
                  <button className="reject" title="拒绝此关系" onClick={() => review(relation.id, "reject")}>
                    <X size={13} /> 拒绝
                  </button>
                </div>
              </article>
            );
          })
        )}
      </div>
      <div className="ops-pagination">
        <span>
          共 {total.toLocaleString()} 条 · 第 {page} / {Math.max(1, Math.ceil(total / pageSize))} 页
          {total > 0 && relations.length > 0 ? ` · 当前 ${relationStatuses[status] ?? status}` : ""}
        </span>
        <div>
          <button disabled={page <= 1} onClick={() => setPage((v) => v - 1)}>
            上一页
          </button>
          <button disabled={page >= Math.ceil(total / pageSize)} onClick={() => setPage((v) => v + 1)}>
            下一页
          </button>
        </div>
      </div>
    </section>
  );
}
