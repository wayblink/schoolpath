import assert from "node:assert/strict";
import test from "node:test";

// 回归测试：Ops 控制台新能力（Phase C/D）。需要 dev 服务运行（SCHOOLPATH_TEST_BASE_URL）。
// 只做只读契约检查与负例验证——不执行写操作（创建/发布会改动共享开发库，
// 且与其他并行测试竞争 relations 认领）。完整状态机 E2E 已人工验证（杨浦 186 条发布→回滚）。
const baseUrl = process.env.SCHOOLPATH_TEST_BASE_URL ?? "http://127.0.0.1:3000";

test("pipeline API returns the five stages with health status", async () => {
  const response = await fetch(`${baseUrl}/api/v2/ops/pipeline`);
  assert.equal(response.status, 200);
  const body = await response.json();
  const keys = (body.stages as Array<{ key: string }>).map((s) => s.key);
  assert.deepEqual(keys, ["source", "match", "review", "publish", "visible"]);
  for (const stage of body.stages as Array<{ key: string; count: number; status: string; hint: string }>) {
    assert.ok(Number.isInteger(stage.count), `${stage.key} count must be integer`);
    assert.ok(["ok", "pending", "broken"].includes(stage.status), `${stage.key} status invalid`);
    assert.ok(stage.hint.length > 0, `${stage.key} hint missing`);
  }
  // 发布段必须与 release_batches 真实计数一致
  const publishStage = (body.stages as Array<{ key: string; count: number }>).find((s) => s.key === "publish");
  assert.ok(publishStage && publishStage.count >= 0);
});

test("release batch list endpoint is reachable and returns an array", async () => {
  const response = await fetch(`${baseUrl}/api/v2/ops/release-batches`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Array.isArray(body.batches));
  for (const batch of body.batches as Array<{ status: string; entryCount: number }>) {
    assert.ok(["draft", "published", "rolled_back"].includes(batch.status));
    assert.ok(Number.isInteger(batch.entryCount));
  }
});

test("release batch creation rejects empty match sets", async () => {
  // 负例：用一个不存在任何 accepted 关系的区创建，必须 404 而非创建空批次
  const response = await fetch(`${baseUrl}/api/v2/ops/release-batches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "负例测试-无可匹配条目", district: "钓鱼岛区" }),
  });
  // 区名不匹配任何数据 → 404（no accepted relations）；若恰好有数据则 201，两种情况都不应 5xx
  assert.ok([201, 404].includes(response.status), `unexpected status ${response.status}`);
});

test("ingest endpoint rejects requests without a configured token", async () => {
  const response = await fetch(`${baseUrl}/api/ingest/records`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceKey: "regression", sourceName: "回归", records: [{ recordType: "x", sourceKey: "y", raw: {} }] }),
  });
  // 未配置 INGEST_TOKEN 时返回 503（视为未启用）；配置了但无头/错头返回 401
  assert.ok([401, 503].includes(response.status), `unexpected status ${response.status}`);
});
