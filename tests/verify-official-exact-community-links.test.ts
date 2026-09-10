import assert from "node:assert/strict";
import test from "node:test";
import { isExplicitOfficialAreaName, isResidentialName } from "../scripts/verify-official-exact-community-links";

test("accepts explicit residential village project names", () => {
  assert.equal(isResidentialName("宝山一村"), true);
  assert.equal(isResidentialName("泗塘一村"), true);
  assert.equal(isResidentialName("海滨新村"), true);
});

test("rejects administrative and committee village names", () => {
  assert.equal(isResidentialName("果园村"), false);
  assert.equal(isResidentialName("三营房居委"), false);
  assert.equal(isResidentialName("海滨二村一居委"), false);
  assert.equal(isResidentialName("金溪居委会金商新村"), false);
});

test("rejects schools, training entities, roads, and bare addresses", () => {
  assert.equal(isResidentialName("宝山实验学校"), false);
  assert.equal(isResidentialName("某某培训机构"), false);
  assert.equal(isResidentialName("清河路"), false);
  assert.equal(isResidentialName("清河路38弄"), false);
  assert.equal(isResidentialName("中山西路中华新村"), false);
  assert.equal(isResidentialName("人民西路西北新村"), false);
  assert.equal(isResidentialName("道路片区"), false);
});

test("accepts complete official enrollment-area entities without treating them as commercial projects", () => {
  assert.equal(isExplicitOfficialAreaName("新成路街道迎园社区"), true);
  assert.equal(isExplicitOfficialAreaName("东陆村民小组"), true);
  assert.equal(isExplicitOfficialAreaName("二村居委"), true);
  assert.equal(isExplicitOfficialAreaName("嘉萱苑"), true);
});

test("rejects broad administrative ranges and road fragments for official verification", () => {
  assert.equal(isExplicitOfficialAreaName("马陆镇"), false);
  assert.equal(isExplicitOfficialAreaName("安亭镇片区"), false);
  assert.equal(isExplicitOfficialAreaName("宝安公路3636弄"), false);
  assert.equal(isExplicitOfficialAreaName("38弄"), false);
  assert.equal(isExplicitOfficialAreaName("道路片区"), false);
});
