/**
 * 用 .tmp/xhs-profile/ 里持久化的登录态批量搜索学校并 dump 原文。
 *
 * 两种模式：
 *
 * (A) 学校模式（默认）：从 PG schools 表拉学校，以 "{name} 梯队" 为搜索词遍历。
 *   pnpm xhs:collect --district 徐汇 --type primary --max-schools 30 --limit 5
 *
 * (B) 自由 query 模式：直接传搜索词列表，不绑学校；每条 note 的 school_id=0。
 *   pnpm xhs:collect --queries "上海市徐汇区小学梯队,上海市黄浦区初中梯队" --limit 15
 *   pnpm xhs:collect --queries-file scripts/xhs-district-queries.txt --limit 15
 *
 * 公共选项：
 *   --query-template "{name} 梯队"  仅 (A)，默认值
 *   --out data/xhs/notes-YYYYMMDD.jsonl
 *   --resume                            (A) 跳过已抓 school；(B) 跳过已抓 query
 *   --headed                            可见调试
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { chromium, type BrowserContext, type Page } from "playwright";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;

loadLocalEnv();

// ---------- CLI helpers (沿用 backfill-school-tiers 习惯) ----------
function valueArg(name: string): string | undefined {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1].trim();
  return undefined;
}
function numberArg(name: string): number | undefined {
  const raw = valueArg(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid number for ${name}: ${raw}`);
  return n;
}

const districtFilter = valueArg("--district");
const typeFilter = valueArg("--type");
const perSchoolLimit = numberArg("--limit") ?? 10;
const maxSchools = numberArg("--max-schools") ?? 20;
const queryTemplate = valueArg("--query-template") ?? "{name} 梯队";
const headed = process.argv.includes("--headed");
const resume = process.argv.includes("--resume");
const queriesArg = valueArg("--queries");
const queriesFile = valueArg("--queries-file");

const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const defaultOut = path.join(process.cwd(), "data", "xhs", `notes-${today}.jsonl`);
const outPath = valueArg("--out") ? path.resolve(valueArg("--out")!) : defaultOut;

// ---------- 类型 ----------
type SchoolRow = {
  id: number;
  name: string;
  district: string;
  type: string | null;
};

type Comment = { author: string | null; text: string | null; likes: number | null };

type NoteRecord = {
  ts: string;
  school_id: number;
  school_name: string;
  district: string;
  type: string | null;
  query: string;
  note_id: string;
  note_url: string;
  title: string | null;
  content: string | null;
  tags: string[];
  author: { id: string | null; name: string | null };
  likes: number | null;
  comments_count: number | null;
  publish_time: string | null;
  comments: Comment[];
};

type ErrorRecord = {
  ts: string;
  school_id: number;
  school_name: string;
  district: string;
  query: string;
  note_id?: string;
  error: string;
};

// ---------- 通用工具 ----------
function nowIso() {
  // 带本地时区偏移
  const d = new Date();
  const pad = (n: number) => `${n}`.padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function jitterSleep(baseMs: number, extraMs: number) {
  await sleep(baseMs + Math.random() * extraMs);
}

function appendLine(file: string, obj: unknown) {
  appendFileSync(file, JSON.stringify(obj) + "\n");
}

function loadResumeSet(file: string): Set<number> {
  if (!existsSync(file)) return new Set();
  const set = new Set<number>();
  const text = readFileSync(file, "utf-8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj.school_id === "number" && !obj.error) {
        set.add(obj.school_id);
      }
    } catch {
      // ignore
    }
  }
  return set;
}

// ---------- DB ----------
async function fetchSchools(): Promise<SchoolRow[]> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required (check .env.local)");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<SchoolRow>(
      `
        SELECT id, name, district, type::text AS type
        FROM schools
        WHERE ($1::text IS NULL OR district = $1)
          AND ($2::text IS NULL OR type::text = $2)
        ORDER BY district, id
        LIMIT $3
      `,
      [districtFilter ?? null, typeFilter ?? null, maxSchools],
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

// ---------- XHS 抓取 ----------
const PROFILE_DIR = path.join(process.cwd(), ".tmp", "xhs-profile");
const SEARCH_BASE = "https://www.xiaohongshu.com/search_result";

function buildSearchUrl(query: string) {
  const u = new URL(SEARCH_BASE);
  u.searchParams.set("keyword", query);
  u.searchParams.set("source", "web_search_result_notes");
  u.searchParams.set("type", "51");
  return u.toString();
}

async function detectLoginWall(page: Page): Promise<string | null> {
  const url = page.url();
  if (url.includes("/login") || url.includes("/passport")) return `redirected to ${url}`;
  // 弹出登录浮层
  const loginModal = await page.locator('div[class*="login-container"], div[class*="login-modal"]').first().count().catch(() => 0);
  if (loginModal > 0) return "login modal detected";
  // 验证码
  const captcha = await page.locator('div[class*="captcha"], iframe[src*="captcha"]').first().count().catch(() => 0);
  if (captcha > 0) return "captcha detected";
  return null;
}

async function dumpDebug(page: Page, label: string) {
  const tsTag = nowIso().replace(/[:+]/g, "-");
  const outDir = path.join(process.cwd(), ".tmp");
  mkdirSync(outDir, { recursive: true });
  const png = path.join(outDir, `xhs-debug-${label}-${tsTag}.png`);
  await page.screenshot({ path: png, fullPage: true }).catch(() => undefined);
  console.warn(`[xhs-collect] debug screenshot: ${png}`);
}

type SearchHit = { noteId: string; href: string };

async function collectSearchHits(page: Page, query: string, limit: number): Promise<SearchHit[]> {
  await page.goto(buildSearchUrl(query), { waitUntil: "domcontentloaded", timeout: 30_000 });
  // 等卡片或确认空结果
  await Promise.race([
    page.waitForSelector('a[href*="/explore/"]', { timeout: 12_000 }),
    page.waitForSelector('text=/没有相关.*结果|未找到|无搜索结果/', { timeout: 12_000 }),
  ]).catch(() => undefined);

  const wall = await detectLoginWall(page);
  if (wall) throw new Error(`login wall: ${wall}`);

  const hits = await page.evaluate((cap: number) => {
    // 卡片里通常有两个 a：一个 /explore/<id> 无 token（隐藏占位），一个
    // /search_result/<id>?xsec_token=... 才是带凭证可打开详情的。优先抓后者。
    const byId = new Map<string, { tokenHref: string | null; bareHref: string }>();
    const anchors = Array.from(document.querySelectorAll('a[href*="/explore/"], a[href*="/search_result/"]')) as HTMLAnchorElement[];
    for (const a of anchors) {
      const href = a.href;
      const m = href.match(/\/(?:explore|search_result)\/([0-9a-f]+)/i);
      if (!m) continue;
      const id = m[1];
      const cur = byId.get(id) ?? { tokenHref: null, bareHref: href };
      if (href.includes("xsec_token=") && !cur.tokenHref) cur.tokenHref = href;
      if (!cur.bareHref) cur.bareHref = href;
      byId.set(id, cur);
    }
    const out: { noteId: string; href: string }[] = [];
    for (const [id, v] of byId.entries()) {
      let href = v.tokenHref ?? v.bareHref;
      // 强制补 xsec_source=pc_search（搜索结果里这个字段经常是空的，详情页要求非空）
      try {
        const u = new URL(href);
        if (!u.searchParams.get("xsec_source")) u.searchParams.set("xsec_source", "pc_search");
        href = u.toString();
      } catch {
        // ignore URL parse failure
      }
      out.push({ noteId: id, href });
      if (out.length >= cap) break;
    }
    return out;
  }, limit);

  return hits;
}

function extractNumber(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\s/g, "");
  const wMatch = cleaned.match(/([0-9.]+)\s*[wW万]/);
  if (wMatch) return Math.round(parseFloat(wMatch[1]) * 10_000);
  const m = cleaned.match(/[0-9]+(?:\.[0-9]+)?/);
  return m ? parseFloat(m[0]) : null;
}

async function scrapeNoteDetail(page: Page, hit: SearchHit): Promise<Omit<NoteRecord, "ts" | "school_id" | "school_name" | "district" | "type" | "query"> | { error: string }> {
  await page.goto(hit.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForSelector("#detail-desc, .note-content", { timeout: 12_000 }).catch(() => undefined);
  // 评论懒加载，给一点时间
  await page.waitForTimeout(1500);

  const wall = await detectLoginWall(page);
  if (wall) return { error: `login wall on detail: ${wall}` };

  const data = await page.evaluate(() => {
    const text = (sel: string) => {
      const el = document.querySelector(sel);
      return el && el.textContent ? el.textContent.trim() : null;
    };
    const desc = text("#detail-desc") ?? text(".note-content .desc") ?? text(".desc");
    // XHS 多数 note 没单独 title 节点，用 desc 第一行；document.title 含完整内容也可作 fallback
    const explicitTitle = text("#detail-title");
    const firstLine = desc ? desc.split("\n").map((s) => s.trim()).filter(Boolean)[0] ?? null : null;
    const title = explicitTitle ?? firstLine ?? document.title.replace(/ - 小红书.*$/, "").slice(0, 200);

    // tags 从正文里 # 抽取（不取 a.tag，会撞到无关的 nav）
    const tagSet = new Set<string>();
    if (desc) {
      const re = /#([^#\s]+?)(?=[\s#]|$)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(desc)) !== null) {
        const t = m[1].trim();
        if (t) tagSet.add("#" + t);
      }
    }

    const authorName = text(".author-wrapper .name") ?? text(".user-info .name") ?? text(".info .name");
    const authorAnchor = document.querySelector(".author-wrapper a, .info .user a, .user-info a") as HTMLAnchorElement | null;
    const authorHref = authorAnchor?.href ?? null;

    const likesRaw = text(".like-wrapper .count") ?? text(".engage-bar .like .count") ?? text(".buttons .like-count");
    // 「共 N 条评论」
    const totalNode = document.querySelector(".total");
    const totalRaw = totalNode?.textContent?.trim() ?? null;
    const dateRaw = text(".date") ?? text(".bottom-container .date");

    const commentNodes = Array.from(document.querySelectorAll(".parent-comment, .comment-item"));
    const comments = commentNodes.slice(0, 15).map((node) => {
      const get = (sel: string) => {
        const el = node.querySelector(sel);
        return el && el.textContent ? el.textContent.trim() : null;
      };
      return {
        author: get(".name, .author"),
        text: get(".content, .note-text"),
        likesRaw: get(".like-count, .like .count, .interactions .count"),
      };
    });
    return { title, desc, tags: Array.from(tagSet), authorName, authorHref, likesRaw, totalRaw, dateRaw, comments };
  });

  return {
    note_id: hit.noteId,
    note_url: hit.href,
    title: data.title,
    content: data.desc,
    tags: data.tags,
    author: {
      id: data.authorHref ? data.authorHref.split("/").filter(Boolean).pop() ?? null : null,
      name: data.authorName,
    },
    likes: extractNumber(data.likesRaw),
    comments_count: extractNumber(data.totalRaw),
    publish_time: data.dateRaw,
    comments: data.comments.map((c) => ({
      author: c.author,
      text: c.text,
      likes: extractNumber(c.likesRaw),
    })),
  };
}

function loadQueries(): string[] {
  if (queriesArg) {
    return queriesArg.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (queriesFile) {
    const content = readFileSync(path.resolve(queriesFile), "utf-8");
    return content
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("#"));
  }
  return [];
}

function loadResumeQuerySet(file: string): Set<string> {
  if (!existsSync(file)) return new Set();
  const set = new Set<string>();
  const text = readFileSync(file, "utf-8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj.query === "string" && !obj.error) set.add(obj.query);
    } catch {
      // ignore
    }
  }
  return set;
}

// ---------- 主流程 ----------
async function main() {
  const queries = loadQueries();
  const isQueryMode = queries.length > 0;

  console.log("[xhs-collect] config:", {
    mode: isQueryMode ? "query" : "schools",
    queries: isQueryMode ? `${queries.length} 条` : undefined,
    districtFilter,
    typeFilter,
    perSchoolLimit,
    maxSchools,
    queryTemplate: isQueryMode ? undefined : queryTemplate,
    headed,
    resume,
    outPath,
  });

  if (!existsSync(PROFILE_DIR) || statSync(PROFILE_DIR).isFile()) {
    throw new Error(`未检测到登录态 profile (${PROFILE_DIR})。请先运行: pnpm xhs:login`);
  }

  mkdirSync(path.dirname(outPath), { recursive: true });

  const context: BrowserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: !headed,
    viewport: { width: 1280, height: 900 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
  // tsx (esbuild) injects __name(fn, "name") around named functions; when
  // page.evaluate ships our function string to the page, __name is undefined.
  // Stub it on every page before any of our scripts run.
  await context.addInitScript(() => {
    const g = globalThis as unknown as { __name?: (fn: unknown) => unknown };
    if (!g.__name) g.__name = (fn) => fn;
  });
  const page = context.pages()[0] ?? (await context.newPage());

  if (isQueryMode) {
    await runQueryMode(page, context, queries);
  } else {
    await runSchoolsMode(page, context);
  }
}

async function runQueryMode(page: Page, context: BrowserContext, queries: string[]) {
  const skipSet = resume ? loadResumeQuerySet(outPath) : new Set<string>();
  if (resume) console.log(`[xhs-collect] resume: 已记录 ${skipSet.size} 条 query，将跳过`);

  let okQueries = 0;
  let totalNotes = 0;
  let errorRows = 0;

  try {
    for (const query of queries) {
      if (skipSet.has(query)) {
        console.log(`[skip] ${query}`);
        continue;
      }
      console.log(`[search] query="${query}"`);

      let hits: SearchHit[] = [];
      try {
        hits = await collectSearchHits(page, query, perSchoolLimit);
      } catch (err) {
        const msg = (err as Error).message;
        console.warn(`  ✗ search failed: ${msg}`);
        const rec: ErrorRecord = {
          ts: nowIso(),
          school_id: 0,
          school_name: "",
          district: "",
          query,
          error: `search: ${msg}`,
        };
        appendLine(outPath, rec);
        errorRows += 1;
        if (msg.includes("login wall")) {
          await dumpDebug(page, "login-wall");
          throw new Error("登录态失效或被风控，停止抓取。请先 pnpm xhs:login 重新登录。");
        }
        await jitterSleep(2_500, 1_500);
        continue;
      }

      if (hits.length === 0) {
        console.log(`  · 0 hits`);
        const rec: ErrorRecord = {
          ts: nowIso(),
          school_id: 0,
          school_name: "",
          district: "",
          query,
          error: "no results",
        };
        appendLine(outPath, rec);
        errorRows += 1;
        await jitterSleep(2_500, 1_500);
        continue;
      }

      console.log(`  · ${hits.length} hits`);
      let queryOk = 0;
      for (const hit of hits) {
        try {
          const detail = await scrapeNoteDetail(page, hit);
          if ("error" in detail) {
            const rec: ErrorRecord = {
              ts: nowIso(),
              school_id: 0,
              school_name: "",
              district: "",
              query,
              note_id: hit.noteId,
              error: detail.error,
            };
            appendLine(outPath, rec);
            errorRows += 1;
          } else {
            const rec: NoteRecord = {
              ts: nowIso(),
              school_id: 0,
              school_name: "",
              district: "",
              type: null,
              query,
              ...detail,
            };
            appendLine(outPath, rec);
            queryOk += 1;
            totalNotes += 1;
          }
        } catch (err) {
          const msg = (err as Error).message;
          console.warn(`    ✗ note ${hit.noteId}: ${msg}`);
          const rec: ErrorRecord = {
            ts: nowIso(),
            school_id: 0,
            school_name: "",
            district: "",
            query,
            note_id: hit.noteId,
            error: `detail: ${msg}`,
          };
          appendLine(outPath, rec);
          errorRows += 1;
        }
        await jitterSleep(1_500, 1_000);
      }

      if (queryOk > 0) okQueries += 1;
      await jitterSleep(2_500, 1_500);
    }
  } finally {
    await context.close().catch(() => undefined);
  }

  console.log(`\n[xhs-collect] done (query mode). ok_queries=${okQueries}/${queries.length} total_notes=${totalNotes} errors=${errorRows}`);
  console.log(`[xhs-collect] output: ${outPath}`);
}

async function runSchoolsMode(page: Page, context: BrowserContext) {
  const skipSet = resume ? loadResumeSet(outPath) : new Set<number>();
  if (resume) console.log(`[xhs-collect] resume: 已记录 ${skipSet.size} 所学校，将跳过`);

  const schools = await fetchSchools();
  console.log(`[xhs-collect] DB returned ${schools.length} schools`);

  let okSchools = 0;
  let totalNotes = 0;
  let errorRows = 0;

  try {
    for (const school of schools) {
      if (skipSet.has(school.id)) {
        console.log(`[skip] ${school.district} ${school.name} (#${school.id})`);
        continue;
      }
      const query = queryTemplate.replace("{name}", school.name);
      console.log(`[search] ${school.district} ${school.name} -> "${query}"`);

      let hits: SearchHit[] = [];
      try {
        hits = await collectSearchHits(page, query, perSchoolLimit);
      } catch (err) {
        const msg = (err as Error).message;
        console.warn(`  ✗ search failed: ${msg}`);
        const rec: ErrorRecord = {
          ts: nowIso(),
          school_id: school.id,
          school_name: school.name,
          district: school.district,
          query,
          error: `search: ${msg}`,
        };
        appendLine(outPath, rec);
        errorRows += 1;
        if (msg.includes("login wall")) {
          await dumpDebug(page, "login-wall");
          throw new Error("登录态失效或被风控，停止抓取。请先 pnpm xhs:login 重新登录。");
        }
        await jitterSleep(2_500, 1_500);
        continue;
      }

      if (hits.length === 0) {
        console.log(`  · 0 hits`);
        const rec: ErrorRecord = {
          ts: nowIso(),
          school_id: school.id,
          school_name: school.name,
          district: school.district,
          query,
          error: "no results",
        };
        appendLine(outPath, rec);
        errorRows += 1;
        await jitterSleep(2_500, 1_500);
        continue;
      }

      console.log(`  · ${hits.length} hits`);
      let schoolOk = 0;
      for (const hit of hits) {
        try {
          const detail = await scrapeNoteDetail(page, hit);
          if ("error" in detail) {
            const rec: ErrorRecord = {
              ts: nowIso(),
              school_id: school.id,
              school_name: school.name,
              district: school.district,
              query,
              note_id: hit.noteId,
              error: detail.error,
            };
            appendLine(outPath, rec);
            errorRows += 1;
          } else {
            const rec: NoteRecord = {
              ts: nowIso(),
              school_id: school.id,
              school_name: school.name,
              district: school.district,
              type: school.type,
              query,
              ...detail,
            };
            appendLine(outPath, rec);
            schoolOk += 1;
            totalNotes += 1;
          }
        } catch (err) {
          const msg = (err as Error).message;
          console.warn(`    ✗ note ${hit.noteId}: ${msg}`);
          const rec: ErrorRecord = {
            ts: nowIso(),
            school_id: school.id,
            school_name: school.name,
            district: school.district,
            query,
            note_id: hit.noteId,
            error: `detail: ${msg}`,
          };
          appendLine(outPath, rec);
          errorRows += 1;
        }
        await jitterSleep(1_500, 1_000);
      }

      if (schoolOk > 0) okSchools += 1;
      await jitterSleep(2_500, 1_500);
    }
  } finally {
    await context.close().catch(() => undefined);
  }

  console.log(`\n[xhs-collect] done (schools mode). schools_with_notes=${okSchools} total_notes=${totalNotes} errors=${errorRows}`);
  console.log(`[xhs-collect] output: ${outPath}`);
}

main().catch((err) => {
  console.error("[xhs-collect] fatal:", err);
  process.exit(1);
});
