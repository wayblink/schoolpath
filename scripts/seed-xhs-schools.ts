/**
 * 把 data/school-tiers.xhs.json 里 PG 还没收录的顶级民办/公办名校 INSERT 到 schools 表。
 *
 * 策略：保守做法
 *   1. 对每条 xhs item，用 backfill 同款 normalize 在 PG 同区做模糊匹配。
 *   2. score >= 200：认为是现有学校（哪怕名字不完全一致），跳过 INSERT，避免重复。
 *   3. 100 <= score < 200：列入"需人工复核"，不 INSERT，输出供人工审。
 *   4. score < 100：PG 完全没这所学校，INSERT 时直接带 tier + xhs 元数据。
 *
 * 安全规则：
 *   - 默认 dry-run；--apply 才真插
 *   - INSERT 包在 BEGIN/COMMIT 事务里，任意一行报错回滚
 *   - 输出 snapshot/before, plan, applied 三个 json 报告到 .tmp/seed-xhs-schools/<ts>/
 *   - 永不 UPDATE，永不 DELETE
 *
 * 用法：
 *   pnpm tsx scripts/seed-xhs-schools.ts                  # dry-run，看计划
 *   pnpm tsx scripts/seed-xhs-schools.ts --apply          # 真插
 *   pnpm tsx scripts/seed-xhs-schools.ts --source path.json --apply
 *   pnpm tsx scripts/seed-xhs-schools.ts --district 徐汇  # 仅处理某区
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const { Client } = pg;

// ---------- CLI ----------
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

const sourcePath = path.resolve(valueArg("--source") ?? "data/school-tiers.xhs.json");
const districtFilter = valueArg("--district");
const apply = process.argv.includes("--apply");
const insertScoreCeil = numberArg("--insert-below") ?? 100; // score < 此值才 INSERT
const matchScoreFloor = numberArg("--match-above") ?? 200; // score >= 此值认为已收录

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) throw new Error("DATABASE_URL is required (.env.local)");

// ---------- normalize（与 backfill-school-tiers.ts 一致）----------
function normalizeName(value: string) {
  return value
    .replace(/（[^）]*校区）|\([^)]*校区\)/g, "")
    .replace(/（[^）]*部）|\([^)]*部\)/g, "")
    .replace(/[\s　·•\-—]+/g, "")
    .replace(/[()（）]/g, "")
    .replace(/^上海市/, "")
    .replace(/^(民办|私立|公办)/, "")
    .replace(/教育集团/g, "")
    .replace(/集团校/g, "")
    .replace(/初级中学/g, "中学")
    .replace(/实验学校/g, "实验")
    .replace(/附属/g, "附")
    .replace(/区/g, "")
    .replace(/等$/, "")
    .trim();
}
function compactName(value: string) {
  return value
    .replace(/[\s　·•\-—]+/g, "")
    .replace(/^上海市/, "")
    .replace(/[()（）]/g, "")
    .replace(/^(民办|私立|公办)/, "")
    .replace(/等$/, "")
    .trim();
}

function scoreSimilarity(schoolName: string, candidate: string) {
  const a = normalizeName(schoolName);
  const b = normalizeName(candidate);
  const aS = compactName(schoolName);
  const bS = compactName(candidate);
  if (!a || !b) return -100;
  if (aS === bS) return 300;
  if (a === b) return 260;
  let score = 0;
  if (a.includes(b) || b.includes(a)) score += 110;
  if (aS.includes(bS) || bS.includes(aS)) score += 90;
  const aChars = new Set(a);
  const bChars = new Set(b);
  let overlap = 0;
  for (const ch of bChars) if (aChars.has(ch)) overlap += 1;
  score += Math.round((overlap / Math.max(aChars.size, bChars.size)) * 80);
  return score;
}

// ---------- 学校属性推断 ----------
function inferSchoolNature(name: string): "民办" | "公办" {
  if (/民办|私立/.test(name)) return "民办";
  return "公办";
}
function inferTypeFromStage(stage: string | undefined): "primary" | "middle" | "nine_year" {
  if (stage === "primary") return "primary";
  if (stage === "nine_year") return "nine_year";
  return "middle"; // 默认
}

// ---------- 类型 ----------
type XhsItem = {
  district: string;
  names: string[];
  tier: string;
  sourceName?: string;
  sourceUrl?: string;
  sourceNote?: string;
  verified?: boolean;
  stage?: "primary" | "middle" | "unknown";
};

type PGSchoolRow = {
  id: number;
  name: string;
  district: string;
  type: string;
  tier: string | null;
};

type Decision = {
  xhs: XhsItem;
  best_match: { school: PGSchoolRow; score: number } | null;
  action: "skip-already-exists" | "insert" | "needs-review";
};

// ---------- 主流程 ----------
async function main() {
  const fileRaw = readFileSync(sourcePath, "utf-8");
  const file = JSON.parse(fileRaw) as { items?: XhsItem[] };
  const items = (file.items ?? []).filter((x) => !districtFilter || x.district === districtFilter);
  console.log(`[seed-xhs] source: ${sourcePath} (${items.length} 条${districtFilter ? `, 仅 ${districtFilter}` : ""})`);

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    const decisions: Decision[] = [];

    for (const item of items) {
      const candidates = await client.query<PGSchoolRow>(
        `SELECT id, name, district, type::text AS type, tier FROM schools WHERE district = $1`,
        [item.district],
      );
      // 取每个 xhs 别名 vs 每个候选的最高 score
      let best: { school: PGSchoolRow; score: number } | null = null;
      for (const candName of item.names) {
        for (const cand of candidates.rows) {
          const s = scoreSimilarity(candName, cand.name);
          if (!best || s > best.score) best = { school: cand, score: s };
        }
      }

      let action: Decision["action"];
      if (best && best.score >= matchScoreFloor) action = "skip-already-exists";
      else if (best && best.score >= insertScoreCeil) action = "needs-review";
      else action = "insert";

      decisions.push({ xhs: item, best_match: best, action });
    }

    // 报告分类
    const skip = decisions.filter((d) => d.action === "skip-already-exists");
    const review = decisions.filter((d) => d.action === "needs-review");
    const toInsert = decisions.filter((d) => d.action === "insert");

    console.log(`\n[seed-xhs] 分类:`);
    console.log(`  skip-already-exists: ${skip.length}`);
    console.log(`  needs-review (模糊匹配 ${insertScoreCeil}-${matchScoreFloor}): ${review.length}`);
    console.log(`  insert: ${toInsert.length}`);

    if (review.length > 0) {
      console.log(`\n--- 需复核（不会自动 INSERT）---`);
      for (const d of review) {
        console.log(
          `  score=${d.best_match!.score} XHS:[${d.xhs.district}/${d.xhs.tier}] ${d.xhs.names[0]}` +
            ` ↔ PG:#${d.best_match!.school.id} ${d.best_match!.school.name} (现 tier=${d.best_match!.school.tier ?? "null"})`,
        );
      }
    }

    if (toInsert.length > 0) {
      console.log(`\n--- 待 INSERT ---`);
      for (const d of toInsert) {
        const stage = inferTypeFromStage(d.xhs.stage);
        const nature = inferSchoolNature(d.xhs.names[0]);
        const bestNote = d.best_match
          ? ` (PG 最相似: ${d.best_match.school.name}, score=${d.best_match.score})`
          : "";
        console.log(`  [${d.xhs.district}/${stage}/${nature}/${d.xhs.tier}] ${d.xhs.names[0]}${bestNote}`);
      }
    }

    // 写报告
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const outDir = path.join(process.cwd(), ".tmp", "seed-xhs-schools", ts);
    mkdirSync(outDir, { recursive: true });
    const planPath = path.join(outDir, apply ? "plan-applied.json" : "plan-dry-run.json");
    writeFileSync(
      planPath,
      JSON.stringify(
        {
          _generated_at: new Date().toISOString(),
          _source: sourcePath,
          _config: { districtFilter, apply, insertScoreCeil, matchScoreFloor },
          summary: { skip: skip.length, review: review.length, insert: toInsert.length },
          decisions,
        },
        null,
        2,
      ),
    );
    console.log(`\n[seed-xhs] 计划报告: ${planPath}`);

    if (!apply) {
      console.log(`\n[seed-xhs] dry-run 完成。加 --apply 真插。`);
      return;
    }

    // 真插
    if (toInsert.length === 0) {
      console.log(`[seed-xhs] 无可插入条目。`);
      return;
    }

    await client.query("BEGIN");
    let inserted = 0;
    try {
      for (const d of toInsert) {
        const stage = inferTypeFromStage(d.xhs.stage);
        const nature = inferSchoolNature(d.xhs.names[0]);
        const noteIdsMatch = d.xhs.sourceNote?.match(/note_ids:\s*([0-9a-f, ]+)/i);
        const noteIds = noteIdsMatch ? noteIdsMatch[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
        const attrs = {
          data_source: "xhs-aggregate-2026-06",
          verified: false,
          school_nature: { value: nature, normalized: nature === "民办" ? "private" : "public" },
          xhs_votes: {
            top_tier: d.xhs.tier,
            source_name: d.xhs.sourceName ?? "小红书 XHS",
            source_url: d.xhs.sourceUrl,
            note_ids: noteIds,
            ingestion_note: d.xhs.sourceNote,
          },
          aliases: d.xhs.names.slice(1),
          source_inserted_at: new Date().toISOString(),
        };
        const res = await client.query<{ id: number }>(
          `INSERT INTO schools (name, district, type, tier, attrs)
           VALUES ($1, $2, $3::school_type, $4, $5::jsonb)
           RETURNING id`,
          [d.xhs.names[0], d.xhs.district, stage, d.xhs.tier, JSON.stringify(attrs)],
        );
        console.log(`  INSERT id=${res.rows[0].id} ${d.xhs.district}/${stage} ${d.xhs.names[0]} -> ${d.xhs.tier}`);
        inserted += 1;
      }
      await client.query("COMMIT");
      console.log(`\n[seed-xhs] ✓ INSERT 成功 ${inserted} 条，已 COMMIT。`);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`[seed-xhs] INSERT 失败，已回滚:`, err);
      throw err;
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
