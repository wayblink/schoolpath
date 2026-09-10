import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("scripts/backfill-third-party-admission-notes.ts", "utf8");

test("third-party admission backfill is dry-run by default and only fills blanks", () => {
  assert.match(script, /--apply/);
  assert.match(script, /ROLLBACK/);
  assert.match(script, /enrollment_note IS NULL|enrollment_note.*btrim/);
  assert.match(script, /UPDATE public\.schools/);
  assert.match(script, /AND \(enrollment_note IS NULL OR btrim\(enrollment_note\) = ''\)/);
});

test("third-party admission backfill requires a unique source-school binding", () => {
  assert.match(script, /HAVING count\(\*\) = 1/);
  assert.match(script, /public_school_id IS NOT NULL/);
  assert.match(script, /admission_mode/);
  assert.match(script, /source_name = '学区助手'/);
});

test("third-party admission provenance is explicit and keeps raw source fields", () => {
  assert.match(script, /third_party_admission/);
  assert.match(script, /学区助手/);
  assert.match(script, /https:\/\/xuequzhushou\.cn\//);
  assert.match(script, /source_date/);
  assert.match(script, /area/);
  assert.match(script, /street/);
  assert.match(script, /school_type/);
  assert.match(script, /raw/);
  assert.doesNotMatch(script, /UPDATE school_communities/);
  assert.doesNotMatch(script, /DELETE FROM/);
});
