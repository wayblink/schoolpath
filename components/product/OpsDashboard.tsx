"use client";
import { Activity, AlertTriangle, Database, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PipelineDiagram } from "@/components/ops/PipelineDiagram";
import { CandidateReview } from "@/components/ops/CandidateReview";
import { ReleaseBatches } from "@/components/ops/ReleaseBatches";
import { ManualEntry } from "@/components/ops/ManualEntry";
import { CompletenessPanel } from "@/components/ops/CompletenessPanel";
import { QualityQueue } from "@/components/ops/QualityQueue";

type OpsSummary = {
  overview: Record<string, number>;
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

      <QualityQueue matches={data.matches} conflicts={data.conflicts} />

      <CandidateReview />
      <ReleaseBatches />
      <ManualEntry />
    </>
  );
}
