import assert from "node:assert/strict";
import test from "node:test";
import { eligibleSchoolMapSource } from "../scripts/backfill-school-map-sources";

const base = {
  id: 5163,
  name: "上海市控江初级中学",
  district: "杨浦",
  type: "middle",
  address: "上海市杨浦区永吉路118号",
  attrs: {},
};

const evidence = {
  provider: "baidu_browser",
  poi_name: "上海市控江初级中学",
  poi_type: "教育培训 中学 初中",
  address: "上海市杨浦区永吉路118号(靖宇中路永吉路)",
  score: 289,
  uid: "poi-5163",
};

test("accepts a unique same-district middle-school map POI", () => {
  assert.equal(eligibleSchoolMapSource(base, evidence), true);
});

test("accepts a stable private-school alias without inferring a campus", () => {
  assert.equal(
    eligibleSchoolMapSource(
      { ...base, name: "民办克勒外国语", district: "虹口", id: 5109 },
      { ...evidence, poi_name: "上海民办克勒外国语学校", poi_type: "教育培训 中学 完全中学", address: "上海市虹口区西江湾路800号", score: 280 },
    ),
    true,
  );
});

test("rejects high-school, campus, cross-district, and weak evidence", () => {
  assert.equal(eligibleSchoolMapSource(base, { ...evidence, poi_type: "教育培训 中学 高中" }), false);
  assert.equal(eligibleSchoolMapSource(base, { ...evidence, poi_name: "控江初级中学(分校)" }), false);
  assert.equal(eligibleSchoolMapSource(base, { ...evidence, address: "上海市浦东新区永吉路118号" }), false);
  assert.equal(eligibleSchoolMapSource(base, { ...evidence, score: 269 }), false);
});
