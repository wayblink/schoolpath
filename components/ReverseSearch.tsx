"use client";

import { useCallback, useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSelection } from "@/lib/store";

type SearchSchool = {
  id: number;
  name: string;
  district: string;
  type: "primary" | "middle" | "nine_year";
  tier: string | null;
  committeeName: string | null;
  sourceName: string;
  sourceUrl: string | null;
  policyUrl: string | null;
};

type SearchCommunity = {
  id: number;
  name: string;
  district: string;
  lng: number | null;
  lat: number | null;
  address: string | null;
  sourceCommittee: string | null;
  verified: boolean;
  schools: SearchSchool[];
};

type SearchResp = {
  query: string;
  communities: SearchCommunity[];
  stats: { matched_communities: number; total_school_links: number };
};

const TYPE_LABEL: Record<SearchSchool["type"], string> = {
  primary: "小学",
  middle: "初中",
  nine_year: "九年一贯",
};

const TIER_BADGE: Record<string, string> = {
  "一梯队": "bg-[var(--color-tier1-bg)] text-[var(--color-tier1)]",
  "二梯队": "bg-[var(--color-tier2-bg)] text-[var(--color-tier2)]",
  "三梯队": "bg-[var(--color-tier3-bg)] text-[var(--color-tier3)]",
  "四梯队": "bg-[var(--color-tier4-bg)] text-[var(--color-tier4)]",
  "未入榜/待补充": "bg-[var(--color-tier-unranked-bg)] text-[var(--color-tier-unranked)]",
};

interface Props {
  externalOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function ReverseSearch({ externalOpen, onOpenChange }: Props = {}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const open = externalOpen ?? internalOpen;
  const setOpen = useCallback((v: boolean) => {
    if (!v) {
      setQuery("");
      setDebouncedQuery("");
    }
    if (onOpenChange) onOpenChange(v);
    else setInternalOpen(v);
  }, [onOpenChange]);

  const setDistrict = useSelection((s) => s.setDistrict);
  const setSelectedSchool = useSelection((s) => s.setSelectedSchool);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  const searchQuery = useQuery({
    queryKey: ["communitySearch", debouncedQuery],
    enabled: open && debouncedQuery.length >= 1,
    queryFn: async () => {
      const res = await fetch(`/api/community-search?q=${encodeURIComponent(debouncedQuery)}`);
      if (!res.ok) throw new Error("search failed");
      return (await res.json()) as SearchResp;
    },
  });

  const data = searchQuery.data;
  const isLoading = searchQuery.isFetching && debouncedQuery.length >= 1;

  function jumpToSchool(districtName: string, schoolId: number) {
    setDistrict(districtName);
    setSelectedSchool(schoolId);
    setOpen(false);
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-[var(--color-modal-backdrop)] backdrop-blur-sm flex items-start justify-center pt-24 px-4"
      onClick={() => setOpen(false)}
    >
      <div
        className="bg-[var(--color-modal-bg)] border border-[var(--color-panel-border)] rounded-xl shadow-[var(--color-card-shadow)] w-full max-w-2xl max-h-[70vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-1 bg-[var(--color-panel-accent)]" aria-hidden />
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--color-panel-border)]">
          <span className="grid h-6 w-6 place-items-center rounded bg-[var(--color-section-label-bg)] text-[var(--color-accent)] ring-1 ring-[var(--color-section-label-border)]/70">⌕</span>
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="输入小区名 / 居委 / 地址 (例: 长桥五村, 上海新村)"
            className="flex-1 bg-transparent text-[14px] focus:outline-none placeholder:text-[var(--color-text-muted)]"
          />
          {data && debouncedQuery && (
            <span className="text-[10px] font-mono-tiny text-[var(--color-text-muted)]">
              {data.stats.matched_communities} 小区 · {data.stats.total_school_links} 对口
            </span>
          )}
          <kbd className="font-mono-tiny px-1.5 py-0.5 rounded bg-[var(--color-chip-bg)] border border-[var(--color-control-border)] text-[var(--color-text-muted)]">
            ESC
          </kbd>
        </div>

