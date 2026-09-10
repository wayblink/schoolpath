import pg from "pg";
import { loadLocalEnv } from "./load-env";
loadLocalEnv();
async function main() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const where = `
    attrs->>'data_source' = 'xhs-flush'
    AND attrs ? 'xhs_first_note'
    AND (
      -- 长 name 不以学校后缀结尾
      (char_length(name) > 13 AND name !~ '(学校|中学|小学|学院|集团校|双语|外国语|附校|附属|分校|本部|总校)$')
      OR
      -- 包含明显描述性词
      name ~ '(标杆|路径|资源|亮眼|选择|背景|上升|优势|对比|分析|规划|清晰|稳步|双轨|背靠|系背|备选|风险|建议|策略|考虑|关注|了解|根据|表现|拥有|属于|提供|焦虑|希望|输出|快车|个性|前列|来自|实力派|性价比|精英校|战力|顶尖|鼎尖|不相|独特|均衡|文科|理科|偏好|追求|预录取|名额|集团化|数字化|师资|成果|空间|平稳|这里|这些|那些|都是|一所|两所|多所|几所|大部分|大多数|超过|大概|包括|涵盖|可能|或许|应该|也是|也有|没有|很有|不少|顶级|头部|此类|该校|本校|此校|该区|本区|名校|生源|提分|提升|备考|参考|秘籍|攻略|魔都|代表|总之|综上|此外|另外|首先|其次|最后|另一方面|因此|所以|然而|不过|此前|往往|往年|今年|去年|未来|当下|目前|现今|往后|过去)'
      OR
      -- 含特殊符号
      name ~ '[①②③④⑤⑥⑦⑧⑨⑩◆▪▲●○“”《》「」‌‍：➕]'
      OR
      -- 短 name 中的明显非校名 / 标签
      name IN ('顶尖战力','鼎尖名校','头部精英','头部','其他','以上','此外','如下','备注','重点','关键','核心','顶尖','精英','头等','一档','二档','三档','四档','普通公办','重点公办','顶级民办','普通民办','优质公办','优质民办','热门公办','热门民办','公办','民办','顶尖民办','热门校','名校榜')
      OR
      -- 仅 1-2 个汉字（多半是切错的残段）
      char_length(name) <= 2
    )
  `;
  const counts = await c.query(`SELECT COUNT(*)::int n FROM schools WHERE ${where}`);
  const sample = await c.query(`SELECT name, district, tier FROM schools WHERE ${where} ORDER BY char_length(name) DESC LIMIT 25`);
  console.log(`将删除: ${counts.rows[0].n} 条`);
  console.log("\n--- 抽样 (长到短)---");
  for (const r of sample.rows) console.log(`  [${r.name.length}] ${r.district}/${r.tier} ${r.name}`);

  if (process.argv.includes("--apply")) {
    const del = await c.query(`DELETE FROM schools WHERE ${where}`);
    console.log(`\n[apply] 已删除 ${del.rowCount} 条`);
  } else {
    console.log("\n（默认 dry-run；加 --apply 真删）");
  }
  await c.end();
}
main();
