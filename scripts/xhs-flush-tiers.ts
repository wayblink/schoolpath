/**
 * 激进版：把 data/xhs/notes-*.jsonl 里所有 list 模式梯队榜单直接 UPSERT 到 PG schools 表。
 *
 * 不做：alias 字典 / 模糊匹配 / dry-run / cross-validation / 投票聚合。
 * 做：扫帖子 → 追踪 "✨X区" 区标记 + "X梯队：" tier 标记交替 → split 学校名 → UPSERT。
 *
 * 默认行为：tier 字段直接覆盖（"latest 帖子 wins"，因为榜单帖时间近的更可信，我们也不在乎错）。
 * 人工 source 的 tier 也会被覆盖——这是用户的明确意图（速度 > 准确）。
 *
 * 用法：
 *   pnpm tsx scripts/xhs-flush-tiers.ts                     # 默认所有 jsonl，全 apply
 *   pnpm tsx scripts/xhs-flush-tiers.ts --in-glob "..."
 *   pnpm tsx scripts/xhs-flush-tiers.ts --skip-existing-tier  # 仅写 tier 为空的
 *   pnpm tsx scripts/xhs-flush-tiers.ts --no-insert            # 仅 UPDATE 已有 row 不插新行
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const { Client } = pg;

function valueArg(name: string): string | undefined {
  const inline = process.argv.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1].trim();
  return undefined;
}
const skipExisting = process.argv.includes("--skip-existing-tier");
const noInsert = process.argv.includes("--no-insert");

const DISTRICTS = [
  "徐汇", "黄浦", "静安", "长宁", "普陀", "虹口", "杨浦", "浦东",
  "闵行", "宝山", "嘉定", "松江", "青浦", "奉贤", "金山", "崇明",
];

const TIER_LABEL: Record<string, string> = {
  "一": "一梯队", "1": "一梯队", "１": "一梯队",
  "二": "二梯队", "2": "二梯队", "２": "二梯队",
  "三": "三梯队", "3": "三梯队", "３": "三梯队",
  "四": "四梯队", "4": "四梯队", "４": "四梯队",
};

// tier 标记：包含 emoji 容忍
const TIER_RE = /(?:^|[\n；;])\s*\S{0,3}?\s*第?\s*([一二三四1234１２３４])\s*梯队\s*\S{0,3}?\s*[：:]/gu;
// 区标记：✨X区 / [X区] / X区:
const DISTRICT_RE = new RegExp(`(?:✨|\\[|【|\\b)(${DISTRICTS.join("|")})区`, "gu");

type Event =
  | { type: "tier"; tier: string; payloadStart: number }
  | { type: "district"; district: string; pos: number };

function findEvents(text: string): Event[] {
  const events: Event[] = [];
  TIER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TIER_RE.exec(text)) !== null) {
    const tier = TIER_LABEL[m[1]];
    if (tier) events.push({ type: "tier", tier, payloadStart: m.index + m[0].length });
  }
  DISTRICT_RE.lastIndex = 0;
  while ((m = DISTRICT_RE.exec(text)) !== null) {
    events.push({ type: "district", district: m[1], pos: m.index });
  }
  events.sort((a, b) => {
    const ap = a.type === "tier" ? a.payloadStart : a.pos;
    const bp = b.type === "tier" ? b.payloadStart : b.pos;
    return ap - bp;
  });
  return events;
}

const SCHOOL_NAME_TRIM = /^[\s、，,；;。\.·•\-—\(\（]+|[\s、，,；;。\.·•\-—\)\）等]+$/g;
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F02F}\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2700}-\u{27BF}\u{FE0F}]/gu;

const SCHOOL_SUFFIX_RE = /(学校|中学|小学|学院|集团校|双语|外国语|附校|附属|分校|本部|总校|实验|国际|科技|公学)$/;
// 包含其中之一即认为是描述性短语，不是学校名
const DESCRIPTOR_RE =
  /(标杆|路径|资源|亮眼|选择|背景|上升|优势|对比|分析|规划|清晰|稳步|双轨|背靠|系背|备选|风险|建议|策略|考虑|关注|了解|根据|表现|拥有|属于|提供|焦虑|希望|输出|快车|个性|前列|来自|实力派|性价比|精英校|战力|顶尖|鼎尖|独特|均衡|文科|理科|偏好|追求|预录取|名额|集团化|数字化|师资|成果|空间|平稳|这里|这些|那些|都是|一所|两所|多所|几所|大部分|大多数|超过|大概|包括|涵盖|可能|或许|应该|也是|也有|没有|很有|不少|顶级|头部|此类|该校|本校|此校|该区|本区|名校|生源|提分|提升|拼音|听说|据说|有人|有的|没有|备考|参考|建议|策略|秘籍|攻略|tips|TIPS)/;
const BANNED_CHARS_RE = /[①②③④⑤⑥⑦⑧⑨⑩◆▪▲●○"《》「」：➕]/;
const ZWS_RE = /[​-‏‪-‮⁠-⁩﻿]/g;

function cleanSchoolName(raw: string): string | null {
  let s = raw
    .replace(EMOJI_RE, "")
    .replace(ZWS_RE, "")
    .replace(SCHOOL_NAME_TRIM, "")
    .trim();
  // 去括号注释（民办/2025届/小学部 等）
  s = s.replace(/[（(][^）)]{0,30}[）)]/g, "").trim();
  s = s.replace(/(等等|等)$/g, "").trim();
  if (!s) return null;
  if (s.length < 3 || s.length > 15) return null;
  if (BANNED_CHARS_RE.test(s)) return null;
  if (DESCRIPTOR_RE.test(s)) return null;
  // 必须含中文
  if (!/[一-龥]/.test(s)) return null;
  // 拒绝含明显非名词标记
  if (/(的|是|为|与|及|或|但|后|到|被|让|加|减|不|很|更|较|最|且|又|又是|也是|也有|很有|很多|不少|偏|稍|确实|应该|可能|可以|没法|大概|约略|至少|至多|超过|低于|高于|提升|下降|增长|变化|趋势|背靠|背景|系列|路线|轨道|档次|分数|年级|年代|学期|学年|学制|阶段|时期|过程|过程中|当下|目前|此前|未来|今后|后续|过往|过去|现在|新晋|新近|近年|历年|多年|此前|此后|当前)/.test(s)) return null;
  // 必须以学校后缀结尾，或是 3-6 字简称（很多帖子用简称）
  if (!SCHOOL_SUFFIX_RE.test(s)) {
    if (s.length > 6) return null;
  }
  return s;
}

function splitPayloadIntoSchools(payload: string): string[] {
  // 切出最多 250 字符 → 按 、，;,；以及编号 1. 2. 切
  const cap = payload.slice(0, 250);
  const parts = cap.split(/[、，,；;\n]|(?<=\d)\.|·|\s{2,}/g);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    const cleaned = cleanSchoolName(p);
    if (!cleaned) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

function inferDistrictFromQuery(query: string): string | null {
  for (const d of DISTRICTS) if (query.includes(d)) return d;
  return null;
}

function inferDistrictFromTitle(title: string | null): string | null {
  if (!title) return null;
  for (const d of DISTRICTS) {
    if (new RegExp(`${d}区?(?:小学|初中|中学|公办|民办)?(?:梯队|排名)`).test(title)) return d;
    if (title.includes(d + "区")) return d;
  }
  return null;
}

function inferStage(query: string, title: string | null): "primary" | "middle" {
  const t = (query + " " + (title ?? "")).toLowerCase();
  if (/小学梯队|小学排|小学.*?梯队|primary/.test(t)) return "primary";
  return "middle"; // 默认
}

type NoteRow = {
  query: string;
  title: string | null;
  content: string | null;
  abstract?: string | null; // SERP（百度/Bing/知乎搜索结果）摘要
  district?: string | null;
  comments?: Array<{ text: string | null }>;
  note_id?: string;
  url?: string;        // SERP url
  rank?: number;       // SERP rank
  engine?: string;     // SERP engine
  error?: string;
};

function findInputFiles(): string[] {
  const glob = valueArg("--in-glob");
  if (glob) {
    const dir = path.dirname(glob.replace(/\*.*$/, "x"));
    const pattern = path.basename(glob);
    const re = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
    return readdirSync(path.resolve(dir))
      .filter((f) => re.test(f))
      .map((f) => path.join(path.resolve(dir), f))
      .sort();
  }
  const single = valueArg("--in");
  if (single) return [path.resolve(single)];
  // 默认：data/{xhs,sogou,baidu,zhihu}/ 下所有 jsonl
  const out: string[] = [];
  for (const sub of ["xhs", "sogou", "baidu", "zhihu"]) {
    const dir = path.join(process.cwd(), "data", sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".jsonl")) out.push(path.join(dir, f));
    }
  }
  if (out.length === 0) throw new Error("没有 data/{xhs,sogou,baidu,zhihu}/*.jsonl");
  return out.sort();
}

async function main() {
  const files = findInputFiles();
  console.log(`[flush] 输入文件: ${files.length}`);
  for (const f of files) console.log(`  - ${f}`);

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is required (.env.local)");
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  let parsedNotes = 0;
  let candidatesSeen = 0; // (district, name, tier) triples
  let inserted = 0;
  let updated = 0;
  let skippedNoDistrict = 0;
  let skippedExisting = 0;
  let skippedNoInsert = 0;

  try {
    await client.query("BEGIN");
    for (const file of files) {
      for (const line of readFileSync(file, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        let row: NoteRow;
        try { row = JSON.parse(line); } catch { continue; }
        if (row.error) continue;
        parsedNotes += 1;

        const blob =
          (row.title ?? "") + "\n" +
          (row.content ?? "") + "\n" +
          (row.abstract ?? "") + "\n" +
          (row.comments ?? []).map((c) => c.text ?? "").join("\n");
        if (!blob.trim()) continue;

        const queryDistrict = inferDistrictFromQuery(row.query) ?? row.district ?? null;
        const titleDistrict = inferDistrictFromTitle(row.title);
        const fallbackDistrict = titleDistrict || queryDistrict;
        const stage = inferStage(row.query, row.title);

        const events = findEvents(blob);
        if (events.length === 0) continue;

        let currentDistrict: string | null = fallbackDistrict;
        for (let i = 0; i < events.length; i++) {
          const ev = events[i];
          if (ev.type === "district") {
            currentDistrict = ev.district;
            continue;
          }
          // ev is tier
          const start = ev.payloadStart;
          const next = events[i + 1];
          let end: number;
          if (next) end = next.type === "tier" ? next.payloadStart : next.pos;
          else end = blob.length;
          end = Math.min(end, start + 250);
          const payload = blob.slice(start, end);
          const schools = splitPayloadIntoSchools(payload);
          for (const name of schools) {
            candidatesSeen += 1;
            const district = currentDistrict;
            if (!district) {
              skippedNoDistrict += 1;
              continue;
            }
            // UPSERT
            const existing = await client.query<{ id: number; tier: string | null }>(
              `SELECT id, tier FROM schools WHERE district=$1 AND name=$2 LIMIT 1`,
              [district, name],
            );
            if (existing.rows.length > 0) {
              const cur = existing.rows[0];
              if (skipExisting && cur.tier && cur.tier !== "未入榜/待补充" && cur.tier !== "") {
                skippedExisting += 1;
                continue;
              }
              await client.query(
                `UPDATE schools SET
                   tier = $1,
                   attrs = COALESCE(attrs, '{}'::jsonb) || $2::jsonb,
                   updated_at = now()
                 WHERE id = $3`,
                [
                  ev.tier,
                  JSON.stringify({
                    data_source: "xhs-flush",
                    xhs_last_note: row.note_id ?? row.url ?? null,
                    xhs_last_query: row.query,
                  }),
                  cur.id,
                ],
              );
              updated += 1;
            } else {
              if (noInsert) { skippedNoInsert += 1; continue; }
              await client.query(
                `INSERT INTO schools (name, district, type, tier, attrs)
                 VALUES ($1, $2, $3::school_type, $4, $5::jsonb)`,
                [
                  name,
                  district,
                  stage,
                  ev.tier,
                  JSON.stringify({
                    data_source: "xhs-flush",
                    verified: false,
                    xhs_first_note: row.note_id ?? row.url ?? null,
                    xhs_first_query: row.query,
                  }),
                ],
              );
              inserted += 1;
            }
          }
        }
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }

  console.log(`\n[flush] 完成`);
  console.log(`  parsed notes:           ${parsedNotes}`);
  console.log(`  candidates (district+name+tier triples): ${candidatesSeen}`);
  console.log(`  INSERT:                 ${inserted}`);
  console.log(`  UPDATE:                 ${updated}`);
  console.log(`  skipped (no district):  ${skippedNoDistrict}`);
  if (skipExisting) console.log(`  skipped (--skip-existing-tier):  ${skippedExisting}`);
  if (noInsert) console.log(`  skipped (--no-insert):  ${skippedNoInsert}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
