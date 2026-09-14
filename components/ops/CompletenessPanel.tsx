"use client";
import { useMemo, useState } from "react";
import { ChevronDown, Filter, Gauge } from "lucide-react";

type CompletionMetric = { total: number; complete: number; percent: number };
type Completeness = {
  year: number;
  city: {
    overall: { percent: number };
    schools: CompletionMetric;
    tiers: CompletionMetric;
    schoolNature: CompletionMetric;
    schoolLocation: CompletionMetric;
    schoolCommunities: CompletionMetric;
    communityLocation: CompletionMetric;
    communityPreciseCoordinates: CompletionMetric;
  };
  availableTags: string[];
  details: Array<{ id: number; name: string; district: string; type: string; percent: number; missingTags: string[] }>;
};

const metricLabels: [keyof Completeness["city"], string][] = [
  ["schools", "基础信息"],
  ["tiers", "梯队"],
  ["schoolNature", "学校性质"],
  ["schoolLocation", "学校位置"],
  ["schoolCommunities", "对口小区"],
  ["communityLocation", "小区位置"],
  ["communityPreciseCoordinates", "精确坐标"],
];
const typeLabels: Record<string, string> = { primary: "小学", middle: "初中", nine_year: "九年一贯制" };

export function CompletenessPanel({ data }: { data: Completeness | undefined }) {
  const [tag, setTag] = useState("");
  const [district, setDistrict] = useState("");
  const districts = useMemo(
    () => (data ? [...new Set(data.details.map((row) => row.district))].sort((a, b) => a.localeCompare(b, "zh-CN")) : []),
    [data],
  );
  const rows = useMemo(
    () => data?.details.filter((row) => (!district || row.district === district) && (!tag || row.missingTags.includes(tag))) ?? [],
    [data, district, tag],
  );
  if (!data)
    return (
      <section className="ops-completeness">
        <div className="empty-state">数据完备度加载中…</div>
      </section>
    );
  return (
    <details className="ops-completeness">
      <summary>
        <div className="ops-completeness-summary-main">
          <span className="ops-completeness-kicker">
            <Gauge size={14} aria-hidden="true" /> DATA COMPLETENESS · {data.year}
          </span>
          <h2>数据完备度</h2>
          <p>学校资料完整性与缺失字段概览</p>
        </div>
        <div className="ops-completeness-summary-side">
          <div className="ops-completeness-ring" style={{ "--completion": `${data.city.overall.percent}%` } as React.CSSProperties}>
            <strong>
              {data.city.overall.percent.toFixed(0)}
              <small>%</small>
            </strong>
          </div>
          <span>{data.details.length.toLocaleString()} 所学校</span>
        </div>
        <ChevronDown className="ops-completeness-chevron" size={20} aria-hidden="true" />
      </summary>
      <div className="ops-completeness-body">
        <div className="ops-completeness-metrics">
          {metricLabels.map(([key, label], index) => {
            const metric = data.city[key] as CompletionMetric;
            return (
              <article key={key}>
                <div className="ops-completeness-metric-head">
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <b>{metric.percent.toFixed(0)}%</b>
                </div>
                <strong>{label}</strong>
                <small>
                  {metric.complete.toLocaleString()} / {metric.total.toLocaleString()}
                </small>
                <i>
                  <em style={{ width: `${metric.percent}%` }} />
                </i>
              </article>
            );
          })}
        </div>
        <div className="ops-completeness-tools">
          <label>
            <span>
              <Filter size={13} aria-hidden="true" /> 区域
            </span>
            <select value={district} onChange={(event) => setDistrict(event.target.value)}>
              <option value="">全部区域</option>
              {districts.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <div className="ops-completeness-tag-filter">
            <span>按缺失标签过滤</span>
            <button className={!tag ? "active" : ""} onClick={() => setTag("")}>
              全部
            </button>
            {data.availableTags.map((item) => (
              <button className={tag === item ? "active" : ""} key={item} onClick={() => setTag(item)}>
                {item}
              </button>
            ))}
          </div>
        </div>
        <div className="ops-completeness-result">
          <span>当前显示 {rows.length.toLocaleString()} 所学校</span>
          {rows.length === 0 && <p>没有符合当前过滤条件的学校。</p>}
          <div className="ops-completeness-list">
            {rows.map((row) => (
              <article key={row.id}>
                <div>
                  <b>{row.name}</b>
                  <span>
                    {row.district} · {typeLabels[row.type] || row.type}
                  </span>
                </div>
                <strong>{row.percent}%</strong>
                <div>
                  {row.missingTags.length ? row.missingTags.map((item) => <i key={item}>{item}</i>) : <i className="complete">数据完整</i>}
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
    </details>
  );
}
