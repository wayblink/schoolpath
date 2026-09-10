import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";

test("relation explorer labels official areas separately from residential/source relations",()=>{
  const source=readFileSync("components/product/DistrictRelationExplorer.tsx","utf8");
  assert.match(source,/官方招生区域/);
  assert.match(source,/住宅小区关系/);
  assert.match(source,/来源收录关系/);
  assert.match(source,/官方招生区域与来源收录关系分开展示/);
  assert.match(source,/officialAreaLevel===\"administrative_or_enrollment_area\"\)return \"官方招生区域\"/);
  assert.match(source,/officialAreaLevel===\"administrative_or_enrollment_area\"\)return \"待核验\"/);
  assert.doesNotMatch(source,/官方招生区域.*已审核/);
});
