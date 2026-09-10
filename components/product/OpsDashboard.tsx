"use client";
import { Activity, AlertTriangle, ArrowRight, Check, ChevronDown, Database, Filter, Gauge, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type Relation = {
  id: number;
  district: string;
  schoolName: string;
  committeeName: string;
  catalogSchoolName: string | null;
  catalogCommunityName: string | null;
  catalogCommitteeName: string | null;
  schoolMatchScore: number;
  communityMatchMethod: string;
};
type RelationPage = { relations: Relation[]; total: number; page: number; pageSize: number };
type CompletionMetric = { total:number;complete:number;percent:number };
type Completeness = {
  year:number;
  city:{overall:{percent:number};schools:CompletionMetric;tiers:CompletionMetric;schoolNature:CompletionMetric;schoolLocation:CompletionMetric;schoolCommunities:CompletionMetric;communityLocation:CompletionMetric;communityPreciseCoordinates:CompletionMetric};
  availableTags:string[];
  details:Array<{id:number;name:string;district:string;type:string;percent:number;missingTags:string[]}>;
};
type OpsSummary = {
  overview: Record<string, number>;
  runs: Array<{id:number;name:string;fetchedAt:string;pageTitle:string;contentHash:string;stats:Record<string, number>|null}>;
  matches: Array<{status:string;count:number}>;
  conflicts: Array<{fieldName:string;status:string;count:number}>;
  relationStatuses: Array<{status:string;count:number}>;
};

const overviewLabels:Record<string,string>={schools:"产品学校",communities:"产品小区",assignments:"学校小区关系",policies:"政策记录",pending_matches:"待匹配学校",conflicts:"待处理冲突",pending_relations:"待审核关系",matched_relations:"可直接审核关系"};
const overviewGroups=[
  {label:"数据规模",keys:["schools","communities","assignments","policies"],icon:Database},
  {label:"待处理事项",keys:["pending_matches","conflicts"],icon:AlertTriangle},
  {label:"关系审核",keys:["pending_relations","matched_relations"],icon:ShieldCheck},
] as const;
const relationStatuses:Record<string,string>={pending:"待处理",suggested:"待建议",accepted:"已接受",rejected:"已拒绝"};
const conflictFields:Record<string,string>={coordinates:"坐标",tier:"梯队"};

export function OpsDashboard() {
  const [data,setData]=useState<OpsSummary>();
  const [completeness,setCompleteness]=useState<Completeness>();
  const [relations,setRelations]=useState<Relation[]>([]);
  const [district,setDistrict]=useState("");
  const [page,setPage]=useState(1);
  const [total,setTotal]=useState(0);
  const pageSize=30;
  const [message,setMessage]=useState("");
  const loadSummary=useCallback(()=>fetch("/api/v2/ops").then(r=>r.json()).then(setData),[]);
  const loadRelations=useCallback(()=>{
    const params=new URLSearchParams({status:"pending",page:String(page),pageSize:String(pageSize)});
    if(district)params.set("district",district);
    return fetch(`/api/v2/ops/relations?${params}`).then(r=>r.json()).then((body:RelationPage)=>{
      const lastPage=Math.max(1,Math.ceil(body.total/pageSize));
      if(page>lastPage){setPage(lastPage);return}
      setRelations(body.relations);setTotal(body.total)
    });
  },[district,page]);
  useEffect(()=>{void loadSummary();fetch("/api/completeness").then(r=>r.json()).then(setCompleteness)},[loadSummary]);
  useEffect(()=>{void loadRelations()},[loadRelations]);
  function changeDistrict(value:string){setDistrict(value);setPage(1)}
  async function review(id:number,action:"accept"|"reject"){
    setMessage("");
    const response=await fetch(`/api/v2/ops/relations/${id}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({action})});
    const body=await response.json();
    if(!response.ok){setMessage(body.error??"审核失败");return}
    setMessage(action==="accept"?"关系已接受，等待发布批次":"关系已拒绝");
    await Promise.all([loadSummary(),loadRelations()]);
  }
  if(!data)return <div className="empty-state">正在加载监控数据…</div>;
  return <>
    <div className="ops-dashboard-intro"><div><span className="ops-section-kicker">TODAY AT A GLANCE</span><h2>运营概览</h2><p>先看数据规模，再处理需要人工确认的事项。</p></div><span className="ops-updated"><Activity size={13} /> 数据源已接入</span></div>
    <div className="ops-stats">{overviewGroups.map(({label,keys,icon:Icon})=><section className="ops-stat-group" key={label}><div className="ops-stat-group-head"><span><Icon size={14} /> {label}</span><small>{keys.reduce((sum,key)=>sum+Number(data.overview[key]??0),0).toLocaleString()} 项</small></div><div className="ops-stat-group-grid">{keys.map(key=><div key={key}><b>{Number(data.overview[key]??0).toLocaleString()}</b><span>{overviewLabels[key]||key}</span></div>)}</div></section>)}</div>
    <CompletenessPanel data={completeness}/>
    <div className="ops-columns"><section><div className="ops-panel-head"><div><span className="ops-section-kicker">SOURCE RUNS</span><h2>采集批次</h2><p>最近一次同步的来源与覆盖范围。</p></div><Database size={18} /></div>{data.runs.map((run)=><article className="ops-row" key={run.id}><div><b>{run.name}</b><span className="ops-status success"><Check size={11} /> 已完成</span></div><time>{new Date(run.fetchedAt).toLocaleString("zh-CN")}</time><small>{run.pageTitle}</small><span className="ops-run-stats">覆盖 {run.stats?.districtCount??0} 个区域 · {run.stats?.committeeRelationCount??0} 条关系 · {run.stats?.coordinateCount??0} 个坐标</span><code>{run.contentHash.slice(0,16)}…</code></article>)}</section><section><div className="ops-panel-head"><div><span className="ops-section-kicker">DATA QUALITY</span><h2>质量队列</h2><p>需要人工确认或补充的数据。</p></div><AlertTriangle size={18} /></div><h3 className="ops-subhead">实体匹配</h3>{data.matches.map((row)=><article className="ops-row compact" key={row.status}><b>{relationStatuses[row.status]||row.status}</b><strong>{Number(row.count).toLocaleString()}</strong></article>)}<h3 className="ops-subhead">字段冲突</h3>{data.conflicts.map((row)=><article className="ops-row compact" key={`${row.fieldName}-${row.status}`}><b>{conflictFields[row.fieldName]||row.fieldName}</b><span>{relationStatuses[row.status]||row.status}</span><strong>{Number(row.count).toLocaleString()}</strong></article>)}</section></div>
    <section className="ops-review"><div className="ops-review-head"><div><span>RELATION REVIEW</span><h2>学区关系候选审核</h2><p>将来源中的学校与小区关系，确认后进入待发布队列。</p></div><label><span>筛选区域</span><select value={district} onChange={event=>changeDistrict(event.target.value)}><option value="">全部区域</option>{["徐汇区","黄浦区","长宁区","静安区","虹口区","杨浦区","浦东新区","闵行区"].map(item=><option key={item}>{item}</option>)}</select></label></div><div className="ops-review-guide"><span><ArrowRight size={13} /> 来源关系</span><span><ArrowRight size={13} /> 系统候选</span><span><Check size={13} /> 接受后待发布</span></div>{message&&<div className="ops-message">{message}</div>}<div className="ops-review-list">{relations.map(relation=>{const ready=Boolean(relation.catalogSchoolName&&relation.catalogCommunityName);return <article className="ops-review-row" key={relation.id}><div><small>{relation.district} · 来源学校</small><b>{relation.schoolName}</b><span><ArrowRight size={12} /> {relation.committeeName}</span></div><div><small>学校候选{relation.schoolMatchScore>0?` · 相似度 ${(relation.schoolMatchScore*100).toFixed(0)}%`:""}</small><b>{relation.catalogSchoolName??"未找到候选"}</b><small>小区候选 · {relation.communityMatchMethod.replaceAll("_"," ")}</small><span>{relation.catalogCommunityName??"未唯一匹配"}{relation.catalogCommitteeName?` · ${relation.catalogCommitteeName}`:""}</span></div><div className="ops-review-actions"><button disabled={!ready} title={!ready?"学校和小区都匹配后才能接受":"接受此关系"} onClick={()=>review(relation.id,"accept")}><Check size={13} /> 接受</button><button className="reject" title="拒绝此关系" onClick={()=>review(relation.id,"reject")}><X size={13} /> 拒绝</button></div></article>})}</div><div className="ops-pagination"><span>共 {total.toLocaleString()} 条 · 第 {page} / {Math.max(1,Math.ceil(total/pageSize))} 页</span><div><button disabled={page<=1} onClick={()=>setPage(value=>value-1)}>上一页</button><button disabled={page>=Math.ceil(total/pageSize)} onClick={()=>setPage(value=>value+1)}>下一页</button></div></div></section>
  </>;
}

const metricLabels:[keyof Completeness["city"],string][]=[["schools","基础信息"],["tiers","梯队"],["schoolNature","学校性质"],["schoolLocation","学校位置"],["schoolCommunities","对口小区"],["communityLocation","小区位置"],["communityPreciseCoordinates","精确坐标"]];
const typeLabels:Record<string,string>={primary:"小学",middle:"初中",nine_year:"九年一贯制"};

function CompletenessPanel({data}:{data:Completeness|undefined}){
  const[tag,setTag]=useState("");
  const[district,setDistrict]=useState("");
  const districts=useMemo(()=>data?[...new Set(data.details.map(row=>row.district))].sort((left,right)=>left.localeCompare(right,"zh-CN")):[],[data]);
  const rows=useMemo(()=>data?.details.filter(row=>(!district||row.district===district)&&(!tag||row.missingTags.includes(tag)))??[],[data,district,tag]);
  if(!data)return <section className="ops-completeness"><div className="empty-state">数据完备度加载中…</div></section>;
  return <details className="ops-completeness">
    <summary>
      <div className="ops-completeness-summary-main">
        <span className="ops-completeness-kicker"><Gauge size={14} aria-hidden="true" /> DATA COMPLETENESS · {data.year}</span>
        <h2>数据完备度</h2>
        <p>学校资料完整性与缺失字段概览</p>
      </div>
      <div className="ops-completeness-summary-side">
        <div className="ops-completeness-ring" style={{"--completion":`${data.city.overall.percent}%`} as React.CSSProperties}><strong>{data.city.overall.percent.toFixed(0)}<small>%</small></strong></div>
        <span>{data.details.length.toLocaleString()} 所学校</span>
      </div>
      <ChevronDown className="ops-completeness-chevron" size={20} aria-hidden="true" />
    </summary>
    <div className="ops-completeness-body">
      <div className="ops-completeness-metrics">{metricLabels.map(([key,label],index)=>{const metric=data.city[key] as CompletionMetric;return <article key={key}><div className="ops-completeness-metric-head"><span>{String(index+1).padStart(2,"0")}</span><b>{metric.percent.toFixed(0)}%</b></div><strong>{label}</strong><small>{metric.complete.toLocaleString()} / {metric.total.toLocaleString()}</small><i><em style={{width:`${metric.percent}%`}} /></i></article>})}</div>
      <div className="ops-completeness-tools"><label><span><Filter size={13} aria-hidden="true" /> 区域</span><select value={district} onChange={event=>setDistrict(event.target.value)}><option value="">全部区域</option>{districts.map(item=><option key={item}>{item}</option>)}</select></label><div className="ops-completeness-tag-filter"><span>按缺失标签过滤</span><button className={!tag?"active":""} onClick={()=>setTag("")}>全部</button>{data.availableTags.map(item=><button className={tag===item?"active":""} key={item} onClick={()=>setTag(item)}>{item}</button>)}</div></div>
      <div className="ops-completeness-result"><span>当前显示 {rows.length.toLocaleString()} 所学校</span>{rows.length===0&&<p>没有符合当前过滤条件的学校。</p>}<div className="ops-completeness-list">{rows.map(row=><article key={row.id}><div><b>{row.name}</b><span>{row.district} · {typeLabels[row.type]||row.type}</span></div><strong>{row.percent}%</strong><div>{row.missingTags.length?row.missingTags.map(item=><i key={item}>{item}</i>):<i className="complete">数据完整</i>}</div></article>)}</div></div>
    </div>
  </details>;
}
