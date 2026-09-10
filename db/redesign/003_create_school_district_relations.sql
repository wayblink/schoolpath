BEGIN;

CREATE TABLE IF NOT EXISTS catalog.school_district_relations (
  id bigserial PRIMARY KEY,
  source_record_id bigint NOT NULL UNIQUE,
  source_name text NOT NULL,
  source_url text,
  source_year integer,
  district text NOT NULL,
  school_name text NOT NULL,
  school_type text,
  committee_name text NOT NULL,
  area text,
  street text,
  catalog_school_id bigint,
  catalog_community_id bigint,
  school_match_score numeric(6,4) NOT NULL DEFAULT 0,
  community_match_score numeric(6,4) NOT NULL DEFAULT 0,
  match_status text NOT NULL DEFAULT 'raw',
  review_status text NOT NULL DEFAULT 'provisional',
  verified boolean NOT NULL DEFAULT false,
  attrs jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS school_district_relations_district_idx
  ON catalog.school_district_relations(district);
CREATE INDEX IF NOT EXISTS school_district_relations_school_name_idx
  ON catalog.school_district_relations(school_name);
CREATE INDEX IF NOT EXISTS school_district_relations_committee_name_idx
  ON catalog.school_district_relations(committee_name);
CREATE INDEX IF NOT EXISTS school_district_relations_catalog_school_idx
  ON catalog.school_district_relations(catalog_school_id);
CREATE INDEX IF NOT EXISTS school_district_relations_catalog_community_idx
  ON catalog.school_district_relations(catalog_community_id);

COMMIT;
