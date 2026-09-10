/**
 * Recon 2: 用 response listener + page.evaluate fetch 从页面内部拿 detail JSON
 */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const POI_ID = process.argv[2] ?? "B00154DNIE";

type Captured = { url: string; status: number; contentType: string; bodySize: number; body?: string };

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();

  // listener 抓所有 response 在导航之前挂上
  const captured: Captured[] = [];
  page.on("response", async (resp) => {
    const url = resp.url();
    if (!/detail\/get|service\/(cardQuery|regeo|locator)|web_map\/get_tile/.test(url)) return;
    try {
      const headers = resp.headers();
      const ct = headers["content-type"] ?? "";
      const bodyBuf = await resp.body().catch(() => null);
      if (!bodyBuf) {
        captured.push({ url, status: resp.status(), contentType: ct, bodySize: 0 });
        return;
      }
      const isBinary = !ct.includes("json") && !ct.includes("text") && !ct.includes("javascript");
      const sz = bodyBuf.length;
      const body = isBinary ? `<binary ${sz}b>` : bodyBuf.toString("utf-8").slice(0, 3000);
      captured.push({ url, status: resp.status(), contentType: ct, bodySize: sz, body });
    } catch (err) {
      captured.push({ url, status: resp.status(), contentType: "?", bodySize: -1 });
    }
  });

  console.log(`正在打开 https://www.amap.com/place/${POI_ID}`);
  await page.goto(`https://www.amap.com/place/${POI_ID}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  console.log(`DOM ready，等待 10s 让脚本跑、tile 加载、polygon 渲染`);
  await page.waitForTimeout(10_000);

  // 从页面内部 fetch detail endpoint（带 8s timeout）
  console.log(`尝试 in-page fetch detail/get/detail`);
  const inPageDetail = await Promise.race([
    page.evaluate(async (id) => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 7000);
        const r = await fetch(`/detail/get/detail?id=${id}`, {
          credentials: "include",
          headers: { Accept: "application/json, text/plain, */*" },
          signal: ctrl.signal,
        });
        clearTimeout(t);
        const ct = r.headers.get("content-type") ?? "";
        const txt = await r.text();
        return { status: r.status, ct, txtLen: txt.length, head: txt.slice(0, 4000) };
      } catch (e) {
        return { error: (e as Error).message };
      }
    }, POI_ID),
    new Promise<{ error: string }>((res) => setTimeout(() => res({ error: "outer-timeout-10s" }), 10_000)),
  ]);
  console.log(`detail fetch 完成`);

  // 也看下 DOM 里有没有 SVG path / canvas
  const dom = await page.evaluate(() => ({
    svgPathCount: document.querySelectorAll("svg path").length,
    canvasCount: document.querySelectorAll("canvas").length,
    canvasSizes: [...document.querySelectorAll("canvas")].map((c) => `${(c as HTMLCanvasElement).width}x${(c as HTMLCanvasElement).height}`),
    titleText: document.title,
  }));

  console.log("\n=== captured responses (filtered) ===");
  for (const c of captured) {
    console.log(`\n  url=${c.url}`);
    console.log(`  status=${c.status} ct=${c.contentType} size=${c.bodySize}`);
    if (c.body) console.log(`  body=${c.body.slice(0, 500)}`);
  }

  console.log("\n=== in-page fetch detail/get/detail ===");
  console.log(JSON.stringify(inPageDetail, null, 2).slice(0, 4500));

  console.log("\n=== DOM ===");
  console.log(JSON.stringify(dom, null, 2));

  writeFileSync(`recon2-${POI_ID}.json`, JSON.stringify({ captured, inPageDetail, dom }, null, 2), "utf-8");
  console.log(`\n✓ saved recon2-${POI_ID}.json`);
  await browser.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("✗", err);
  process.exit(1);
});
