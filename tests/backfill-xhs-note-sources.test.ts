import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { noteUrl } from "../scripts/backfill-xhs-note-sources";

test("XHS note ids are converted only when they are complete hex ids", () => {
  assert.equal(noteUrl("69ef17db0000000035023d80"), "https://www.xiaohongshu.com/explore/69ef17db0000000035023d80");
  assert.equal(noteUrl("short-id"), null);
  assert.equal(noteUrl(""), null);
});

test("XHS note source registration is provenance-only and dry-run by default", () => {
  const script = readFileSync("scripts/backfill-xhs-note-sources.ts", "utf8");
  assert.match(script, /NOT EXISTS \(SELECT 1 FROM public\.web_data_source/);
  assert.match(script, /third_party_tier/);
  assert.match(script, /不代表官方招生或学区结论/);
  assert.match(script, /if \(apply\) await client\.query\("COMMIT"\); else await client\.query\("ROLLBACK"\)/);
  assert.doesNotMatch(script, /UPDATE public\.schools/);
  assert.doesNotMatch(script, /school_communities/);
});
