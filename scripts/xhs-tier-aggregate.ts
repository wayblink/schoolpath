/**
 * 把 data/xhs/notes-*.jsonl 聚合成「学校 → 梯队」投票表（无 LLM 版）。
 *
 * 算法：
 *   1. 从 PG schools 表拉全部学校 (~948 所)，按规则生成 alias（去"上海市/X区"前缀）。
 *   2. 手写 ALIAS_OVERRIDES 补充帖子里高频出现但 PG 名字相差较远的简称（华育/世外/师三...）。
 *   3. 切段：仅采纳「X梯队：A、B、C」list 模式（散文修饰一律忽略）。
 *   4. 在 list payload 里扫所有 alias，命中即一票。
 *   5. 输出：每校 tier 票分布、得票最高的 tier、引用 note_ids（≤5）。
 *
 * 用法：
 *   pnpm tsx scripts/xhs-tier-aggregate.ts \
 *     [--in data/xhs/notes-*.jsonl]    # 默认匹配最新；多文件用 --in-glob
 *     [--in-glob "data/xhs/notes-*.jsonl"]
 *     [--out data/xhs/tier-votes-LATEST.json]
 *     [--out-tiers data/school-tiers.xhs.json]
 *     [--district 徐汇]
 *     [--min-votes 2]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const { Client } = pg;

// ---------- CLI helpers ----------
function valueArg(name: string): string | undefined {
  const inline = process.argv.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1].trim();
  return undefined;
}
function numberArg(name: string): number | undefined {
  const r = valueArg(name);
  return r === undefined ? undefined : Number(r);
}

const districtFilter = valueArg("--district");
const minVotes = numberArg("--min-votes") ?? 1;

// ---------- alias 词典 ----------
type AliasEntry = {
  official: string;
  district: string;
  stage: "primary" | "middle" | "unknown";
  aliases: string[];
};

// 手写补丁：覆盖 PG 自动派生不到的高频简称。这些通常是民办名校或社群昵称。
// PG 里若有同名学校，会被自动 PG 派生覆盖（officialMeta 以 official 名为 key）。
const ALIAS_OVERRIDES: AliasEntry[] = [
  // 徐汇 — 公办四大 + 顶级民办
  { official: "上海市徐汇区建襄小学", district: "徐汇", stage: "primary", aliases: ["建襄", "建襄小学"] },
  { official: "上海市徐汇区高安路第一小学", district: "徐汇", stage: "primary", aliases: ["高一", "高安路一小", "高安路第一小学"] },
  { official: "上海市徐汇区向阳小学", district: "徐汇", stage: "primary", aliases: ["向阳小学"] },
  { official: "上海市徐汇区汇师小学", district: "徐汇", stage: "primary", aliases: ["汇师", "汇师小学"] },
  { official: "上海市民办华育中学", district: "徐汇", stage: "middle", aliases: ["华育", "华育中学", "民办华育"] },
  { official: "上海市民办西南模范中学", district: "徐汇", stage: "middle", aliases: ["西南模", "西南模范", "西南模范中学"] },
  { official: "上海市西南位育中学", district: "徐汇", stage: "middle", aliases: ["西南位育", "西南位育中学", "西位"] },
  { official: "上海市世界外国语中学", district: "徐汇", stage: "middle", aliases: ["世外中学", "世外初中", "世界外国语中学"] },
  { official: "上海市南洋模范初级中学", district: "徐汇", stage: "middle", aliases: ["南模初", "南模初级", "南洋模范初级"] },
  { official: "上海市位育初级中学", district: "徐汇", stage: "middle", aliases: ["位育初", "位育初级"] },
  { official: "上海中学东校", district: "浦东", stage: "middle", aliases: ["上中东校"] },

  // 静安 — 顶级民办 + 顶级公办
  { official: "上海市静安区市北初级中学", district: "静安", stage: "middle", aliases: ["市北初", "市北初级", "市北初级中学"] },
  { official: "上海市市西初级中学", district: "静安", stage: "middle", aliases: ["市西初", "市西初级", "市西初级中学"] },
  { official: "上海市民办扬波中学", district: "静安", stage: "middle", aliases: ["扬波", "民办扬波"] },
  { official: "上海市静安区教育学院附属学校教育集团", district: "静安", stage: "middle", aliases: ["静教院附校", "静教院", "静安教育学院附属学校"] },
  { official: "上海市风华初级中学", district: "静安", stage: "middle", aliases: ["风华初", "风华初级"] },

  // 普陀
  { official: "上海市民办进华中学", district: "普陀", stage: "middle", aliases: ["进华", "进华中学", "民办进华"] },
  { official: "上海市梅陇中学", district: "普陀", stage: "middle", aliases: ["梅陇", "梅陇中学"] },
  { official: "上海培佳双语学校", district: "普陀", stage: "middle", aliases: ["培佳双语", "培佳"] },
  { official: "上海市曹杨第二中学附属学校", district: "普陀", stage: "middle", aliases: ["曹二附属", "曹二附校"] },
  { official: "上海市晋元高级中学附属学校", district: "普陀", stage: "middle", aliases: ["晋元附校", "晋元附属"] },

  // 黄浦
  { official: "上海市民办立达中学", district: "黄浦", stage: "middle", aliases: ["民办立达", "立达中学", "立达"] },
  { official: "上海市格致初级中学", district: "黄浦", stage: "middle", aliases: ["格致初", "格致初级"] },
  { official: "上海市大同初级中学", district: "黄浦", stage: "middle", aliases: ["大同初", "大同初级"] },
  { official: "上海市向明初级中学", district: "黄浦", stage: "middle", aliases: ["向明初", "向明初级"] },
  { official: "上海市卢湾初级中学", district: "黄浦", stage: "middle", aliases: ["卢湾初", "卢湾初级"] },

  // 长宁
  { official: "上海市延安初级中学", district: "长宁", stage: "middle", aliases: ["延安初", "延安初级", "延安初中"] },
  { official: "上海市民办新世纪中学", district: "长宁", stage: "middle", aliases: ["新世纪", "新世纪中学"] },
  { official: "上海市天山初级中学", district: "长宁", stage: "middle", aliases: ["天山初", "天山初级"] },

  // 杨浦
  { official: "上海市兰生复旦中学", district: "杨浦", stage: "middle", aliases: ["兰生", "兰生复旦", "兰生复旦中学"] },
  { official: "上海市民办凯慧中学", district: "杨浦", stage: "middle", aliases: ["凯慧", "凯慧中学"] },
  { official: "上海市同济大学第二附属中学", district: "杨浦", stage: "middle", aliases: ["同济二附", "同济二附中"] },
  { official: "上海市存志中学", district: "杨浦", stage: "middle", aliases: ["存志", "存志中学", "同济存志"] },
  { official: "上海外国语大学附属双语学校", district: "杨浦", stage: "middle", aliases: ["上外双语"] },

  // 浦东 — 顶级公办初中
  { official: "上海市民办张江集团学校", district: "浦东", stage: "middle", aliases: ["张江集团", "张江集团学校"] },
  { official: "上海市建平中学西校（大唐校区）", district: "浦东", stage: "middle", aliases: ["建平西校", "建平西", "建平中学西校"] },
  { official: "上海民办新竹园中学", district: "浦东", stage: "middle", aliases: ["新竹园", "民办新竹园"] },
  { official: "上海交通大学附属浦东实验中学", district: "浦东", stage: "middle", aliases: ["交中初级", "交大附中浦东", "交大附属中学浦东实验初级", "上海交大附属中学浦东实验初级中学"] },
  { official: "上海市进才中学北校", district: "浦东", stage: "middle", aliases: ["进才北校", "进才北", "上海市进才北校"] },
  { official: "上海市进才外国语中学", district: "浦东", stage: "middle", aliases: ["进才外国语"] },

  // 闵行
  { official: "上海市民办文绮中学", district: "闵行", stage: "middle", aliases: ["文绮", "文绮中学"] },
  { official: "上海市民办上宝中学", district: "闵行", stage: "middle", aliases: ["上宝", "上宝中学"] },
  { official: "上海市闵行区华东师范大学第二附属中学前滩学校", district: "闵行", stage: "middle", aliases: ["华二前滩"] },
  { official: "上海闵行华漕中学", district: "闵行", stage: "middle", aliases: ["华漕中学"] },

  // 宝山
  { official: "华东师范大学第二附属中学宝山校区", district: "宝山", stage: "middle", aliases: ["华曜宝山", "华二宝山"] },
  { official: "上海市行知二中", district: "宝山", stage: "middle", aliases: ["至德实验", "行知二中"] },

  // 嘉定
  { official: "华东师范大学第二附属中学嘉定校区", district: "嘉定", stage: "middle", aliases: ["华曜嘉定", "华二嘉定"] },
  { official: "上海市民办桃李园实验学校", district: "嘉定", stage: "middle", aliases: ["桃李园", "民办桃李园"] },
  { official: "上海民办嘉一联合中学", district: "嘉定", stage: "middle", aliases: ["嘉一联合", "民办嘉一联合"] },

  // 虹口
  { official: "上海外国语大学附属外国语学校", district: "虹口", stage: "middle", aliases: ["上外附中", "上海外国语大学附属"] },
  { official: "上海市新华初级中学", district: "虹口", stage: "middle", aliases: ["新华初", "新华初级"] },
  { official: "上海市新复兴初级中学", district: "虹口", stage: "middle", aliases: ["新复兴初", "新复兴初级"] },

  // 上中（避开浦东上中东校混淆）
  { official: "上海中学", district: "徐汇", stage: "middle", aliases: ["上海中学"] },
];

// 兼容旧名
const ALIAS_TABLE = ALIAS_OVERRIDES;

// ---------- tier 词典 ----------
// list 模式 marker：行首/分号/全角分号 之后出现「X梯队 [emoji]? ：」，到下一个 marker 或行尾视为该 tier 的 payload。
// 这是 XHS 整理类帖子的金牌格式（"一梯队🥇：华育、世外、..."），噪声极低。
// 散文里的"X梯队"修饰会跨学校误判，故不采纳。
// 注意：emoji 用 u-flag 才能正确处理多字节字符；这里直接用 \S{0,3} 吃掉 marker 与冒号之间任何 emoji/空格。
const TIER_MARKER_RE = /(?:^|[\n；;])\s*\S{0,3}?\s*第?\s*([一二三四1234１２３４])\s*梯队\s*\S{0,3}?\s*[：:]/gu;
const TIER_LABELS: Record<string, string> = {
  "一": "一梯队", "1": "一梯队", "１": "一梯队",
  "二": "二梯队", "2": "二梯队", "２": "二梯队",
  "三": "三梯队", "3": "三梯队", "３": "三梯队",
  "四": "四梯队", "4": "四梯队", "４": "四梯队",
};

// ---------- 主流程 ----------
type NoteRow = {
  ts: string;
  school_id: number;
  school_name: string;
  district: string;
  type?: string | null;
  query: string;
  note_id: string;
  note_url: string;
  title: string | null;
  content: string | null;
  comments?: Array<{ author: string | null; text: string | null; likes: number | null }>;
};

type Vote = { tier: string; note_id: string; school_query: string; matched_alias: string };

type SchoolBucket = {
  official_name: string;
  district: string;
  type: string | null;
  votes: Vote[];
  tier_counts: Record<string, number>;
  top_tier: string | null;
  total_votes: number;
};

function findInputFile(): string {
  const cli = valueArg("--in");
  if (cli) return path.resolve(cli);
  const dir = path.join(process.cwd(), "data", "xhs");
  if (!existsSync(dir)) throw new Error(`未找到 data/xhs/ 目录`);
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("notes-") && f.endsWith(".jsonl"))
    .sort();
  if (files.length === 0) throw new Error(`data/xhs/ 下没有 notes-*.jsonl`);
  return path.join(dir, files[files.length - 1]);
}

function findInputFiles(): string[] {
  const glob = valueArg("--in-glob");
  if (glob) {
    // 简单 glob：仅支持目录前缀 + 通配
    const dir = path.dirname(glob.replace(/\*.*$/, "x"));
    const pattern = path.basename(glob);
    const re = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
    return readdirSync(path.resolve(dir))
      .filter((f) => re.test(f))
      .map((f) => path.join(path.resolve(dir), f))
      .sort();
  }
  return [findInputFile()];
}

// 从 PG schools 表拉全部学校，派生自动 alias。
async function fetchSchoolsFromPG(): Promise<AliasEntry[]> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.warn("[aggregate] 警告: DATABASE_URL 未设置，跳过 PG 自动 alias，仅用 OVERRIDES");
    return [];
  }
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const r = await client.query<{ name: string; district: string; type: string }>(
      `SELECT name, district, type::text AS type FROM schools ORDER BY district, type, id`,
    );
    const out: AliasEntry[] = [];
    for (const row of r.rows) {
      const aliases = deriveAliasesFromName(row.name);
      out.push({
        official: row.name,
        district: row.district,
        stage: row.type === "primary" || row.type === "middle" ? row.type : "unknown",
        aliases,
      });
    }
    return out;
  } finally {
    await client.end();
  }
}

// 由 PG 学校全名派生别名候选。规则保守：长度 ≥ 4 字、避开纯通用词。
function deriveAliasesFromName(name: string): string[] {
  const out = new Set<string>();
  out.add(name);
  let s = name.replace(/^上海市/, "");
  if (s.length >= 4) out.add(s);
  s = s.replace(/^[一-龥]{1,4}区\s*/, "");
  if (s.length >= 4) out.add(s);
  // 去末尾「（X校区 ）/（X部）/（X分校 ）」
  const noCampus = s.replace(/[（(][^）)]*[校部分][^）)]*[）)]\s*$/g, "").trim();
  if (noCampus.length >= 4 && noCampus !== s) out.add(noCampus);
  // 全角空格/末尾空格
  for (const a of Array.from(out)) {
    const trimmed = a.replace(/[\s　]+/g, "");
    if (trimmed.length >= 4 && trimmed !== a) out.add(trimmed);
  }
  out.delete(name);
  // 排掉过于通用、易产生跨学校误判的串
  const banned = new Set([
    "实验学校", "附属学校", "实验中学", "附属中学", "附属小学", "实验小学",
    "外国语小学", "外国语中学", "九年一贯制学校", "民办学校",
    "上海市", "上海中学", // 上海中学保留在 OVERRIDES 里点对点处理
  ]);
  for (const a of Array.from(out)) if (banned.has(a) || a.length < 4) out.delete(a);
  return Array.from(out);
}

