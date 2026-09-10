import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("scripts/backfill-legacy-policy-sources.ts", "utf8");

test("legacy policy source backfill only promotes existing attrs provenance", () => {
  assert.match(script, /attrs->>'policy_url'/);
  assert.match(script, /attrs->>'data_source'/);
  assert.match(script, /third_party_directory/);
  assert.doesNotMatch(script, /UPDATE public\.schools/);
  assert.doesNotMatch(script, /school_communities/);
});

test("legacy policy source backfill is auditable and dry-run by default", () => {
  assert.match(script, /--apply/);
  assert.match(script, /ROLLBACK/);
  assert.match(script, /ON CONFLICT \(school_id, source_url, source_type\)/);
  assert.match(script, /DO NOTHING/);
  assert.match(script, /legacy_policy_source/);
  assert.match(script, /report/);
});
