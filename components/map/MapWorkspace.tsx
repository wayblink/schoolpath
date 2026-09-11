"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Search } from "lucide-react";
import { ALL_DISTRICTS, TIER_FILTERS, useSelection, type TierFilter, type TypeFilter } from "@/lib/store";
import { PRODUCT_DISTRICTS, displayProductDistrict, normalizeProductDistrict } from "@/lib/product/districts";
import { AmapContainer } from "@/components/map/AmapContainer";
import { SchoolTable } from "@/components/table/SchoolTable";
import { HeaderBar } from "@/components/HeaderBar";
import type { CommunityApi } from "@/lib/api-types";

type SchoolApi = {
  id: number;
  name: string;
  district: string;
  tier: string | null;
  type: "primary" | "middle" | "nine_year";
  schoolNature: "公立" | "私立" | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  enrollmentNote: string | null;
  recentScoreLine: string | null;
  pitRiskLevel: "low" | "medium" | "high" | "unknown" | null;
  attrs: Record<string, unknown> | null;
};

type DistrictsFC = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: {
      boundaryId: number;
      schoolId: number;
      schoolName: string;
      schoolTier: string | null;
      schoolType: "primary" | "middle" | "nine_year";
      district: string;
      year: number;
      notes: string | null;
    };
    geometry:
      | { type: "Polygon"; coordinates: number[][][] }
      | { type: "MultiPolygon"; coordinates: number[][][][] };
  }>;
};

type CommunitiesResp = {
  communities: CommunityApi[];
  stats: { total: number; via_committee: number; via_feeder: number; priced: number };
};

type DataSourceApi = {
  id: number;
  schoolId: number;
  schoolName: string;
  district: string;
  sourceType: string;
  sourceName: string;
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourceDate: string | null;
  evidence: string | null;
  confidence: string;
  fetchedAt: string | null;
  updatedAt: string | null;
};

type DataSourcesResp = {
  sources: DataSourceApi[];
  stats: {
    total: number;
    byType: Record<string, number>;
    byConfidence: Record<string, number>;
  };
};

type AuditSourceApi = {
  year: number;
  district: string;
  title: string;
  url: string | null;
  sourceName: string;
  sourceType: string;
  category: string;
  confidence: string;
};

type DistrictAuditRowApi = {
  year: number;
  district: string;
  schoolTotal: number;
  boundaryTextSchools: number;
  linkedSchools: number;
  linkRows: number;
  linkedCommunities: number;
  sourceCount: number;
  scopeSourceCount: number;
  coveragePercent: number;
  status: "missing" | "source-found" | "boundary-text" | "partially-linked" | "linked";
  sources: AuditSourceApi[];
};

type SchoolDistrictAuditResp = {
  generatedAt: string;
  years: number[];
  indexUrl: string;
  rows: DistrictAuditRowApi[];
  summary: Array<{
    year: number;
    schoolTotal: number;
    boundaryTextSchools: number;
    linkedSchools: number;
    linkRows: number;
    linkedCommunities: number;
    sourceCount: number;
    scopeSourceCount: number;
    coveragePercent: number;
  }>;
};

type SchoolCommunityCandidatesResp = {
  tableReady: boolean;
  summaries: Array<{
    year: number;
    district: string;
    status: string;
    confidence: string;
    count: number;
    matchedSchools: number;
  }>;
  stats: {
    total: number;
    matchedSchools: number;
    byYear: Record<string, number>;
    byStatus: Record<string, number>;
  };
};

type ViewMode = "map" | "schools" | "data-sources" | "district-audit";

const DISTRICTS = [
  ALL_DISTRICTS,
  "徐汇", "黄浦", "长宁", "静安", "普陀", "虹口", "杨浦", "浦东",
  "闵行", "宝山", "嘉定", "金山", "松江", "青浦", "奉贤", "崇明",
];

const FILTER_OPTIONS: Array<{ value: TypeFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "primary", label: "小学" },
  { value: "middle", label: "初中" },
];

const TIER_OPTIONS: Array<{ value: TierFilter; label: string; color: string }> = [
  { value: "一梯队", label: "一梯队", color: "var(--color-tier1)" },
  { value: "二梯队", label: "二梯队", color: "var(--color-tier2)" },
  { value: "三梯队", label: "三梯队", color: "var(--color-tier3)" },
  { value: "四梯队", label: "四梯队", color: "var(--color-tier4)" },
  { value: "未入榜/待补充", label: "待补充", color: "var(--color-tier-unranked)" },
];

type SchoolAttrs = {
  alias?: string;
  aliases?: string[];
  shortName?: string;
  matching_committees?: unknown[];
  official_committee_items?: unknown[];
  feeder_schools?: unknown[];
  enrollment_method?: string;
  middle_school_route?: string;
  policy_url?: string;
  data_source?: string;
};

function viewModeFromHash(hash: string): ViewMode {
  if (hash === "#schools") return "schools";
  if (hash === "#data-sources") return "data-sources";
  if (hash === "#district-audit") return "district-audit";
  return "map";
}

function normalizeTier(tier: string | null): TierFilter {
  return TIER_FILTERS.includes(tier as TierFilter) ? (tier as TierFilter) : "未入榜/待补充";
}

const TIER_ORDER: Record<string, number> = {
  "一梯队": 1,
  "二梯队": 2,
  "三梯队": 3,
  "四梯队": 4,
  "未入榜/待补充": 5,
};

function tierRank(tier: string | null): number {
  return TIER_ORDER[tier ?? "未入榜/待补充"] ?? 5;
}

