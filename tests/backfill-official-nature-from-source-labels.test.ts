import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { explicitNature } from "../scripts/backfill-official-nature-from-source-labels";

const script = readFileSync("scripts/backfill-official-nature-from-source-labels.ts", "utf8");

test("official nature backfill maps explicit source labels and fills only nulls", () => {
  assert.match(script, /公办/);
  assert.match(script, /民办/);
  assert.match(script, /公立/);
  assert.match(script, /私立/);
  assert.match(script, /school_nature IS NULL/);
  assert.match(script, /UPDATE public\.schools/);
  assert.match(script, /--apply/);
  assert.match(script, /ROLLBACK/);
});

test("official nature backfill preserves provenance and never touches relations", () => {
  assert.match(script, /official_source_nature_label/);
  assert.match(script, /web_data_source/);
  assert.match(script, /source_url/);
  assert.match(script, /raw/);
  assert.doesNotMatch(script, /school_communities/);
  assert.doesNotMatch(script, /DELETE FROM/);
});

test("extracts nature from nested official source fields", () => {
  assert.equal(explicitNature({ source_title: "2025学校信息", raw: { source: { nature: "民办初中" } } }), "私立");
  assert.equal(explicitNature({ source_title: "2025学校信息", raw: { raw_nature: "公办" } }), "公立");
});

test("does not classify a source with conflicting public and private labels", () => {
  assert.equal(explicitNature({ source_title: "2025学校信息", raw: { nature: "公办", source: { nature: "民办" } } }), null);
});
