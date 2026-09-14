"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, ClipboardList, Database, FileText, Map as MapIcon, Palette, School, Search, Settings2 } from "lucide-react";
import { ALL_DISTRICTS, useSelection, type TierFilter, type TypeFilter } from "@/lib/store";
import { ReverseSearch } from "@/components/ReverseSearch";
import { cn } from "@/lib/utils";

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

const THEME_OPTIONS = [
  {
    value: "fresh",
    label: "清爽默认",
    source: "自有",
    description: "亮白底、蓝色强调，适合地图数据工作台。",
    swatches: ["#f7fafc", "#ffffff", "#1871c9"],
  },
  {
    value: "linear",
    label: "Linear",
    source: "awesome-design",
    description: "取 Linear 的精密产品感和薰衣草蓝强调。",
    swatches: ["#f6f7fb", "#ffffff", "#5e6ad2"],
  },
  {
    value: "ibm",
    label: "IBM",
    source: "awesome-design",
    description: "取 Carbon 的企业数据系统感和 IBM Blue。",
    swatches: ["#ffffff", "#f4f4f4", "#0f62fe"],
  },
  {
    value: "notion",
    label: "Notion",
    source: "awesome-design",
    description: "取 Notion 的温和纸面感和紫色强调。",
    swatches: ["#fafaf9", "#ffffff", "#5645d4"],
  },
] as const;

type ThemeValue = (typeof THEME_OPTIONS)[number]["value"];

const NAV_LINKS = [
  { href: "/#map", label: "地图", icon: MapIcon, view: "map" },
  { href: "/#schools", label: "学校", icon: School, view: "schools" },
  { href: "/#data-sources", label: "数据源", icon: FileText, view: "data-sources" },
  { href: "/#district-audit", label: "学区审计", icon: ClipboardList, view: "district-audit" },
] as const;

type HeaderView = (typeof NAV_LINKS)[number]["view"];

interface Props {
  visibleSchools: number;
  totalSchools: number;
  activeView: HeaderView;
  onViewChange: (view: HeaderView) => void;
}

