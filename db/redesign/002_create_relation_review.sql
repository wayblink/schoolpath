BEGIN;
CREATE TABLE IF NOT EXISTS audit.school_community_relation_candidates (
  id bigserial PRIMARY KEY,
  crawl_run_id bigint NOT NULL REFERENCES ingest.crawl_runs(id),
  source_record_id bigint NOT NULL REFERENCES ingest.extracted_records(id) ON DELETE CASCADE,
  school_match_candidate_id bigint REFERENCES audit.entity_match_candidates(id),
  catalog_school_id bigint REFERENCES catalog.schools(id),
  catalog_community_id bigint REFERENCES catalog.communities(id),
  district text NOT NULL,
  school_name_raw text NOT NULL,
  committee_name_raw text NOT NULL,
  area text,
  street text,
  school_match_score numeric(6,4) NOT NULL DEFAULT 0,
  community_match_method text NOT NULL DEFAULT 'unmatched',
  community_match_score numeric(6,4) NOT NULL DEFAULT 0,
  review_status text NOT NULL DEFAULT 'pending',
  resolution_note text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_record_id)
);
CREATE INDEX IF NOT EXISTS relation_candidates_review_status_idx
  ON audit.school_community_relation_candidates(review_status);
CREATE INDEX IF NOT EXISTS relation_candidates_school_idx
  ON audit.school_community_relation_candidates(catalog_school_id);
COMMIT;
