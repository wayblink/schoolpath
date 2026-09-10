import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync("db/redesign/003_create_school_district_relations.sql", "utf8");

test("published district relations keep raw names and optional catalog links", () => {
  assert.match(migration, /school_name text NOT NULL/);
  assert.match(migration, /committee_name text NOT NULL/);
  assert.match(migration, /catalog_school_id bigint,/);
  assert.match(migration, /catalog_community_id bigint,/);
  assert.doesNotMatch(migration, /catalog_school_id bigint[^,]*REFERENCES/i);
  assert.doesNotMatch(migration, /catalog_community_id bigint[^,]*REFERENCES/i);
});
