import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";

const baseUrl = process.env.SCHOOLPATH_TEST_BASE_URL ?? "http://127.0.0.1:3000";

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

test("map route selects the school named in the query string", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(10000);
    const school = {
      id: 900001, name: "深链测试小学", district: "黄浦",
      tier: "一梯队", type: "primary", schoolNature: "公立",
    };
    await page.route("**/api/schools?*", (route) => route.fulfill({
      json: { schools: [school, { ...school, id: 900002, name: "另一所学校" }] },
    }));
    await page.route("**/api/districts?*", (route) => route.fulfill({
      json: { type: "FeatureCollection", features: [] },
    }));
    await page.route("**/api/communities?*", (route) => route.fulfill({ json: { communities: [] } }));
    await page.goto(`${baseUrl}/map?school=900001`, { waitUntil: "networkidle" });

    const cards = page.locator(".school-card");
    await cards.first().waitFor();
    const selected = page.locator(".school-card-selected");
    assert.equal(await selected.count(), 1, "exactly one card is selected from the query string");
    assert.match(await selected.innerText(), /深链测试小学/);
    assert.equal(
      await selected.getByRole("link", { name: "详情" }).getAttribute("href"),
      "/schools/900001",
    );
  } finally {
    await browser.close();
  }
});

test("map route ignores unusable school query values", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const value of ["999999", "abc", "0"]) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      page.setDefaultTimeout(10000);
      const school = {
        id: 900001, name: "深链测试小学", district: "黄浦",
        tier: "一梯队", type: "primary", schoolNature: "公立",
      };
      await page.route("**/api/schools?*", (route) => route.fulfill({ json: { schools: [school] } }));
      await page.route("**/api/districts?*", (route) => route.fulfill({
        json: { type: "FeatureCollection", features: [] },
      }));
      await page.goto(`${baseUrl}/map?school=${value}`, { waitUntil: "networkidle" });
      await page.locator(".school-card").first().waitFor();
      assert.equal(
        await page.locator(".school-card-selected").count(),
        0,
        `no card is selected for school=${value}`,
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
