import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("scripts/backfill-official-exact-school-info.ts", "utf8");

test("nine-year schools may use unknown-stage official records only with a consistent nature", () => {
  assert.match(script, /type === \"nine_year\"/);
  assert.match(script, /stage === \"unknown\"/);
  assert.match(script, /性质标签不一致|normalizedNatureSet/);
  assert.match(script, /official.*nature|nature.*official/i);
});

test("nine-year official backfill keeps multi-campus addresses conservative", () => {
  assert.match(script, /unique.*address|addresses.*length|address.*length/);
  assert.match(script, /fillAddress/);
  assert.match(script, /school_nature IS NULL/);
  assert.match(script, /ON CONFLICT \(school_id, source_url, source_type\)/);
});

test("official exact school info requires a unique district-stage-name source", () => {
  assert.match(script, /uniqueSourceRows/);
  assert.match(script, /sourceStageForSchool/);
  assert.match(script, /skip-ambiguous/);
  assert.match(script, /official-school-info/);
});

test("official exact school info only fills blank canonical fields and keeps provenance", () => {
  assert.match(script, /school_nature IS NULL/);
  assert.match(script, /address IS NULL OR btrim\(address\)=''/);
  assert.match(script, /web_data_source/);
  assert.match(script, /confidence.*high/);
  assert.match(script, /BEGIN/);
  assert.match(script, /COMMIT/);
  assert.match(script, /ROLLBACK/);
});
