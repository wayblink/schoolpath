import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("scripts/backfill-hongkou-admission-info.ts", "utf8");

test("Hongkou admission backfill only consumes explicit feeder-primary fields", () => {
  assert.match(script, /district\s*===?\s*[\"']虹口/);
  assert.match(script, /raw\[8\]/);
  assert.match(script, /对口小学/);
  assert.match(script, /enrollment_note IS NULL|enrollment_note.*btrim/);
  assert.doesNotMatch(script, /school_communities/);
});

test("Hongkou admission backfill is strict, auditable, and dry-run by default", () => {
  assert.match(script, /--apply/);
  assert.match(script, /ROLLBACK/);
  assert.match(script, /ON CONFLICT \(school_id,source_url,source_type\)/);
  assert.match(script, /official_admission/);
  assert.match(script, /source_quote|evidence/);
  assert.match(script, /unique|ambiguous/i);
});
