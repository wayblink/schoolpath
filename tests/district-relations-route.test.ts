import assert from "node:assert/strict";
import test from "node:test";
const baseUrl=process.env.SCHOOLPATH_TEST_BASE_URL??"http://127.0.0.1:3000";
test("district relations API links published records to public schools",async()=>{const response=await fetch(`${baseUrl}/api/v2/district-relations?district=徐汇区&limit=20`);assert.equal(response.status,200);const body=await response.json();assert.ok(body.summary.total>=2764);assert.ok(body.relations.length>0);assert.ok(body.relations.every((row:{schoolName:string;committeeName:string;schoolId:number|null})=>row.schoolName&&row.committeeName&&Number.isInteger(Number(row.schoolId))));});

test("district relations API rejects an out-of-scope district without leaking rows",async()=>{
  const response=await fetch(`${baseUrl}/api/v2/district-relations?district=崇明区&limit=1000`);
  assert.equal(response.status,200);
  const body=await response.json() as {relations:Array<unknown>;districts:string[];summary:{total:number}};
  assert.equal(body.relations.length,0);
  assert.equal(body.summary.total,0);
  assert.deepEqual(body.districts,["黄浦区","静安区","长宁区","虹口区","杨浦区","徐汇区","闵行区","浦东新区","普陀区"]);
});

test("district relations API can return the full catalog relation set",async()=>{
  const response=await fetch(`${baseUrl}/api/v2/district-relations?limit=5000`);
  assert.equal(response.status,200);
  const body=await response.json() as {relations:Array<{district:string}>;summary:{total:number}};
  assert.ok(body.summary.total>0);
  // 列表上限 5,000（boundedLimit），全量口径看 summary.total
  assert.equal(body.relations.length,Math.min(body.summary.total,5000));
  assert.ok(body.relations.every((row) =>
    ["黄浦区","静安区","长宁区","虹口区","杨浦区","徐汇区","闵行区","浦东新区","普陀区"].includes(row.district)));
});

// 回归：catalog.school_communities 收敛后 area/street 并入 notes、school_name 改名 school_name_raw。
// 过滤条件若仍引用旧列名会抛 PG 42703 → 整条路由 500。这里同时钉住"过滤真的生效"：
// 命中片区有行、不存在的片区必须为空（防止退化成忽略过滤条件）。
test("district relations API applies the area filter through the converged notes column",async()=>{
  const hit=await fetch(`${baseUrl}/api/v2/district-relations?area=${encodeURIComponent("天平")}&limit=100`);
  assert.equal(hit.status,200);
  const hitBody=await hit.json() as {relations:Array<{district:string;schoolName:string}>};
  assert.ok(hitBody.relations.length>0,"area=天平 应命中学区助手系行");

  const miss=await fetch(`${baseUrl}/api/v2/district-relations?area=${encodeURIComponent("不存在的片区XYZ")}&limit=100`);
  assert.equal(miss.status,200);
  const missBody=await miss.json() as {relations:Array<unknown>};
  assert.equal(missBody.relations.length,0,"未命中的片区应返回空列表，证明过滤条件已生效");
});

test("district relations API keeps the school type filter working on the notes column",async()=>{
  const response=await fetch(`${baseUrl}/api/v2/district-relations?type=primary&limit=100`);
  assert.equal(response.status,200);
  const body=await response.json() as {relations:Array<unknown>};
  assert.ok(body.relations.length>0,"type=primary 应命中（school_type 已并入 notes）");
});