// 全局 banned alias：过通用、易跨学校误判
const GLOBAL_BANNED_ALIAS = new Set([
  "实验中学", "实验小学", "实验学校",
  "附属中学", "附属小学", "附属学校",
  "外国语小学", "外国语中学", "外国语学校",
  "九年一贯制学校", "民办学校", "公办学校",
  "科技学校", "阳光学校", "明德学校",
  "上海市", "上海中学",
]);

function buildAliasIndex(entries: AliasEntry[]) {
  const alias2official = new Map<string, string>();
  const officialMeta = new Map<string, { district: string; stage: "primary" | "middle" | "unknown" }>();
  // 冲突计数：同一 alias 被多个 official 占用时，丢弃避免误判
  const aliasOwners = new Map<string, Set<string>>();
  for (const entry of entries) {
    officialMeta.set(entry.official, { district: entry.district, stage: entry.stage });
    for (const a of [entry.official, ...entry.aliases]) {
      if (GLOBAL_BANNED_ALIAS.has(a)) continue;
      if (a.length < 4) continue; // 三字以下噪声大
      const owners = aliasOwners.get(a) ?? new Set<string>();
      owners.add(entry.official);
      aliasOwners.set(a, owners);
    }
  }
  let dropped = 0;
  for (const [a, owners] of aliasOwners.entries()) {
    if (owners.size === 1) {
      alias2official.set(a, Array.from(owners)[0]);
    } else {
      dropped += 1;
    }
  }
  console.log(`[aggregate] alias 索引：${alias2official.size} 项；冲突丢弃 ${dropped} 项`);
  // 长别名优先匹配
  const sortedAliases = Array.from(alias2official.keys()).sort((a, b) => b.length - a.length);
  return { alias2official, sortedAliases, officialMeta };
}

