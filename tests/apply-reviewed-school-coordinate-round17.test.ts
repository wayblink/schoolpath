import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("scripts/apply-reviewed-school-coordinate-round17.ts", "utf8");

test("round17 contains only the four reviewed school map entities", () => {
  for (const [id, name, uid] of [
    [4342, "上海市宝山区祁连镇中心校", "298d1a58cd808eed3517dc25"],
    [5367, "上海外国语大学松江外国语学校（初中部）", "273db708ed45185b82288a1c"],
    [3806, "上海市周浦实验学校（瑞阳校区）", "a481bfedea0cdf2d451a32e3"],
    [5629, "上海市民办文绮中学（初中部）", "912a7dfe26e8a1ca40afe60b"],
  ] as const) {
    assert.match(script, new RegExp(`schoolId: ${id}\\b`));
    assert.match(script, new RegExp(`schoolName: "${name}"`));
    assert.match(script, new RegExp(`poiUid: "${uid}"`));
  }
});

test("round17 only fills empty coordinates and records provenance transactionally", () => {
  assert.match(script, /lat IS NULL AND lng IS NULL/);
  assert.match(script, /reviewed_school_coordinate_source/);
  assert.match(script, /source_type[\s\S]*'map'/);
  assert.match(script, /BEGIN/);
  assert.match(script, /COMMIT/);
  assert.match(script, /ROLLBACK/);
});
