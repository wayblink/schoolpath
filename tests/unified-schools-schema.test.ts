import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync("db/redesign/005_flatten_schools.sql", "utf8");

test("public schools becomes the canonical wide school table", () => {
  for (const field of [
    "source_key text",
    "source_name text",
    "source_url text",
    "source_year integer",
    "source_tier integer",
    "area text",
    "street text",
    "feeder_middle_school text",
    "middle_school_tier integer",
    "evaluation text",
    "admission_mode text",
    "class_count integer",
    "tags jsonb",
  ]) assert.match(migration, new RegExp(field));

  assert.match(migration, /insert into public\.schools/i);
  assert.match(migration, /update public\.schools/i);
  assert.match(migration, /school_id integer references public\.schools\(id\)/i);
  assert.match(migration, /create unique index if not exists schools_source_key_idx/i);
});

test("all school-owned catalog and audit rows point at public schools", () => {
  for (const table of [
    "catalog.source_schools",
    "catalog.school_aliases",
    "catalog.school_community_assignments",
    "catalog.policy_documents",
    "catalog.school_ratings",
    "audit.entity_match_candidates",
    "audit.school_community_relation_candidates",
  ]) {
    assert.match(
      migration,
      new RegExp(`alter table ${table.replace(".", "\\.")}[^;]+public_school_id integer references public\\.schools\\(id\\)`, "is"),
    );
  }

  assert.match(migration, /from_public_school_id integer references public\.schools\(id\)/i);
  assert.match(migration, /to_public_school_id integer references public\.schools\(id\)/i);
  assert.match(migration, /create index if not exists school_aliases_public_school_idx/i);
  assert.match(migration, /create index if not exists relation_candidates_public_school_idx/i);
});
