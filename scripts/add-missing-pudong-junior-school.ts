/**
 * Insert a single missing 浦东 public junior-high master row that the official
 * 2025 公办初中招生地段公示 references but our schools table lacks (e.g. 上海市东昌东校).
 *
 * Safety rules (mirrors import-baoshan-schools.ts):
 * - default mode is dry-run; pass --apply to insert
 * - only inserts into schools; never deletes, truncates, resets, seeds, or touches mappings
 * - snapshots current 浦东 schools and writes a report under .tmp
 * - skips if a 浦东 school with the same normalized name already exists
 *
 * Usage:
 *   npx tsx scripts/add-missing-pudong-junior-school.ts                       # dry-run, default name 上海市东昌东校
 *   npx tsx scripts/add-missing-pudong-junior-school.ts --name=上海市东昌东校 --apply
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;
loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const district = "浦东";
const name = valueArg("--name") ?? "上海市东昌东校";
const SOURCE_URL =
  "https://www.shanghai.gov.cn/pdxqywjy/20250507/79de2fd60f4a42099fad4acc7aa78922.html";

function valueArg(n: string) {
  const inline = process.argv.find((a) => a.startsWith(`${n}=`));
  if (inline) return inline.slice(n.length + 1).trim();
  const i = process.argv.indexOf(n);
  if (i >= 0) return process.argv[i + 1]?.trim();
  return undefined;
}

function normalizeName(value: string) {
  return value.replace(/[（）]/g, (c) => (c === "（" ? "(" : ")")).replace(/\s+/g, "").trim();
}

async function main() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "pudong-school-add", stamp);
  mkdirSync(dir, { recursive: true });

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const before = await client.query(
      `SELECT id, name, type FROM schools WHERE district = $1 ORDER BY id`,
      [district],
    );
    writeFileSync(path.join(dir, "pudong-schools-before.json"), JSON.stringify(before.rows, null, 2), "utf8");

    const target = normalizeName(name);
    const existing = before.rows.find((r: { name: string }) => normalizeName(r.name) === target);

    console.log(`Mode: ${apply ? "apply" : "dry-run"}`);
    console.log(`District: ${district}`);
    console.log(`Name: ${name}`);
    console.log(`Existing ${district} schools: ${before.rows.length}`);

    if (existing) {
      console.log(`Already exists (id ${(existing as { id: number }).id}); nothing to insert.`);
      await client.query("ROLLBACK").catch(() => {});
      return;
    }

    const attrs = {
      campus: "东校",
      verified: false,
      data_source: "上海市浦东新区2025公办初中招生地段公示",
      official_school_info_source: {
        source_url: SOURCE_URL,
        source_title: "2025年浦东新区公办初中招生地段公示",
        matched_name: name,
      },
      added_by: "add-missing-pudong-junior-school.ts",
    };

    if (!apply) {
      console.log("Would insert:", JSON.stringify({ name, district, type: "middle", school_nature: "公立", tier: "未入榜/待补充", attrs }, null, 2));
      console.log("No changes (dry-run).");
      return;
    }

    await client.query("BEGIN");
    const res = await client.query<{ id: number }>(
      `
        INSERT INTO schools (name, district, type, school_nature, tier, pit_risk_level, attrs)
        VALUES ($1, $2, 'middle', '公立', '未入榜/待补充', 'unknown', $3::jsonb)
        RETURNING id
      `,
      [name, district, JSON.stringify(attrs)],
    );
    await client.query("COMMIT");
    console.log(`Inserted school id ${res.rows[0]?.id}: ${name}`);
    console.log("No deletes, resets, seeds, overwrites, or updates were performed.");
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
