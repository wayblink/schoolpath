import test from "node:test";
import assert from "node:assert/strict";
import { findUniqueSchoolMatch, normalizeSchoolName } from "../lib/school-name-matching";

test("normalizes official campus names without losing the meaningful school name", () => {
  assert.equal(
    normalizeSchoolName("上海市浦东新区园西小学（南桥校区）"),
    "浦东新区园西小学南桥校区",
  );
  assert.equal(
    normalizeSchoolName("上海市浦东新区园西小学（南桥校区）"),
    normalizeSchoolName("浦东新区园西小学(南桥校区)"),
  );
});

test("returns a unique school match for an official candidate", () => {
  const result = findUniqueSchoolMatch(
    {
      name: "上海市浦东新区园西小学（南桥校区）",
      stage: "primary",
    },
    [
      { id: 1, name: "上海市浦东新区园西小学（南桥校区）", type: "primary" },
      { id: 2, name: "上海市浦东新区园西小学（北校区）", type: "primary" },
    ],
  );
  assert.deepEqual(result, { schoolId: 1, matchKind: "exact" });
});

test("does not guess when a campus-less candidate maps to multiple schools", () => {
  const result = findUniqueSchoolMatch(
    {
      name: "上海市浦东新区观澜小学",
      stage: "primary",
    },
    [
      { id: 1, name: "上海市浦东新区观澜小学（新川校区）", type: "primary" },
      { id: 2, name: "上海市浦东新区观澜小学（新溪校区）", type: "primary" },
    ],
  );
  assert.equal(result, null);
});

test("does not associate non-school placeholder rows", () => {
  const result = findUniqueSchoolMatch(
    { name: "统筹安排", stage: "unknown" },
    [{ id: 1, name: "上海市浦东新区实验小学", type: "primary" }],
  );
  assert.equal(result, null);
});
