import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("scripts/backfill-enrollment-notes-from-official-boundaries.ts", "utf8");

test("official boundary note backfill only promotes existing official evidence", () => {
  assert.match(script, /official_boundary_text/);
  assert.match(script, /official_boundary_source/);
  assert.match(script, /official_admission/);
  assert.doesNotMatch(script, /school_communities/);
  assert.doesNotMatch(script, /INSERT INTO public\.communities/);
});

test("official boundary note backfill is strict, auditable, and dry-run by default", () => {
  assert.match(script, /--apply/);
  assert.match(script, /ROLLBACK/);
  assert.match(script, /enrollment_note IS NULL|enrollment_note.*btrim/);
  assert.match(script, /ON CONFLICT \(school_id\s*,\s*source_url\s*,\s*source_type\)/);
  assert.match(script, /backfill-dry-run|backfill-applied/);
  assert.match(script, /raw/);
});
