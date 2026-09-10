import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("scripts/apply-reviewed-school-coordinate-round16.ts", "utf8");

test("round16 is restricted to the reviewed Xuhui school map entity", () => {
  assert.match(script, /schoolId: 4706\b/);
  assert.match(script, /schoolName: "师三实验中学"/);
  assert.match(script, /poiName: "上海师大第三附属实验学校"/);
  assert.match(script, /poiUid: "d4502a1378a89011e01103e4"/);
  assert.match(script, /address: "三江路310号"/);
});

test("round16 only fills empty coordinates and records auditable provenance", () => {
  assert.match(script, /lat IS NULL AND lng IS NULL/);
  assert.match(script, /reviewed_school_coordinate_source/);
  assert.match(script, /source_type[\s\S]*'map'/);
  assert.match(script, /BEGIN/);
  assert.match(script, /COMMIT/);
  assert.match(script, /ROLLBACK/);
});
