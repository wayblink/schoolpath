import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const script = readFileSync("scripts/backfill-candidate-school-ids.ts", "utf8");

test("candidate school-id backfill is dry-run by default and updates only empty ids", () => {
  assert.match(script, /const apply = process\.argv\.includes\("--apply"\)/);
  assert.match(script, /school_id IS NULL/);
  assert.match(script, /UPDATE school_community_candidates/);
  assert.match(script, /WHERE id = \$1 AND school_id IS NULL/);
  assert.match(script, /verified|boundaryOnly/);
});

test("candidate school-id backfill emits an auditable report", () => {
  assert.match(script, /candidates-source\.json/);
  assert.match(script, /backfill-(?:dry-run|applied)\.json/);
  assert.match(script, /schoolId/);
  assert.match(script, /matchKind/);
});
