"use client";

import Link from "next/link";
import { BookOpen, ChartNoAxesCombined, ChevronDown, MapPinned, School as SchoolIcon, Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { PRODUCT_DISTRICTS } from "@/lib/product/districts";

type School = {
  id: number;
  district: string;
  name: string;
  type: string;
  tier: number | null;
  area: string | null;
  street: string | null;
  evaluation: string | null;
  feederMiddleSchool: string | null;
  tags: string[];
};
type Relation = {
  id: number;
  district: string;
  schoolName: string;
  committeeName: string;
  area: string | null;
  street: string | null;
  officialAreaLevel: string | null;
  residentialPoi: boolean | null;
  verified: boolean;
  sourceYear: number | null;
  sourceName: string;
};
type DistrictSummary = {
  district: string;
  admissionSystem: string | null;
  schoolCount: number;
  primaryCount: number;
  middleCount: number;
  tierOneCount: number;
  coordinateCount: number;
};
type Tab = "index" | "overview";
type AreaAggregate = { name: string; schools: School[]; relations: Relation[]; verified: number };

const districtOrder = PRODUCT_DISTRICTS.map((district) => district === "浦东" ? "浦东新区" : `${district}区`);
const schoolStages = [["primary", "小学"], ["middle", "初中"], ["nine_year", "九年一贯制"]] as const;
const relationKinds = ["官方招生区域", "住宅小区关系", "来源收录关系"] as const;
const tabs = [
  { id: "index", label: "学校索引", icon: BookOpen },
  { id: "overview", label: "区域概览", icon: ChartNoAxesCombined },
] as const;

function relationKind(relation: Relation) {
  if (relation.officialAreaLevel === "administrative_or_enrollment_area") return "官方招生区域";
  if (relation.residentialPoi === true) return "住宅小区关系";
  return "来源收录关系";
}

function tierLabel(tier: number | null, type: string) {
  if (!tier) return type === "middle" ? "未分级" : "待补";
  return `${tier === 1 ? "一" : tier === 2 ? "二" : tier === 3 ? "三" : "四"}梯队`;
}

function aggregateAreas(schools: School[], relations: Relation[]) {
  const areas = new Map<string, AreaAggregate>();
  function getArea(street: string | null, area: string | null) {
    const name = street || area || "街道 / 片区待补";
    let row = areas.get(name);
    if (!row) {
      row = { name, schools: [], relations: [], verified: 0 };
      areas.set(name, row);
    }
    return row;
  }
  for (const school of schools) getArea(school.street, school.area).schools.push(school);
  for (const relation of relations) {
    const row = getArea(relation.street, relation.area);
    row.relations.push(relation);
    if (relation.verified) row.verified += 1;
  }
  return [...areas.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

export function XuequReplica() {
  const [schools, setSchools] = useState<School[]>([]);
  const [summaries, setSummaries] = useState<DistrictSummary[]>([]);
  // 待审关系池已下线：relations 恒空（区域概览仅展示学校聚合）
  const relations: Relation[] = [];
  const [tab, setTab] = useState<Tab>("index");
  const [district, setDistrict] = useState("");
  const [area, setArea] = useState("");
  const [q, setQ] = useState("");
  const [openDistricts, setOpenDistricts] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/v2/schools?limit=2000", { signal: controller.signal });
        if (!response.ok) throw new Error("学校数据加载失败，请刷新重试。");
        const schoolData = await response.json();
        if (controller.signal.aborted) return;
        setSchools(schoolData.schools);
        setSummaries(schoolData.districts);
        // 待审关系池已下线（2026-09-15 用户决策 B）：relations 恒空，区域概览仅展示学校聚合
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "学校数据加载失败，请刷新重试。");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, []);

  const areas = useMemo(() => [...new Set(schools
    .filter((school) => !district || school.district === district)
    .map((school) => school.street || school.area)
    .filter((value): value is string => Boolean(value)),
  )].sort((a, b) => a.localeCompare(b, "zh-CN")), [schools, district]);

  const relationSearch = useMemo(() => {
    const names = new Map<string, string[]>();
    for (const relation of relations) {
      const key = `${relation.district}:${relation.schoolName}`;
      const values = names.get(key) ?? [];
      values.push(relation.committeeName);
      names.set(key, values);
    }
    return new Map([...names].map(([key, values]) => [key, values.join(" ")]));
  }, [relations]);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    return schools.filter((school) => {
      if (district && school.district !== district) return false;
      if (area && (school.street || school.area) !== area) return false;
      const text = [school.name, school.district, school.street, school.area, school.evaluation,
        relationSearch.get(`${school.district}:${school.name}`)].join(" ");
      return !query || text.toLowerCase().includes(query);
    });
  }, [schools, relationSearch, district, area, q]);

  // Overview uses only district selection; index search survives view changes.
  const overview = useMemo(() => districtOrder
    .filter((name) => !district || name === district)
    .map((name) => {
      const districtSchools = schools.filter((school) => school.district === name);
      const districtRelations = relations.filter((relation) => relation.district === name);
      return {
        district: name,
        summary: summaries.find((summary) => summary.district === name),
        schools: districtSchools,
        relations: districtRelations,
        areas: aggregateAreas(districtSchools, districtRelations),
      };
    }), [schools, relations, summaries, district]);

  function toggleGroup(key: string) {
    setOpenDistricts((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="schoolpath-page school-workspace">
      <header className="sw-hero">
        <h1>上海学校与学区关系</h1>
        <span>九区学校目录</span>
      </header>
      <div className="sw-content">
        <div className="sw-tabs" role="tablist" aria-label="学校视图">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id} id={`school-tab-${id}`} role="tab" type="button"
              aria-selected={tab === id} aria-controls={`school-panel-${id}`}
              tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === "Home" ? "index" : event.key === "End" ? "overview" : tab === "index" ? "overview" : "index";
                setTab(next);
                document.getElementById(`school-tab-${next}`)?.focus();
              }}
            >
              <Icon size={18} aria-hidden="true" />{label}
            </button>
          ))}
        </div>

        <div className="sw-controls">
          {tab === "index" && (
            <div className="sw-search" role="search">
              <Search size={22} aria-hidden="true" />
              <input
                ref={searchRef} type="search" aria-label="搜索学校、街道、片区或区域名称"
                placeholder="搜索学校、街道、片区或区域名称"
                value={q} onChange={(event) => setQ(event.target.value)}
              />
              <button
                type="button" className="sw-clear" title="清除搜索" aria-label="清除搜索" disabled={!q}
                onClick={() => { setQ(""); searchRef.current?.focus(); }}
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>
          )}
          <div className="sw-filters">
            <label className="sw-filter" htmlFor="school-district">
              <span>区域</span>
              <span className="sw-select">
                <select id="school-district" aria-label="区域" value={district} onChange={(event) => {
                  setDistrict(event.target.value);
                  setArea("");
                  setOpenDistricts(new Set());
                }}>
                  <option value="">全部（9区）</option>
                  {districtOrder.map((name) => <option key={name}>{name}</option>)}
                </select>
                <ChevronDown size={16} aria-hidden="true" />
              </span>
            </label>
            {tab === "index" && (
              <label className="sw-filter" htmlFor="school-area">
                <span>街道 / 片区</span>
                <span className="sw-select">
                  <select id="school-area" aria-label="街道 / 片区" value={area} onChange={(event) => setArea(event.target.value)}>
                    <option value="">全部街道 / 片区</option>
                    {areas.map((name) => <option key={name}>{name}</option>)}
                  </select>
                  <ChevronDown size={16} aria-hidden="true" />
                </span>
              </label>
            )}
            {!loading && !error && <p className="sw-scope" role="status">
              {tab === "index" ? `筛选结果：${filtered.length} 所学校` : `${district || "全部九区"} · 全区统计`}
            </p>}
          </div>
        </div>

        {loading && <p className="sw-empty" role="status">正在加载学校与区域数据…</p>}
        {error && <p className="sw-empty" role="alert">{error}</p>}
        <div id="school-panel-index" role="tabpanel" aria-labelledby="school-tab-index" hidden={tab !== "index"}>
          {!loading && !error && filtered.length === 0 && <p className="sw-empty">没有符合条件的学校</p>}
          {tab === "index" && !loading && !error && districtOrder.filter((name) => !district || name === district).map((name) => {
            const districtSchools = filtered.filter((school) => school.district === name);
            const admission = summaries.find((summary) => summary.district === name)?.admissionSystem;
            return schoolStages.map(([type, label]) => {
              const groupSchools = districtSchools.filter((school) => school.type === type);
              if (!groupSchools.length) return null;
              const groupKey = `${name}-${type}`;
              const isOpen = openDistricts.has(groupKey);
              return (
                <section className={`xq-section sw-school-group ${isOpen ? "is-open" : ""}`} key={groupKey}>
                  <h2>
                    <button className="xq-section-toggle" type="button" aria-expanded={isOpen}
                      aria-controls={`school-group-${groupKey}`} onClick={() => toggleGroup(groupKey)}>
                      <SchoolIcon size={19} aria-hidden="true" />
                      <span className="sw-group-title">{name} · {label}</span>
                      {type === "primary" && admission && <span className="sw-admission">{admission}</span>}
                      <span className="sw-group-count">{groupSchools.length} 所</span>
                      <ChevronDown className="xq-section-chevron" size={18} aria-hidden="true" />
                    </button>
                  </h2>
                  <div id={`school-group-${groupKey}`} hidden={!isOpen}>
                    {isOpen && <SchoolTable schools={groupSchools} />}
                  </div>
                </section>
              );
            });
          })}
        </div>
        <div id="school-panel-overview" role="tabpanel" aria-labelledby="school-tab-overview" hidden={tab !== "overview"}>
          {tab === "overview" && !loading && !error && overview.map((row) => <DistrictDashboard key={row.district} {...row} />)}
        </div>
      </div>
    </div>
  );
}

