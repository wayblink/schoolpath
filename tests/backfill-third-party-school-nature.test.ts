import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const script = readFileSync("scripts/backfill-third-party-school-nature.ts", "utf8");

test("third-party school nature backfill is dry-run by default and fills only blank canonical nature", () => {
  assert.match(script, /process\.argv\.includes\("--apply"\)/);
  assert.match(script, /school_nature IS NULL/);
  assert.match(script, /school_nature = \$1::school_nature/);
  assert.match(script, /third_party_school_nature/);
});

test("third-party school nature provenance is explicit and never marked official", () => {
  assert.match(script, /source_type, source_name, source_url, source_title/);
  assert.match(script, /third_party_school_nature/);
  assert.match(script, /学区助手/);
  assert.match(script, /confidence, raw, fetched_at/);
  assert.doesNotMatch(script, /source_type.*official_school_info/);
});

test("nature extraction requires explicit public/private wording and rejects ambiguous rows", () => {
  assert.match(script, /公办|公立/);
  assert.match(script, /民办|私立/);
  assert.match(script, /conflict|ambiguous|冲突/);
});
