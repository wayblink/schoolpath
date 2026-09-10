import Link from "next/link";
import { House, MessagesSquare, School, TrendingUp } from "lucide-react";
import { ProductShell } from "@/components/product/ProductShell";
import { getOverview } from "@/lib/product/queries";

export const dynamic = "force-dynamic";

const entries=[
  {href:'/schools',index:'01',title:'找学校',description:'按区域、学段、性质和梯队筛选，快速找到值得比较的学校。',accent:'blue'},
  {href:'/pathways',index:'02',title:'查升学路径',description:'沿小学到初中的关系，分清固定对口、九年一贯和派位候选。',accent:'violet'},
  {href:'/map',index:'03',title:'地图找校/房',description:'把学校、小区、区域和学区边界放在一起，核对实际居住位置。',accent:'green'},
  {href:'/sources',index:'04',title:'信息源',description:'按类型、区域和年份查看政策与招生记录，知道每条信息从哪里来。',accent:'amber'},
];

const roadmap = [
  {icon: <TrendingUp size={22} aria-hidden="true" />, title: '升学变化趋势', description: '持续整理升学路径与招生变化，辅助判断学校选择。'},
  {icon: <House size={22} aria-hidden="true" />, title: '学区房价格趋势', description: '结合小区与区域信息，逐步观察学区房价格变化。'},
  {icon: <School size={22} aria-hidden="true" />, title: '学校风评画像', description: '汇总可追溯的学校信息，形成更完整的比较视角。'},
  {icon: <MessagesSquare size={22} aria-hidden="true" />, title: '教育舆情分析', description: '后续分析公开教育讨论，识别值得继续核对的信号。'},
];

export default async function Home(){
  const o=await getOverview();
  return <ProductShell><main className="product-page home-page">
    <section className="product-hero"><div><span className="hero-kicker">上海学区决策助手 · 2026</span><h1>上海学区选择决策助手</h1><p>把学校 → 升学路径 → 学区房 → 信息源放在一起，帮你盘清楚</p></div><div className="hero-data-card"><span>当前产品数据</span><b>{o.schools.toLocaleString()}<small> 所学校</small></b><div><span>{o.communities.toLocaleString()} 小区</span><span>{o.assignments.toLocaleString()} 关系</span><span>{o.policies.toLocaleString()} 条信息源</span></div><p>{o.pending_matches} 条第三方学校信息待核对 · {o.conflicts} 条字段仍在复核</p></div></section>
    <section className="entry-section"><div className="home-section-heading entry-section-heading"><span>Feature</span></div><div className="entry-grid">{entries.map(e=><Link href={e.href} className={`entry-card ${e.accent}`} key={e.href}><span className="entry-index">{e.index}</span><h3>{e.title}</h3><p>{e.description}</p><span className="entry-link">进入 →</span></Link>)}</div></section>
    <section className="home-section home-coverage" aria-labelledby="home-coverage-title">
      <div className="home-section-heading"><span>AI ROADMAP</span><h2 id="home-coverage-title">AI 驱动的学区决策助手</h2><p className="home-coverage-intro">当前先用真实学校、关系和来源数据打基础，后续逐步加入趋势洞察与舆情分析。以下能力均为未来规划，尚未上线。</p></div>
      <div className="home-coverage-grid">
        {roadmap.map((item) => <article className="home-coverage-card" key={item.title} style={{ display: 'grid', gap: 10, minWidth: 0, padding: '20px 0 19px' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40, borderRadius: 10, background: '#e6f4f7', color: '#23728b' }}>{item.icon}</span>
          <h3 style={{ margin: 0, color: '#153f67', fontSize: 17, lineHeight: 1.35 }}>{item.title}</h3>
          <p style={{ margin: 0, color: '#667b91', fontSize: 12, lineHeight: 1.65 }}>{item.description}</p>
          <span style={{ width: 'max-content', padding: '3px 7px', borderRadius: 999, background: '#eef3f8', color: '#557086', fontSize: 10 }}>规划中</span>
        </article>)}
      </div>
    </section>
    <section className="home-section home-quality" aria-labelledby="home-quality-title">
      <div><span>Vision &amp; Commitment</span><h2 id="home-quality-title"><em>“一个程序员宝爸的自我修养”</em></h2></div>
    </section>
  </main></ProductShell>;
}
