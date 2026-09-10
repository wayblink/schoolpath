import assert from "node:assert/strict";
import test from "node:test";

const baseUrl = process.env.HOUSE_TEST_BASE_URL ?? "http://127.0.0.1:3000";

test("product navigation keeps the database console discoverable", async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /href="\/db"/);
  assert.match(html, /数据库/);
  assert.match(html, /管理端/);
  assert.match(html, /href="\/ops"/);
  assert.match(html, /href="\/map"/);
  assert.doesNotMatch(html, /旧版地图/);
  assert.doesNotMatch(html, /旧版页面/);
  assert.doesNotMatch(html, /学区与梯队信息仅供参考/);
});

for (const route of ["/ops", "/db"]) {
  test(`${route} keeps the shared product navigation visible`, async () => {
    const response = await fetch(`${baseUrl}${route}`);
    assert.equal(response.status, 200);

    const html = await response.text();
    assert.match(html, /aria-label="用户端导航"/);
    assert.match(html, /aria-label="管理端导航"/);
    assert.match(html, /href="\/schools"/);
    assert.match(html, /href="\/ops"/);
    assert.match(html, /href="\/db"/);
    assert.match(html, /href="\/map"/);
    assert.doesNotMatch(html, /旧版地图/);
    assert.doesNotMatch(html, /旧版页面/);
    assert.doesNotMatch(html, /学区与梯队信息仅供参考/);
  });
}

test("map route renders the promoted legacy map mode", async () => {
  const response = await fetch(`${baseUrl}/map`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /HOUSE/);
});
