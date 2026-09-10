import assert from "node:assert/strict";
import test from "node:test";
import { eligibleCatalogCoordinate } from "../scripts/backfill-school-coordinates-from-catalog";

const base = {
  id: 5147,
  name: "上海市长阳实验学校",
  district: "杨浦",
  address: "怀德路1000号",
  lat: null,
  lng: null,
  catalog_id: 966,
  catalog_name: "上海市长阳实验学校",
  catalog_district: "杨浦",
  catalog_address: "怀德路1000号",
  catalog_lat: 31.2646813,
  catalog_lng: 121.5217653,
  catalog_attrs: null,
};

test("accepts only exact same-district high-confidence Baidu evidence", () => {
  assert.equal(eligibleCatalogCoordinate(base, {
    provider: "baidu_browser",
    poi_name: base.name,
    address: "上海市杨浦区怀德路1000号",
    score: 387,
  }), true);
});

test("rejects campus aliases, weak scores, and existing coordinates", () => {
  const evidence = { provider: "baidu_browser", poi_name: base.name, address: "上海市杨浦区怀德路1000号", score: 387 };
  assert.equal(eligibleCatalogCoordinate({ ...base, catalog_name: "长阳实验学校" }, evidence), false);
  assert.equal(eligibleCatalogCoordinate(base, { ...evidence, score: 299 }), false);
  assert.equal(eligibleCatalogCoordinate({ ...base, lat: 31.2 }, evidence), false);
  assert.equal(eligibleCatalogCoordinate(base, { ...evidence, poi_name: "控江中学" }), false);
});
