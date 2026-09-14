"use client";
import { useEffect, useState } from "react";
import { AlertTriangle, ArrowRight, Check, CircleDot } from "lucide-react";

type Stage = {
  key: string;
  label: string;
  count: number;
  status: "ok" | "pending" | "broken";
  hint: string;
};

const ANCHORS: Record<string, string> = {
  collect: "ops-candidates",
  import: "ops-candidates",
  source: "ops-candidates",
  match: "ops-candidates",
  review: "ops-candidates",
  publish: "ops-release",
  visible: "ops-release",
};

export function PipelineDiagram() {
  const [stages, setStages] = useState<Stage[] | null>(null);

  useEffect(() => {
    fetch("/api/v2/ops/pipeline")
      .then((r) => r.json())
      .then((d) => setStages(d.stages ?? []))
      .catch(() => setStages([]));
  }, []);

  if (!stages) {
    return (
      <section className="ops-pipeline" aria-label="数据流水线">
        <div className="empty-state">流水线加载中…</div>
      </section>
    );
  }

  return (
    <section className="ops-pipeline" aria-label="数据流水线">
      <div className="ops-pipeline-head">
        <div>
          <span className="ops-section-kicker">DATA PIPELINE</span>
          <h2>数据流水线</h2>
          <p>采集 → 导入 → 结构化 → 匹配 → 审核 → 发布 → 产品可见。断点会标红。</p>
        </div>
      </div>
      <ol className="ops-pipeline-steps">
        {stages.map((s, i) => (
          <li key={s.key} className={`ops-pipeline-step is-${s.status}`}>
            <button
              type="button"
              className="ops-pipeline-card"
              onClick={() => {
                const el = document.getElementById(ANCHORS[s.key] ?? "ops-candidates");
                el?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              title={s.hint}
            >
              <div className="ops-pipeline-card-top">
                <span className="ops-pipeline-index">{String(i + 1).padStart(2, "0")}</span>
                <span className="ops-pipeline-dot" aria-hidden>
                  {s.status === "ok" ? <Check size={11} /> : s.status === "pending" ? <CircleDot size={11} /> : <AlertTriangle size={11} />}
                </span>
              </div>
              <strong>{s.label}</strong>
              <b>{s.count.toLocaleString()}</b>
              <small>{s.hint}</small>
            </button>
            {i < stages.length - 1 && (
              <span className="ops-pipeline-arrow" aria-hidden>
                <ArrowRight size={14} />
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
