/**
 * Backfill the two reviewed 2025 Baoshan district admission policy pages.
 *
 * Dry-run is the default. Pass --apply to commit. The migration only inserts
 * district-level policy rows and uses an explicit natural-key lookup because
 * the legacy policies table has no unique constraint for this identity.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

export type BaoshanPolicySpec = {
  scope: "district";
  district: "宝山";
  year: 2025;
  stage: "小学" | "初中";
  title: string;
  sourceUrl: string;
  sourceDate: string;
  sourcePath: string;
};

export const BAOSHAN_POLICY_SPECS: BaoshanPolicySpec[] = [
  {
    scope: "district",
    district: "宝山",
    year: 2025,
    stage: "小学",
    title: "2025年宝山区义务教育阶段学校校区范围与招生计划（小学）",
    sourceUrl: "https://www.shanghai.gov.cn/bsqywjy/20250423/ac8a95f3a4494ef8bd356e112aec499c.html",
    sourceDate: "2025-04-23",
    sourcePath: path.join(process.cwd(), ".tmp", "baoshan-primary-policy.html"),
  },
  {
    scope: "district",
    district: "宝山",
    year: 2025,
    stage: "初中",
    title: "2025年宝山区义务教育阶段学校校区范围与招生计划（初中）",
    sourceUrl: "https://www.shanghai.gov.cn/bsqywjy/20250423/497250a7552b43c59fca0a904b1eee82.html",
    sourceDate: "2025-04-23",
    sourcePath: path.join(process.cwd(), ".tmp", "baoshan-middle-policy.html"),
  },
];

export function isAllowedBaoshanPolicy(spec: {
  scope: string;
  district: string;
  year: number;
  sourceUrl: string;
}) {
  return (
    spec.scope === "district" &&
    spec.district === "宝山" &&
    spec.year === 2025 &&
    /^https:\/\/www\.shanghai\.gov\.cn\/bsqywjy\/20250423\/[a-f0-9]+\.html$/.test(spec.sourceUrl)
  );
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)));
}

export function cleanOfficialHtml(html: string) {
  const contentMatch = /<div\b[^>]*id=["']ivs_content["'][^>]*>([\s\S]*?)<\/div>/i.exec(html);
  const selected = contentMatch?.[1] ?? html;
  return decodeHtmlEntities(
    selected
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/tr\s*>/gi, "\n")
      .replace(/<\/p\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t\r\f\v]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

export function policyContent(spec: BaoshanPolicySpec, body: string) {
  return [
    `页面标题：${spec.title}`,
    `政策类型：宝山区${spec.stage}义务教育招生范围与计划（区级政策）`,
    `来源日期：${spec.sourceDate}`,
    `来源 URL：${spec.sourceUrl}`,
    "",
    body.trim(),
  ].join("\n");
}

export function policyDedupeKey(spec: Pick<BaoshanPolicySpec, "scope" | "district" | "year" | "title" | "sourceUrl">) {
  return [spec.scope, spec.district, spec.year, spec.title, spec.sourceUrl].join("|");
}

function outputDir() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "baoshan-policy-backfill", stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function parseArgs() {
  const apply = process.argv.includes("--apply");
  const sourceDir = process.argv.find((arg) => arg.startsWith("--source-dir="))?.slice("--source-dir=".length);
  return { apply, sourceDir };
}

function sourcePathFor(spec: BaoshanPolicySpec, sourceDir?: string) {
  return sourceDir ? path.join(sourceDir, spec.stage === "小学" ? "baoshan-primary-policy.html" : "baoshan-middle-policy.html") : spec.sourcePath;
}

async function loadSource(spec: BaoshanPolicySpec, sourceDir?: string) {
  const localPath = sourcePathFor(spec, sourceDir);
  try {
    return { path: localPath, html: readFileSync(localPath, "utf8") };
  } catch (error) {
    if (!(error instanceof Error) || !String(error.message).includes("ENOENT")) throw error;
    const response = await fetch(spec.sourceUrl);
    if (!response.ok) throw new Error(`Failed to fetch ${spec.sourceUrl}: HTTP ${response.status}`);
    const html = await response.text();
    return { path: spec.sourceUrl, html };
  }
}

type Action = {
  key: string;
  scope: string;
  district: string;
  year: number;
  title: string;
  sourceUrl: string;
  sourcePath: string;
  contentLength: number;
  action: "insert" | "dry-run" | "skip-existing";
};

async function main() {
  const { apply, sourceDir } = parseArgs();
  const dir = outputDir();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const actions: Action[] = [];
  let inserted = 0;

  try {
    const loaded = await Promise.all(BAOSHAN_POLICY_SPECS.map((spec) => loadSource(spec, sourceDir)));
    writeFileSync(path.join(dir, "source-manifest.json"), JSON.stringify(BAOSHAN_POLICY_SPECS.map((spec, i) => ({ ...spec, loadedFrom: loaded[i]?.path })), null, 2), "utf8");
    await client.query("BEGIN");

    for (let i = 0; i < BAOSHAN_POLICY_SPECS.length; i += 1) {
      const spec = BAOSHAN_POLICY_SPECS[i]!;
      if (!isAllowedBaoshanPolicy(spec)) throw new Error(`Policy spec failed allowlist: ${spec.title}`);
      const body = cleanOfficialHtml(loaded[i]!.html);
      if (body.length < 100) throw new Error(`Official policy body is unexpectedly short: ${spec.title}`);
      const content = policyContent(spec, body);
      const key = policyDedupeKey(spec);
      const existing = await client.query(
        `SELECT id FROM public.policies
         WHERE scope = $1::public.policy_scope AND district = $2 AND year = $3
           AND title = $4 AND source_url = $5
         LIMIT 1`,
        [spec.scope, spec.district, spec.year, spec.title, spec.sourceUrl],
      );

      if (existing.rowCount) {
        actions.push({ ...spec, key, sourcePath: loaded[i]!.path, contentLength: content.length, action: "skip-existing" });
        continue;
      }

      if (apply) {
        const result = await client.query(
          `INSERT INTO public.policies
             (school_id, scope, district, year, title, source_url, content, change_summary, fetched_at)
           SELECT NULL, $1::public.policy_scope, $2, $3, $4, $5, $6, $7, now()
           WHERE NOT EXISTS (
             SELECT 1 FROM public.policies
             WHERE scope = $1::public.policy_scope AND district = $2 AND year = $3
               AND title = $4 AND source_url = $5
           )`,
          [spec.scope, spec.district, spec.year, spec.title, spec.sourceUrl, content, `官方${spec.stage}区级政策补充；正文来自上海市人民政府页面`],
        );
        inserted += result.rowCount ?? 0;
      }
      actions.push({ ...spec, key, sourcePath: loaded[i]!.path, contentLength: content.length, action: apply ? "insert" : "dry-run" });
    }

    writeFileSync(path.join(dir, apply ? "backfill-applied.json" : "backfill-dry-run.json"), JSON.stringify(actions, null, 2), "utf8");
    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", candidates: BAOSHAN_POLICY_SPECS.length, eligible: actions.filter((action) => action.action === "insert" || action.action === "dry-run").length, skippedExisting: actions.filter((action) => action.action === "skip-existing").length, inserted, report: dir }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
