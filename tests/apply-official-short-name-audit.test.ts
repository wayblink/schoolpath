import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const script = readFileSync("scripts/apply-official-short-name-audit.ts", "utf8");

test("official short-name audit supports an explicit district scope", () => {
  assert.match(script, /valueArg\("--district"\)/);
  assert.match(script, /\$1::text IS NULL OR district = \$1/);
  assert.match(script, /\[district \?\? null\]/);
});

test("official short-name audit preserves aliases and blank-only address updates", () => {
  assert.match(script, /const aliases = Array\.from\(new Set\(\[\.\.\.\(school\.aliases \?\? \[\]\), school\.name\]/);
  assert.match(script, /!hasAddress\(school\.address\) && hasAddress\(best\.record\.address\)/);
  assert.match(script, /address = coalesce\(\$3, address\)/);
});
