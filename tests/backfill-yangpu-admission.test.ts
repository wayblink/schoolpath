import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("scripts/backfill-yangpu-admission-info.ts", "utf8");

test("Yangpu admission backfill reads the explicit class-plan column", () => {
  assert.match(script, /district\s*===?\s*[\"']杨浦/);
  assert.match(script, /stage\s*===?\s*[\"']primary/);
  assert.match(script, /raw\??\.\[raw\.length\s*-\s*1\]|raw\[21\]/);
  assert.match(script, /招收班级数/);
  assert.match(script, /enrollment_note/);
});

test("Yangpu admission backfill is strict, auditable, and dry-run by default", () => {
  assert.match(script, /--apply/);
  assert.match(script, /ROLLBACK/);
  assert.match(script, /ON CONFLICT \(school_id,source_url,source_type\)/);
  assert.match(script, /official_admission/);
  assert.match(script, /unique|ambiguous/i);
  assert.match(script, /WHERE id=\$\d+ AND district=['\"]杨浦['\"] AND name=\$\d+/);
  assert.match(script, /enrollment_note IS NULL|enrollment_note.*btrim/);
});
