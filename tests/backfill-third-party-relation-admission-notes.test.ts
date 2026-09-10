import assert from "node:assert/strict";
import test from "node:test";
import { aggregateRelationRows, matchUniqueSchool, normalizeRelationSchoolName } from "../scripts/backfill-third-party-relation-admission-notes";

test("normalizes relation school names without using fuzzy similarity", () => {
  assert.equal(normalizeRelationSchoolName("上海市徐汇区复旦附属实验学校（小学部）"), "徐汇复旦附属实验学校");
  assert.equal(normalizeRelationSchoolName("复旦附属实验学校(小学部)"), "复旦附属实验学校");
});

test("matches only one same-district same-stage school", () => {
  const schools = [
    { id: 1, name: "上海市复旦附属实验学校（小学部）", district: "徐汇", type: "primary", aliases: [] },
    { id: 2, name: "上海市复旦附属实验学校（初中部）", district: "徐汇", type: "middle", aliases: [] },
  ];
  assert.equal(matchUniqueSchool({ district: "徐汇", schoolType: "primary", schoolName: "复旦附属实验学校(小学部)" }, schools)?.id, 1);
  assert.equal(matchUniqueSchool({ district: "静安", schoolType: "primary", schoolName: "复旦附属实验学校(小学部)" }, schools), null);
});

test("rejects ambiguous exact matches and groups source rows by school", () => {
  const schools = [
    { id: 1, name: "实验学校（小学部）", district: "徐汇", type: "primary", aliases: [] },
    { id: 2, name: "实验学校（小学部）", district: "徐汇", type: "primary", aliases: [] },
  ];
  assert.equal(matchUniqueSchool({ district: "徐汇", schoolType: "primary", schoolName: "实验学校（小学部）" }, schools), null);
  const groups = aggregateRelationRows([
    { id: 11, schoolId: 7, schoolName: "甲校", district: "徐汇", schoolType: "primary", committeeName: "甲居委", area: "甲片区", street: "甲街道", sourceUrl: "https://xuequzhushou.cn/a" },
    { id: 12, schoolId: 7, schoolName: "甲校", district: "徐汇", schoolType: "primary", committeeName: "乙居委", area: "甲片区", street: "甲街道", sourceUrl: "https://xuequzhushou.cn/b" },
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]?.relationIds, [11, 12]);
  assert.deepEqual(groups[0]?.committeeNames, ["乙居委", "甲居委"]);
});
