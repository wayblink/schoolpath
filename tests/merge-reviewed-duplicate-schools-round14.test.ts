import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mergeSchoolRows } from "../scripts/merge-reviewed-duplicate-schools-round14";

const scriptPath = "scripts/merge-reviewed-duplicate-schools-round14.ts";

test("round14 only merges the five reviewed duplicate rows into canonical schools", () => {
  const script = readFileSync(scriptPath, "utf8");

  for (const pair of [
    "4782, targetId: 5107",
    "5266, targetId: 5107",
    "4968, targetId: 5552",
    "4577, targetId: 5552",
    "6054, targetId: 4642",
  ]) {
    assert.match(script, new RegExp(`sourceId: ${pair}`));
  }

  for (const deferredId of [4765, 4771, 4706, 4668]) {
    assert.doesNotMatch(script, new RegExp(`sourceId: ${deferredId}\\b`));
  }
});

test("round14 is dry-run by default and applies under one short locked transaction", () => {
  const script = readFileSync(scriptPath, "utf8");

  assert.match(script, /process\.argv\.includes\("--apply"\)/);
  assert.match(script, /BEGIN/);
  assert.match(script, /ORDER BY id[\s\S]*FOR UPDATE/);
  assert.match(script, /statement_timeout/);
  assert.match(script, /COMMIT/);
  assert.match(script, /ROLLBACK/);
});

test("round14 preserves target values and records source rows, aliases, and conflicts", () => {
  const script = readFileSync(scriptPath, "utf8");

  assert.match(script, /school_data_merged_sources_round14/);
  assert.match(script, /school_data_merge_conflicts/);
  assert.match(script, /aliases/);
  assert.match(script, /targetValue[\s\S]*sourceValue/);
  assert.match(script, /targetValue[\s\S]*return targetValue/);
});

test("round14 merge behavior keeps canonical values and only fills gaps", () => {
  const target = {
    id: 5552,
    name: "上海市民办新华初级中学",
    aliases: ["新华初"],
    district: "虹口",
    type: "middle" as const,
    school_nature: "私立" as const,
    tier: "三梯队",
    enrollment_note: null,
    tags: [],
    attrs: { reviewed: true },
  };
  const source = {
    id: 4968,
    name: "新华初级",
    aliases: ["新华初级中学"],
    district: "黄浦",
    type: "middle" as const,
    school_nature: "公立" as const,
    tier: "一梯队",
    enrollment_note: "仅用于验证空字段补充",
    tags: ["source-tag"],
    attrs: { data_source: "xhs-flush" },
  };

  const merged = mergeSchoolRows(target, source, {
    sourceId: 4968,
    targetId: 5552,
    sourceName: "新华初级",
    sourceDistrict: "黄浦",
    targetName: "上海市民办新华初级中学",
    targetDistrict: "虹口",
    type: "middle",
    evidence: "reviewed fixture",
  }, "2026-08-13T00:00:00.000Z");

  assert.equal(merged.values.school_nature, "私立");
  assert.equal(merged.values.tier, "三梯队");
  assert.equal(merged.values.enrollment_note, "仅用于验证空字段补充");
  assert.deepEqual(merged.values.tags, ["source-tag"]);
  assert.deepEqual(merged.aliases.sort(), ["新华初", "新华初级", "新华初级中学"].sort());
  assert.equal((merged.attrs as unknown as { reviewed: boolean }).reviewed, true);
  assert.equal((merged.attrs.school_data_merged_sources_round14 as Array<{ source_id: number }>)[0].source_id, 4968);
  assert.deepEqual(merged.conflicts.map((item) => item.field).sort(), ["school_nature", "tier"]);
});

test("round14 migrates every live school reference and handles unique-key collisions", () => {
  const script = readFileSync(scriptPath, "utf8");

  for (const table of [
    "school_communities",
    "district_boundaries",
    "policies",
    "school_info",
    "school_community_candidates",
    "web_data_source",
  ]) {
    assert.match(script, new RegExp(table));
  }

  assert.match(script, /\["catalog", "source_schools", "public_school_id"\]/);
  assert.match(script, /school_communities_uniq_idx|community_id[\s\S]*year/);
  assert.match(script, /web_data_source_school_url_type_idx|source_url[\s\S]*source_type/);
  assert.match(script, /ON CONFLICT \(school_id, source_url, source_type\)/);
});

test("round14 writes auditable dry-run and applied reports and is idempotent", () => {
  const script = readFileSync(scriptPath, "utf8");

  assert.match(script, /dry-run\.json/);
  assert.match(script, /applied\.json/);
  assert.match(script, /skippedMissingSources/);
  assert.match(script, /postMerge/);
});
