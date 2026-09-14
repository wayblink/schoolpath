"use client";
import { Activity, AlertTriangle, Check, Database, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PipelineDiagram } from "@/components/ops/PipelineDiagram";
import { CandidateReview } from "@/components/ops/CandidateReview";
import { ReleaseBatches } from "@/components/ops/ReleaseBatches";
import { ManualEntry } from "@/components/ops/ManualEntry";
import { CompletenessPanel } from "@/components/ops/CompletenessPanel";

type OpsSummary = {
  overview: Record<string, number>;
  runs: Array<{ id: number; name: string; fetchedAt: string; pageTitle: string; contentHash: string; stats: Record<string, number> | null }>;
  matches: Array<{ status: string; count: number }>;
  conflicts: Array<{ fieldName: string; status: string; count: number }>;
  relationStatuses: Array<{ status: string; count: number }>;
};
type Completeness = Parameters<typeof CompletenessPanel>[0]["data"];

const overviewLabels: Record<string, string> = {
  schools: "产品学校",
  communities: "产品小区",
  assignments: "学校小区关系",
  policies: "政策记录",
  pending_matches: "待匹配学校",
  conflicts: "待处理冲突",
  pending_relations: "待审核关系",
  matched_relations: "可直接审核关系",
};
const overviewGroups = [
  { label: "数据规模", keys: ["schools", "communities", "assignments", "policies"], icon: Database },
  { label: "待处理事项", keys: ["pending_matches", "conflicts"], icon: AlertTriangle },
  { label: "关系审核", keys: ["pending_relations", "matched_relations"], icon: ShieldCheck },
] as const;
const relationStatuses: Record<string, string> = { pending: "待处理", suggested: "待建议", accepted: "已接受", rejected: "已拒绝" };
const conflictFields: Record<string, string> = { coordinates: "坐标", tier: "梯队" };

export function OpsDashboard() {
  const [data, setData] = useState<OpsSummary>();
  const [completeness, setCompleteness] = useState<Completeness>();

  const loadSummary = useCallback(
    () =>
      fetch("/api/v2/ops")
        .then((r) => r.json())
        .then(setData),
    [],
  );
  useEffect(() => {
    void loadSummary();
    fetch("/api/completeness")
      .then((r) => r.json())
      .then(setCompleteness);
  }, [loadSummary]);

  if (!data)
    return (
      <main className="ops-page">
        <div className="empty-state">正在加载监控数据…</div>
      </main>
    );

  return (
    <>
      <div className="ops-dashboard-intro">
        <div>
          <span className="ops-section-kicker">TODAY AT A GLANCE</span>
          <h2>运营概览</h2>
          <p>先看数据规模，再处理需要人工确认的事项，最后组批次发布。</p>
        </div>
        <span className="ops-updated">
          <Activity size={13} /> 数据源已接入
        </span>
      </div>

      <PipelineDiagram />

      <div className="ops-stats">
        {overviewGroups.map(({ label, keys, icon: Icon }) => (
          <section className="ops-stat-group" key={label}>
            <div className="ops-stat-group-head">
              <span>
                <Icon size={14} /> {label}
              </span>
              <small>{keys.reduce((sum, key) => sum + Number(data.overview[key] ?? 0), 0).toLocaleString()} 项</small>
            </div>
            <div className="ops-stat-group-grid">
              {keys.map((key) => (
                <div key={key}>
                  <b>{Number(data.overview[key] ?? 0).toLocaleString()}</b>
                  <span>{overviewLabels[key] || key}</span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      <CompletenessPanel data={completeness} />

      <div className="ops-columns">
        <section>
          <div className="ops-panel-head">
            <div>
              <span className="ops-section-kicker">SOURCE RUNS</span>
              <h2>采集批次</h2>
              <p>最近一次同步的来源与覆盖范围。</p>
            </div>
            <Database size={18} />
          </div>
          {data.runs.map((run) => (
            <article className="ops-row" key={run.id}>
              <div>
                <b>{run.name}</b>
                <span className="ops-status success">
                  <Check size={11} /> 已完成
                </span>
              </div>
              <time>{new Date(run.fetchedAt).toLocaleString("zh-CN")}</time>
              <small>{run.pageTitle}</small>
              <span className="ops-run-stats">
                覆盖 {run.stats?.districtCount ?? 0} 个区域 · {run.stats?.committeeRelationCount ?? 0} 条关系 · {run.stats?.coordinateCount ?? 0} 个坐标
              </span>
              <code>{run.contentHash.slice(0, 16)}…</code>
            </article>
          ))}
        </section>
        <section>
          <div className="ops-panel-head">
            <div>
              <span className="ops-section-kicker">DATA QUALITY</span>
              <h2>质量队列</h2>
              <p>需要人工确认或补充的数据。</p>
            </div>
            <AlertTriangle size={18} />
          </div>
          <h3 className="ops-subhead">实体匹配</h3>
          {data.matches.map((row) => (
            <article className="ops-row compact" key={row.status}>
              <b>{relationStatuses[row.status] || row.status}</b>
              <strong>{Number(row.count).toLocaleString()}</strong>
            </article>
          ))}
          <h3 className="ops-subhead">字段冲突</h3>
          {data.conflicts.map((row) => (
            <article className="ops-row compact" key={`${row.fieldName}-${row.status}`}>
              <b>{conflictFields[row.fieldName] || row.fieldName}</b>
              <span>{relationStatuses[row.status] || row.status}</span>
              <strong>{Number(row.count).toLocaleString()}</strong>
            </article>
          ))}
        </section>
      </div>

      <CandidateReview />
      <ReleaseBatches />
      <ManualEntry />
    </>
  );
}
