import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const auditScript = readFileSync("scripts/audit-missing-data.ts", "utf8");

test("data quality audit reads promoted school nature from the canonical column", () => {
  assert.match(auditScript, /school_nature,\s*enrollment_note,\s*attrs/);
  assert.match(auditScript, /where school_nature is not null/i);
  assert.doesNotMatch(auditScript, /school_nature_text like/i);
});

test("data quality audit reports provenance and review quality metrics", () => {
  for (const metric of [
    "enrollment_note_complete",
    "schools_with_sources",
    "verified_assignments",
    "reviewed_feeders",
    "policy_distinct_urls",
  ]) {
    assert.match(auditScript, new RegExp(metric));
  }
  assert.match(auditScript, /weightedPercent/);
});

test("official school backfill checks the canonical school nature column", () => {
  const script = readFileSync("scripts/backfill-school-info-from-official.ts", "utf8");
  assert.match(script, /school_nature: "公立" \| "私立" \| null/);
  assert.match(script, /school_nature IS NULL/);
  assert.match(script, /hasValidSchoolNature\(school\.school_nature\)/);
  assert.doesNotMatch(script, /hasValidSchoolNature\(school\.attrs\)/);
  assert.match(script, /school_nature = CASE/);
  assert.match(script, /::school_nature/);
});

test("strict official exact backfill only promotes unique stage-compatible matches", () => {
  const script = readFileSync("scripts/backfill-official-exact-school-info.ts", "utf8");
  assert.match(script, /school_nature IS NULL/);
  assert.match(script, /unique source row|unique\s*=|unique\.length/);
  assert.match(script, /stage-compatible|stageCompatible/i);
  assert.match(script, /ON CONFLICT \(school_id, source_url, source_type\)/);
  assert.match(script, /official_school_info_source/);
  assert.match(script, /--apply/);
});

test("official school provenance registration accepts the audited source_url shape", () => {
  const script = readFileSync("scripts/backfill-official-school-info-sources.ts", "utf8");
  assert.match(script, /source\.url/);
  assert.match(script, /source\.source_url/);
  assert.match(script, /official_school_info/);
  assert.match(script, /ON CONFLICT \(school_id, source_url, source_type\)/);
  assert.doesNotMatch(script, /UPDATE public\.schools/);
});

test("round 12 PDF collector keeps official fields and excludes catchment columns", () => {
  const script = readFileSync("scripts/collect-round12-official-pdf-info.py", "utf8");
  assert.match(script, /sourceUrl/);
  assert.match(script, /school.*address|address.*school/i);
  assert.match(script, /nature/);
  assert.doesNotMatch(script, /school_communities|school-community|community_id/);
});

test("accepted relation publisher loads local env and preserves provisional review states", () => {
  const script = readFileSync("scripts/redesign/publish-xuequzhushou-relations.ts", "utf8");
  assert.match(script, /loadLocalEnv\(\)/);
  assert.match(script, /r\.review_status='accepted'/);
  assert.match(script, /case when r\.review_status='accepted' then 'accepted' else 'provisional' end/);
});
