import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";

const baseUrl = process.env.HOUSE_TEST_BASE_URL ?? "http://127.0.0.1:3000";

test("street details expand independently and preserve source-only areas", async () => {
  const browser = await chromium.launch({ headless: true });
  const school = {
    id: 900001, district: "黄浦区", name: "测试街道小学", type: "primary",
    tier: 1, street: "测试街道", area: null, evaluation: "街道学校评价内容",
    feederMiddleSchool: "测试对口初中", tags: ["测试特色"],
  };
  const relation = {
    id: 900001, district: "黄浦区", schoolName: school.name,
    committeeName: "测试居委", street: "测试街道", area: null,
    officialAreaLevel: null, residentialPoi: false, verified: false, sourceYear: 2026,
  };
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(5000);
      await page.route("**/api/v2/schools?*", (route) => route.fulfill({ json: {
        schools: [school, { ...school, id: 900002, district: "静安区", name: "其他区学校" }],
        districts: [],
      } }));
      await page.route("**/api/v2/district-relations?*", (route) => route.fulfill({ json: {
        relations: [relation,
          { ...relation, id: 900002, street: "仅关系街道", schoolName: "尚未关联学校", committeeName: "独立来源居委" },
          { ...relation, id: 900003, district: "静安区", committeeName: "其他区居委" },
        ],
      } }));
      await page.goto(`${baseUrl}/schools`, { waitUntil: "domcontentloaded" });
      await page.getByRole("tab", { name: "区域概览" }).click();
      const district = page.locator(".sw-district").filter({ has: page.getByRole("heading", { name: "黄浦区", exact: true }) });
      const street = district.getByRole("button", { name: "测试街道", exact: true });
      await street.waitFor();
      const other = district.getByRole("button", { name: "仅关系街道", exact: true });
      assert.equal(await street.getAttribute("aria-expanded"), "false");
      assert.equal(await district.getByRole("link", { name: school.name, exact: true }).count(), 0);
      await street.click();
      assert.equal(await street.getAttribute("aria-expanded"), "true");
      assert.equal(await other.getAttribute("aria-expanded"), "false");
      const detailId = await street.getAttribute("aria-controls");
      assert.ok(detailId);
      const detail = page.locator(`[id="${detailId}"]`);
      assert.ok(await detail.isVisible());
      for (const content of [school.evaluation, school.feederMiddleSchool, relation.committeeName]) {
        assert.ok((await detail.innerText()).includes(content), content);
      }
      assert.equal(await detail.getByRole("link", { name: school.name, exact: true }).getAttribute("href"), "/schools/900001");
      assert.doesNotMatch(await detail.innerText(), /其他区学校|其他区居委|独立来源居委/);
      await other.click();
      assert.ok(await district.getByText("独立来源居委", { exact: true }).isVisible());
      assert.equal(await street.getAttribute("aria-expanded"), "true");
      await street.focus();
      await page.keyboard.press("Enter");
      assert.equal(await street.getAttribute("aria-expanded"), "false");
      assert.equal(await district.getByRole("link", { name: school.name, exact: true }).count(), 0);
      assert.equal(await other.getAttribute("aria-expanded"), "true");
      await page.keyboard.press("Space");
      assert.equal(await street.getAttribute("aria-expanded"), "true");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("school workspace separates searchable lists from district dashboards", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(10_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${baseUrl}/schools`, { waitUntil: "domcontentloaded" });
      const tabs = page.getByRole("tab");
      await page.getByRole("tab", { name: "区域概览" }).waitFor();
      assert.equal(await tabs.count(), 2);
      const section = page.getByRole("button", { name: /黄浦区.*小学/ }).first();
      await section.waitFor();
      assert.equal(await page.locator(".xq-table").count(), 0);
      assert.equal(await section.getAttribute("aria-expanded"), "false");
      await section.click();
      const firstSchool = page.locator(".xq-school-name").first();
      await firstSchool.waitFor();
      const schoolName = (await firstSchool.innerText()).trim();
      assert.match((await firstSchool.getAttribute("href")) ?? "", /^\/schools\/\d+$/);
      assert.equal(await page.locator(".xq-detail-btn").count(), 0);
      assert.ok(await page.locator(".xq-map-btn svg").count());
      await section.click();
      assert.equal(await page.locator(".xq-table").count(), 0);

      const search = page.getByRole("searchbox");
      await search.fill(schoolName);
      await page.getByRole("tab", { name: "区域概览" }).click();
      assert.equal(await page.locator(".sw-district").count(), 9);
      assert.equal(await page.getByRole("searchbox").count(), 0);
      assert.equal(await page.locator(".xq-table, .xq-school-name, .xq-school-detail").count(), 0);
      assert.equal(await page.locator('a[href^="/schools/"]').count(), 0);
      for (const label of ["官方招生区域", "住宅小区关系", "来源收录关系"]) {
        assert.ok((await page.locator("body").innerText()).includes(label));
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.getByLabel("区域", { exact: true }).selectOption("黄浦区");
      assert.equal(await page.locator(".sw-district").count(), 1);
      assert.equal(await page.getByRole("heading", { name: "静安区", exact: true }).count(), 0);
      await page.getByRole("tab", { name: "学校索引" }).click();
      assert.equal(await search.inputValue(), schoolName);
      await search.fill("zzzz-no-school-match");
      assert.equal(await page.getByRole("button", { name: /黄浦区.*小学/ }).count(), 0);
      await search.fill("");
      await page.getByRole("button", { name: /黄浦区.*小学/ }).first().waitFor();
      const bodyText = await page.locator("body").innerText();
      assert.doesNotMatch(bodyText, /[📚📊📍🏫🗺]|public\.schools|数据说明/u);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
