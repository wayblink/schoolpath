"use client";
import { useEffect, useState } from "react";
import { Database } from "lucide-react";
import { OpsTableExplorer } from "./OpsTableExplorer";

type TableInfo = { key: string; label: string; icon: string; count: number };

/** 数据表区：左侧 9 表导航（贴卡片底）+ 右侧表浏览器，同处一张卡片。 */
export function OpsConsole() {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [active, setActive] = useState("schools");

  useEffect(() => {
    fetch("/api/v2/ops/tables")
      .then((r) => r.json())
      .then((d) => setTables(d.tables ?? []))
      .catch(() => {});
  }, []);

  return (
    <div className="ops-console">
      <nav className="ops-console-nav" aria-label="数据表导航">
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
        <OpsTableExplorer
          key={active}
          table={active}
          label={tables.find((t) => t.key === active)?.label ?? active}
        />
      </div>
    </div>
  );
}