export function HeaderBar({ visibleSchools, totalSchools, activeView, onViewChange }: Props) {
  const district = useSelection((s) => s.selectedDistrict);
  const setDistrict = useSelection((s) => s.setDistrict);
  const typeFilter = useSelection((s) => s.typeFilter);
  const setTypeFilter = useSelection((s) => s.setTypeFilter);
  const visibleTiers = useSelection((s) => s.visibleTiers);
  const toggleTier = useSelection((s) => s.toggleTier);
  const setSelectedSchool = useSelection((s) => s.setSelectedSchool);
  const year = useSelection((s) => s.selectedYear);

  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeValue>("fresh");
  const currentTheme = THEME_OPTIONS.find((item) => item.value === theme) ?? THEME_OPTIONS[0];

  // ⌘K 快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem("schoolpath-theme") as ThemeValue | null;
    if (!saved || !THEME_OPTIONS.some((item) => item.value === saved)) return;
    const frame = window.requestAnimationFrame(() => setTheme(saved));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "fresh") root.removeAttribute("data-theme");
    else root.dataset.theme = theme;
    root.style.colorScheme = "light";
    window.localStorage.setItem("schoolpath-theme", theme);
  }, [theme]);

  return (
    <>
      <header className="app-header sticky top-0 z-40 shrink-0 border-b border-[var(--color-panel-border)] bg-[var(--color-header-bg)] shadow-sm">
        <div className="absolute inset-x-0 top-0 h-1 bg-[image:var(--color-theme-strip)]" aria-hidden />

        <div className="flex min-h-16 flex-wrap items-center gap-4 px-4 pb-3 pt-4 md:px-6">
          <Link
            href="/#map"
            onClick={() => onViewChange("map")}
            className="flex min-w-[210px] items-center gap-3"
            title="返回地图"
          >
            <div className="grid h-11 w-11 place-items-center rounded-lg bg-[var(--color-panel-accent)] text-base font-bold text-white shadow-sm ring-1 ring-[var(--color-accent-border)]/70">
              学
            </div>
            <div className="flex flex-col leading-none">
              <span className="text-[17px] font-semibold tracking-tight text-[var(--color-text)]">学区图谱</span>
              <span className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                上海学区房数据工作台 · {year}
              </span>
            </div>
          </Link>

          <nav
            className="flex items-center gap-1 rounded-lg border border-[var(--color-control-border)] bg-[var(--color-control-bg)] p-1 shadow-sm"
            aria-label="首页导航"
          >
            {NAV_LINKS.map((item) => {
              const Icon = item.icon;
              const active = activeView === item.view;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => onViewChange(item.view)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px] font-medium transition-colors",
                    active
                      ? "bg-[var(--color-control-active)] text-[var(--color-accent)] shadow-sm"
                      : "text-[var(--color-text-dim)] hover:bg-[var(--color-control-hover)] hover:text-[var(--color-text)]",
                  )}
                >
                  <Icon size={14} />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <Link
              href="/db"
              className="flex items-center gap-2 rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] px-3 py-1.5 text-[12px] text-[var(--color-text-dim)] shadow-sm transition-colors hover:border-[var(--color-card-hover-border)] hover:bg-[var(--color-control-hover)]"
              title="数据库控制台"
            >
              <Database size={14} />
              <span>数据库</span>
            </Link>

            <div className="relative">
              <button
                type="button"
                onClick={() => setSettingsOpen((value) => !value)}
                className={cn(
                  "flex h-8 items-center gap-2 rounded-md border px-2.5 text-[11px] transition-colors",
                  settingsOpen
                    ? "border-[var(--color-accent-border)] bg-[var(--color-accent-bg)] text-[var(--color-accent)]"
                    : "border-[var(--color-control-border)] bg-[var(--color-control-bg)] text-[var(--color-text-dim)] hover:border-[var(--color-card-hover-border)] hover:bg-[var(--color-control-hover)]",
                )}
                title={`设置 · 当前配色：${currentTheme.label}`}
                aria-label="设置"
                aria-expanded={settingsOpen}
              >
                <Settings2 size={15} />
                <span
                  className="h-2.5 w-2.5 rounded-full border border-[var(--color-border)]"
                  style={{ backgroundColor: currentTheme.swatches[2] }}
                  aria-hidden
                />
                <span className="hidden 2xl:inline">{currentTheme.label}</span>
              </button>

              {settingsOpen && (
                <div className="theme-menu-card absolute right-0 top-10 z-50 w-[340px] overflow-hidden rounded-lg border border-[var(--color-panel-border)] bg-[var(--color-modal-bg)] p-3 text-sm shadow-[var(--color-card-shadow)]">
                  <div className="absolute inset-x-0 top-0 h-1 bg-[image:var(--color-theme-strip)]" aria-hidden />
                  <div className="mb-3 flex items-center gap-2">
                    <Palette size={15} className="text-[var(--color-accent)]" />
                    <div>
                      <div className="font-medium text-[var(--color-text)]">页面配色</div>
                      <div className="text-[11px] text-[var(--color-text-muted)]">方案来自当前产品与 awesome-design</div>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    {THEME_OPTIONS.map((option) => {
                      const active = theme === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => {
                            setTheme(option.value);
                            setSettingsOpen(false);
                          }}
                          className={cn(
                            "relative w-full overflow-hidden rounded-md border px-3 py-2 text-left transition-colors",
                            active
                              ? "border-[var(--color-card-hover-border)] bg-[var(--color-card-selected-bg)] shadow-[0_0_0_2px_var(--color-selected-ring)]"
                              : "border-[var(--color-control-border)] bg-[var(--color-control-bg)] hover:border-[var(--color-card-hover-border)] hover:bg-[var(--color-control-hover)]",
                          )}
                        >
                          <span
                            className="absolute inset-y-0 left-0 w-1"
                            style={{ backgroundColor: option.swatches[2] }}
                            aria-hidden
                          />
                          <span className="flex items-center justify-between gap-3">
                            <span className="min-w-0">
                              <span className="flex items-center gap-2">
                                <span className="font-medium text-[var(--color-text)]">{option.label}</span>
                                <span className="rounded border border-[var(--color-control-border)] bg-[var(--color-chip-bg)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
                                  {option.source}
                                </span>
                              </span>
                              <span className="mt-1 block text-[11px] leading-snug text-[var(--color-text-muted)]">
                                {option.description}
                              </span>
                            </span>
                            <span className="flex shrink-0 items-center gap-1.5">
                              <span className="flex overflow-hidden rounded-full border border-[var(--color-border)]">
                                {option.swatches.map((color) => (
                                  <span
                                    key={color}
                                    className="h-4 w-4"
                                    style={{ backgroundColor: color }}
                                  />
                                ))}
                              </span>
                              {active && <Check size={14} className="text-[var(--color-accent)]" />}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <a
              href="https://github.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] px-2 py-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-dim)] transition-colors"
              title="版本信息"
            >
              <span className="font-mono-tiny">v0.3 BETA</span>
            </a>
          </div>
        </div>

        {activeView === "schools" && (
        <div className="flex flex-wrap items-center gap-3 border-t border-[var(--color-panel-border)]/70 px-4 py-2 md:px-6">

        {/* District 下拉 */}
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-[var(--color-text-muted)]">区</span>
          <select
            value={district}
            onChange={(e) => {
              setDistrict(e.target.value);
              setSelectedSchool(null);
            }}
            className="text-[13px] bg-[var(--color-control-bg)] border border-[var(--color-control-border)] rounded-md px-2.5 py-1.5 hover:border-[var(--color-card-hover-border)] hover:bg-[var(--color-control-hover)] focus:border-[var(--color-card-hover-border)] focus:outline-none focus:ring-2 focus:ring-[var(--color-selected-ring)] cursor-pointer transition-colors"
          >
            {DISTRICTS.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </div>

        {/* 学段切换 */}
        <div className="inline-flex bg-[var(--color-control-bg)] border border-[var(--color-control-border)] rounded-md p-0.5 shadow-sm">
          {FILTER_OPTIONS.map((opt) => {
            const active = typeFilter === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setTypeFilter(opt.value)}
                className={cn(
                  "px-3 py-1 text-[12px] rounded transition-colors",
                  active
                    ? "bg-[var(--color-control-active)] text-[var(--color-accent)] shadow-sm"
                    : "text-[var(--color-text-dim)] hover:text-[var(--color-text)]",
                )}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        {/* 计数 */}
        <div className="hidden lg:flex flex-col leading-none">
          <span className="text-[10px] text-[var(--color-text-muted)]">当前可见</span>
          <span className="mt-1 text-[14px] font-semibold text-[var(--color-text)]">
            {visibleSchools}
            {totalSchools !== visibleSchools && (
              <span className="font-normal text-[var(--color-text-muted)]"> / {totalSchools}</span>
            )}{" "}
            所
          </span>
        </div>

        {/* 梯队显示开关 */}
        <div className="hidden xl:flex items-center gap-1.5 ml-2 text-[11px] text-[var(--color-text-muted)]">
          <span className="mr-0.5">梯队</span>
          {TIER_OPTIONS.map((tier) => {
            const active = visibleTiers.includes(tier.value);
            return (
              <button
                key={tier.value}
                type="button"
                aria-pressed={active}
                title={`${active ? "隐藏" : "显示"}${tier.label}学校`}
                onClick={() => toggleTier(tier.value)}
                className={cn(
                  "inline-flex h-6 items-center gap-1 rounded-full border px-2 transition-colors",
                  active
                    ? "border-[var(--color-accent-border)] bg-[var(--color-control-active)] text-[var(--color-text)] shadow-sm"
                    : "border-transparent text-[var(--color-text-muted)] hover:border-[var(--color-control-border)] hover:bg-[var(--color-control-hover)] hover:text-[var(--color-text-dim)]",
                )}
              >
                <span
                  className={cn(
                    "h-2.5 w-2.5 rounded-full border transition-all",
                    active ? "scale-100 opacity-100" : "scale-90 bg-transparent opacity-45",
                  )}
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

        <div className="ml-auto flex items-center gap-2">
          {/* 反向查询 trigger 风格化为 cmd+k */}
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="flex items-center gap-2 text-[12px] px-3 py-1.5 rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] hover:border-[var(--color-card-hover-border)] hover:bg-[var(--color-control-hover)] text-[var(--color-text-dim)] transition-colors shadow-sm"
          >
            <Search size={14} />
            <span>小区查学校</span>
            <kbd className="font-mono-tiny px-1 py-0.5 rounded bg-[var(--color-chip-bg)] border border-[var(--color-control-border)] text-[var(--color-text-muted)]">
              ⌘K
            </kbd>
          </button>
        </div>
        </div>
        )}
      </header>

      <ReverseSearch externalOpen={searchOpen} onOpenChange={setSearchOpen} />
    </>
  );
}
