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
