import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("scripts/backfill-feeder-public-ids.ts", "utf8");

test("feeder public-id projection is dry-run by default and keeps review status unchanged", () => {
  assert.match(script, /const apply = process\.argv\.includes\("--apply"\)/);
  assert.match(script, /from_public_school_id/);
  assert.match(script, /to_public_school_id/);
  assert.match(script, /legacy_id/);
  assert.match(script, /review_status/);
  assert.doesNotMatch(script, /review_status\s*=\s*['"](?:accepted|published|verified)/);
  assert.match(script, /ROLLBACK/);
});

test("feeder public-id projection only copies established catalog legacy ids", () => {
  assert.match(script, /source\.legacy_id IS NOT NULL/);
  assert.match(script, /target\.legacy_id IS NOT NULL/);
  assert.match(script, /COALESCE\(\$1, from_public_school_id\)/);
  assert.match(script, /COALESCE\(\$2, to_public_school_id\)/);
});
