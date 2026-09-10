import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  extractCommitteeRelations,
  isSafeSchoolMatch,
  normalizeSchoolName,
  schoolNameSimilarity,
  type ParsedXuequzhushou,
} from "../lib/ingest/xuequzhushou";

const parsed = JSON.parse(
  readFileSync(path.join(process.cwd(), "data/ingest/xuequzhushou/20260711-035825/parsed.json"), "utf8"),
) as ParsedXuequzhushou;

test("expands every committee relation into an auditable record", () => {
  const relations = extractCommitteeRelations(parsed);
  assert.equal(relations.length, 2764);
  assert.equal(new Set(relations.map((relation) => relation.sourceKey)).size, 2764);
  assert.ok(relations.every((relation) => relation.schoolName && relation.committeeName));
});

test("normalizes common campus and punctuation variants without changing source text", () => {
  assert.equal(normalizeSchoolName("高安路一小(宛平校区)"), "高安路一小宛平");
  assert.equal(normalizeSchoolName("上海市第二中学（梅陇校区）"), "上海市第二中学梅陇");
  assert.equal(normalizeSchoolName("华师大二附中·前滩学校"), "华师大二附中前滩学校");
});

test("scores normalized exact matches above partial names", () => {
  assert.equal(schoolNameSimilarity("高安路一小(宛平校区)", "高安路一小宛平校区"), 1);
  assert.ok(schoolNameSimilarity("上海市第二中学", "市二中学") < 1);
});

test("only normalized exact school matches are safe to attach", () => {
  assert.equal(isSafeSchoolMatch(1), true);
  assert.equal(isSafeSchoolMatch(0.99), false);
  assert.equal(isSafeSchoolMatch(0.5), false);
});
