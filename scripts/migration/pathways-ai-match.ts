// school_pathways AI 语义匹配补丁：把 unmatched 行的 raw_text（初中简称）人工语义映射到 schools id。
// 2026-09-15 由 AI 逐条对照各区 middle 学校池完成（简称→全名：位育初级→上海市位育初级中学等）。
// 幂等：UPDATE 定位行（middle_school_id is null + raw_text + 小学区县），重复执行无副作用。
// 用法：npx tsx scripts/migration/pathways-ai-match.ts
import pg from "pg";
import { loadLocalEnv } from "../load-env";

loadLocalEnv();

// 候选名 → 目标初中 id（每条经核对：id 存在、type=middle、与 feeder 小学同区；重复录入取官方全称条目）
const MAPPINGS: { candidate: string; district: string; middleId: number }[] = [
  // 长宁
  { candidate: "天山初中", district: "长宁", middleId: 5997 },
  { candidate: "延安初中", district: "长宁", middleId: 4589 },
  { candidate: "市三女初", district: "长宁", middleId: 5589 },
  { candidate: "华政", district: "长宁", middleId: 5998 },
  { candidate: "延安", district: "长宁", middleId: 4589 },
  { candidate: "市三", district: "长宁", middleId: 5589 },
  { candidate: "复旦初中", district: "长宁", middleId: 5085 },
  { candidate: "仙霞高中", district: "长宁", middleId: 6000 },
  { candidate: "延安实验", district: "长宁", middleId: 6001 },
  // 徐汇
  { candidate: "市四", district: "徐汇", middleId: 4602 },
  { candidate: "市二", district: "徐汇", middleId: 4603 },
  { candidate: "田林三中", district: "徐汇", middleId: 4598 },
  { candidate: "位育初级", district: "徐汇", middleId: 4580 },
  { candidate: "徐汇", district: "徐汇", middleId: 5859 },
  { candidate: "徐汇中学", district: "徐汇", middleId: 5859 },
  { candidate: "南洋", district: "徐汇", middleId: 4708 },
  { candidate: "五十四", district: "徐汇", middleId: 5847 },
  { candidate: "南模", district: "徐汇", middleId: 4581 },
  { candidate: "南模初", district: "徐汇", middleId: 4581 },
  { candidate: "南模初级", district: "徐汇", middleId: 4581 },
  { candidate: "田二", district: "徐汇", middleId: 5851 },
  { candidate: "中国中学", district: "徐汇", middleId: 3485 },
  // 静安
  { candidate: "七一中学", district: "静安", middleId: 3575 },
  { candidate: "三泉学校", district: "静安", middleId: 6075 },
  { candidate: "民立中学", district: "静安", middleId: 3572 },
  { candidate: "市北初级北校", district: "静安", middleId: 3581 },
  { candidate: "华灵学校", district: "静安", middleId: 6074 },
  { candidate: "培明学校", district: "静安", middleId: 3577 },
  // 杨浦
  { candidate: "国和中学", district: "杨浦", middleId: 5166 },
  { candidate: "市光学校", district: "杨浦", middleId: 5915 },
  { candidate: "三门中学", district: "杨浦", middleId: 5165 },
  { candidate: "铁岭中学", district: "杨浦", middleId: 4673 },
  { candidate: "辽阳中学", district: "杨浦", middleId: 5164 },
  { candidate: "鞍山初级中学", district: "杨浦", middleId: 5646 },
  { candidate: "市东实验学校", district: "杨浦", middleId: 5914 },
  { candidate: "育鹰学校", district: "杨浦", middleId: 5920 },
  { candidate: "惠民中学", district: "杨浦", middleId: 5161 },
  // 虹口
  { candidate: "华师大一附初中", district: "虹口", middleId: 3627 },
  { candidate: "曲阳二中", district: "虹口", middleId: 3639 },
  { candidate: "丰镇中学", district: "虹口", middleId: 3633 },
  { candidate: "澄衷中学", district: "虹口", middleId: 3628 },
  { candidate: "北郊学校", district: "虹口", middleId: 5113 },
  { candidate: "长青学校", district: "虹口", middleId: 4691 },
  // 黄浦
  { candidate: "储能中学", district: "黄浦", middleId: 4683 },
  { candidate: "格致初级中学", district: "黄浦", middleId: 4573 },
  { candidate: "卢湾中学", district: "黄浦", middleId: 4899 },
  { candidate: "比乐中学", district: "黄浦", middleId: 6114 },
  // 第二轮：全称更长/带校区前缀的简称（第一轮匹配后复查剩余名单补录）
  { candidate: "华理附中", district: "徐汇", middleId: 3493 },
  { candidate: "紫阳中学", district: "徐汇", middleId: 4601 },
  { candidate: "康外中", district: "徐汇", middleId: 3486 },
  { candidate: "徐教院附中", district: "徐汇", middleId: 3488 },
  { candidate: "徐教院附中南校", district: "徐汇", middleId: 3492 },
  { candidate: "园南中学", district: "徐汇", middleId: 3489 },
  { candidate: "西郊学校", district: "长宁", middleId: 6008 },
  { candidate: "南洋初中", district: "徐汇", middleId: 4708 },
  { candidate: "徐汇中学南校", district: "徐汇", middleId: 5859 },
  { candidate: "静教院附校", district: "静安", middleId: 6053 },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const client = await pool.connect();
  try {
    let total = 0;
    let failed = 0;
    for (const m of MAPPINGS) {
      // 校验：目标学校存在、type=middle、区县一致
      const { rows: check } = await client.query(
        `select id, name, district from public.schools where id = $1`,
        [m.middleId],
      );
      const target = check[0];
      if (!target || target.district.replace(/区$/, "") !== m.district) {
        console.log(`✗ ${m.candidate}[${m.district}] → #${m.middleId} 校验失败（${target ? target.name + " " + target.district : "不存在"}），跳过`);
        failed++;
        continue;
      }
      const { rowCount } = await client.query(
        `update public.school_pathways w
         set middle_school_id = $2, source_name = 'pathway-ai-match'
         from public.schools p
         where w.primary_school_id = p.id
           and w.middle_school_id is null
           and w.raw_text = $1
           and regexp_replace(p.district, '区$', '') = $3`,
        [m.candidate, m.middleId, m.district],
      );
      console.log(`✓ ${m.candidate}[${m.district}] → ${target.name}（#${m.middleId}）: ${rowCount} 行`);
      total += rowCount ?? 0;
    }
    const { rows: stats } = await client.query(`
      select
        count(*)::int total,
        count(*) filter (where middle_school_id is not null)::int matched,
        count(*) filter (where middle_school_id is null)::int unmatched
      from public.school_pathways
    `);
    console.log(`\nAI 匹配更新 ${total} 行${failed ? `，${failed} 条校验失败` : ""}`);
    console.log(`school_pathways 现状：共 ${stats[0].total} · matched ${stats[0].matched} · unmatched ${stats[0].unmatched}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
