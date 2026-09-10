"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { PRODUCT_DISTRICTS } from "@/lib/product/districts";

type School = { id: number; legacyId: number | null; name: string; district: string; type: string; nature: string | null; tier: string | null; address: string | null; communityCount: number; policyCount: number };
const typeLabel: Record<string, string> = { primary: "小学", middle: "初中", nine_year: "九年一贯" };

export function SchoolExplorer() {
  const [schools, setSchools] = useState<School[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [district, setDistrict] = useState("");
  const [type, setType] = useState("");

  useEffect(() => {
    const p = new URLSearchParams({ limit: "500" });
    if (q) p.set("q", q);
    if (district) p.set("district", district);
    if (type) p.set("type", type);
    const timer = setTimeout(() => {
      setLoading(true);
      void fetch(`/api/v2/schools?${p}`)
        .then((response) => response.json())
        .then((data: { schools: School[] }) => setSchools(data.schools))
        .finally(() => setLoading(false));
    }, 180);
    return () => clearTimeout(timer);
  }, [q, district, type]);

  return <>
    <div className="product-filters">
      <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="搜索学校名称或别名" />
      <select value={district} onChange={(event) => setDistrict(event.target.value)}>
        <option value="">全部区域</option>
        {PRODUCT_DISTRICTS.map((item) => <option key={item} value={item}>{item}</option>)}
      </select>
      <select value={type} onChange={(event) => setType(event.target.value)}>
        <option value="">全部学段</option><option value="primary">小学</option><option value="middle">初中</option><option value="nine_year">九年一贯</option>
      </select>
    </div>
    <div className="result-meta">{loading ? "查询中…" : `显示 ${schools.length} 所学校`}</div>
    <div className="school-grid">{schools.map((school) => <article key={school.id} className="school-card-new">
      <div className="school-card-head"><span className={`tier-pill tier-${school.tier?.slice(0, 1) || "none"}`}>{school.tier || "待补充"}</span><span className="school-type">{typeLabel[school.type] || school.type}</span></div>
      <h3><Link className="school-name-link" href={`/schools/${school.id}`}>{school.name}</Link></h3>
      <p>{school.district} · {school.nature || "性质待补充"}</p>
      <div className="school-card-stats"><span><b>{school.communityCount}</b> 关联小区</span><span><b>{school.policyCount}</b> 政策记录</span></div>
      <div className="school-card-address">{school.address || "地址待补充"}</div>
    </article>)}</div>
  </>;
}
