import assert from "node:assert/strict";
import test from "node:test";
import { buildSafePatch, CORRECTIONS, type CurrentSchool } from "../scripts/reviewed-school-corrections-round12";

function current(overrides: Partial<CurrentSchool>): CurrentSchool {
  return {
    id: 5638,
    name: "中医晶城中学",
    district: "闵行",
    type: "middle",
    address: null,
    schoolNature: null,
    aliases: [],
    ...overrides,
  };
}

test("round12 contains only unique official aliases with source URLs", () => {
  assert.equal(CORRECTIONS.length, 4);
  for (const correction of CORRECTIONS) {
    assert.ok(correction.source.url.startsWith("https://"));
    assert.equal(correction.source.type, "official_school_info");
    assert.ok(correction.district);
    assert.ok(correction.type);
  }
});

test("safe patch fills only missing fields and keeps existing aliases", () => {
  const correction = CORRECTIONS.find((item) => item.id === 5638)!;
  const patch = buildSafePatch(current({ aliases: ["历史简称"] }), correction);
  assert.deepEqual(patch, {
    name: "上海中医药大学附属闵行晶城中学",
    address: "朱行路16号",
    schoolNature: "公立",
    aliases: ["历史简称", "中医晶城中学", "闵行晶城中学"],
  });
});

test("safe patch does not overwrite non-empty manual fields", () => {
  const correction = CORRECTIONS.find((item) => item.id === 5638)!;
  const patch = buildSafePatch(
    current({
      name: "上海中医药大学附属闵行晶城中学",
      address: "人工核验地址",
      schoolNature: "私立",
    }),
    correction,
  );
  assert.deepEqual(patch, {
    aliases: ["中医晶城中学", "闵行晶城中学"],
  });
});

test("safe patch rejects district, stage, or renamed-row drift", () => {
  const correction = CORRECTIONS.find((item) => item.id === 5638)!;
  assert.equal(buildSafePatch(current({ district: "浦东" }), correction), null);
  assert.equal(buildSafePatch(current({ type: "primary" }), correction), null);
  assert.equal(buildSafePatch(current({ name: "另一所学校" }), correction), null);
});
