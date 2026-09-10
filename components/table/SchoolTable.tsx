"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { useSelection } from "@/lib/store";
import { cn } from "@/lib/utils";

type School = {
  id: number;
  name: string;
  district: string;
  tier: string | null;
  type: "primary" | "middle" | "nine_year";
  schoolNature: "公立" | "私立" | null;
};

const TYPE_LABEL: Record<School["type"], string> = {
  primary: "小学",
  middle: "初中",
  nine_year: "九年一贯",
};

const TIER_BADGE: Record<string, string> = {
  "一梯队": "bg-[var(--color-tier1-bg)] text-[var(--color-tier1)] border-[var(--color-tier1)]/20",
  "二梯队": "bg-[var(--color-tier2-bg)] text-[var(--color-tier2)] border-[var(--color-tier2)]/20",
  "三梯队": "bg-[var(--color-tier3-bg)] text-[var(--color-tier3)] border-[var(--color-tier3)]/20",
  "四梯队": "bg-[var(--color-tier4-bg)] text-[var(--color-tier4)] border-[var(--color-tier4)]/20",
  "未入榜/待补充": "bg-[var(--color-tier-unranked-bg)] text-[var(--color-tier-unranked)] border-[var(--color-tier-unranked)]/20",
};

export function SchoolTable({
  schools,
  onFocusMap,
  keepSelectionOnClick = false,
}: {
  schools: School[] | undefined;
  communities?: unknown[];
  communityStats?: unknown;
  communitiesLoading?: boolean;
  onFocusMap?: () => void;
  keepSelectionOnClick?: boolean;
}) {
  const selectedSchoolId = useSelection((s) => s.selectedSchoolId);
  const setSelectedSchool = useSelection((s) => s.setSelectedSchool);
  const hoveredSchoolId = useSelection((s) => s.hoveredSchoolId);
  const setHoveredSchool = useSelection((s) => s.setHoveredSchool);
  const cardRefs = useRef<Map<number, HTMLElement>>(new Map());

  useEffect(() => {
    if (selectedSchoolId == null) return;
    cardRefs.current.get(selectedSchoolId)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedSchoolId]);

  if (!schools) {
    return <div className="school-list-panel h-full bg-[var(--color-panel-bg)] p-4"><div className="rounded-lg border border-[var(--color-card-border)] bg-[var(--color-empty-bg)] p-6 text-sm text-[var(--color-text-muted)] shadow-[var(--color-card-shadow)]">加载中…</div></div>;
  }

  if (schools.length === 0) {
    return <div className="school-list-panel h-full bg-[var(--color-panel-bg)] p-4"><div className="rounded-lg border border-dashed border-[var(--color-card-hover-border)] bg-[var(--color-empty-bg)] p-6 text-sm text-[var(--color-text-muted)] shadow-[var(--color-card-shadow)]">当前筛选无结果。可在顶部切换学段或打开更多梯队。</div></div>;
  }

  return (
    <div className="school-list-panel h-full overflow-auto bg-[var(--color-panel-bg)] p-4 space-y-3">
      {schools.map((school) => {
        const isSelected = selectedSchoolId === school.id;
        const isHovered = hoveredSchoolId === school.id && !isSelected;
        return (
          <section
            key={school.id}
            ref={(el) => { if (el) cardRefs.current.set(school.id, el); else cardRefs.current.delete(school.id); }}
            onMouseEnter={() => setHoveredSchool(school.id)}
            onMouseLeave={() => setHoveredSchool(null)}
            className={cn(
              "school-card group relative overflow-hidden rounded-lg border shadow-[var(--color-card-shadow)] transition-[background-color,border-color,box-shadow,transform]",
              isSelected && "school-card-selected border-[var(--color-card-hover-border)] bg-[var(--color-card-selected-bg)] shadow-[0_0_0_3px_var(--color-selected-ring),var(--color-card-shadow)]",
              isHovered && "school-card-hovered border-[var(--color-card-hover-border)] bg-[var(--color-list-row-hover)]",
              !isSelected && !isHovered && "border-[var(--color-card-border)] bg-[var(--color-card-bg)]",
            )}
          >
            <div className={cn("absolute inset-y-0 left-0 w-1 bg-[var(--color-panel-accent)] transition-opacity", isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-70")} aria-hidden />
            <button
              type="button"
              onClick={() => {
                if (isSelected && !keepSelectionOnClick) { setSelectedSchool(null); return; }
                setSelectedSchool(school.id);
                onFocusMap?.();
              }}
              className="w-full px-4 py-3 pl-5 text-left grid grid-cols-[minmax(0,1fr)_52px_44px_96px] gap-2 items-center hover:bg-[var(--color-list-row-hover)] transition-colors"
            >
              <div className="min-w-0"><div className="font-medium text-[var(--color-text)] leading-snug break-words">{school.name}</div></div>
              <div className="text-sm text-[var(--color-text-dim)] whitespace-nowrap">{TYPE_LABEL[school.type]}</div>
              <div className="text-xs text-[var(--color-text-muted)] whitespace-nowrap">{school.schoolNature ?? "—"}</div>
              <div className="justify-self-end">{school.tier ? <span className={cn("inline-flex px-2 py-0.5 rounded text-xs border whitespace-nowrap", TIER_BADGE[school.tier] ?? "bg-[var(--color-bg-hover)] text-[var(--color-text-dim)] border-[var(--color-border)]")}>{school.tier}</span> : <span className="text-[var(--color-text-muted)] text-xs">—</span>}</div>
            </button>
            {isSelected && (
              <div className="border-t border-[var(--color-section-label-border)]/60 bg-[var(--color-detail-bg)] px-4 py-3 pl-5">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-[var(--color-text-muted)]">完整学校信息请查看详情页</span>
                  <Link href={`/schools/${school.id}`} onClick={(e) => e.stopPropagation()} className="map-school-detail-link">详情</Link>
                </div>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
