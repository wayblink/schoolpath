import assert from "node:assert/strict";
import test from "node:test";

const baseUrl = process.env.HOUSE_TEST_BASE_URL ?? "http://127.0.0.1:3000";

test("home keeps the four product entry cards without the removed intro panels", async () => {
  const response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /学校查询/);
  assert.match(html, /升学组合/);
  assert.match(html, />地图</);
  assert.match(html, /信息源/);
  assert.doesNotMatch(html, /按真实决策任务组织信息/);
  assert.doesNotMatch(html, /第三方资料先审核/);
  assert.doesNotMatch(html, /原始快照/);
});
