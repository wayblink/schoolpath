"use client";

import { ChevronLeft, ChevronRight, ExternalLink, Search } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";

type PolicyType = "district" | "school";
type Policy = {
  id: number;
  type: PolicyType;
  typeLabel: string;
  district: string;
  year: number;
  title: string;
  schoolName: string | null;
  schoolType: string | null;
  sourceUrl: string | null;
  content: string;
};

const filters: Array<{ value: "all" | PolicyType; label: string }> = [
  { value: "all", label: "全部" },
  { value: "district", label: "区级政策" },
  { value: "school", label: "学校招生记录" },
];
const pageSize = 50;

function excerpt(content: string) {
  let readable = content;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === "object") {
      readable = Object.values(parsed as Record<string, unknown>)
        .flatMap((value) => Array.isArray(value) ? value : [value])
        .filter((value): value is string => typeof value === "string")
        .join("；");
    }
  } catch {
    // School-level records are already stored as readable prose.
  }
  const normalized = readable.replace(/\s+/g, " ").trim();
  return normalized.length > 150 ? `${normalized.slice(0, 150)}...` : normalized;
}

export function PolicyExplorer({ policies }: { policies: Policy[] }) {
  const [type, setType] = useState<"all" | PolicyType>("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase("zh-CN"));

  const counts = useMemo(() => ({
    all: policies.length,
    district: policies.filter((policy) => policy.type === "district").length,
    school: policies.filter((policy) => policy.type === "school").length,
  }), [policies]);

  const visiblePolicies = useMemo(() => policies.filter((policy) => {
    if (type !== "all" && policy.type !== type) return false;
    if (!deferredQuery) return true;
    return [policy.title, policy.district, policy.schoolName, policy.content]
      .some((value) => value?.toLocaleLowerCase("zh-CN").includes(deferredQuery));
  }), [deferredQuery, policies, type]);
  const pageCount = Math.max(1, Math.ceil(visiblePolicies.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pagePolicies = visiblePolicies.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  return <section className="policy-catalog" aria-label="信息源目录">
    <div className="policy-toolbar">
      <div className="policy-type-filter" role="group" aria-label="按资料类型筛选">
        {filters.map((filter) => <button
          type="button"
          key={filter.value}
          className={type === filter.value ? "active" : ""}
          aria-pressed={type === filter.value}
          onClick={() => { setType(filter.value); setPage(1); }}
        >{filter.label}<span>{counts[filter.value]}</span></button>)}
      </div>
      <label className="policy-search">
        <Search size={16} aria-hidden="true" />
        <span className="sr-only">搜索信息源</span>
        <input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="搜索标题、学校、区域或内容" />
      </label>
    </div>

    <div className="policy-result-meta">
      {`显示 ${visiblePolicies.length.toLocaleString()} / ${policies.length.toLocaleString()} 条信息源`}
    </div>

    {visiblePolicies.length === 0 ? <div className="policy-empty">没有符合条件的信息源</div> : null}
    <div className="policy-list">
      {pagePolicies.map((policy) => <article className="policy-record" key={policy.id}>
        <div className="policy-record-main">
          <div className="policy-record-meta">
            <span className={`policy-type-tag ${policy.type}`}>{policy.typeLabel}</span>
            <span>{policy.year}</span>
            <span>{policy.district}</span>
            {policy.schoolName ? <span>{policy.schoolName}</span> : null}
          </div>
          <h2>{policy.title}</h2>
          <p>{excerpt(policy.content)}</p>
        </div>
        {policy.sourceUrl ? <a href={policy.sourceUrl} target="_blank" rel="noreferrer" aria-label={`查看《${policy.title}》来源`}>
          <ExternalLink size={16} aria-hidden="true" />
          <span>查看来源</span>
        </a> : <span className="policy-no-source">暂无来源链接</span>}
      </article>)}
    </div>
    {visiblePolicies.length > pageSize ? <nav className="policy-pagination" aria-label="信息源分页">
      <button type="button" aria-label="上一页" disabled={currentPage === 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={16}/></button>
      <span>第 {currentPage} / {pageCount} 页</span>
      <button type="button" aria-label="下一页" disabled={currentPage === pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}><ChevronRight size={16}/></button>
    </nav> : null}
  </section>;
}
