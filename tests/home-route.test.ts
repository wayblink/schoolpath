import assert from "node:assert/strict";
import test from "node:test";

const baseUrl = process.env.SCHOOLPATH_TEST_BASE_URL ?? "http://127.0.0.1:3000";

test("home keeps the four current product entry cards", async () => {
  const response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /找学校/);
  assert.match(html, /查升学路径/);
  assert.match(html, /地图找校\/房/);
  assert.match(html, /信息源/);
  assert.doesNotMatch(html, /按真实决策任务组织信息/);
  assert.doesNotMatch(html, /第三方资料先审核/);
  assert.doesNotMatch(html, /原始快照/);
});
