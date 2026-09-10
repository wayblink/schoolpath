/**
 * 搜狗搜索 SERP 抓取。反爬比百度/Bing 弱，国内可访问。
 * 用法: pnpm tsx scripts/sogou-collect.ts --queries-file scripts/baidu-queries.txt --pages 3
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
const pagesPerQuery = numberArg("--pages") ?? 3;
const headed = process.argv.includes("--headed");

const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const outPath = valueArg("--out") ?? path.join(process.cwd(), "data", "sogou", `results-${today}.jsonl`);

type SearchResultItem = {
  title: string;
  url: string;
  abstract: string;
};

function loadQueries(): string[] {
  if (!queriesFile) throw new Error("--queries-file required");
  return readFileSync(path.resolve(queriesFile), "utf-8")
    .split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
}
function nowIso() {
  const d = new Date(); const pad = (n: number) => `${n}`.padStart(2, "0");
  const off = -d.getTimezoneOffset(); const sign = off >= 0 ? "+" : "-"; const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs/60))}:${pad(abs%60)}`;
}
async function jitter(b: number, e: number) { await new Promise((r) => setTimeout(r, b + Math.random()*e)); }

async function scrapePage(page: Page, query: string, pageNum: number) {
  const url = `https://www.sogou.com/web?query=${encodeURIComponent(query)}&page=${pageNum + 1}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(1500);
  const t = await page.title();
  if (/验证|安全|robot/i.test(t)) throw new Error(`captcha: ${t}`);
  await page.waitForSelector(".vrwrap, .results .vrwrap", { timeout: 8_000 }).catch(() => undefined);
  const results = await page.evaluate<SearchResultItem[]>(() => {
    const out: SearchResultItem[] = [];
    const items = Array.from(document.querySelectorAll(".vrwrap"));
    for (const it of items) {
      const titleEl = it.querySelector("h3 a, .vr-title a, a.title");
      const a = titleEl as HTMLAnchorElement | null;
      const title = (a?.textContent || "").trim();
      const url = a?.href || "";
      // 摘要：搜狗的 .str-text-info / .str-info / .text-layout
      const captionEl = it.querySelector(".str-text-info, .str-info, .text-layout, .ft");
      const fullText = (it as HTMLElement).innerText || "";
      const abstract = (captionEl?.textContent || fullText.replace(title, ""))
        .replace(/\s+/g, " ").trim().slice(0, 1000);
      if (!title) continue;
      out.push({ title, url, abstract });
    }
    return out;
  });
  return results.map((r, i) => ({
    ts: nowIso(), query, page: pageNum, rank: i + 1, engine: "sogou",
    title: r.title, url: r.url, abstract: r.abstract,
  }));
}

async function main() {
  const queries = loadQueries();
  console.log(`[sogou] ${queries.length} queries × ${pagesPerQuery} pages → ${outPath}`);
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
  let total = 0; let errors = 0;
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
        errors += 1;
        if ((e as Error).message.startsWith("captcha")) {
          console.error("[sogou] captcha, abort");
          await browser.close();
          throw e;
        }
      }
      await jitter(1200, 1000);
    }
    await jitter(1500, 1000);
  }
  await browser.close();
  console.log(`\n[sogou] done. total=${total} errors=${errors}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
