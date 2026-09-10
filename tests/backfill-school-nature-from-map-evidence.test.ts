import assert from "node:assert/strict";
import test from "node:test";
import {
  eligibleMapNatureEvidence,
  normalizeMapNature,
} from "../scripts/backfill-school-nature-from-map-evidence";

const base = {
  id: 5661,
  name: "斌心学校",
  district: "嘉定",
  type: "middle" as const,
  address: "上海市嘉定区徐行镇红星路937号",
  school_nature: null,
};

test("accepts same-district stage-compatible private POI evidence", () => {
  const evidence = {
    provider: "baidu_browser",
    poi_name: "上海市嘉定民办斌心学校",
    poi_type: "教育培训 九年一贯制学校",
    address: "上海市嘉定区徐行镇红星路937号",
    score: 277,
    uid: "83825b08d3471a8b40e19265",
  };
  assert.equal(eligibleMapNatureEvidence(base, evidence), true);
  assert.equal(normalizeMapNature(evidence.poi_name), "私立");
});

test("accepts exact primary private-school POI evidence", () => {
  assert.equal(
    eligibleMapNatureEvidence(
      { ...base, name: "上海市民办东展小学", district: "长宁", type: "primary" as const, address: "上海市长宁区淮阴路581号" },
      {
        provider: "baidu_browser",
        poi_name: "上海市民办东展小学",
        poi_type: "教育培训 小学",
        address: "上海市长宁区淮阴路581号(淮阴路剑河路)",
        score: 397,
      },
    ),
    true,
  );
});

test("rejects a stage-conflicting POI and ambiguous nature text", () => {
  assert.equal(
    eligibleMapNatureEvidence(
      { ...base, name: "上海市杨浦区沪东外国语学校（小学部）", district: "杨浦", type: "primary" as const, address: "上海市杨浦区四平路街道密云路454弄21号" },
      {
        provider: "baidu_browser",
        poi_name: "上海民办沪东外国语学校",
        poi_type: "教育培训 九年一贯制学校",
        address: "上海市四平路街道密云路454弄21号",
        score: 280,
      },
    ),
    false,
  );
  assert.equal(normalizeMapNature("公办民办学校"), null);
});

test("rejects cross-district, weak, and non-map evidence", () => {
  const evidence = {
    provider: "baidu_browser",
    poi_name: "上海市民办克勒外国语学校",
    poi_type: "教育培训 中学 完全中学",
    address: "上海市虹口区西江湾路800号",
    score: 280,
  };
  assert.equal(eligibleMapNatureEvidence({ ...base, name: "民办克勒外国语", district: "虹口", address: "上海市虹口区西江湾路800号" }, evidence), true);
  assert.equal(eligibleMapNatureEvidence({ ...base, district: "浦东" }, evidence), false);
  assert.equal(eligibleMapNatureEvidence({ ...base }, { ...evidence, score: 269 }), false);
  assert.equal(eligibleMapNatureEvidence({ ...base }, { ...evidence, provider: "tencent" }), false);
});
