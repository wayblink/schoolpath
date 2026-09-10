import assert from "node:assert/strict";
import test from "node:test";
import { siteRecords, type Json } from "../lib/ingest/xuequzhushou-site-records";

test("retains every community occurrence, unknown field, address and mixed map g values", () => {
  const raw: Json = { districts: { "浦东新区": [
    { n: "同名校", c: [{ n: "同名小区", extra: { future: 0 } }, { n: "同名小区" }], j: ["居委", "居委"], g: "d", m: "甲/乙(派位)" },
    { n: "同名校", c: [], g: { p: [{ a: "地址", lng: 0, lat: 0 }], r: ["道路"] } },
  ] }, middles: { "甲/乙": { districts: ["浦东新区"], future: false } } };
  const rows = siteRecords("map.json", raw);
  assert.deepEqual(rows[0].raw, raw);
  assert.equal(new Set(rows.map(r => r.key)).size, rows.length);
  assert.equal(rows.filter(r => r.type === "map_school").length, 2);
  assert.equal(rows.filter(r => r.type === "map_community").length, 2);
  assert.equal(rows.filter(r => r.type === "map_enrollment_area").length, 2);
  assert.deepEqual(rows.find(r => r.type === "map_address")?.raw, { a: "地址", lng: 0, lat: 0 });
  assert.equal(rows.find(r => r.type === "map_middle")?.key, "/middles/甲~1乙");
});

test("keeps complete outside-scope geometry in source archive and identifies district", () => {
  const feature = { type: "Feature", properties: { "区": "宝山区", name: "原始居委" }, geometry: { type: "Polygon", coordinates: [[[121, 31], [122, 32]]] } };
  const rows = siteRecords("boundary.json", { type: "FeatureCollection", features: [feature] });
  assert.equal(rows.length, 2);
  assert.equal(rows[1].district, "宝山区");
  assert.deepEqual(rows[1].raw, feature);
});

test("does not collapse duplicate index values or omit empty and unknown JSON", () => {
  const rows = siteRecords("index.json", { "黄浦区|学校": ["居委", "居委"], unknown: null });
  assert.equal(rows.filter(r => r.type === "map_index_member").length, 2);
  assert.equal(rows.find(r => r.key === "/unknown")?.raw, null);
  assert.deepEqual(siteRecords("future.json", [1, false, null])[0].raw, [1, false, null]);
});
