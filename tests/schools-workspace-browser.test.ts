import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";

const baseUrl = process.env.SCHOOLPATH_TEST_BASE_URL ?? "http://127.0.0.1:3000";

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
