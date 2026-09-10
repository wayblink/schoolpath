import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("scripts/apply-reviewed-school-sources-round15.ts", "utf8");

test("round15 contains only the two reviewed same-district middle-school entities", () => {
  assert.match(script, /schoolId: 4667\b/);
  assert.match(script, /schoolName: "同济实验学校"/);
  assert.match(script, /district: "嘉定"/);
  assert.match(script, /matchedName: "同济大学附属嘉定实验中学"/);
  assert.match(script, /schoolId: 5411\b/);
  assert.match(script, /schoolName: "奉贤实验中学"/);
  assert.match(script, /district: "奉贤"/);
  assert.match(script, /matchedName: "上海外国语大学附属奉贤实验中学"/);
  assert.doesNotMatch(script, /4711|4671|5410|5418/);
});

test("round15 is dry-run by default, transactional on apply, and preserves blank-only updates", () => {
  assert.match(script, /const apply = process\.argv\.includes\("--apply"\)/);
  assert.match(script, /school_nature IS NULL/);
  assert.match(script, /address IS NULL|btrim\(address\)/);
  assert.match(script, /ON CONFLICT \(school_id, source_url, source_type\)/);
  assert.match(script, /BEGIN/);
  assert.match(script, /COMMIT/);
  assert.match(script, /ROLLBACK/);
  assert.match(script, /manual-entity-review-round15/);
  assert.match(script, /aliases/);
});

