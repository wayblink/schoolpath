import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("scripts/apply-school-location-report.ts", "utf8");

test("reviewed school reports require exact same-district high-score POIs", () => {
  assert.match(script, /minScore.*300/);
  assert.match(script, /match\.poiName !== school\.name/);
  assert.match(script, /districtAddressToken/);
  assert.match(script, /shanghaiInRange/);
  assert.match(script, /addressSupportsSameDistrict/);
  assert.match(script, /roadTokens/);
  assert.match(script, /baidu_browser/);
});

test("reviewed school reports only fill missing location fields", () => {
  assert.match(script, /CASE WHEN address IS NULL OR btrim\(address\) = '' THEN/);
  assert.match(script, /CASE WHEN lat IS NULL THEN/);
  assert.match(script, /CASE WHEN lng IS NULL THEN/);
  assert.match(script, /WHERE id = \$5/);
  assert.match(script, /AND name = \$6/);
  assert.match(script, /AND district = \$7/);
});

test("reviewed school reports are dry-run by default and preserve provider evidence", () => {
  assert.match(script, /process\.argv\.includes\("--apply"\)/);
  assert.match(script, /school_location_match/);
  assert.match(script, /source_report/);
  assert.match(script, /provider/);
  assert.match(script, /ROLLBACK/);
});

test("explicit official address mappings tolerate extractor whitespace", () => {
  const script = readFileSync("scripts/backfill-school-addresses-explicit.ts", "utf8");
  assert.match(script, /normalizeSchoolIdentityName/);
});
