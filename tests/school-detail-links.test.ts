import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";

const baseUrl = process.env.SCHOOLPATH_TEST_BASE_URL ?? "http://127.0.0.1:3000";

test("map school cards expose an in-app school detail link", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "components/table/SchoolTable.tsx"), "utf8");
  assert.match(source, /href=\{`\/schools\/\$\{school\.id\}`\}/);
  assert.match(source, /详情\s*<\/Link>/);
});

test("schools API provides ids used by the school detail links", async () => {
  const response = await fetch(`${baseUrl}/api/v2/schools?limit=3`);
  assert.equal(response.status, 200);
  const body = await response.json() as { schools: Array<{ id: number; name: string }> };
  assert.ok(body.schools.length > 0);
  assert.ok(body.schools.every((school) => Number.isInteger(Number(school.id)) && school.name));
});

test("pathways API provides source school ids when either endpoint has an exact source match", async () => {
  const response = await fetch(`${baseUrl}/api/v2/pathways?limit=20`);
  assert.equal(response.status, 200);
  const body = await response.json() as { pathways: Array<{ primaryId: number | null; middleId: number | null }> };
  assert.ok(body.pathways.length > 0);
  assert.ok(body.pathways.some((pathway) => pathway.primaryId !== null));
  assert.ok(body.pathways.every((pathway) => pathway.primaryId === null || Number.isInteger(Number(pathway.primaryId))));
  assert.ok(body.pathways.every((pathway) => pathway.middleId === null || Number.isInteger(Number(pathway.middleId))));
});

// 回归：详情页经 getSchoolRelationsByName(district, school.name) 读 catalog.school_communities。
// 该函数曾按已收敛掉的 school_name 列过滤 → PG 42703 → 整个 /schools/[id] 页 500。
test("school detail page renders for a school that has converged catalog relations", async () => {
  // 从 district-relations 取一个确有 catalog 行的 schoolId（学区助手系行必带 school_id）
  const list = await fetch(`${baseUrl}/api/v2/district-relations?limit=50`);
  assert.equal(list.status, 200);
  const listBody = await list.json() as { relations: Array<{ schoolId: number | null }> };
  const schoolId = listBody.relations.find((row) => row.schoolId != null)?.schoolId;
  assert.ok(Number.isInteger(Number(schoolId)), "district-relations 应返回带 schoolId 的行");

  const page = await fetch(`${baseUrl}/schools/${schoolId}`);
  assert.equal(page.status, 200, "详情页不应因审核池列收敛而 500");
  const html = await page.text();
  assert.match(html, /学校区域关系/);
  // 该校确有 catalog 行 → 关系列表应渲染出条目（school_name_raw 与产品校名不一致，须经 school_id 关联）
  const items = html.match(/<strong>/g) ?? [];
  assert.ok(items.length > 0, "详情页关系列表应为空以外的内容");
});