        <div className="flex-1 overflow-y-auto">
          {!debouncedQuery && (
            <div className="text-center py-16 px-6">
              <div className="text-[var(--color-text-muted)] text-[13px] mb-3">输入小区名查看对口学校</div>
              <div className="flex flex-wrap gap-1.5 justify-center">
                {["长桥五村", "上海新村", "汇成五村", "明华苑", "罗秀新村"].map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setQuery(s)}
                    className="text-[11px] px-2 py-0.5 rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] text-[var(--color-text-dim)] hover:border-[var(--color-card-hover-border)] hover:bg-[var(--color-control-hover)]"
                  >
                    {s}
                  </button>
                ))}
              </div>
              <div className="mt-6 text-[10px] font-mono-tiny text-[var(--color-text-muted)]">
                数据来源 · 本地宝 + 高德 PlaceSearch
              </div>
            </div>
          )}
          {isLoading && (
            <div className="text-center text-[var(--color-text-muted)] py-12 text-[13px]">查询中…</div>
          )}
          {data && data.communities.length === 0 && debouncedQuery && (
            <div className="text-center text-[var(--color-text-muted)] py-12 text-[13px]">
              未找到 <span className="text-[var(--color-text-dim)]">「{debouncedQuery}」</span>
            </div>
          )}
          {data && data.communities.length > 0 && (
            <div className="divide-y divide-[var(--color-border)]">
              {data.communities.map((c) => (
                <div key={c.id} className="px-4 py-3 hover:bg-[var(--color-list-row-hover)]/60">
                  <div className="flex items-baseline gap-2 mb-2 flex-wrap">
                    <span className="text-[14px] font-medium text-[var(--color-text)]">{c.name}</span>
                    <span className="text-[11px] text-[var(--color-text-muted)]">
                      {c.district}区
                      {c.sourceCommittee && ` · ${c.sourceCommittee}居委`}
                    </span>
                  </div>
                  {c.schools.length === 0 ? (
                    <div className="text-[12px] text-[var(--color-text-muted)] italic pl-2">无对口学校数据</div>
                  ) : (
                    <div className="space-y-1">
                      {c.schools.map((s) => (
                        <button
                          key={`${c.id}-${s.id}`}
                          type="button"
                          onClick={() => jumpToSchool(s.district, s.id)}
                          className="w-full text-left px-2.5 py-2 rounded-md border border-transparent hover:border-[var(--color-card-hover-border)] hover:bg-[var(--color-list-row-hover)] transition-colors group flex items-center gap-2"
                        >
                          <span className="w-1 h-1 rounded-full bg-[var(--color-text-muted)] group-hover:bg-[var(--color-accent)]" />
                          <span className="text-[13px] text-[var(--color-text)] group-hover:text-[var(--color-accent)]">
                            {s.name}
                          </span>
                          <span className="text-[10px] font-mono-tiny px-1.5 py-0.5 rounded bg-[var(--color-chip-bg)] text-[var(--color-text-muted)]">
                            {TYPE_LABEL[s.type]}
                          </span>
                          <span className="text-[10px] text-[var(--color-text-muted)]">{s.district}</span>
                          {s.tier && (
                            <span className={`text-[10px] font-mono-tiny px-1.5 py-0.5 rounded ${TIER_BADGE[s.tier] ?? "bg-[var(--color-chip-bg)] text-[var(--color-text-muted)]"}`}>
                              {s.tier}
                            </span>
                          )}
                          <span className="ml-auto text-[10px] text-[var(--color-text-muted)] group-hover:text-[var(--color-accent)]">
                            ↵
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="px-4 py-2 border-t border-[var(--color-panel-border)] bg-[var(--color-empty-bg)] text-[10px] font-mono-tiny text-[var(--color-text-muted)] flex items-center justify-between">
          <span>↑↓ 浏览 · ↵ 跳转 · ESC 关闭</span>
          <span>仅供学区信息参考</span>
        </div>
      </div>
    </div>
  );
}
