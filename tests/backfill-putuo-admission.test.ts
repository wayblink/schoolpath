import assert from "node:assert/strict";
import test from "node:test";
import {
  matchSchool,
  normalizeName,
  parsePrivatePlanRows,
  parsePublicPlanRows,
} from "../scripts/backfill-official-putuo-admission-info";

test("normalizes official Putuo abbreviations without erasing stage", () => {
  assert.equal(normalizeName("上海市普陀区平利一小"), normalizeName("上海市普陀区平利路第一小学"));
  assert.equal(normalizeName("曹二实验"), normalizeName("上海市曹杨第二中学附属实验中学"));
  assert.equal(normalizeName("上海兰田中学"), normalizeName("上海市兰田中学"));
  assert.notEqual(normalizeName("上海培佳双语学校（小学）"), normalizeName("上海培佳双语学校（初中）"));
});

test("parses compact public-school plan tables", () => {
  const html = `<table><tr><td>学校</td><td>招生计划(班级数)</td><td>学校</td><td>招生计划(班级数)</td></tr><tr><td>平利一小</td><td>3</td><td>曹杨实验小学</td><td>5</td></tr></table>`;
  assert.deepEqual(parsePublicPlanRows(html, "primary"), [
    { stage: "primary", name: "平利一小", plannedClasses: "3", raw: ["平利一小", "3", "曹杨实验小学", "5"] },
    { stage: "primary", name: "曹杨实验小学", plannedClasses: "5", raw: ["平利一小", "3", "曹杨实验小学", "5"] },
  ]);
});

test("parses private-school totals and keeps the official category row", () => {
  const html = `<table><tr><td>学段</td><td>2025年民办学校全称</td><td>是否购买学位</td><td>学校招生计划总数</td><td>分类计划名称</td><td>相关招生条件</td><td>走读计划数</td><td>住宿计划数</td><td>是否接受调剂</td></tr><tr><td>小学</td><td>上海金洲小学</td><td>是</td><td>240</td><td>上海金洲小学（统招）</td><td>/</td><td>235</td><td>0</td><td>是</td></tr><tr><td>上海培佳双语学校（小学）</td><td>是</td><td>260</td><td>上海培佳双语学校（小学）（统招）</td><td>/</td><td>200</td><td>56</td><td>是</td></tr></table>`;
  assert.deepEqual(parsePrivatePlanRows(html), [{
    stage: "primary",
    name: "上海金洲小学",
    totalPlan: "240",
    category: "上海金洲小学（统招）",
    condition: "/",
    dayPlan: "235",
    boardingPlan: "0",
    transfer: "是",
    directPlan: "",
    raw: ["小学", "上海金洲小学", "是", "240", "上海金洲小学（统招）", "/", "235", "0", "是"],
  }, {
    stage: "primary",
    name: "上海培佳双语学校（小学）",
    totalPlan: "260",
    category: "上海培佳双语学校（小学）（统招）",
    condition: "/",
    directPlan: "",
    dayPlan: "200",
    boardingPlan: "56",
    transfer: "是",
    raw: ["上海培佳双语学校（小学）", "是", "260", "上海培佳双语学校（小学）（统招）", "/", "200", "56", "是"],
  }]);
});

test("matches by stage first and refuses ambiguous schools", () => {
  const source = { stage: "primary" as const, name: "中远实验学校", plannedClasses: "6", raw: [] };
  assert.equal(matchSchool(source, [
    { id: 1, name: "中远实验学校", type: "primary" },
    { id: 2, name: "中远实验学校", type: "nine_year" },
  ])?.id, 1);
  assert.equal(matchSchool(source, [
    { id: 1, name: "中远实验学校", type: "primary" },
    { id: 2, name: "中远实验学校（小学部）", type: "primary" },
  ]), null);
  assert.equal(matchSchool({ ...source, name: "上海培佳双语学校（小学）" }, [
    { id: 3, name: "上海培佳双语学校（小学部）", type: "primary" },
    { id: 4, name: "上海培佳双语学校", type: "nine_year" },
  ])?.id, 3);
});
