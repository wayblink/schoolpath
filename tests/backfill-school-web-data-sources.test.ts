import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const scriptPath = "scripts/backfill-school-web-data-sources.ts";

test("reviewed school source backfill is dry-run by default and transactional on apply", () => {
  const script = readFileSync(scriptPath, "utf8");

  assert.match(script, /const apply = process\.argv\.includes\("--apply"\)/);
  assert.match(script, /INSERT INTO web_data_source/);
  assert.match(script, /ON CONFLICT \(school_id, source_url, source_type\)/);
  assert.match(script, /await client\.query\("BEGIN"\)/);
  assert.match(script, /await client\.query\("COMMIT"\)/);
  assert.match(script, /await client\.query\("ROLLBACK"\)/);
});

test("reviewed source plan contains only explicit provenance classes and audited school ids", () => {
  const script = readFileSync(scriptPath, "utf8");

  assert.match(script, /sourceType: SourceType/);
  assert.match(script, /official_website/);
  assert.match(script, /official_school_info/);
  assert.match(script, /official_admission/);
  assert.match(script, /third_party_directory/);

  for (const id of [3467, 3585, 3586, 3901, 4008, 4298, 4486, 4533, 4555, 4567, 4573, 4574, 4579, 4580, 4581, 4583]) {
    assert.match(script, new RegExp(`schoolId: ${id}\\b`));
  }
  assert.match(script, /sourceCount: SOURCES\.length/);
  assert.match(script, /school_name_at_review/);
});

test("website updates never overwrite an existing conflicting homepage", () => {
  const script = readFileSync(scriptPath, "utf8");

  assert.match(script, /if \(current && current !== next\)/);
  assert.match(script, /skipped_conflict/);
  assert.match(script, /AND \(website IS NULL OR btrim\(website\) = ''\)/);
});
