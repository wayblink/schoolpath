import assert from "node:assert/strict";
import test from "node:test";

const baseUrl = process.env.HOUSE_TEST_BASE_URL ?? "http://127.0.0.1:3000";

test("map route renders the promoted legacy map", async () => {
  const response = await fetch(`${baseUrl}/map`);
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, />地图</);
  assert.doesNotMatch(html, /地图找房/);
  assert.match(html, /搜索筛选/);
  assert.match(html, /输入学校全名或简称/);
  assert.match(html, /href="\/map"/);
  assert.doesNotMatch(html, /href="\/#map"/);
  assert.doesNotMatch(html, /href="\/#schools"/);
  assert.doesNotMatch(html, /上海学区房数据工作台/);
});

test("legacy route keeps the original workspace navigation", async () => {
  const response = await fetch(`${baseUrl}/legacy`);
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /href="\/#map"/);
  assert.match(html, /上海学区房数据工作台/);
});
