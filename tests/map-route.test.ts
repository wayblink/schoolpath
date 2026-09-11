import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";

const baseUrl = process.env.HOUSE_TEST_BASE_URL ?? "http://127.0.0.1:3000";

test("map canvas stays within the viewport after the school list loads", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(`${baseUrl}/map`, { waitUntil: "networkidle" });
      await page.locator(".school-card").first().waitFor();
      const bounds = await page.getByTestId("amap-container").boundingBox();
      assert.ok(bounds && bounds.height >= 400 && bounds.height <= 900,
        `map height must be bounded at width ${width}: ${bounds?.height}`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight));
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("map route renders the current map workspace", async () => {
  const response = await fetch(`${baseUrl}/map`);
  assert.equal(response.status, 200);

  const html = await response.text();
  const shellClasses = html.match(/<div class="(product-app(?:\s[^"]*)?)">/)?.[1].split(/\s+/);
  assert.ok(shellClasses?.includes("product-map-app"), "map shell must include product-map-app");
  assert.match(html, />地图</);
  assert.doesNotMatch(html, /地图找房/);
  assert.match(html, /搜索筛选/);
  assert.match(html, /输入学校全名或简称/);
  assert.match(html, /href="\/map"/);
  assert.doesNotMatch(html, /href="\/#map"/);
  assert.doesNotMatch(html, /href="\/#schools"/);
  assert.doesNotMatch(html, /上海学区房数据工作台/);
});
