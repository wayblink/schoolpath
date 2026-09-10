import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("scripts/apply-reviewed-school-coordinate-round18.ts", "utf8");

test("round18 is restricted to the reviewed Xiyan school entity", () => {
  assert.match(script, /schoolId: 5588\b/);
  assert.match(script, /schoolName: "上海市西延安中学"/);
  assert.match(script, /poiName: "上海市延安中学\(西校\)"/);
  assert.match(script, /poiUid: "5b25f44679165fe811293591"/);
  assert.match(script, /address: "清池路211号"/);
});

test("round18 only fills empty coordinates and records provenance", () => {
  assert.match(script, /lat IS NULL AND lng IS NULL/);
  assert.match(script, /reviewed_school_coordinate_source/);
  assert.match(script, /source_type[\s\S]*'map'/);
  assert.match(script, /BEGIN/);
  assert.match(script, /COMMIT/);
  assert.match(script, /ROLLBACK/);
});
