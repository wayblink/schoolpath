import assert from "node:assert/strict";
import test from "node:test";
import {
  dedupeOfficialRows,
  isImportableOfficialSchool,
  normalizeOfficialNature,
  officialSchoolSourceKey,
  normalizedSchoolName,
  selectImportCandidates,
} from "../scripts/import-official-pudong-schools";

const source = {
  district: "浦东",
  stage: "primary" as const,
  name: "上海市浦东新区新学校（东校区）",
  campus: "东",
  nature: "公办",
  address: "新路100号",
  sourceTitle: "2025年浦东新区义务教育阶段学校招生入学信息公示（小学）",
  sourceUrl: "https://www.shanghai.gov.cn/pdxqywjy/20250507/example.html",
};

test("normalizes official nature labels without guessing unknown values", () => {
  assert.equal(normalizeOfficialNature("公办"), "公立");
  assert.equal(normalizeOfficialNature("民办学校"), "私立");
  assert.equal(normalizeOfficialNature(""), null);
  assert.equal(normalizeOfficialNature("未知性质"), null);
});

test("normalizes full official names for exact matching", () => {
  assert.equal(normalizedSchoolName("上海市浦东新区新学校（东校区）"), "新学校(东校区)");
  assert.equal(normalizedSchoolName(" 新学校 (东校区) "), "新学校(东校区)");
});

test("builds a stable source key for idempotent official imports", () => {
  assert.equal(officialSchoolSourceKey(source), "official_pudong_school_2025:primary:新学校(东校区)");
});

test("rejects non-school placeholders and incomplete official rows", () => {
  assert.equal(isImportableOfficialSchool({ ...source, name: "统筹安排" }), false);
  assert.equal(isImportableOfficialSchool({ ...source, address: "" }), false);
  assert.equal(isImportableOfficialSchool({ ...source, nature: "" }), false);
  assert.equal(isImportableOfficialSchool(source), true);
});

test("dedupes only identical official rows and preserves campus records", () => {
  const rows = dedupeOfficialRows([source, source, { ...source, campus: "西", name: "上海市浦东新区新学校（西校区）", address: "新路200号" }]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.campus), ["东", "西"]);
});

test("does not import an official row when the same normalized school already exists", () => {
  const result = selectImportCandidates([source], [
    { id: 1, name: "新学校（东校区）", district: "浦东", type: "primary", address: null, aliases: [] },
  ]);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.actions[0]?.action, "skip-existing-school");
});

test("skips a missing school with conflicting same-name addresses", () => {
  const rows = [source, { ...source, address: "新路200号" }];
  const result = selectImportCandidates(rows, []);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.actions[0]?.action, "skip-ambiguous-source");
});
