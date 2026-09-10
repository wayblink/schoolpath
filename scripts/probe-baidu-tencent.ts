/**
 * 直接打开百度地图 + 腾讯地图，搜索"长桥五村"，看渲染时是否展示 polygon + 数据怎么来
 */
import { chromium } from "playwright";

async function probe(label: string, url: string, searchKeyword: string) {
  console.log(`\n========================================`);
  console.log(`probe ${label}: ${url}`);
  console.log(`========================================`);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();

  // 抓所有 response
  const reqs: Array<{ url: string; ct: string; size: number; isJson: boolean; preview?: string }> = [];
  page.on("response", async (resp) => {
    try {
      const u = resp.url();
      if (/\.png|\.jpg|\.webp|\.css|\.svg|\.woff/.test(u)) return;
      const ct = resp.headers()["content-type"] ?? "";
      const buf = await resp.body().catch(() => null);
      if (!buf) return;
      const isJson = ct.includes("json");
      const txt = isJson || ct.includes("text") ? buf.toString("utf-8").slice(0, 2500) : `<bin ${buf.length}b>`;
      reqs.push({ url: u, ct, size: buf.length, isJson, preview: txt });
    } catch {}
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(7_000);
  } catch (err) {
    console.log(`✗ navigate failed: ${(err as Error).message}`);
  }

  // 列出含 polygon 相关字段的 JSON 响应
  console.log(`\n抓到 ${reqs.length} 个网络请求`);
  const candidates = reqs
    .filter((r) => r.isJson)
    .filter((r) =>
      /polyline|polygon|boundary|coordinates|points|shape|geom|geometry|outline|border|fence|location|poi/i.test(
        r.preview ?? "",
      ),
    );
  console.log(`其中含 polygon 关键字的 JSON 候选: ${candidates.length}`);
  for (const c of candidates.slice(0, 10)) {
    console.log(`\n  url=${c.url.slice(0, 100)}`);
    console.log(`  ct=${c.ct}  size=${c.size}`);
    console.log(`  preview=${c.preview?.slice(0, 300)}...`);
  }

  // 也打印所有不是图片不是 css 的 JSON endpoints
  console.log(`\n所有 JSON endpoints 一览:`);
  for (const r of reqs.filter((r) => r.isJson).slice(0, 25)) {
    console.log(`  ${r.url.slice(0, 110)} (${r.size}b)`);
  }

  await browser.close();
}

async function main() {
  await probe(
    "Baidu Map - 长桥五村",
    "https://map.baidu.com/search/长桥五村/@13524000,3623000,16z?querytype=s&wd=长桥五村",
    "长桥五村",
  );
  await probe(
    "Tencent Map - 长桥五村",
    "https://map.qq.com/m/?type=pInfoSrch&city=上海&kw=长桥五村",
    "长桥五村",
  );
  console.log(`\n\n✓ ALL DONE`);
}

main().catch((err) => {
  console.error("✗", err);
  process.exit(1);
});
