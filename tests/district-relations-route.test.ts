import assert from "node:assert/strict";
import test from "node:test";
const baseUrl=process.env.HOUSE_TEST_BASE_URL??"http://127.0.0.1:3000";
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
  assert.equal(body.relations.length,body.summary.total);
  assert.ok(body.relations.every((row) =>
    ["黄浦区","静安区","长宁区","虹口区","杨浦区","徐汇区","闵行区","浦东新区","普陀区"].includes(row.district)));
});
