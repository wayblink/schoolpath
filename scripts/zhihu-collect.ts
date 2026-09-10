/**
 * 知乎搜索结果抓取。无需登录可看搜索结果页 + zhuanlan 文章摘要。
 * 用法：
 *   pnpm tsx scripts/zhihu-collect.ts --queries-file scripts/baidu-queries.txt --pages 2
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";

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

const queriesFile = valueArg("--queries-file");
const pagesPerQuery = numberArg("--pages") ?? 2;
const headed = process.argv.includes("--headed");

const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const outPath = valueArg("--out") ?? path.join(process.cwd(), "data", "zhihu", `results-${today}.jsonl`);

type SearchResultItem = {
  title: string;
  url: string;
  abstract: string;
};

function loadQueries(): string[] {
  if (!queriesFile) throw new Error("--queries-file required");
  return readFileSync(path.resolve(queriesFile), "utf-8")
    .split("\n").map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
}
function nowIso() {
  const d = new Date(); const pad = (n: number) => `${n}`.padStart(2, "0");
  const off = -d.getTimezoneOffset(); const sign = off >= 0 ? "+" : "-"; const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs/60))}:${pad(abs%60)}`;
}
async function jitter(b: number, e: number) { await new Promise((r) => setTimeout(r, b + Math.random()*e)); }

async function scrapePage(page: Page, query: string, pageNum: number) {
  const url = `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(query)}&page=${pageNum + 1}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(2500); // 让 JS 加载结果
  // 知乎登录墙检测
  const wallText = await page.locator('text=/登录后查看|继续浏览|未登录/').first().count().catch(() => 0);
  if (wallText > 0) {
    // 关掉登录墙弹窗
    await page.locator('button[class*="Modal-closeButton"], .Modal-closeButton').first().click({ timeout: 2000 }).catch(() => undefined);
    await page.waitForTimeout(800);
  }
  const results = await page.evaluate<SearchResultItem[]>(() => {
    const out: SearchResultItem[] = [];
    const items = Array.from(document.querySelectorAll('div.SearchResult-Card, div.Card.SearchResult-Card, div[class*="SearchResult"]'));
    for (const it of items) {
      const titleEl = it.querySelector('h2 a, .ContentItem-title a, a[class*="Title"]') as HTMLAnchorElement | null;
      const title = (titleEl?.textContent || "").trim();
      const url = (titleEl as HTMLAnchorElement | null)?.href || "";
      const fullText = (it as HTMLElement).innerText || "";
      const abstract = fullText.replace(title, "").replace(/\s+/g, " ").trim().slice(0, 1000);
      if (!title) continue;
      out.push({ title, url, abstract });
    }
    return out;
  });
  return results.map((r, i) => ({
    ts: nowIso(), query, page: pageNum, rank: i + 1, engine: "zhihu",
    title: r.title, url: r.url, abstract: r.abstract,
  }));
}

async function main() {
  const queries = loadQueries();
  console.log(`[zhihu] ${queries.length} queries × ${pagesPerQuery} pages → ${outPath}`);
  mkdirSync(path.dirname(outPath), { recursive: true });
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
  await context.addInitScript(() => {
    const g = globalThis as unknown as { __name?: (fn: unknown) => unknown };
    if (!g.__name) g.__name = (fn) => fn;
  });
  const page = await context.newPage();
  let total = 0;
  for (const query of queries) {
    console.log(`[search] ${query}`);
    for (let p = 0; p < pagesPerQuery; p++) {
      try {
        const rows = await scrapePage(page, query, p);
        for (const r of rows) appendFileSync(outPath, JSON.stringify(r) + "\n");
        console.log(`  · page ${p}: ${rows.length}`);
        total += rows.length;
      } catch (e) {
        console.warn(`  ✗ page ${p}: ${(e as Error).message}`);
      }
      await jitter(1500, 1500);
    }
    await jitter(2000, 1000);
  }
  await browser.close();
  console.log(`\n[zhihu] done. total=${total} → ${outPath}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
