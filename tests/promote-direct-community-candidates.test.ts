import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const script = readFileSync("scripts/promote-direct-community-candidates.ts", "utf8");

test("direct community promotion is dry-run by default and only fills official pending candidates", () => {
  assert.match(script, /process\.argv\.includes\("--apply"\)/);
  assert.match(script, /--candidate-id/);
  assert.match(script, /id = ANY\(\$5::int\[\]\)/);
  assert.match(script, /status = ANY\(\$2\)/);
  assert.match(script, /confidence = ANY\(\$3\)/);
  assert.match(script, /school_id IS NOT NULL/);
  assert.match(script, /boundaryOnly/);
});

test("direct community promotion requires unique same-district normalized names", () => {
  assert.match(script, /normalizeCommunityName/);
  assert.match(script, /matches\.length !== 1/);
  assert.match(script, /district = \$1/);
  assert.match(script, /ON CONFLICT \(school_id, community_id, year\) DO NOTHING/);
});

test("direct community promotion preserves official provenance and leaves links unverified", () => {
  assert.match(script, /official_school_community_candidates/);
  assert.match(script, /verified, notes/);
  assert.match(script, /VALUES \(.*false/);
  assert.match(script, /promotion-(?:dry-run|applied)\.json/);
  assert.match(script, /status = ANY\(\$3::text\[\]\)/);
  assert.match(script, /year = \$4/);
});

test("direct community promotion rejects road addresses and keeps residential-name boundaries", () => {
  assert.match(script, /isResidentialCommunityName/);
  assert.match(script, /号|弄/);
  assert.match(script, /小区\|公寓\|花园\|家园\|苑\|坊\|里\|城\|府\|湾\|邸\|庭/);
  assert.match(script, /新村/);
});
