import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { communityLocationAuditRunName, isResidentialCommunityPoiType } from "../lib/community-location-review";

const script = readFileSync("scripts/apply-community-location-report.ts", "utf8");

test("reviewed location reports require exact same-district high-score POIs", () => {
  assert.match(script, /minScore.*300/);
  assert.match(script, /match\.poiName !== community\.name/);
  assert.match(script, /match\.poiDistrict/);
  assert.match(script, /normalizeDistrict/);
  assert.match(script, /districtAddressToken/);
  assert.match(script, /shanghaiInRange/);
});

test("reviewed location reports only accept explicit residential POI categories", () => {
  for (const poiType of [
    "商务住宅;住宅区;住宅小区",
    "商务住宅;住宅区;住宅区",
    "房产小区:住宅区:住宅小区",
  ]) {
    assert.equal(isResidentialCommunityPoiType(poiType), true, poiType);
  }

  for (const poiType of [
    "地名地址:行政地名",
    "机构团体:政府机关",
    "地名地址:门牌信息",
    "房产小区:房产小区附属",
    "生活服务:其它生活服务",
    "政府机构及社会团体;政府机关;乡镇以下级政府及事业单位",
    "",
  ]) {
    assert.equal(isResidentialCommunityPoiType(poiType), false, poiType);
  }
});

test("concurrent reviewed reports keep source- and provider-specific audit directories", () => {
  const stamp = "20260813-180503123Z";
  const amap = communityLocationAuditRunName(stamp, "amap", ".tmp/community-location-backfill/20260813-160734/matches-dry-run.json");
  const tencent = communityLocationAuditRunName(stamp, "tencent", ".tmp/community-location-backfill/20260813-160131/matches-dry-run.json");

  assert.equal(amap, "20260813-180503123Z-amap-20260813-160734");
  assert.equal(tencent, "20260813-180503123Z-tencent-20260813-160131");
  assert.notEqual(amap, tencent);
});

test("reviewed location reports only fill missing coordinates", () => {
  assert.match(script, /CASE WHEN lng IS NULL THEN/);
  assert.match(script, /CASE WHEN lat IS NULL THEN/);
  assert.match(script, /WHERE id = \$4/);
  assert.match(script, /AND name = \$5/);
  assert.match(script, /AND district = \$6/);
  assert.match(script, /lng IS NULL OR lat IS NULL/);
});

test("reviewed location reports are dry-run by default and preserve evidence", () => {
  assert.match(script, /process\.argv\.includes\("--apply"\)/);
  assert.match(script, /community_location_match/);
  assert.match(script, /source_report/);
  assert.match(script, /ROLLBACK/);
});
