import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  selectUniqueOfficialCommittee,
  type CommitteeEvidence,
} from "../scripts/backfill-community-committee-from-official-relations";

const script = readFileSync("scripts/backfill-community-committee-from-official-relations.ts", "utf8");

function evidence(overrides: Partial<CommitteeEvidence> = {}): CommitteeEvidence {
  return {
    relationId: 101,
    schoolDistrict: "宝山",
    committeeName: "宝山一村",
    sourceName: "official_school_community_candidates:official_area_level",
    sourceUrl: "https://shrxbm.edu.sh.gov.cn/zszc/policy/example.html",
    sourceQuote: "宝山一村",
    ...overrides,
  };
}

test("selects a committee value only when every 2026 relation supplies the same official evidence", () => {
  const result = selectUniqueOfficialCommittee("宝山", [
    evidence(),
    evidence({ relationId: 102, sourceUrl: "https://www.shanghai.gov.cn/example" }),
  ]);

  assert.deepEqual(result, { eligible: true, committeeName: "宝山一村" });
});

test("rejects conflicting, incomplete, cross-district, or non-official relation evidence", () => {
  assert.equal(
    selectUniqueOfficialCommittee("宝山", [evidence(), evidence({ relationId: 102, committeeName: "宝山二村" })]).eligible,
    false,
  );
  assert.equal(selectUniqueOfficialCommittee("宝山", [evidence({ committeeName: null })]).eligible, false);
  assert.equal(selectUniqueOfficialCommittee("宝山", [evidence({ schoolDistrict: "闵行" })]).eligible, false);
  assert.equal(selectUniqueOfficialCommittee("宝山", [evidence({ sourceName: "xuequzhushou" })]).eligible, false);
  assert.equal(selectUniqueOfficialCommittee("宝山", [evidence({ sourceUrl: null })]).eligible, false);
});

test("migration is dry-run by default, blank-only, transactional, and writes provenance snapshots", () => {
  assert.match(script, /process\.argv\.includes\("--apply"\)/);
  assert.match(script, /source_committee IS NULL OR btrim\(source_committee\) = ''/);
  assert.match(script, /amap_address IS NULL OR btrim\(amap_address\) = ''/);
  assert.match(script, /BEGIN/);
  assert.match(script, /COMMIT/);
  assert.match(script, /ROLLBACK/);
  assert.match(script, /communities-before\.json/);
  assert.match(script, /relations-evidence\.json/);
  assert.match(script, /official_relation_committee_backfill/);
  assert.match(script, /relation_ids/);
  assert.match(script, /source_urls/);
  assert.match(script, /backfill-(?:dry-run|applied)\.json/);
});
