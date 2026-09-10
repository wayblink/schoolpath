import assert from "node:assert/strict";
import test from "node:test";
import {
  matchUniqueOfficialRow,
  normalizeName,
  noteForOfficialRow,
  TARGET_SCHOOL_IDS,
  validOfficialRow,
  type BaoshanSchool,
  type OfficialBaoshanRow,
} from "../scripts/backfill-official-baoshan-admission-notes";

const row: OfficialBaoshanRow = {
  district: "宝山",
  type: "primary",
  name: "上海市宝山实验学校",
  address: "友谊支路20号",
  enrollmentNote: "宝钢一村、宝钢五村",
  admissionPlanClasses: "5",
  sourceTitle: "2025年宝山区义务教育阶段学校校区范围与招生计划（小学）",
  sourceUrl: "https://www.shanghai.gov.cn/example",
  sourceDate: "2025-04-07",
};

const school = (overrides: Partial<BaoshanSchool> = {}): BaoshanSchool => ({
  id: 5791,
  name: "宝山实验学校",
  district: "宝山",
  type: "primary",
  enrollment_note: null,
  attrs: null,
  ...overrides,
});

test("normalizes official full names and catalog short names", () => {
  assert.equal(normalizeName("上海市宝山实验学校"), normalizeName("宝山实验学校"));
  assert.equal(normalizeName("上海市宝山区第三中心小学"), normalizeName("第三中心小学"));
});

test("accepts only an explicit, complete official row", () => {
  assert.equal(validOfficialRow(row), true);
  assert.equal(validOfficialRow({ ...row, enrollmentNote: "" }), false);
  assert.equal(validOfficialRow({ ...row, admissionPlanClasses: "待定" }), false);
  assert.equal(validOfficialRow({ ...row, district: "浦东" }), false);
});

test("matches a unique same-district same-stage row and refuses duplicate campus rows", () => {
  assert.equal(matchUniqueOfficialRow(school(), [row])?.name, row.name);
  assert.equal(matchUniqueOfficialRow(school({ type: "middle", id: 4633 }), [{ ...row, type: "middle" }])?.name, row.name);
  assert.equal(matchUniqueOfficialRow(school({ id: 9000 }), [row]), null);
  assert.equal(matchUniqueOfficialRow(school(), [row, { ...row, address: "另一校区" }]), null);
  assert.equal(matchUniqueOfficialRow(school({ district: "黄浦" }), [row]), null);
});

test("formats range and plan as a user-facing enrollment note", () => {
  assert.equal(noteForOfficialRow(row), "2025年宝山区官方小学招生范围：宝钢一村、宝钢五村；招生计划：5个班");
});

test("keeps the reviewed scope explicit", () => {
  assert.deepEqual([...TARGET_SCHOOL_IDS].sort((a, b) => a - b), [4633, 5790, 5791, 5793, 5794, 5803]);
});
