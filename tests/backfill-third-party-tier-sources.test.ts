import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("scripts/backfill-third-party-tier-sources.ts", "utf8");

test("third-party tier backfill records provenance without mutating school data", () => {
  assert.match(script, /attrs\.xhs_votes\.source_url/);
  assert.match(script, /third_party_tier/);
  assert.match(script, /小红书 XHS/);
  assert.match(script, /不代表官方招生或学区结论/);
  assert.doesNotMatch(script, /UPDATE public\.schools/);
  assert.doesNotMatch(script, /school_communities/);
});

test("third-party tier backfill rejects note ids and keeps dry-run as default", () => {
  assert.match(script, /new URL\(value\.trim\(\)\)/);
  assert.match(script, /protocol === "http:"/);
  assert.match(script, /--apply/);
  assert.match(script, /ROLLBACK/);
  assert.match(script, /ON CONFLICT \(school_id, source_url, source_type\) DO NOTHING/);
  assert.match(script, /confidence: "low" \| "medium"/);
});
