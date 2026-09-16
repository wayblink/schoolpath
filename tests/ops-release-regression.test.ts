import assert from "node:assert/strict";
import test from "node:test";

// 回归测试：Ops 控制台新能力（Phase C/D）。需要 dev 服务运行（SCHOOLPATH_TEST_BASE_URL）。
// 只做只读契约检查与负例验证——不执行写操作（创建/发布会改动共享开发库，
// 且与其他并行测试竞争 relations 认领）。完整状态机 E2E 已人工验证（杨浦 186 条发布→回滚）。
const baseUrl = process.env.SCHOOLPATH_TEST_BASE_URL ?? "http://127.0.0.1:3000";

test("ingest endpoint rejects requests without a configured token", async () => {
  const response = await fetch(`${baseUrl}/api/ingest/records`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceKey: "regression", sourceName: "回归", records: [{ recordType: "x", sourceKey: "y", raw: {} }] }),
  });
  // 未配置 INGEST_TOKEN 时返回 503（视为未启用）；配置了但无头/错头返回 401
  assert.ok([401, 503].includes(response.status), `unexpected status ${response.status}`);
});

test("ops summary API returns 200 with all overview fields", async () => {
  // 回归：getFullOverview/getOpsSummary 的 SQL 子查询删改曾留悬空逗号致 500（页面卡"正在加载"），
  // 而现有测试只打页面 HTML 不打 API 数据——补 API 级冒烟。
  const response = await fetch(`${baseUrl}/api/v2/ops`);
  assert.equal(response.status, 200);
  const body = await response.json() as { overview: Record<string, number> };
  for (const key of ["schools", "communities", "assignments", "policies"]) {
    assert.ok(Number.isInteger(body.overview[key]), `overview.${key} must be integer, got ${body.overview[key]}`);
  }
});
