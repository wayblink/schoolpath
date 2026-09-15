"use client";
import { useEffect, useState } from "react";
import { Database, Home } from "lucide-react";
import { OpsTableExplorer } from "./OpsTableExplorer";

type TableInfo = { key: string; label: string; icon: string; count: number };

/** Ops 数据控制台：左侧 9 表导航 + 右侧表浏览器，外加概览页。 */
export function OpsConsole() {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [active, setActive] = useState("overview");
  const [overview, setOverview] = useState<Record<string, number>>({});

  useEffect(() => {
    fetch("/api/v2/ops/tables")
      .then((r) => r.json())
      .then((d) => setTables(d.tables ?? []))
      .catch(() => {});
    fetch("/api/v2/ops")
      .then((r) => r.json())
      .then((d) => setOverview(d.overview ?? {}))
      .catch(() => {});
  }, []);

  return (
    <div className="ops-console">
      <nav className="ops-console-nav" aria-label="数据表导航">
        <button
          type="button"
          className={active === "overview" ? "ops-console-nav-item active" : "ops-console-nav-item"}
          onClick={() => setActive("overview")}
        >
          <Home size={14} /> 概览
        </button>
        <div className="ops-console-nav-group">
          <span>数据表</span>
          {tables.map((t) => (
            <button
              key={t.key}
              type="button"
              className={active === t.key ? "ops-console-nav-item active" : "ops-console-nav-item"}
              onClick={() => setActive(t.key)}
            >
              <Database size={14} /> {t.label}
              <small>{t.count.toLocaleString()}</small>
            </button>
          ))}
        </div>
      </nav>
      <div className="ops-console-main">
        {active === "overview" ? (
          <div className="ops-console-overview">
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
          </div>
        ) : (
          <OpsTableExplorer
            key={active}
            table={active}
            label={tables.find((t) => t.key === active)?.label ?? active}
          />
        )}
      </div>
    </div>
  );
}
