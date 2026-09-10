import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOfficialCommunityEnrollmentNote,
  isOfficialPudongCommunitySource,
} from "../scripts/backfill-enrollment-notes-from-official-community-links";

test("accepts only the reviewed Pudong official 2026 relation source families", () => {
  assert.equal(isOfficialPudongCommunitySource("official_pudong_primary_2026"), true);
  assert.equal(isOfficialPudongCommunitySource("official_pudong_middle_2026"), true);
  assert.equal(isOfficialPudongCommunitySource("official_pudong_junior_2025"), true);
  assert.equal(isOfficialPudongCommunitySource("学区助手"), false);
});

test("builds a compact official relation summary without expanding community names", () => {
  assert.equal(
    buildOfficialCommunityEnrollmentNote({ district: "浦东", year: 2026, communityCount: 18 }),
    "2026年浦东新区官方招生地段公示已收录18个对应小区；完整对应关系见学校小区明细。关系由官方附件结构化导入，当前待人工复核。",
  );
});

test("does not build a note without an evidenced relation count", () => {
  assert.equal(buildOfficialCommunityEnrollmentNote({ district: "浦东", year: 2026, communityCount: 0 }), "");
});