const SOURCE_TYPE_LABELS: Record<string, string> = {
  official_website: "学校官网",
  official_admission: "招生政策",
  official_school_info: "官方校情",
  official_notice: "官方通知",
  third_party_directory: "第三方目录",
  map: "地图",
};

function sourceTypeLabel(type: string): string {
  return SOURCE_TYPE_LABELS[type] ?? type;
}

const AUDIT_STATUS_LABELS: Record<DistrictAuditRowApi["status"], string> = {
  missing: "缺对口来源",
  "source-found": "有来源",
  "boundary-text": "有边界文本",
  "partially-linked": "部分结构化",
  linked: "已结构化",
};

const AUDIT_CATEGORY_LABELS: Record<string, string> = {
  "district-policy": "区级政策",
  "primary-scope": "小学对口",
  "middle-scope": "初中对口",
  "school-list": "学校清单",
  service: "服务入口",
  other: "其他",
};

function formatSourceDate(value: string | null): string {
  if (!value) return "—";
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  return value;
}

function displayValue(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  const preferred = record.value ?? record.name ?? record.label ?? record.text;
  if (typeof preferred === "string") return preferred;
  if (typeof preferred === "number" || typeof preferred === "boolean") return String(preferred);
  return undefined;
}

function displayList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map(displayValue).filter((item): item is string => Boolean(item));
}

function schoolAliases(school: SchoolApi, attrs: SchoolAttrs) {
  return Array.from(new Set([
    attrs.shortName,
    attrs.alias,
    ...displayList(attrs.aliases),
  ].filter((item): item is string => Boolean(item && item !== school.name))));
}

function schoolCommitteeCount(attrs: SchoolAttrs) {
  const committees = displayList(attrs.matching_committees);
  if (committees.length > 0) return committees.length;
  return displayList(attrs.official_committee_items).length;
}

function schoolFeederCount(attrs: SchoolAttrs) {
  return displayList(attrs.feeder_schools).length;
}

