import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const script = readFileSync("scripts/backfill-official-nature-from-json.ts", "utf8");

test("official JSON nature backfill is strict and dry-run by default", () => {
  assert.match(script, /process\.argv\.includes\("--apply"\)/);
  assert.match(script, /school_nature IS NULL/);
  assert.match(script, /official_json_nature/);
  assert.match(script, /distinct\.length === 1/);
});

test("official nature JSON matching normalizes public/private prefixes without guessing", () => {
  assert.match(script, /上海民办|上海市民办|私立/);
  assert.match(script, /const isPrivate = \/民办\|私立\//);
  assert.match(script, /const isPublic = \/公办\|公立\//);
  assert.match(script, /if \(isPrivate === isPublic\) return null/);
  assert.match(script, /skip-ambiguous|skip-no-source/);
});

test("official JSON provenance remains official and preserves raw source", () => {
  assert.match(script, /source_type.*official_school_info/);
  assert.match(script, /source_url/);
  assert.match(script, /raw/);
});
