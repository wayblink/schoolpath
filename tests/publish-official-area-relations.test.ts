import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("scripts/publish-official-area-relations.ts", "utf8");

test("official area publisher is dry-run by default and only consumes official pending candidates", () => {
  assert.match(script, /process\.argv\.includes\("--apply"\)/);
  assert.match(script, /status=ANY\(\$1::text\[\]\)/);
  assert.match(script, /confidence=ANY\(\$2::text\[\]\)/);
  assert.match(script, /source_url/);
  assert.match(script, /gov\.cn/);
});

test("official area publisher rejects roads, addresses, ranges, and colon-scoped text", () => {
  assert.match(script, /isPureOfficialAreaName/);
  assert.match(script, /[：:]/);
  assert.match(script, /路\|弄\|号\|街\|公路\|大道/);
  assert.match(script, /boundaryOnly/);
});

test("official area publisher keeps provenance, remains unverified, and is idempotent", () => {
  assert.match(script, /official_area_level/);
  assert.match(script, /source_record_id/);
  assert.match(script, /-\(candidate\.id\)/);
  assert.match(script, /ON CONFLICT\(source_record_id\) DO UPDATE/);
  assert.match(script, /verified.*false/);
  assert.match(script, /BEGIN/);
  assert.match(script, /COMMIT/);
  assert.match(script, /ROLLBACK/);
  assert.match(script, /official-area-relations-(?:dry-run|applied)\.json/);
});
