/**
 * 百度搜索结果（SERP）抓取，直接写 JSONL。
 *
 * 思路：百度 SERP 摘要里大量直接包含 "一梯队：X、Y、Z" 这类片段，
 * 我们只抓 SERP 不进详情页，速度极快。后续点完详情可以加。
 *
 * 用法：
 *   pnpm tsx scripts/baidu-collect.ts \
 *     --queries-file scripts/baidu-queries.txt \
 *     [--pages 2]   # 每个 query 翻多少页（每页 10 结果）
 *     [--out data/baidu/results-YYYYMMDD.jsonl]
 *     [--headed]
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";

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

const queriesArg = valueArg("--queries");
const queriesFile = valueArg("--queries-file");
const pagesPerQuery = numberArg("--pages") ?? 2;
const headed = process.argv.includes("--headed");

const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const outPath = valueArg("--out") ?? path.join(process.cwd(), "data", "baidu", `results-${today}.jsonl`);

function loadQueries(): string[] {
  if (queriesArg) return queriesArg.split(",").map((s) => s.trim()).filter(Boolean);
  if (queriesFile) {
    return readFileSync(path.resolve(queriesFile), "utf-8")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("#"));
  }
  return [];
}

function nowIso() {
  const d = new Date();
  const pad = (n: number) => `${n}`.padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

async function jitter(baseMs: number, extraMs: number) {
  await new Promise((r) => setTimeout(r, baseMs + Math.random() * extraMs));
}

type Result = {
  ts: string;
  query: string;
  page: number;
  rank: number;
  title: string;
  url: string;
  abstract: string; // 摘要文本（含梯队片段）
  source: string; // 来源域 / 站名
};

type SearchResultItem = Pick<Result, "title" | "url" | "abstract" | "source">;

async function scrapePage(page: Page, query: string, pageNum: number): Promise<Result[]> {
  const start = pageNum * 10;
  const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&pn=${start}&rn=10`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  // 反爬：偶尔会出现"百度安全验证" 滑块。检测一下。
  const pageTitle = await page.title();
  if (/安全验证|百度安全|robot|验证/i.test(pageTitle)) throw new Error(`captcha: ${pageTitle}`);
  // 等结果
  await page.waitForSelector('div.c-container, #content_left .result, #content_left .c-container', { timeout: 10_000 }).catch(() => undefined);
  const results = await page.evaluate<SearchResultItem[]>(() => {
    const out: SearchResultItem[] = [];
    const containers = Array.from(document.querySelectorAll('div.c-container[mu], div.result[mu], div.c-container'));
    for (const c of containers) {
      const a = c.querySelector('h3 a, .t a, a.title') as HTMLAnchorElement | null;
      if (!a) continue;
      const title = (a.textContent || "").trim();
      const url = a.href || a.getAttribute("href") || "";
      // 摘要：百度的摘要在 .c-abstract / .c-span9 / .content-right_8Zs40 等 class，跨版本 class 名不稳定
      // 用通用方法：取 container 的 innerText 去掉 title 部分
      const fullText = (c as HTMLElement).innerText || "";
      const abstract = fullText
        .replace(title, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 800);
      // source / 站名
      const sourceEl = c.querySelector('.c-color-gray, .source-name, .siteLink_9TPP3, [class*="source"]');
      const source = sourceEl?.textContent?.trim() ?? "";
      out.push({ title, url, abstract, source });
    }
    return out;
  });
  return results.map((r, i) => ({
    ts: nowIso(),
    query,
    page: pageNum,
    rank: i + 1,
    title: r.title,
    url: r.url,
    abstract: r.abstract,
    source: r.source,
  }));
}

async function main() {
  const queries = loadQueries();
  if (queries.length === 0) throw new Error("--queries or --queries-file required");
  console.log(`[baidu] ${queries.length} queries × ${pagesPerQuery} pages → ${outPath}`);
  mkdirSync(path.dirname(outPath), { recursive: true });

  const browser = await chromium.launch({ headless: !headed });
  const context: BrowserContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
  await context.addInitScript(() => {
    const g = globalThis as unknown as { __name?: (fn: unknown) => unknown };
    if (!g.__name) g.__name = (fn) => fn;
  });
  const page = await context.newPage();

  let totalRows = 0;
  let errors = 0;

  for (const query of queries) {
    console.log(`[search] ${query}`);
    for (let p = 0; p < pagesPerQuery; p++) {
      try {
        const rows = await scrapePage(page, query, p);
        for (const r of rows) appendFileSync(outPath, JSON.stringify(r) + "\n");
        console.log(`  · page ${p}: ${rows.length} rows`);
        totalRows += rows.length;
      } catch (e) {
        console.warn(`  ✗ page ${p}: ${(e as Error).message}`);
        appendFileSync(outPath, JSON.stringify({ ts: nowIso(), query, page: p, error: (e as Error).message }) + "\n");
        errors += 1;
        if ((e as Error).message.startsWith("captcha")) {
          console.error("[baidu] hit captcha, abort");
          await browser.close();
          throw e;
        }
      }
      await jitter(1500, 1500);
    }
    await jitter(2000, 1500);
  }

  await browser.close();
  console.log(`\n[baidu] done. total_rows=${totalRows} errors=${errors}`);
  console.log(`[baidu] output: ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
