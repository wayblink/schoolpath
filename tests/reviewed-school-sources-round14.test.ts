import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("scripts/apply-reviewed-school-sources-round14.ts", "utf8");

test("round14 is restricted to the reviewed Xuhui school entity", () => {
  assert.match(script, /schoolId: 4706\b/);
  assert.match(script, /schoolName: "师三实验中学"/);
  assert.match(script, /district: "徐汇"/);
  assert.match(script, /matchedName: "上海师范大学第三附属实验学校"/);
  assert.match(script, /type: "middle"/);
});

test("round14 only fills blank fields and preserves official provenance", () => {
  assert.match(script, /school_nature IS NULL/);
  assert.match(script, /address IS NULL|btrim\(address\)/);
  assert.match(script, /ON CONFLICT \(school_id, source_url, source_type\)/);
  assert.match(script, /manual-entity-review-round14/);
  assert.match(script, /BEGIN/);
  assert.match(script, /COMMIT/);
  assert.match(script, /ROLLBACK/);
});

