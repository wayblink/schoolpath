import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("scripts/backfill-ocr-enrollment-notes.ts", "utf8");

test("OCR admission backfill is limited to official evidence and blank notes", () => {
  assert.match(script, /official-policy-images/);
  assert.match(script, /official_admission/);
  assert.match(script, /enrollment_note IS NULL|enrollment_note.*btrim/);
  assert.match(script, /confidence.*high/);
  assert.doesNotMatch(script, /INSERT INTO public\.school_communities|UPDATE public\.school_communities/);
  assert.doesNotMatch(script, /INSERT INTO public\.communities/);
});

test("OCR admission backfill is auditable, protected, and dry-run by default", () => {
  assert.match(script, /--apply/);
  assert.match(script, /ROLLBACK/);
  assert.match(script, /raw/);
  assert.match(script, /rawCells|raw_cells|ocr/);
  assert.match(script, /WHERE id=\$\d+ AND district=\$\d+ AND name=\$\d+/);
  assert.match(script, /backfill-dry-run|backfill-applied/);
  assert.match(script, /ON CONFLICT \(school_id,source_url,source_type\)/);
});

test("OCR parser filters non-boundary rows and keeps explicit source metadata", () => {
  assert.match(script, /splitArea|boundary/i);
  assert.match(script, /sourceTitle|source_title/);
  assert.match(script, /rowY|row_y/);
  assert.match(script, /districtArg|--district/);
  assert.match(script, /私立|school_nature/);
});

test("OCR admission backfill covers official middle-school tables without touching relations", () => {
  assert.match(script, /jingan-middle-2026\.ocr\.json/);
  assert.match(script, /yangpu-middle-2026\.ocr\.json/);
  assert.match(script, /stage:\s*[\"']middle[\"']/);
  assert.match(script, /school\.type === type/);
  assert.match(script, /对口小学/);
  assert.match(script, /对口方式/);
  assert.match(script, /招生班级数/);
  assert.match(script, /skip-ambiguous|ambiguous/);
  assert.match(script, /feederSchools|feeder_schools/);
});
