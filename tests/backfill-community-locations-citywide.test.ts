import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("scripts/backfill-community-locations-citywide.ts", "utf8");

test("community geocoder supports Tencent as a quota-safe fallback", () => {
  assert.match(script, /TENCENT_MAP_KEY/);
  assert.match(script, /valueArg\("--provider"\)/);
  assert.match(script, /requestedProvider === "amap"/);
  assert.match(script, /provider.*tencent/);
  assert.match(script, /apis\.map\.qq\.com\/ws\/place\/v1\/search/);
  assert.match(script, /Tencent daily query limit/);
});

test("community geocoder keeps district, housing POI, and Shanghai bounds checks", () => {
  assert.match(script, /poi\.cityname !== "上海市"/);
  assert.match(script, /districtHit/);
  assert.match(script, /住宅区\|住宅小区\|商务住宅/);
  assert.match(script, /shanghaiInRange/);
});

test("community updates remain incremental and guarded", () => {
  assert.match(script, /CASE WHEN lng IS NULL/);
  assert.match(script, /CASE WHEN lat IS NULL/);
  assert.match(script, /\$13::text = 'amap'.*amap_poi_id/);
  assert.match(script, /provider === "tencent"[\s\S]*lng IS NULL OR lat IS NULL/);
  assert.match(script, /community_location_match/);
  assert.match(script, /WHERE id = \$10/);
  assert.match(script, /AND name = \$11/);
  assert.match(script, /AND district = \$12/);
  assert.match(script, /No deletes, resets, seeds/);
});

test("community geocoder can prioritize communities missing coordinates", () => {
  assert.match(script, /const missingCoordinatesOnly = process\.argv\.includes\("--missing-coordinates-only"\)/);
  assert.match(script, /missingCoordinatesOnly[\s\S]*lng IS NULL OR lat IS NULL/);
  assert.match(script, /ORDER BY[\s\S]*CASE WHEN lng IS NULL OR lat IS NULL THEN 0 ELSE 1 END/);
  assert.match(script, /missing-coordinates-only/);
});

test("community geocoder supports an id cursor for resumable district batches", () => {
  assert.match(script, /nonNegativeIntegerArg\("--after-id"\)/);
  assert.match(script, /afterId/);
  assert.match(script, /id > \$\$\{params\.length\}/);
  assert.match(script, /name\.slice\(2\).*must be a non-negative integer/);
});

test("community geocoder supports a configurable request delay", () => {
  assert.match(script, /nonNegativeIntegerArg\("--delay-ms"\)/);
  assert.match(script, /await sleep\(delayMs\)/);
  assert.match(script, /delayMs=/);
});

test("community geocoder skips invalid oversized search keywords without aborting the batch", () => {
  assert.match(script, /data\.infocode === "20000"[\s\S]*continue;/);
  assert.match(script, /INVALID_PARAMS/);
});

test("community geocoder rejects civic-service POIs that are not residential communities", () => {
  assert.match(script, /党群服务站\|居委会\|居民委员会\|警务室\|社区服务中心\|工作站\|服务站\|消防\|退役军人/);
  assert.match(script, /return -200|return -100/);
});

test("Tencent matches never receive an AMap source URL", () => {
  assert.match(script, /provider === "amap" && match\.poiId \? `https:\/\/www\.amap\.com\/place\//);
});
