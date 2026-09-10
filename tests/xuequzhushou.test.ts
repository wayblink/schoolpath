import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseXuequzhushouHtml } from "../lib/ingest/xuequzhushou";

const fixture = readFileSync(new URL("./fixtures/xuequzhushou-20260711.html", import.meta.url), "utf8");

test("parses the complete embedded school dataset", () => {
  const parsed = parseXuequzhushouHtml(fixture);
  assert.equal(parsed.pageTitle, "上海学区信息（2026年·市区8区）");
  assert.deepEqual(parsed.stats, {
    districtCount: 8,
    primarySchoolCount: 264,
    middleSchoolCount: 191,
    streetCount: 61,
    committeeRelationCount: 2764,
    coordinateCount: 455,
    taggedSchoolCount: 13,
  });
  assert.deepEqual(parsed.districtOrder, [
    "徐汇区", "杨浦区", "虹口区", "长宁区", "静安区", "黄浦区", "浦东新区", "闵行区",
  ]);
});

test("keeps source-specific facts and opinions intact", () => {
  const parsed = parseXuequzhushouHtml(fixture);
  const school = parsed.districts.黄浦区.小学?.find((item) => item.名称 === "上外-黄浦外国语小学");
  assert.equal(school?.梯队, 1);
  assert.equal(school?.对口初中, "大同初级中学");
  assert.ok(school?.标签?.includes("学位预警"));
  assert.ok(Array.isArray(school?.对口居委));
});

test("rejects pages without the embedded data block", () => {
  assert.throws(() => parseXuequzhushouHtml("<html></html>"), /data block was not found/);
});
