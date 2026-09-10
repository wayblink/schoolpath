import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("scripts/backfill-third-party-district-admission-notes.ts", "utf8");

test("district admission backfill only uses existing snapshot fields and fills blanks", () => {
  assert.match(script, /districtAdmissionSystem/);
  assert.match(script, /districtNote/);
  assert.match(script, /enrollment_note IS NULL|enrollment_note.*btrim/);
  assert.match(script, /UPDATE public\.schools/);
  assert.match(script, /--apply/);
  assert.match(script, /ROLLBACK/);
  assert.doesNotMatch(script, /school_communities/);
});

test("district admission provenance is explicitly third-party and raw", () => {
  assert.match(script, /third_party_admission/);
  assert.match(script, /学区助手/);
  assert.match(script, /https:\/\/xuequzhushou\.cn\//);
  assert.match(script, /source_date/);
  assert.match(script, /district_admission_system/);
  assert.match(script, /district_note/);
});