function splitSegments(text: string): string[] {
  // 仅用于 fallback 调试，主流程不再用 segment 切分
  return text
    .replace(/[✨🥇🥈🥉🏅⭐️📚📌💡🔖♨️‼️⬆️🔎👑🚀]/g, " ")
    .split(/[\n；;]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 从一篇 note 文本里抽取 list 模式的 tier-payload。返回 [{ tier, payload }]，
 * payload 是 marker 之后到下一个 marker 或末尾之间的字符串。
 *
 * 例：「一梯队🥇：华育、世外\n二梯队：徐汇中学」会切成
 *   { tier:"一梯队", payload:"华育、世外" }
 *   { tier:"二梯队", payload:"徐汇中学" }
 */
function extractTierPayloads(text: string): Array<{ tier: string; payload: string }> {
  const out: Array<{ tier: string; payload: string }> = [];
  // 收集所有 marker 位置
  const markers: Array<{ tier: string; start: number; end: number }> = [];
  TIER_MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TIER_MARKER_RE.exec(text)) !== null) {
    const tier = TIER_LABELS[m[1]];
    if (!tier) continue;
    markers.push({ tier, start: m.index + m[0].length, end: -1 });
  }
  if (markers.length === 0) return out;
  // 切片直到下一个 marker 或下一个换行段（避免吞太多无关下文）
  for (let i = 0; i < markers.length; i++) {
    const cur = markers[i];
    const next = markers[i + 1];
    let end = next ? next.start - 1 : text.length;
    // 同时限制在「下一个换行连续段」内：榜单行往往不超过 200 字
    const nlIdx = text.indexOf("\n\n", cur.start);
    if (nlIdx > 0 && nlIdx < end) end = nlIdx;
    if (end - cur.start > 250) end = cur.start + 250; // 硬上限
    const payload = text.slice(cur.start, end);
    out.push({ tier: cur.tier, payload });
  }
  return out;
}

