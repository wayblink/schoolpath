"use client";
import { useEffect, useState } from "react";
import { OpsConsole } from "@/components/ops/OpsConsole";
import { CompletenessPanel } from "@/components/ops/CompletenessPanel";

type Completeness = Parameters<typeof CompletenessPanel>[0]["data"];

export function OpsDashboard() {
  const [completeness, setCompleteness] = useState<Completeness>();

  useEffect(() => {
    fetch("/api/completeness")
      .then((r) => r.json())
      .then(setCompleteness);
  }, []);

  return (
    <>
      <div className="ops-dashboard-intro">
        <div>
          <span className="ops-section-kicker">DATA CONSOLE</span>
          <h2>数据表导航</h2>
          <p>左侧选择数据表进行查看、新增、编辑与删除。外部采集数据经固定接口（POST /api/ingest/records）直灌对口关系表。</p>
        </div>
      </div>

      <OpsConsole />

      <CompletenessPanel data={completeness} />
    </>
  );
}
