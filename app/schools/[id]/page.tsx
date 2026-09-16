import Link from "next/link";
import { notFound } from "next/navigation";
import { MapPin, Navigation, School, Users } from "lucide-react";
import { ProductShell } from "@/components/product/ProductShell";
import { BackButton } from "@/components/product/BackButton";
import { getSchoolById, getSchoolPathways } from "@/lib/product/queries";

export const dynamic = "force-dynamic";

export default async function SchoolDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const school = await getSchoolById(Number(id));
  if (!school) notFound();
  const typeLabel = school.type === "middle" ? "初中" : "小学";
  const location = school.street || school.area || "地址待补充";
  const coordinates = school.lng != null && school.lat != null ? `${school.lng}, ${school.lat}` : "坐标待补充";
  const { downstream, upstream } = await getSchoolPathways(school.id);
  const pathwayLabel = (p: { middleName: string | null; middleTier: number | null; modeLabel: string }) =>
    p.middleTier ? `${p.middleName}（${p.middleTier}梯 · ${p.modeLabel}）` : `${p.middleName}（${p.modeLabel}）`;
  const isPrimary = school.type === "primary";
  const downstreamPaths = downstream.filter((p) => p.middleId);
  const upstreamPaths = upstream.filter((p) => p.middleId);
  return (
    <ProductShell active="/schools">
      <main className="school-detail-page">
        <div className="school-detail-toolbar"><BackButton /><span className="school-detail-breadcrumb">学校查询 <b>/</b> 学校详情</span></div>
        <header className="school-detail-hero">
          <div className="school-detail-hero-copy">
            <div className="school-detail-eyebrow"><span>{school.district}</span><i />{typeLabel}<i />{school.tier ? `${school.tier} 梯队` : "梯队待补"}</div>
            <h1>{school.name}</h1>
            <p>{school.evaluation || "暂无评价摘要，更多学校信息正在持续补充。"}</p>
            <div className="school-detail-location"><MapPin size={15} /><span>{location}</span></div>
          </div>
          <div className="school-detail-hero-aside"><div className="school-detail-aside-label">当前学校</div><School size={27} /><strong>{school.relationCount}</strong><span>条区域关系</span></div>
        </header>
        <section className="school-detail-grid" aria-label="核心指标">
          <article><div className="school-detail-stat-icon blue"><School size={17} /></div><small>学校梯队</small><b>{school.tier ? `${school.tier} 梯队` : "待补充"}</b></article>
          <article><div className="school-detail-stat-icon teal"><Users size={17} /></div><small>关联区域关系</small><b>{school.relationCount}<em> 条</em></b></article>
          <article><div className="school-detail-stat-icon amber"><Navigation size={17} /></div><small>入学方式</small><b>{school.admissionMode || "待补充"}</b></article>
          <article><div className="school-detail-stat-icon violet"><MapPin size={17} /></div><small>所属片区</small><b>{school.area || school.street || "待补充"}</b></article>
        </section>
        <section className="school-detail-columns">
          <article className="school-detail-content"><div className="school-detail-section-head"><span>PROFILE</span><h2>学校信息</h2></div><dl><div><dt>所在区域</dt><dd>{school.district || "待补充"}</dd></div><div><dt>地址 / 街道</dt><dd>{location}</dd></div><div><dt>学校评价</dt><dd>{school.evaluation || "暂无评价"}</dd></div><div><dt>地图坐标</dt><dd>{coordinates}</dd></div></dl><Link href={`/map?school=${school.id}`} className="school-detail-map-link"><MapPin size={16} />在地图中查看</Link></article>
          <article className="school-detail-content school-detail-next"><div className="school-detail-section-head"><span>PATHWAY</span><h2>升学与对口</h2></div>{isPrimary ? (
            downstreamPaths.length ? (
              <div className="school-detail-feeder"><span>对口初中（{downstreamPaths.length}）</span><div className="school-detail-feeder-list">{downstreamPaths.map((p) => <Link key={p.id} className="school-detail-feeder-row" href={`/schools/${p.middleId}`}>{pathwayLabel(p)}</Link>)}</div></div>
            ) : <div className="school-detail-feeder"><span>对口初中</span><strong>暂无明确对口初中</strong></div>
          ) : (
            upstreamPaths.length ? (
              <div className="school-detail-feeder"><span>生源小学（{upstreamPaths.length}）</span><div className="school-detail-feeder-list">{upstreamPaths.map((p) => <Link key={p.id} className="school-detail-feeder-row" href={`/schools/${p.primaryId}`}>{p.primaryName}（{p.modeLabel}）</Link>)}</div></div>
            ) : <div className="school-detail-feeder"><span>生源小学</span><strong>暂无收录生源小学</strong></div>
          )}</article>
        </section>

      </main>
    </ProductShell>
  );
}
