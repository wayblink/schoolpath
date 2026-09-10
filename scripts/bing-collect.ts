/**
 * 必应国内版搜索结果（SERP）抓取。反爬比百度弱很多，可大批量跑。
 * 用法：
 *   pnpm tsx scripts/bing-collect.ts --queries-file scripts/baidu-queries.txt --pages 3 \
 *     --out data/baidu/bing-results-YYYYMMDD.jsonl
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

const queriesArg = valueArg("--queries");
const queriesFile = valueArg("--queries-file");
const pagesPerQuery = numberArg("--pages") ?? 3;
const headed = process.argv.includes("--headed");

const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const outPath = valueArg("--out") ?? path.join(process.cwd(), "data", "baidu", `bing-results-${today}.jsonl`);

type SearchResultItem = {
  title: string;
  url: string;
  abstract: string;
  source: string;
};

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

async function scrapePage(page: Page, query: string, pageNum: number) {
  const first = pageNum * 10 + 1;
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&first=${first}&setlang=zh-CN`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForSelector("li.b_algo, ol#b_results", { timeout: 10_000 }).catch(() => undefined);
  const results = await page.evaluate<SearchResultItem[]>(() => {
    const out: SearchResultItem[] = [];
    const items = Array.from(document.querySelectorAll("li.b_algo"));
    for (const it of items) {
      const a = it.querySelector("h2 a") as HTMLAnchorElement | null;
      if (!a) continue;
      const title = (a.textContent || "").trim();
      const url = a.href || "";
      const captionEl = it.querySelector(".b_caption p, .b_lineclamp4, .b_lineclamp3, .b_lineclamp2, .b_lineclamp1, .b_paractl");
      const abstract = (captionEl?.textContent || (it as HTMLElement).innerText || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 1000);
      const sourceEl = it.querySelector("cite, .b_attribution");
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
    engine: "bing",
    ...r,
  }));
}

async function main() {
  const queries = loadQueries();
  if (queries.length === 0) throw new Error("--queries or --queries-file required");
  console.log(`[bing] ${queries.length} queries × ${pagesPerQuery} pages → ${outPath}`);
  mkdirSync(path.dirname(outPath), { recursive: true });

  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({
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
        appendFileSync(outPath, JSON.stringify({ ts: nowIso(), query, page: p, engine: "bing", error: (e as Error).message }) + "\n");
      }
      await jitter(800, 700);
    }
    await jitter(1200, 800);
  }
  await browser.close();
  console.log(`\n[bing] done. total=${total} → ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