function DataSourcesList({ data }: { data: DataSourcesResp | undefined }) {
  const sources = data?.sources ?? [];
  const typeEntries = Object.entries(data?.stats.byType ?? {}).sort((a, b) => b[1] - a[1]);

  return (
    <section
      id="data-sources"
      className="flex-1 overflow-auto bg-[var(--color-bg)] px-4 py-5 md:px-6"
    >
      <div className="mx-auto flex max-w-[1440px] flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-[15px] font-semibold text-[var(--color-text)]">数据源列表</div>
            <div className="mt-1 text-xs text-[var(--color-text-muted)]">
              记录学校官网、官方招生政策、地图与第三方目录等校验来源。
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] px-2 py-1 text-[var(--color-text-dim)]">
              共 {data?.stats.total ?? 0} 条
            </span>
            {typeEntries.map(([type, count]) => (
              <span
                key={type}
                className="rounded-md border border-[var(--color-control-border)] bg-[var(--color-chip-bg)] px-2 py-1 text-[var(--color-text-muted)]"
              >
                {sourceTypeLabel(type)} {count}
              </span>
            ))}
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-[var(--color-panel-border)] bg-[var(--color-bg-elev)] shadow-sm">
          <div className="divide-y divide-[var(--color-border)]/70 md:hidden">
            {sources.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-[var(--color-text-muted)]">
                暂无数据源记录
              </div>
            ) : (
              sources.map((source) => (
                <div key={source.id} className="px-3 py-3 text-xs">
                  <div className="mb-2 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-[var(--color-text)]" title={source.schoolName}>
                        {source.schoolName}
                      </div>
                      <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
                        {source.district} · #{source.schoolId}
                      </div>
                    </div>
                    <span className="shrink-0 rounded border border-[var(--color-control-border)] bg-[var(--color-chip-bg)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-dim)]">
                      {sourceTypeLabel(source.sourceType)}
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate text-[var(--color-text-dim)]" title={source.sourceName}>
                        {source.sourceName}
                      </span>
                      <span className="shrink-0 font-mono-tiny text-[var(--color-text-muted)]">
                        {source.confidence}
                      </span>
                    </div>
                    <div className="font-medium text-[var(--color-text)]">
                      {source.sourceTitle ?? "—"}
                    </div>
                    {source.evidence && (
                      <div className="line-clamp-2 text-[11px] leading-5 text-[var(--color-text-muted)]">
                        {source.evidence}
                      </div>
                    )}
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className="font-mono-tiny text-[var(--color-text-muted)]">
                      {formatSourceDate(source.sourceDate)}
                    </span>
                    {source.sourceUrl ? (
                      <a
                        href={source.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] px-2 text-[11px] text-[var(--color-accent)] hover:border-[var(--color-card-hover-border)] hover:bg-[var(--color-control-hover)]"
                        title={source.sourceUrl}
                      >
                        打开
                        <ExternalLink size={12} />
                      </a>
                    ) : (
                      <span className="text-[var(--color-text-muted)]">—</span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="hidden md:block">
            <div className="grid grid-cols-[92px_150px_1.1fr_1.4fr_92px_84px] gap-3 border-b border-[var(--color-panel-border)] bg-[var(--color-section-label-bg)] px-3 py-2 text-[11px] font-medium text-[var(--color-text-dim)]">
              <div>类型</div>
              <div>学校</div>
              <div>来源</div>
              <div>标题 / 证据</div>
              <div>日期</div>
              <div className="text-right">链接</div>
            </div>

            <div>
              {sources.length === 0 ? (
                <div className="px-3 py-8 text-center text-sm text-[var(--color-text-muted)]">
                  暂无数据源记录
                </div>
              ) : (
                sources.map((source) => (
                  <div
                    key={source.id}
                    className="grid grid-cols-[92px_150px_1.1fr_1.4fr_92px_84px] gap-3 border-b border-[var(--color-border)]/70 px-3 py-2.5 text-xs last:border-b-0 hover:bg-[var(--color-list-row-hover)]"
                  >
                    <div className="min-w-0">
                      <span className="inline-flex max-w-full rounded border border-[var(--color-control-border)] bg-[var(--color-chip-bg)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-dim)]">
                        <span className="truncate">{sourceTypeLabel(source.sourceType)}</span>
                      </span>
                    </div>
                    <div className="min-w-0">
                      <div className="truncate font-medium text-[var(--color-text)]" title={source.schoolName}>
                        {source.schoolName}
                      </div>
                      <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
                        {source.district} · #{source.schoolId}
                      </div>
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-[var(--color-text-dim)]" title={source.sourceName}>
                        {source.sourceName}
                      </div>
                      <div className="mt-0.5 font-mono-tiny text-[var(--color-text-muted)]">
                        {source.confidence}
                      </div>
                    </div>
                    <div className="min-w-0">
                      <div
                        className="truncate text-[var(--color-text)]"
                        title={source.sourceTitle ?? source.evidence ?? "—"}
                      >
                        {source.sourceTitle ?? "—"}
                      </div>
                      {source.evidence && (
                        <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-muted)]" title={source.evidence}>
                          {source.evidence}
                        </div>
                      )}
                    </div>
                    <div className="font-mono-tiny text-[var(--color-text-muted)]">
                      {formatSourceDate(source.sourceDate)}
                    </div>
                    <div className="flex justify-end">
                      {source.sourceUrl ? (
                        <a
                          href={source.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex h-7 items-center gap-1 rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] px-2 text-[11px] text-[var(--color-accent)] hover:border-[var(--color-card-hover-border)] hover:bg-[var(--color-control-hover)]"
                          title={source.sourceUrl}
                        >
                          打开
                          <ExternalLink size={12} />
                        </a>
                      ) : (
                        <span className="text-[var(--color-text-muted)]">—</span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function SchoolDistrictAuditList({
  data,
  candidates,
}: {
  data: SchoolDistrictAuditResp | undefined;
  candidates: SchoolCommunityCandidatesResp | undefined;
}) {
  const [selectedYear, setSelectedYear] = useState(2026);
  const rows = useMemo(() => {
    const sourceRows = data?.rows ?? [];
    return sourceRows
      .filter((row) => row.year === selectedYear)
      .slice()
      .sort((a, b) => {
        const statusRank: Record<DistrictAuditRowApi["status"], number> = {
          missing: 0,
          "source-found": 1,
          "boundary-text": 2,
          "partially-linked": 3,
          linked: 4,
        };
        const statusDiff = statusRank[a.status] - statusRank[b.status];
        if (statusDiff !== 0) return statusDiff;
        const coverageDiff = a.coveragePercent - b.coveragePercent;
        if (coverageDiff !== 0) return coverageDiff;
        return b.scopeSourceCount - a.scopeSourceCount;
      });
  }, [data?.rows, selectedYear]);
  const summary = data?.summary.find((item) => item.year === selectedYear);
  const years = data?.years.length ? data.years : [2026, 2025];
  const candidateCount = candidates?.stats.byYear[String(selectedYear)] ?? 0;
  const districtCandidateCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of candidates?.summaries ?? []) {
      if (row.year !== selectedYear) continue;
      counts.set(row.district, (counts.get(row.district) ?? 0) + row.count);
    }
    return counts;
  }, [candidates?.summaries, selectedYear]);

  return (
    <section
      id="district-audit"
      className="flex-1 overflow-auto bg-[var(--color-bg)] px-4 py-5 md:px-6"
    >
      <div className="mx-auto flex max-w-[1440px] flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-[15px] font-semibold text-[var(--color-text)]">对口来源和覆盖审计</div>
            <div className="mt-1 text-xs text-[var(--color-text-muted)]">
              汇总 2025 / 2026 区级招生来源、学校边界文本和已结构化的小区对口关系。
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <div className="inline-flex rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] p-0.5 shadow-sm">
              {years.map((year) => {
                const active = selectedYear === year;
                return (
                  <button
                    key={year}
                    type="button"
                    onClick={() => setSelectedYear(year)}
                    className={[
                      "h-7 rounded px-2.5 text-[11px] transition-colors",
                      active
                        ? "bg-[var(--color-control-active)] text-[var(--color-accent)] shadow-sm"
                        : "text-[var(--color-text-dim)] hover:bg-[var(--color-control-hover)] hover:text-[var(--color-text)]",
                    ].join(" ")}
                  >
                    {year}
                  </button>
                );
              })}
            </div>
            <span className="rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] px-2 py-1 text-[var(--color-text-dim)]">
              结构化 {summary?.linkedSchools ?? 0}/{summary?.schoolTotal ?? 0} 校
            </span>
            <span className="rounded-md border border-[var(--color-control-border)] bg-[var(--color-chip-bg)] px-2 py-1 text-[var(--color-text-muted)]">
              对口来源 {summary?.scopeSourceCount ?? 0}
            </span>
            <span className="rounded-md border border-[var(--color-control-border)] bg-[var(--color-chip-bg)] px-2 py-1 text-[var(--color-text-muted)]">
              候选 {candidateCount}
            </span>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          <div className="rounded-lg border border-[var(--color-card-border)] bg-[var(--color-card-bg)] p-3 shadow-sm">
            <div className="text-[11px] text-[var(--color-text-muted)]">学校覆盖</div>
            <div className="mt-1 font-mono text-2xl font-semibold text-[var(--color-text)]">
              {summary?.coveragePercent.toFixed(1) ?? "0.0"}%
            </div>
          </div>
          <div className="rounded-lg border border-[var(--color-card-border)] bg-[var(--color-card-bg)] p-3 shadow-sm">
            <div className="text-[11px] text-[var(--color-text-muted)]">关系行</div>
            <div className="mt-1 font-mono text-2xl font-semibold text-[var(--color-text)]">
              {summary?.linkRows ?? 0}
            </div>
          </div>
          <div className="rounded-lg border border-[var(--color-card-border)] bg-[var(--color-card-bg)] p-3 shadow-sm">
            <div className="text-[11px] text-[var(--color-text-muted)]">边界文本学校</div>
            <div className="mt-1 font-mono text-2xl font-semibold text-[var(--color-text)]">
              {summary?.boundaryTextSchools ?? 0}
            </div>
          </div>
          <div className="rounded-lg border border-[var(--color-card-border)] bg-[var(--color-card-bg)] p-3 shadow-sm">
            <div className="text-[11px] text-[var(--color-text-muted)]">来源候选</div>
            <div className="mt-1 font-mono text-2xl font-semibold text-[var(--color-text)]">
              {summary?.sourceCount ?? 0}
            </div>
          </div>
          <div className="rounded-lg border border-[var(--color-card-border)] bg-[var(--color-card-bg)] p-3 shadow-sm md:col-span-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-[11px] text-[var(--color-text-muted)]">抽取候选池</div>
                <div className="mt-1 text-sm text-[var(--color-text)]">
                  {candidates?.tableReady
                    ? `${candidateCount} 条待审核候选，可用于后续写入正式小区对口关系。`
                    : "候选表尚未创建，先运行建表脚本后再执行抽取。"}
                </div>
              </div>
              <code className="rounded border border-[var(--color-control-border)] bg-[var(--color-code-bg)] px-2 py-1 text-[11px] text-[var(--color-text-dim)]">
                pnpm tsx scripts/extract-school-community-candidates.ts --years={selectedYear}
              </code>
            </div>
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-[var(--color-panel-border)] bg-[var(--color-bg-elev)] shadow-sm">
          <div className="grid grid-cols-[72px_96px_132px_112px_112px_112px_1fr] gap-3 border-b border-[var(--color-panel-border)] bg-[var(--color-section-label-bg)] px-3 py-2 text-[11px] font-medium text-[var(--color-text-dim)] max-lg:hidden">
            <div>区</div>
            <div>状态</div>
            <div>结构化覆盖</div>
            <div>边界文本</div>
            <div>来源</div>
            <div>候选</div>
            <div>优先来源</div>
          </div>

          <div className="divide-y divide-[var(--color-border)]/70">
            {!data ? (
              <div className="px-3 py-8 text-center text-sm text-[var(--color-text-muted)]">
                审计加载中…
              </div>
            ) : rows.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-[var(--color-text-muted)]">
                暂无审计结果
              </div>
            ) : (
              rows.map((row) => {
                const topSources = row.sources.slice(0, 3);
                return (
                  <div
                    key={`${row.year}-${row.district}`}
                    className="grid gap-3 px-3 py-3 text-xs hover:bg-[var(--color-list-row-hover)] lg:grid-cols-[72px_96px_132px_112px_112px_112px_1fr]"
                  >
                    <div className="flex items-start justify-between gap-3 lg:block">
                      <div className="font-semibold text-[var(--color-text)]">{row.district}</div>
                      <div className="font-mono-tiny text-[var(--color-text-muted)] lg:mt-1">{row.year}</div>
                    </div>

                    <div>
                      <span className="inline-flex rounded border border-[var(--color-control-border)] bg-[var(--color-chip-bg)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-dim)]">
                        {AUDIT_STATUS_LABELS[row.status]}
                      </span>
                    </div>

                    <div>
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="font-mono-tiny text-[var(--color-text)]">
                          {row.linkedSchools}/{row.schoolTotal}
                        </span>
                        <span className="font-mono-tiny text-[var(--color-text-muted)]">
                          {row.coveragePercent.toFixed(1)}%
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-progress-track)] ring-1 ring-[var(--color-border)]/45">
                        <div
                          className="h-full rounded-full bg-[var(--color-panel-accent)]"
                          style={{ width: `${Math.max(0, Math.min(100, row.coveragePercent))}%` }}
                        />
                      </div>
                    </div>

                    <div className="font-mono-tiny text-[var(--color-text-dim)]">
                      {row.boundaryTextSchools} 校
                    </div>

                    <div className="font-mono-tiny text-[var(--color-text-dim)]">
                      {row.scopeSourceCount} 对口 / {row.sourceCount} 总
                    </div>

                    <div className="font-mono-tiny text-[var(--color-text-dim)]">
                      {districtCandidateCounts.get(row.district) ?? 0} 条
                    </div>

                    <div className="min-w-0 space-y-1.5">
                      {topSources.length === 0 ? (
                        <span className="text-[var(--color-text-muted)]">未发现候选来源</span>
                      ) : (
                        topSources.map((source) => (
                          <div key={`${source.sourceType}-${source.url ?? source.title}`} className="flex min-w-0 items-center gap-2">
                            <span className="shrink-0 rounded border border-[var(--color-control-border)] bg-[var(--color-chip-bg)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
                              {AUDIT_CATEGORY_LABELS[source.category] ?? source.category}
                            </span>
                            {source.url ? (
                              <a
                                href={source.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex min-w-0 items-center gap-1 text-[var(--color-accent)] underline decoration-dotted underline-offset-2"
                                title={source.url}
                              >
                                <span className="truncate">{source.title}</span>
                                <ExternalLink size={12} className="shrink-0" />
                              </a>
                            ) : (
                              <span className="min-w-0 truncate text-[var(--color-text-dim)]">
                                {source.title}
                              </span>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="text-[11px] leading-5 text-[var(--color-text-muted)]">
          官方入口：
          <a
            href={data?.indexUrl ?? "https://shrxbm.edu.sh.gov.cn/zszc/zcsm.html"}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--color-accent)] underline decoration-dotted underline-offset-2"
          >
            上海市义务教育入学报名系统各区招生政策
          </a>
          。2025 来源包含库内已有来源与已确认的市/区官方页面种子，后续可由脚本继续扩展。
        </div>
      </div>
    </section>
  );
}

function SchoolDirectoryList({
  schools,
  schoolNameQuery,
  onSchoolNameQueryChange,
}: {
  schools: SchoolApi[] | undefined;
  schoolNameQuery: string;
  onSchoolNameQueryChange: (value: string) => void;
}) {
  const selectedSchoolId = useSelection((s) => s.selectedSchoolId);
  const setSelectedSchool = useSelection((s) => s.setSelectedSchool);

  if (!schools) {
    return (
      <section className="flex-1 overflow-auto bg-[var(--color-bg)] px-4 py-5 md:px-6">
        <div className="mx-auto max-w-[1440px] rounded-lg border border-[var(--color-card-border)] bg-[var(--color-empty-bg)] p-6 text-sm text-[var(--color-text-muted)] shadow-sm">
          加载中…
        </div>
      </section>
    );
  }

  return (
    <section
      id="schools"
      className="flex-1 overflow-auto bg-[var(--color-bg)] px-4 py-5 md:px-6"
    >
      <div className="mx-auto flex max-w-[1440px] flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-[15px] font-semibold text-[var(--color-text)]">学校列表</div>
            <div className="mt-1 text-xs text-[var(--color-text-muted)]">
              展示学校基础信息、地址、对口信息摘要与可核验来源字段。
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative block">
              <Search
                size={14}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
              />
              <input
                type="search"
                value={schoolNameQuery}
                onChange={(e) => onSchoolNameQueryChange(e.target.value)}
                placeholder="搜索学校名"
                className="h-8 w-[220px] rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] pl-8 pr-2 text-[12px] text-[var(--color-text)] shadow-sm outline-none transition-colors placeholder:text-[var(--color-text-muted)] hover:border-[var(--color-card-hover-border)] focus:border-[var(--color-card-hover-border)] focus:ring-2 focus:ring-[var(--color-selected-ring)]"
              />
            </label>
            <span className="rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] px-2 py-1 text-[11px] text-[var(--color-text-dim)]">
              共 {schools.length} 所
            </span>
          </div>
        </div>

        {schools.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--color-card-hover-border)] bg-[var(--color-empty-bg)] p-6 text-sm text-[var(--color-text-muted)] shadow-sm">
            当前筛选无结果。可在顶部切换学段或打开更多梯队。
          </div>
        ) : (
          <div className="grid gap-3 xl:grid-cols-2">
            {schools.map((school) => {
              const attrs = (school.attrs as SchoolAttrs | null) ?? {};
              const aliases = schoolAliases(school, attrs);
              const committeeCount = schoolCommitteeCount(attrs);
              const feederCount = schoolFeederCount(attrs);
              const policyUrl = displayValue(attrs.policy_url);
              const enrollment = school.enrollmentNote ?? attrs.enrollment_method ?? attrs.middle_school_route;
              const selected = selectedSchoolId === school.id;

              return (
                <article
                  key={school.id}
                  className={[
                    "rounded-lg border bg-[var(--color-card-bg)] p-4 shadow-sm transition-colors",
                    selected
                      ? "border-[var(--color-card-hover-border)] shadow-[0_0_0_3px_var(--color-selected-ring)]"
                      : "border-[var(--color-card-border)] hover:border-[var(--color-card-hover-border)]",
                  ].join(" ")}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => setSelectedSchool(selected ? null : school.id)}
                      className="min-w-0 text-left"
                    >
                      <div className="text-[15px] font-semibold leading-snug text-[var(--color-text)]">
                        {school.name}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
                        <span>{school.district}</span>
                        <span>#{school.id}</span>
                        {aliases.length > 0 && <span>别名：{aliases.join("、")}</span>}
                      </div>
                    </button>

                    <div className="flex shrink-0 flex-wrap justify-end gap-1.5 text-[11px]">
                      <span className="rounded border border-[var(--color-control-border)] bg-[var(--color-chip-bg)] px-1.5 py-0.5 text-[var(--color-text-dim)]">
                        {school.type === "primary" ? "小学" : school.type === "middle" ? "初中" : "九年一贯"}
                      </span>
                      <span className="rounded border border-[var(--color-control-border)] bg-[var(--color-chip-bg)] px-1.5 py-0.5 text-[var(--color-text-dim)]">
                        {school.schoolNature ?? "性质待补"}
                      </span>
                      <span className="rounded border border-[var(--color-control-border)] bg-[var(--color-chip-bg)] px-1.5 py-0.5 text-[var(--color-text-dim)]">
                        {school.tier ?? "梯队待补"}
                      </span>
                    </div>
                  </div>

                  <div className="mt-3 grid gap-3 text-xs md:grid-cols-2">
                    <div className="min-w-0 rounded-md border border-[var(--color-card-border)] bg-[var(--color-detail-card-bg)] p-3">
                      <div className="mb-1 text-[10px] text-[var(--color-text-muted)]">地址</div>
                      <div className="leading-relaxed text-[var(--color-text-dim)]">
                        {school.address ?? "待补充"}
                      </div>
                    </div>
                    <div className="min-w-0 rounded-md border border-[var(--color-card-border)] bg-[var(--color-detail-card-bg)] p-3">
                      <div className="mb-1 text-[10px] text-[var(--color-text-muted)]">招生 / 升学</div>
                      <div className="line-clamp-3 leading-relaxed text-[var(--color-text-dim)]">
                        {enrollment ?? school.recentScoreLine ?? "待补充"}
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 grid gap-2 text-[11px] text-[var(--color-text-muted)] sm:grid-cols-2 lg:grid-cols-4">
                    <div>对口居委：<span className="text-[var(--color-text-dim)]">{committeeCount || "待补"}</span></div>
                    <div>关联学校：<span className="text-[var(--color-text-dim)]">{feederCount || "—"}</span></div>
                    <div>坐标：<span className="text-[var(--color-text-dim)]">{school.lat != null && school.lng != null ? "已补" : "待补"}</span></div>
                    <div>风险：<span className="text-[var(--color-text-dim)]">{school.pitRiskLevel ?? "unknown"}</span></div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-[var(--color-border)]/60 pt-3 text-[11px]">
                    <span className="text-[var(--color-text-muted)]">
                      来源：{displayValue(attrs.data_source) ?? "—"}
                    </span>
                    {policyUrl && (
                      <a
                        href={policyUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[var(--color-accent)] underline decoration-dotted underline-offset-2"
                      >
                        招生政策
                        <ExternalLink size={12} />
                      </a>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function MapSidebarControls({
  visibleSchools,
  totalSchools,
  schoolNameQuery,
  onSchoolNameQueryChange,
  districtOptions = DISTRICTS,
}: {
  visibleSchools: number;
  totalSchools: number;
  schoolNameQuery: string;
  onSchoolNameQueryChange: (value: string) => void;
  districtOptions?: string[];
}) {
  const district = useSelection((s) => s.selectedDistrict);
  const setDistrict = useSelection((s) => s.setDistrict);
  const typeFilter = useSelection((s) => s.typeFilter);
  const setTypeFilter = useSelection((s) => s.setTypeFilter);
  const visibleTiers = useSelection((s) => s.visibleTiers);
  const toggleTier = useSelection((s) => s.toggleTier);
  const setSelectedSchool = useSelection((s) => s.setSelectedSchool);

  return (
    <div className="shrink-0 border-b border-[var(--color-panel-border)] bg-[var(--color-bg-elev)] p-3 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-[13px] font-semibold text-[var(--color-text)]">搜索筛选</div>
          <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
            当前可见 {visibleSchools}
            {totalSchools !== visibleSchools ? ` / ${totalSchools}` : ""} 所
          </div>
        </div>
      </div>

      <div className="grid gap-3">
        <label className="grid gap-1.5">
          <span className="text-[11px] text-[var(--color-text-muted)]">学校名</span>
          <div className="relative">
            <Search
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
            />
            <input
              type="search"
              value={schoolNameQuery}
              onChange={(e) => onSchoolNameQueryChange(e.target.value)}
              placeholder="输入学校全名或简称"
              className="h-9 w-full rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] pl-8 pr-2.5 text-[13px] text-[var(--color-text)] shadow-sm outline-none transition-colors placeholder:text-[var(--color-text-muted)] hover:border-[var(--color-card-hover-border)] hover:bg-[var(--color-control-hover)] focus:border-[var(--color-card-hover-border)] focus:ring-2 focus:ring-[var(--color-selected-ring)]"
            />
          </div>
        </label>

        <label className="grid gap-1.5">
          <span className="text-[11px] text-[var(--color-text-muted)]">区</span>
          <select
            value={district}
            onChange={(e) => {
              setDistrict(e.target.value);
              setSelectedSchool(null);
            }}
            className="h-9 rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] px-2.5 text-[13px] text-[var(--color-text)] transition-colors hover:border-[var(--color-card-hover-border)] hover:bg-[var(--color-control-hover)] focus:border-[var(--color-card-hover-border)] focus:outline-none focus:ring-2 focus:ring-[var(--color-selected-ring)]"
          >
            {districtOptions.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
        </label>

        <div>
          <div className="mb-1.5 text-[11px] text-[var(--color-text-muted)]">学段</div>
          <div className="inline-flex w-full rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] p-0.5 shadow-sm">
            {FILTER_OPTIONS.map((option) => {
              const active = typeFilter === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setTypeFilter(option.value)}
                  className={[
                    "h-8 flex-1 rounded px-2 text-[12px] transition-colors",
                    active
                      ? "bg-[var(--color-control-active)] text-[var(--color-accent)] shadow-sm"
                      : "text-[var(--color-text-dim)] hover:text-[var(--color-text)]",
                  ].join(" ")}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="mb-1.5 text-[11px] text-[var(--color-text-muted)]">梯队</div>
          <div className="flex flex-wrap gap-1.5">
            {TIER_OPTIONS.map((tier) => {
              const active = visibleTiers.includes(tier.value);
              return (
                <button
                  key={tier.value}
                  type="button"
                  aria-pressed={active}
                  title={`${active ? "隐藏" : "显示"}${tier.label}学校`}
                  onClick={() => toggleTier(tier.value)}
                  className={[
                    "inline-flex h-7 items-center gap-1 rounded-full border px-2 text-[11px] transition-colors",
                    active
                      ? "border-[var(--color-accent-border)] bg-[var(--color-control-active)] text-[var(--color-text)] shadow-sm"
                      : "border-[var(--color-control-border)] bg-[var(--color-control-bg)] text-[var(--color-text-muted)] hover:bg-[var(--color-control-hover)] hover:text-[var(--color-text-dim)]",
                  ].join(" ")}
                >
                  <span
                    className="h-2.5 w-2.5 rounded-full border"
                    style={{
                      backgroundColor: active ? tier.color : "transparent",
                      borderColor: tier.color,
                    }}
                  />
                  <span>{tier.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

    </div>
  );
}

type MapWorkspaceProps = {
  mode?: "workspace" | "map";
};

export default function MapWorkspace({ mode = "workspace" }: MapWorkspaceProps) {
  const mapOnly = mode === "map";
  const district = useSelection((s) => s.selectedDistrict);
  const year = useSelection((s) => s.selectedYear);
  const typeFilter = useSelection((s) => s.typeFilter);
  const visibleTiers = useSelection((s) => s.visibleTiers);
  const selectedSchoolId = useSelection((s) => s.selectedSchoolId);
  const setDistrict = useSelection((s) => s.setDistrict);
  const [viewMode, setViewMode] = useState<ViewMode>("map");
  const [leftWidth, setLeftWidth] = useState(420);
  const [schoolNameQuery, setSchoolNameQuery] = useState("");
  const [mapFocusRequest, setMapFocusRequest] = useState(0);
  const selectedDistrictParam = district === ALL_DISTRICTS ? "" : district;
  const districtOptions = mapOnly ? [ALL_DISTRICTS, ...PRODUCT_DISTRICTS] : DISTRICTS;

  useEffect(() => {
    if (mapOnly && district !== ALL_DISTRICTS && !normalizeProductDistrict(district)) {
      setDistrict(ALL_DISTRICTS);
    }
  }, [district, mapOnly, setDistrict]);

  const schoolsQuery = useQuery({
    queryKey: ["schools", selectedDistrictParam],
    queryFn: async () => {
      const query = new URLSearchParams();
      if (selectedDistrictParam) query.set("district", selectedDistrictParam);
      if (mapOnly) query.set("compact", "1");
      if (mapOnly) query.set("product", "1");
      const res = await fetch(`/api/schools?${query.toString()}`);
      if (!res.ok) throw new Error("failed to load schools");
      const json = await res.json();
      const rows = json.schools as SchoolApi[];
      return mapOnly
        ? rows.filter((school) => normalizeProductDistrict(school.district) !== null)
        : rows;
    },
  });

  const districtsQuery = useQuery({
    queryKey: ["districts", selectedDistrictParam, year],
    queryFn: async () => {
      const params = new URLSearchParams({ year: String(year) });
      if (selectedDistrictParam) params.set("district", selectedDistrictParam);
      if (mapOnly) params.set("product", "1");
      const res = await fetch(
        `/api/districts?${params.toString()}`,
      );
      if (!res.ok) throw new Error("failed to load districts");
      return (await res.json()) as DistrictsFC;
    },
  });

  const communitiesQuery = useQuery({
    queryKey: ["communities", selectedSchoolId, year],
    enabled: selectedSchoolId != null,
    queryFn: async () => {
      const res = await fetch(`/api/communities?schoolId=${selectedSchoolId}&year=${year}`);
      if (!res.ok) throw new Error("failed to load communities");
      return (await res.json()) as CommunitiesResp;
    },
  });

  const dataSourcesQuery = useQuery({
    queryKey: ["data-sources"],
    enabled: !mapOnly,
    queryFn: async () => {
      const res = await fetch("/api/data-sources");
      if (!res.ok) throw new Error("failed to load data sources");
      return (await res.json()) as DataSourcesResp;
    },
  });

  const schoolDistrictAuditQuery = useQuery({
    queryKey: ["school-district-audit"],
    enabled: !mapOnly,
    queryFn: async () => {
      const res = await fetch("/api/school-district-audit?years=2026,2025");
      if (!res.ok) throw new Error("failed to load school district audit");
      return (await res.json()) as SchoolDistrictAuditResp;
    },
  });

  const schoolCommunityCandidatesQuery = useQuery({
    queryKey: ["school-community-candidates"],
    enabled: !mapOnly,
    queryFn: async () => {
      const res = await fetch("/api/school-community-candidates?years=2026,2025");
      if (!res.ok) throw new Error("failed to load school community candidates");
      return (await res.json()) as SchoolCommunityCandidatesResp;
    },
  });

  const filteredSchools = useMemo(() => {
    if (!schoolsQuery.data) return undefined;
    const nameQuery = schoolNameQuery.trim().toLowerCase();
    const productSchools = mapOnly
      ? schoolsQuery.data.filter((school) => PRODUCT_DISTRICTS.includes(school.district as (typeof PRODUCT_DISTRICTS)[number]))
      : schoolsQuery.data;
    return productSchools
      .filter((school) => {
        const typeMatches = typeFilter === "all" || school.type === typeFilter;
        if (!typeMatches || !visibleTiers.includes(normalizeTier(school.tier))) return false;
        if (!nameQuery) return true;

        const attrs = (school.attrs as SchoolAttrs | null) ?? {};
        const aliases = schoolAliases(school, attrs);
        const searchableText = [school.name, ...aliases].join(" ").toLowerCase();
        return searchableText.includes(nameQuery);
      })
      .slice()
      .sort((a, b) => {
        const rankDiff = tierRank(a.tier) - tierRank(b.tier);
        if (rankDiff !== 0) return rankDiff;
        // 同梯队内按区 + 名字稳定排序
        if (a.district !== b.district) return a.district.localeCompare(b.district, "zh-Hans-CN");
        return a.name.localeCompare(b.name, "zh-Hans-CN");
      });
  }, [mapOnly, schoolNameQuery, schoolsQuery.data, typeFilter, visibleTiers]);

  const filteredDistricts = useMemo<DistrictsFC | undefined>(() => {
    if (!districtsQuery.data) return undefined;
    const visibleSchoolIds = new Set(filteredSchools?.map((school) => school.id) ?? []);
    return {
      type: "FeatureCollection",
      features: districtsQuery.data.features.filter((feature) => {
        if (mapOnly && normalizeProductDistrict(feature.properties.district) === null) return false;
        if (!visibleSchoolIds.has(feature.properties.schoolId)) return false;
        const typeMatches =
          typeFilter === "all" || feature.properties.schoolType === typeFilter;
        return typeMatches && visibleTiers.includes(normalizeTier(feature.properties.schoolTier));
      }),
    };
  }, [districtsQuery.data, filteredSchools, mapOnly, typeFilter, visibleTiers]);

  const totalSchools = schoolsQuery.data?.length ?? 0;
  const visibleSchools = filteredSchools?.length ?? 0;

  const communities = communitiesQuery.data?.communities;
  const communityStats = communitiesQuery.data?.stats;

  useEffect(() => {
    if (mapOnly) return;
    const syncViewMode = () => setViewMode(viewModeFromHash(window.location.hash));
    syncViewMode();
    window.addEventListener("hashchange", syncViewMode);
    return () => window.removeEventListener("hashchange", syncViewMode);
  }, [mapOnly]);

  useEffect(() => {
    window.dispatchEvent(new Event("resize"));
  }, [viewMode, leftWidth]);

  const beginResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = leftWidth;

    const onPointerMove = (moveEvent: PointerEvent) => {
      const maxWidth = Math.max(360, window.innerWidth - 520);
      const nextWidth = Math.min(maxWidth, Math.max(320, startWidth + moveEvent.clientX - startX));
      setLeftWidth(nextWidth);
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.dispatchEvent(new Event("resize"));
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }, [leftWidth]);

  return (
    <main className={mapOnly
      ? "flex flex-1 min-h-0 flex-col overflow-hidden"
      : "flex-1 flex flex-col min-h-0 overflow-y-auto"}>
      {!mapOnly && (
        <HeaderBar
          visibleSchools={visibleSchools}
          totalSchools={totalSchools}
          activeView={viewMode}
          onViewChange={setViewMode}
        />
      )}

      {!mapOnly && viewMode === "schools" && (
        <SchoolDirectoryList
          schools={filteredSchools}
          schoolNameQuery={schoolNameQuery}
          onSchoolNameQueryChange={setSchoolNameQuery}
        />
      )}

      {(mapOnly || viewMode === "map") && (
        <div
          id="map"
          className="flex min-h-[420px] flex-1 flex-col overflow-hidden bg-[var(--color-panel-bg)] md:flex-row"
        >
          <aside
            className="flex min-h-[320px] flex-col overflow-hidden border-b border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] md:h-auto md:min-w-[320px] md:border-b-0 md:border-r"
            style={{ width: leftWidth }}
          >
            <MapSidebarControls
              visibleSchools={visibleSchools}
              totalSchools={totalSchools}
              schoolNameQuery={schoolNameQuery}
              onSchoolNameQueryChange={setSchoolNameQuery}
              districtOptions={districtOptions}
            />
            <div className="min-h-0 flex-1">
              <SchoolTable
                schools={filteredSchools}
                communities={communities}
                communityStats={communityStats}
                communitiesLoading={communitiesQuery.isFetching}
                keepSelectionOnClick
                onFocusMap={() => setMapFocusRequest((value) => value + 1)}
              />
            </div>
          </aside>

          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="调整学校列表和地图宽度"
            onPointerDown={beginResize}
            className="hidden w-1.5 shrink-0 cursor-col-resize bg-[var(--color-panel-border)] transition-colors hover:bg-[var(--color-card-hover-border)] md:block"
          />

          <div className="relative min-h-[420px] flex-1 overflow-hidden">
            <AmapContainer
              districts={filteredDistricts}
              schools={filteredSchools}
              communities={communities}
              focusRequest={mapFocusRequest}
              selectedDistrict={selectedDistrictParam}
            />
            <div className="absolute top-4 left-4 px-3 py-2 rounded-md bg-[var(--color-floating-bg)] backdrop-blur-md border border-[var(--color-panel-border)] text-[11px] text-[var(--color-text-dim)] shadow-lg pointer-events-none">
              <span className="text-[var(--color-text)] font-medium">
                {district === ALL_DISTRICTS ? ALL_DISTRICTS : displayProductDistrict(district)}
              </span>
              <span className="text-[var(--color-text-muted)] mx-1.5">·</span>
              <span className="font-mono-tiny text-[var(--color-text-muted)]">
                {visibleSchools} 校
                {communities && ` · ${communities.length} 小区`}
              </span>
            </div>
          </div>
        </div>
      )}

      {!mapOnly && viewMode === "data-sources" && <DataSourcesList data={dataSourcesQuery.data} />}
      {!mapOnly && viewMode === "district-audit" && (
        <SchoolDistrictAuditList
          data={schoolDistrictAuditQuery.data}
          candidates={schoolCommunityCandidatesQuery.data}
        />
      )}
    </main>
  );
}
