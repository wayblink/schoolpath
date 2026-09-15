import assert from "node:assert/strict";
import test from "node:test";

const baseUrl = process.env.SCHOOLPATH_TEST_BASE_URL ?? "http://127.0.0.1:3000";

test("ops route keeps the admin dashboard and table CRUD surface", async () => {
  const response = await fetch(`${baseUrl}/ops`);
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /数据控制台/);
  assert.match(html, /ops-page/);
});

test("ops owns the expandable completeness details and tag filters", async () => {
  // 完备度面板在拆分后位于 components/ops/CompletenessPanel.tsx
  const ops = await import("node:fs/promises").then((fs) => fs.readFile("components/ops/CompletenessPanel.tsx", "utf8"));
  assert.match(ops, /数据完备度/);
  assert.match(ops, /按缺失标签过滤/);
  assert.match(ops, /<details/);
  assert.match(ops, /missingTags/);
});

test("completeness API exposes school details with filterable quality tags", async () => {
  const response = await fetch(`${baseUrl}/api/completeness`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.details.length > 1000);
  assert.ok(body.details.every((row: { id: number; missingTags: string[]; percent: number }) =>
    Number.isInteger(row.id) && Array.isArray(row.missingTags) && row.percent >= 0 && row.percent <= 100));
  assert.ok(body.availableTags.includes("缺梯队"));
  assert.ok(body.availableTags.includes("缺学校位置"));
});
