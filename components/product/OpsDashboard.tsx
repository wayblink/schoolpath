"use client";
import { Activity, Database } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ManualEntry } from "@/components/ops/ManualEntry";
import { CompletenessPanel } from "@/components/ops/CompletenessPanel";

type OpsSummary = {
  overview: Record<string, number>;
};
type Completeness = Parameters<typeof CompletenessPanel>[0]["data"];

const overviewLabels: Record<string, string> = {
  schools: "产品学校",
  communities: "产品小区",
  assignments: "学校小区关系",
  policies: "政策记录",
};
const overviewGroups = [
  { label: "数据规模", keys: ["schools", "communities", "assignments", "policies"], icon: Database },
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
          <p>产品层数据规模与来源收录情况总览。</p>
        </div>
        <span className="ops-updated">
          <Activity size={13} /> 数据源已接入
        </span>
      </div>


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


      <ManualEntry />
    </>
  );
}
