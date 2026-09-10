import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const script = readFileSync("scripts/backfill-pudong-official-school-aliases.ts", "utf8");

test("official Pudong alias backfill is explicitly scoped and auditable", () => {
  assert.match(script, /const REVIEWED_ALIASES/);
  assert.match(script, /official_pudong_primary_2026/);
  assert.match(script, /official_school_info/);
  assert.match(script, /--apply/);
  assert.match(script, /No deletes/);
});

test("2026 official middle-school spelling is tied to the reviewed Jiaotong University Pudong entity", () => {
  assert.match(script, /schoolId: 3776/);
  assert.match(script, /上海交通大学附属中学浦东实验学校/);
  assert.match(script, /峨山路638号/);
  assert.match(script, /official_pudong_middle_2026/);
});

test("campus aliases are pinned to same-stage official addresses", () => {
  assert.match(script, /schoolId: 6413/);
  assert.match(script, /schoolId: 6415/);
  assert.match(script, /schoolId: 6411/);
  assert.match(script, /schoolId: 6412/);
  assert.match(script, /schoolId: 3730/);
  assert.match(script, /schoolId: 6414/);
  assert.match(script, /三墩学校/);
  assert.match(script, /光明学校（分校）/);
  assert.match(script, /川沙中学南校（北校区）/);
  assert.match(script, /进才万祥学校/);
  assert.match(script, /schoolId: 6361/);
  assert.match(script, /schoolId: 3713/);
  assert.match(script, /南泉校区/);
  assert.match(script, /紫荆校区/);
});

test("alias backfill refuses ambiguous or mismatched targets", () => {
  assert.match(script, /target.district !== "浦东"/);
  assert.match(script, /target.type !== item.type/);
  assert.match(script, /target.address/);
  assert.match(script, /throw new Error/);
});
