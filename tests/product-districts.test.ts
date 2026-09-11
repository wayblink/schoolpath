import assert from "node:assert/strict";
import test from "node:test";
import { PRODUCT_DISTRICTS, normalizeProductDistrict } from "../lib/product/districts";
import { readFileSync } from "node:fs";

test("product district scope has exactly the nine canonical districts", () => {
  assert.deepEqual(PRODUCT_DISTRICTS, ["黄浦", "静安", "长宁", "虹口", "杨浦", "徐汇", "闵行", "浦东", "普陀"]);
  assert.equal(normalizeProductDistrict("浦东新区"), "浦东");
  assert.equal(normalizeProductDistrict("浦东区"), "浦东");
  assert.equal(normalizeProductDistrict("静安区"), "静安");
  assert.equal(normalizeProductDistrict(" 宝山区 "), null);
});

test("product queries apply the scope to list, detail, relations, pathways and policies", () => {
  const source = readFileSync("lib/product/queries.ts", "utf8");
  for (const marker of [
    "getOverview",
    "getSchools",
    "getSchoolById",
    "getSchoolDistrictSummary",
    "getSchoolDistrictRelations",
    "getSchoolDistrictRelationFacets",
    "getPathways",
    "getPolicies",
  ]) assert.match(source, new RegExp(`(?:export )?(?:async )?function ${marker}`));
  assert.match(source, /addProductDistrictFilter\(where, values, "s\.district", filters\.district\)/);
  assert.match(source, /s\.id=\$1 and .*s\.district.*any\(\$2::text\[\]\)/);
  assert.match(source, /where .*coalesce\(d\.canonical_name,s\.district\).*any\(\$1::text\[\]\)/);
});

test("source-schools route declares its own node runtime instead of re-exporting config", () => {
  const source = readFileSync("app/api/v2/source-schools/route.ts", "utf8");
  assert.match(source, /export const runtime\s*=\s*["']nodejs["']/);
  assert.doesNotMatch(source, /export\s*\{\s*GET,\s*runtime\s*\}/);
});

test("product school queries reject malformed numeric filters and detail ids", () => {
  const source = readFileSync("lib/product/queries.ts", "utf8");
  assert.match(source, /Number\.isInteger\(tier\)/);
  assert.match(source, /if \(!Number\.isInteger\(id\) \|\| id <= 0\) return null/);
  assert.match(source, /p\.district is null or .*p\.district.*s\.district/);
});

test("school product page does not render removed placeholder counts", () => {
  const source = readFileSync("components/product/XuequReplica.tsx", "utf8");
  assert.doesNotMatch(source, /schools\.length\|\|1723/);
  assert.doesNotMatch(source, /relations\.length\|\|3272/);
});

test("map product mode requests bounded data endpoints", () => {
  const app = readFileSync("components/map/MapWorkspace.tsx", "utf8");
  const schoolsRoute = readFileSync("app/api/schools/route.ts", "utf8");
  const districtsRoute = readFileSync("app/api/districts/route.ts", "utf8");
  assert.match(app, /if \(mapOnly\) query\.set\("product", "1"\)/);
  assert.match(app, /if \(mapOnly\) params\.set\("product", "1"\)/);
  assert.match(schoolsRoute, /productMode/);
  assert.match(schoolsRoute, /PRODUCT_DISTRICT_STORAGE_NAMES/);
  assert.match(districtsRoute, /productMode/);
  assert.match(districtsRoute, /PRODUCT_DISTRICT_STORAGE_NAMES/);
});
