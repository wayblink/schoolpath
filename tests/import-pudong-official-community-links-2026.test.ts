import assert from "node:assert/strict";
import test from "node:test";
import { matchOfficialSchool, schoolVariants } from "../scripts/import-pudong-official-community-links-2026";

const schools = [
  { id: 1, name: "北蔡镇中心小学", district: "浦东", type: "primary" as const, aliases: [] },
  { id: 2, name: "上海市浦东新区御桥小学（御山校区）", district: "浦东", type: "primary" as const, aliases: ["御桥小学御山校区"] },
  { id: 3, name: "御桥小学", district: "浦东", type: "primary" as const, aliases: [] },
  { id: 4, name: "上海市浦兴中学", district: "浦东", type: "middle" as const, aliases: [] },
  { id: 5, name: "浦兴中学", district: "浦东", type: "middle" as const, aliases: [] },
  { id: 6, name: "华东师范大学第二附属中学前滩学校", district: "浦东", type: "middle" as const, aliases: [] },
  { id: 7, name: "华东师范大学第二附属中学前滩学校", district: "浦东", type: "middle" as const, aliases: ["华二前滩"] },
];

test("school variants include official-prefix and stage-suffix forms", () => {
  const variants = schoolVariants("上海市浦东新区北蔡镇中心小学（小学部）");
  assert.ok(variants.includes("北蔡镇中心小学(小学部)"));
  assert.ok(variants.includes("北蔡镇中心小学"));
});

test("matches a full official name to an existing district short name", () => {
  const matches = matchOfficialSchool("上海市浦东新区北蔡镇中心小学", "primary", schools);
  assert.deepEqual(matches.map((school) => school.id), [1]);
});

test("uses aliases but keeps campus-specific names distinct", () => {
  const campus = matchOfficialSchool("上海市浦东新区御桥小学（御山校区）", "primary", schools);
  assert.deepEqual(campus.map((school) => school.id), [2]);
  const base = matchOfficialSchool("上海市浦东新区御桥小学", "primary", schools);
  assert.deepEqual(base.map((school) => school.id), [3]);
});

test("prefers one exact canonical name over a normalized short-name match", () => {
  const matches = matchOfficialSchool("上海市浦兴中学", "middle", schools);
  assert.deepEqual(matches.map((school) => school.id), [4]);
});

test("keeps duplicate exact canonical names ambiguous", () => {
  const matches = matchOfficialSchool("华东师范大学第二附属中学前滩学校", "middle", schools);
  assert.deepEqual(matches.map((school) => school.id), [6, 7]);
});