function DistrictDashboard({ district, summary, schools, relations, areas }: {
  district: string;
  summary: DistrictSummary | undefined;
  schools: School[];
  relations: Relation[];
  areas: AreaAggregate[];
}) {
  const verifiedCount = relations.filter((relation) => relation.verified).length;
  const years = [...new Set(relations.map((relation) => relation.sourceYear)
    .filter((year): year is number => year !== null))].sort((a, b) => a - b);
  const unknownYears = relations.filter((relation) => relation.sourceYear === null).length;
  return (
    <section className="sw-district" aria-labelledby={`overview-${district}`}>
      <header className="sw-district-heading">
        <h2 id={`overview-${district}`}><MapPinned size={20} aria-hidden="true" />{district}</h2>
        <p>入学方式：{summary?.admissionSystem || "待补充"}</p>
      </header>
      <h3 className="sw-subheading">全区学校</h3>
      {summary ? (
        <dl className="sw-metrics">
          {[
            ["学校总数", summary.schoolCount], ["小学", summary.primaryCount], ["初中", summary.middleCount],
            ["一梯队（来源评价）", summary.tierOneCount], ["有地图坐标", summary.coordinateCount],
          ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
      ) : <p className="sw-muted">暂无学校统计</p>}
      <div className="sw-relations-heading">
        <h3 className="sw-subheading">来源关系</h3>
        <span>{relations.length} 条 · 已核验 {verifiedCount} 条 · 待核验 {relations.length - verifiedCount} 条</span>
      </div>
      <dl className="sw-relation-counts">
        {relationKinds.map((kind) => <div key={kind}><dt>{kind}</dt><dd>{relations.filter((relation) => relationKind(relation) === kind).length}</dd></div>)}
      </dl>
      <p className="sw-source-meta">
        关系来源年份：{years.length ? years.join("、") : "待补充"}
        {unknownYears > 0 && years.length > 0 && `；年份待补 ${unknownYears} 条`}
      </p>
      <div className="sw-relations-heading">
        <h3 className="sw-subheading">街道 / 片区汇总</h3>
        <span>收录范围：{schools.length} 所学校 · {relations.length} 条来源关系</span>
      </div>
      {areas.length ? (
        <div className="sw-area-table-wrap" role="region" aria-label={`${district}街道片区统计`} tabIndex={0}>
          <table className="sw-area-table">
            <caption className="sw-sr-only">{district}街道与片区收录统计</caption>
            <thead><tr><th scope="col">街道 / 片区</th><th scope="col">学校</th><th scope="col">来源关系</th><th scope="col">已核验关系</th></tr></thead>
            <tbody>{areas.map((area) => <StreetRows key={area.name} area={area} />)}</tbody>
          </table>
        </div>
      ) : <p className="sw-muted">暂无街道或片区统计</p>}
    </section>
  );
}

function StreetRows({ area }: { area: AreaAggregate }) {
  const [isOpen, setIsOpen] = useState(false);
  const id = useId();
  const buttonId = `street-toggle-${id}`;
  const detailsId = `street-details-${id}`;

  return (
    <>
      <tr>
        <th scope="row">
          <button
            id={buttonId}
            className="sw-street-toggle"
            type="button"
            aria-expanded={isOpen}
            aria-controls={detailsId}
            onClick={() => setIsOpen((current) => !current)}
          >
            <ChevronDown size={16} aria-hidden="true" />
            <span>{area.name}</span>
          </button>
        </th>
        <td>{area.schools.length}</td>
        <td>{area.relations.length}</td>
        <td>{area.verified}</td>
      </tr>
      <tr className="sw-street-detail-row" hidden={!isOpen}>
        <td colSpan={4}>
          <div id={detailsId} role="region" aria-labelledby={buttonId} className="sw-street-details">
            {isOpen && (
              <>
                <h4>学校 · {area.schools.length} 所</h4>
                {area.schools.length ? (
                  <div className="sw-street-schools">
                    {area.schools.map((school) => (
                      <article className="sw-street-school" key={school.id}>
                        <header>
                          <h5><Link className="xq-school-name" href={`/schools/${school.id}`}>{school.name}</Link></h5>
                          <span className={`xq-tier tier-${school.tier || 0}`}>{tierLabel(school.tier, school.type)}</span>
                          {school.tags.map((tag) => <span className="xq-tag" key={tag}>{tag}</span>)}
                          <Link
                            className="xq-map-btn"
                            href={`/map?district=${encodeURIComponent(school.district)}&school=${encodeURIComponent(school.name)}`}
                            aria-label={`在地图查看${school.name}`}
                            title={`在地图查看${school.name}`}
                          >
                            <MapPinned size={16} aria-hidden="true" />
                          </Link>
                        </header>
                        <p>{school.evaluation || "评价待补充"}</p>
                        <p className="sw-muted">对口初中：{school.feederMiddleSchool || "待补充"}</p>
                      </article>
                    ))}
                  </div>
                ) : <p className="sw-muted">暂无收录学校</p>}

                <h4>来源关系 · {area.relations.length} 条</h4>
                {area.relations.length ? (
                  <ul className="sw-street-relations">
                    {area.relations.map((relation) => (
                      <li key={relation.id}>
                        <div className="sw-street-relation-names">
                          <strong>{relation.committeeName}</strong>
                          <span>学校：{relation.schoolName}</span>
                        </div>
                        <div className="sw-street-relation-meta">
                          <span>{relationKind(relation)}</span>
                          <span>{relation.verified ? "已核验" : "待核验"}</span>
                          <span>{relation.sourceYear ?? "年份待补"}</span>
                          <span>{relation.sourceName || "来源待补"}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : <p className="sw-muted">暂无来源关系</p>}
              </>
            )}
          </div>
        </td>
      </tr>
    </>
  );
}

function SchoolTable({ schools }: { schools: School[] }) {
  return (
    <div className="xq-table-wrap" role="region" aria-label="学校列表" tabIndex={0}>
      <table className="xq-table">
        <thead><tr><th scope="col">梯队</th><th scope="col">学校</th><th scope="col">街道 / 片区</th><th scope="col">评价</th><th scope="col">地图</th></tr></thead>
        <tbody>{schools.map((s) => (
          <tr key={s.id}>
            <td><span className={`xq-tier tier-${s.tier || 0}`}>{tierLabel(s.tier, s.type)}</span></td>
            <td>
              <Link className="xq-school-name" href={`/schools/${s.id}`}>{s.name}</Link>
              {s.tags.map((tag) => <span className="xq-tag" key={tag}>{tag}</span>)}
            </td>
            <td>{s.street || s.area || "待补充"}</td>
            <td>{s.evaluation || "待补充"}</td>
            <td><Link className="xq-map-btn"
              href={`/map?district=${encodeURIComponent(s.district)}&school=${encodeURIComponent(s.name)}`}
              aria-label={`在地图查看${s.name}`} title={`在地图查看${s.name}`}>
              <MapPinned size={16} strokeWidth={1.9} aria-hidden="true" />
            </Link></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
