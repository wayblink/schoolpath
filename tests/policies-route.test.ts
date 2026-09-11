import assert from "node:assert/strict";
import test from "node:test";

const baseUrl = process.env.HOUSE_TEST_BASE_URL ?? "http://127.0.0.1:3000";

test("policies route exposes in-scope policy records with explicit types", async () => {
  const response = await fetch(`${baseUrl}/api/v2/policies`);
  assert.equal(response.status, 200);

  const payload = await response.json() as { policies: Array<{ type: string; district: string; schoolName: string | null }> };
  assert.ok(payload.policies.length > 0);
  assert.deepEqual(new Set(payload.policies.map((policy) => policy.type)), new Set(["district", "school"]));
  assert.ok(payload.policies.every((policy) => ["黄浦区","静安区","长宁区","虹口区","杨浦区","徐汇区","闵行区","浦东新区","普陀区"].includes(policy.district)));
  assert.ok(payload.policies.some((policy) => policy.type === "district" && policy.schoolName === null));
  assert.ok(payload.policies.some((policy) => policy.type === "school" && policy.schoolName));
});

test("sources page explains the two policy record types", async () => {
  const response = await fetch(`${baseUrl}/sources`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /区级政策/);
  assert.match(html, /学校招生记录/);
});
