import assert from "node:assert/strict";
import test from "node:test";
import { planDuplicateTierFills } from "../scripts/backfill-duplicate-school-tiers";

test("plans exact same-district same-stage duplicate tier fills only for one source tier", () => {
  const plans = planDuplicateTierFills([
    { id: 1, name: "甲校", district: "徐汇", type: "primary", tier: "未入榜/待补充", attrs: null },
    { id: 2, name: "甲校", district: "徐汇", type: "primary", tier: "一梯队", attrs: { schoolTierSource: { source_url: "https://example.test/a" } } },
    { id: 3, name: "乙校", district: "徐汇", type: "middle", tier: "未入榜/待补充", attrs: null },
    { id: 4, name: "乙校", district: "徐汇", type: "middle", tier: "二梯队", attrs: null },
    { id: 5, name: "乙校", district: "徐汇", type: "middle", tier: "四梯队", attrs: null },
  ]);
  assert.deepEqual(plans.map((plan) => [plan.target.id, plan.tier, plan.source.id]), [[1, "一梯队", 2]]);
});

test("never copies a placeholder or overwrites a valid target tier", () => {
  const plans = planDuplicateTierFills([
    { id: 1, name: "甲校", district: "徐汇", type: "primary", tier: "未入榜/待补充", attrs: null },
    { id: 2, name: "甲校", district: "徐汇", type: "primary", tier: "待补充", attrs: null },
    { id: 3, name: "甲校", district: "徐汇", type: "primary", tier: "二梯队", attrs: null },
    { id: 4, name: "乙校", district: "徐汇", type: "primary", tier: "三梯队", attrs: null },
  ]);
  assert.deepEqual(plans.map((plan) => plan.target.id), [1, 2]);
});
