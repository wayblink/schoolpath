import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTier, shouldFillTier } from "../scripts/backfill-source-school-tiers";

test("normalizes source tier numbers to product labels", () => {
  assert.equal(normalizeTier(1), "一梯队");
  assert.equal(normalizeTier("2"), "二梯队");
  assert.equal(normalizeTier(4), "四梯队");
  assert.equal(normalizeTier(5), null);
  assert.equal(normalizeTier(null), null);
});

test("fills only blank or placeholder school tiers", () => {
  assert.equal(shouldFillTier(null), true);
  assert.equal(shouldFillTier(""), true);
  assert.equal(shouldFillTier("未入榜/待补充"), true);
  assert.equal(shouldFillTier("一梯队"), false);
});
