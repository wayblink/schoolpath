import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("optimizer command and skill keep xuequzhushou scoped to nine districts", () => {
  const script = readFileSync("scripts/optimize-xuequzhushou.ts", "utf8");
  const skill = readFileSync(".agents/skills/house-data-optimizer/SKILL.md", "utf8");
  assert.match(script, /https:\/\/xuequzhushou\.cn\//);
  assert.match(script, /ALLOWED_DISTRICTS/);
  assert.match(script, /districtOrder\.filter/);
  assert.match(skill, /黄浦、静安、长宁、虹口、杨浦、徐汇、闵行、浦东、普陀/);
  assert.match(skill, /third_party/);
  assert.match(skill, /Never delete out-of-scope/);
});