function extractVotesFromText(
  text: string,
  noteId: string,
  schoolQuery: string,
  alias2official: Map<string, string>,
  sortedAliases: string[],
): Vote[] {
  const votes: Vote[] = [];
  const payloads = extractTierPayloads(text);
  for (const { tier, payload } of payloads) {
    let masked = payload;
    for (const alias of sortedAliases) {
      if (!masked.includes(alias)) continue;
      votes.push({ tier, note_id: noteId, school_query: schoolQuery, matched_alias: alias });
      masked = masked.split(alias).join("◊".repeat(alias.length));
    }
  }
  return votes;
}

function dedupVotes(votes: Vote[]): Vote[] {
  // 同一 (note_id, official_name, tier) 只算一次
  const seen = new Set<string>();
  const out: Vote[] = [];
  for (const v of votes) {
    const key = `${v.note_id}|${v.matched_alias}|${v.tier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

async function main() {
  const inputFiles = findInputFiles();
  console.log(`[aggregate] 输入文件: ${inputFiles.length} 个`);
  for (const f of inputFiles) console.log(`  - ${f}`);

  // PG 自动派生 + OVERRIDES 合并；OVERRIDES 后置，其 official 同名时覆盖 PG 派生（很罕见）
  const pgEntries = await fetchSchoolsFromPG();
  console.log(`[aggregate] PG 拉取 ${pgEntries.length} 所学校`);
  const merged = new Map<string, AliasEntry>();
  for (const e of pgEntries) merged.set(e.official, e);
  for (const e of ALIAS_OVERRIDES) {
    // OVERRIDES 与 PG 派生的 alias 联合（避免覆盖了 PG 已有的 entry 的丢失原 alias）
    const existing = merged.get(e.official);
    if (existing) {
      const set = new Set([...existing.aliases, ...e.aliases]);
      merged.set(e.official, { ...existing, aliases: Array.from(set) });
    } else {
      merged.set(e.official, e);
    }
  }
  const entries = Array.from(merged.values());

  const { alias2official, sortedAliases, officialMeta } = buildAliasIndex(entries);

  // 用 official_name 作 key
  const buckets = new Map<string, SchoolBucket>();
  for (const entry of entries) {
    buckets.set(entry.official, {
      official_name: entry.official,
      district: entry.district,
      type: entry.stage === "unknown" ? null : entry.stage,
      votes: [],
      tier_counts: {},
      top_tier: null,
      total_votes: 0,
    });
  }

  let parsedRows = 0;
  for (const inputFile of inputFiles) {
    for (const line of readFileSync(inputFile, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let row: NoteRow;
      try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if ((row as { error?: string }).error) continue;
    parsedRows += 1;

    const fields: string[] = [];
    if (row.title) fields.push(row.title);
    if (row.content) fields.push(row.content);
    if (row.comments) {
      for (const c of row.comments) if (c.text) fields.push(c.text);
    }
    const blob = fields.join("\n");
    if (!blob) continue;

    const votes = extractVotesFromText(blob, row.note_id, row.school_name, alias2official, sortedAliases);
    for (const v of votes) {
      const official = alias2official.get(v.matched_alias);
      if (!official) continue;
      const bucket = buckets.get(official);
      if (!bucket) continue;
      // 给每个 official 桶记录元数据（district/stage 已在 init 时写好；这里不需要再覆盖）
      bucket.votes.push(v);
    }
  }
  }

  // 去重 + 统计
  for (const bucket of buckets.values()) {
    bucket.votes = dedupVotes(bucket.votes);
    bucket.total_votes = bucket.votes.length;
    for (const v of bucket.votes) {
      bucket.tier_counts[v.tier] = (bucket.tier_counts[v.tier] ?? 0) + 1;
    }
    let topTier: string | null = null;
    let topCount = 0;
    for (const [tier, cnt] of Object.entries(bucket.tier_counts)) {
      if (cnt > topCount) {
        topCount = cnt;
        topTier = tier;
      }
    }
    bucket.top_tier = topTier;
  }

  const outputs = Array.from(buckets.values())
    .filter((b) => (districtFilter ? b.district === districtFilter : true))
    .filter((b) => b.total_votes >= minVotes)
    .sort((a, b) => {
      const order = ["一梯队", "二梯队", "三梯队", "四梯队", null];
      const ai = order.indexOf(a.top_tier);
      const bi = order.indexOf(b.top_tier);
      if (ai !== bi) return ai - bi;
      return b.total_votes - a.total_votes;
    });

  // 输出报告
  console.log(`\n[aggregate] 解析 ${parsedRows} 条 note，命中 ${outputs.length} 所学校`);
  console.log("=".repeat(90));
  let lastTier: string | null = "_";
  for (const b of outputs) {
    if (b.top_tier !== lastTier) {
      console.log(`\n  --- ${b.top_tier ?? "未定"} ---`);
      lastTier = b.top_tier;
    }
    const dist = `${b.tier_counts["一梯队"] ?? 0}|${b.tier_counts["二梯队"] ?? 0}|${b.tier_counts["三梯队"] ?? 0}|${b.tier_counts["四梯队"] ?? 0}`;
    const sample = Array.from(new Set(b.votes.map((v) => v.note_id))).slice(0, 2).join(",");
    console.log(
      `  ${(b.top_tier ?? "—").padEnd(4)} ` +
        `[${dist.padStart(11)}] ` +
        `total=${String(b.total_votes).padStart(2)} ` +
        `${(b.district || "?").padEnd(6)}/${(b.type ?? "?").padEnd(7)} ` +
        `${b.official_name}` +
        ` (${sample})`,
    );
  }
  console.log("=".repeat(90));
  console.log("dist 列含义：一梯|二梯|三梯|四梯 票数");

  // 写 JSON
  const firstInput = inputFiles[0];
  const outPath = valueArg("--out") ?? path.join(path.dirname(firstInput), `tier-votes-${path.basename(firstInput).match(/\d{8}/)?.[0] ?? "latest"}.json`);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        _generated_at: new Date().toISOString(),
        _inputs: inputFiles,
        _config: { districtFilter, minVotes },
        items: outputs.map((b) => ({
          official_name: b.official_name,
          district: b.district,
          type: b.type,
          top_tier: b.top_tier,
          total_votes: b.total_votes,
          tier_counts: b.tier_counts,
          source_note_ids: Array.from(new Set(b.votes.map((v) => v.note_id))),
          matched_aliases: Array.from(new Set(b.votes.map((v) => v.matched_alias))),
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\n[aggregate] 详细 JSON: ${outPath}`);

  // 写 backfill 兼容的 TierFile（schema 与 data/school-tiers.json 一致）
  const outTiersPath =
    valueArg("--out-tiers") ?? path.join(process.cwd(), "data", "school-tiers.xhs.json");
  mkdirSync(path.dirname(outTiersPath), { recursive: true });
  const tierFileItems = outputs
    .filter((b) => b.top_tier !== null && b.total_votes > 0)
    .map((b) => {
      const noteIds = Array.from(new Set(b.votes.map((v) => v.note_id)));
      const distSummary = `(一${b.tier_counts["一梯队"] ?? 0}/二${b.tier_counts["二梯队"] ?? 0}/三${b.tier_counts["三梯队"] ?? 0}/四${b.tier_counts["四梯队"] ?? 0})`;
      return {
        district: b.district,
        names: Array.from(new Set([b.official_name, ...b.votes.map((v) => v.matched_alias)])),
        tier: b.top_tier!,
        sourceName: "小红书 XHS",
        sourceUrl: noteIds.length > 0 ? `https://www.xiaohongshu.com/explore/${noteIds[0]}` : undefined,
        sourceNote: `XHS list-mode 投票聚合：${b.total_votes} 票 ${distSummary}；引用 note_ids: ${noteIds.slice(0, 5).join(", ")}`,
        verified: false,
        stage: b.type ?? "unknown",
      };
    });
  writeFileSync(
    outTiersPath,
    JSON.stringify(
      {
        _notes: [
          "本文件由 scripts/xhs-tier-aggregate.ts 自动生成，源数据为 data/xhs/notes-*.jsonl。",
          "投票算法：仅采纳「X梯队：A、B、C」list 模式，跨学校共现的散文修饰一律忽略。",
          "verified=false 表示需要人工/LLM 复核。少数派票（如 dist 一2/二3/三0/四0 的『二梯队』）建议二次确认。",
          "增量重写：每次 aggregate 完整覆盖。如需保留特定条目，请将 verified 改 true 并迁移到 data/school-tiers.json。",
        ],
        _generated_at: new Date().toISOString(),
        _source_jsonls: inputFiles.map((f) => path.basename(f)),
        items: tierFileItems,
      },
      null,
      2,
    ),
  );
  console.log(`[aggregate] backfill 兼容 TierFile: ${outTiersPath} (${tierFileItems.length} 条)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
