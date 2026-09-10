import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const api = readFileSync("app/api/completeness/route.ts", "utf8");
const audit = readFileSync("scripts/audit-missing-data.ts", "utf8");

test("community location completeness accepts either valid address or valid committee text", () => {
  for (const source of [api, audit]) {
    assert.match(source, /amap_address[^\n]+(?:is not null|NOT IN)/i);
    assert.match(source, /source_committee[^\n]+(?:is not null|NOT IN)/i);
    assert.doesNotMatch(source, /coalesce\((?:c\.)?amap_address,\s*(?:c\.)?source_committee,\s*''\)/i);
  }
});

test("API school detail and city summary use the same independent-field rule", () => {
  assert.match(api, /bool_and\([\s\S]*?c\.amap_address[\s\S]*?OR[\s\S]*?c\.source_committee[\s\S]*?\)\) as community_location_complete/i);
  assert.match(api, /count\(\*\) filter \([\s\S]*?amap_address[\s\S]*?OR[\s\S]*?source_committee[\s\S]*?\)::int as community_location_complete/i);
});
