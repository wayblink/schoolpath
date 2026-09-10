import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { scoreAddressMatch } from "../scripts/backfill-school-coordinates-from-address";

const source = readFileSync(new URL("../scripts/backfill-school-coordinates-from-address.ts", import.meta.url), "utf8");

const school = { district: "杨浦", address: "怀德路1000号" };

test("accepts same-district road and house number", () => {
  assert.equal(scoreAddressMatch(school, {
    formatted_address: "上海市杨浦区怀德路1000号",
    district: "杨浦区",
    street: "怀德路",
    number: "1000号",
    location: "121.52,31.26",
  }), 160);
});

test("rejects cross-district, wrong road, and missing house number", () => {
  const base = { formatted_address: "上海市杨浦区怀德路1000号", location: "121.52,31.26" };
  assert.equal(scoreAddressMatch(school, { ...base, formatted_address: "上海市浦东新区怀德路1000号" }), 0);
  assert.equal(scoreAddressMatch(school, { ...base, formatted_address: "上海市杨浦区平凉路1000号" }), 0);
  assert.equal(scoreAddressMatch(school, { ...base, formatted_address: "上海市杨浦区怀德路" }), 0);
});

test("accepts numeric AMap house number fields", () => {
  assert.equal(scoreAddressMatch(school, {
    formatted_address: "上海市杨浦区怀德路1000号",
    district: "杨浦区",
    street: "怀德路",
    number: 1000 as unknown as string,
    location: "121.5,31.2",
  }), 160);
});

test("supports narrowing coordinate candidates by district and source key prefix", () => {
  assert.match(source, /valueArg\("--district"\)/);
  assert.match(source, /valueArg\("--source-key-prefix"\)/);
  assert.match(source, /source_key LIKE/);
});
