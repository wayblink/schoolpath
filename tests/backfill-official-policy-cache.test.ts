import assert from "node:assert/strict";
import test from "node:test";
import {
  cellText,
  matchCachedSchool,
  normalizeSchoolName,
  parseCachedRows,
} from "../scripts/backfill-official-policy-cache";

test("normalizes official school names without collapsing district or stage entities", () => {
  assert.equal(normalizeSchoolName("上海市嘉定区疁城实验学校（小学部）"), "嘉定疁城实验学校");
  assert.equal(normalizeSchoolName("上海市嘉定区疁城实验学校（初中部）"), "嘉定疁城实验学校");
  assert.notEqual(normalizeSchoolName("上海市黄浦区第一中心小学"), normalizeSchoolName("上海市黄浦区第二中心小学"));
});

test("parses only rows with one exact known school name", () => {
  const source = { file: "cache.html", district: "黄浦", stage: "primary" as const, title: "2026年黄浦区公办小学招生划片范围", url: null, html: `<table><tr><td>学校名称</td><td>对口居委</td></tr><tr><td>上海市黄浦区报童小学</td><td>新建居委</td></tr><tr><td>其他学校</td><td>不应匹配</td></tr></table>` };
  const rows = parseCachedRows(source, new Set([normalizeSchoolName("上海市黄浦区报童小学")]));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]?.cells, ["上海市黄浦区报童小学", "新建居委"]);
});

test("decodes HTML entities and keeps source-row text auditable", () => {
  assert.equal(cellText("上海市&nbsp;黄浦区报童小学<br>（本部）"), "上海市 黄浦区报童小学 （本部）");
});

test("matches cached official aliases only inside the source district and stage", () => {
  const schools = [
    { id: 1, name: "上海市虹口区上外附属外国语小学", district: "虹口", type: "primary" as const, aliases: ["上外附小"] },
    { id: 2, name: "上海市虹口区上外附属外国语学校", district: "虹口", type: "middle" as const, aliases: ["上外附小"] },
    { id: 3, name: "上海市奉贤区上外附小", district: "奉贤", type: "primary" as const, aliases: ["上外附小"] },
  ];

  assert.equal(
    matchCachedSchool({ district: "虹口", stage: "primary" }, "上外附小", schools)?.id,
    1,
  );
  assert.equal(
    matchCachedSchool({ district: "奉贤", stage: "primary" }, "上外附小", schools)?.id,
    3,
  );
  assert.equal(matchCachedSchool({ district: "虹口", stage: "middle" }, "上外附小", schools)?.id, 2);
});

test("does not guess when an official alias is ambiguous in the same district and stage", () => {
  const schools = [
    { id: 1, name: "甲实验学校", district: "青浦", type: "middle" as const, aliases: ["实验学校"] },
    { id: 2, name: "乙实验学校", district: "青浦", type: "middle" as const, aliases: ["实验学校"] },
  ];
  assert.equal(matchCachedSchool({ district: "青浦", stage: "middle" }, "实验学校", schools), null);
});

test("script is dry-run by default and never writes relations", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile("scripts/backfill-official-policy-cache.ts", "utf8"));
  assert.match(source, /const apply = process\.argv\.includes\("--apply"\)/);
  assert.match(source, /ROLLBACK/);
  assert.match(source, /official_policy_cache/);
  assert.doesNotMatch(source, /INSERT INTO public\.school_communities|UPDATE public\.school_communities|INSERT INTO public\.communities/);
});
