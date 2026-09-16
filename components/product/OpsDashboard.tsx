"use client";
import { useEffect, useState } from "react";
import { OpsConsole } from "@/components/ops/OpsConsole";
import { CompletenessPanel } from "@/components/ops/CompletenessPanel";

type Completeness = Parameters<typeof CompletenessPanel>[0]["data"];

/** Ops 控制台：上方为概览与完备度，下方为数据表区（9 表 CRUD）。 */
export function OpsDashboard() {
  const [completeness, setCompleteness] = useState<Completeness>();
  const [overview, setOverview] = useState<Record<string, number>>({});

  useEffect(() => {
    fetch("/api/completeness")
      .then((r) => r.json())
      .then(setCompleteness);
    fetch("/api/v2/ops")
      .then((r) => r.json())
      .then((d) => setOverview(d.overview ?? {}))
      .catch(() => {});
  }, []);

  return (
    <>
      <div className="ops-stats">
        <section className="ops-stat-group">
          <div className="ops-stat-group-head"><span>数据规模</span></div>
          <div className="ops-stat-group-grid">
            <div><b>{(overview.schools ?? 0).toLocaleString()}</b><span>学校</span></div>
            <div><b>{(overview.communities ?? 0).toLocaleString()}</b><span>小区</span></div>
            <div><b>{(overview.assignments ?? 0).toLocaleString()}</b><span>对口关系</span></div>
            <div><b>{(overview.policies ?? 0).toLocaleString()}</b><span>政策公示</span></div>
          </div>
        </section>
      </div>

      <CompletenessPanel data={completeness} />

      <OpsConsole />
    </>
  );
}
