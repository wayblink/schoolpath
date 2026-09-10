/**
 * 探: 链家小区详情页是否含 polygon (XHR JSON 还是 vector tile)
 * 试一个已知小区 URL: 长桥五村 in 上海
 */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

async function main() {
  const URL = "https://sh.lianjia.com/xiaoqu/rs长桥五村/";
  const OUT = "recon-lianjia.json";
  console.log(`probe: ${URL}\n`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();

  const reqs: Array<{ url: string; ct: string; size: number; preview?: string }> = [];
  page.on("response", async (resp) => {
    const u = resp.url();
    if (/\.(png|jpg|webp|svg|css|woff|gif)/.test(u)) return;
    try {
      const buf = await resp.body().catch(() => null);
      if (!buf) return;
      const ct = resp.headers()["content-type"] ?? "";
      const isText = ct.includes("text") || ct.includes("json") || ct.includes("javascript");
      reqs.push({
        url: u,
        ct,
        size: buf.length,
        preview: isText ? buf.toString("utf-8").slice(0, 1500) : `<bin ${buf.length}b>`,
      });
    } catch {}
  });

  try {
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(7_000);
  } catch (err) {
    console.log(`✗ ${(err as Error).message}`);
  }

  // 看搜索结果页结构
  const dom = await page.evaluate(() => ({
    titleText: document.title,
    h1: document.querySelector("h1")?.textContent?.trim() ?? null,
    firstResultLinks: [...document.querySelectorAll('a[href*="/xiaoqu/"]')]
      .slice(0, 3)
      .map((a) => ({ text: (a as HTMLAnchorElement).textContent?.trim().slice(0, 50), href: (a as HTMLAnchorElement).href })),
    bodyTextSample: document.body?.innerText?.slice(0, 500) ?? "",
  }));

  console.log("=== DOM ===");
  console.log(JSON.stringify(dom, null, 2));

  console.log(`\n=== 抓到 ${reqs.length} 个网络请求 ===`);
  // 找 polygon 关键字
  const polygonReqs = reqs.filter((r) => /polygon|polyline|coordinates|points|轮廓|边界|outline/i.test(r.preview ?? ""));
  console.log(`含 polygon 关键字的: ${polygonReqs.length}`);
  for (const p of polygonReqs.slice(0, 5)) {
    console.log(`\n  ${p.url.slice(0, 100)}`);
    console.log(`  ${p.preview?.slice(0, 400)}`);
  }
  console.log(`\n=== 列出主要 endpoints (size > 1KB) ===`);
  for (const r of reqs.filter((r) => r.size > 1000).slice(0, 25)) {
    console.log(`  size=${r.size.toString().padStart(7)} ${r.url.slice(0, 100)}`);
  }

  writeFileSync(OUT, JSON.stringify({ dom, reqs }, null, 2));
  console.log(`\n✓ saved ${OUT}`);
  await browser.close();
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
