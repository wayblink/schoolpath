import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const baseUrl = process.env.SCHOOLPATH_TEST_BASE_URL ?? "http://127.0.0.1:3000";

test("schools route keeps SCHOOLPATH navigation and the two-view data workspace", async () => {
  const response = await fetch(`${baseUrl}/schools`);
  assert.equal(response.status, 200);
  const html = await response.text();
  for (const text of [
    "SCHOOLPATH",
    "上海学区决策助手",
    "上海学校与学区关系",
    "学校索引",
    "区域概览",
  ]) assert.match(html, new RegExp(text));
  assert.doesNotMatch(html, /上海学区信息 — 市区8区/);
  assert.doesNotMatch(html, /schoolpath-trust-note|public\.schools|学区总览|各区详细/);
});

test("schools list keeps canonical detail and map links", () => {
  const source = readFileSync("components/product/XuequReplica.tsx", "utf8");
  assert.match(source, /href=\{`\/schools\/\$\{s\.id\}`\}/);
  assert.match(source, /href=\{`\/map\?district=/);
  assert.doesNotMatch(source, /Promise\.all\(\[fetch\("\/api\/v2\/schools/);
});

