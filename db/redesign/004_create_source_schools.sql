BEGIN;

CREATE TABLE IF NOT EXISTS catalog.source_schools (
  id bigserial PRIMARY KEY,
  source_key text NOT NULL UNIQUE,
  source_name text NOT NULL,
  source_url text,
  source_year integer,
  district text NOT NULL,
  school_name text NOT NULL,
  school_type text NOT NULL,
  tier integer,
  area text,
  street text,
  feeder_middle_school text,
  middle_school_tier integer,
  evaluation text,
  admission_mode text,
  class_count integer,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  lng double precision,
  lat double precision,
  catalog_school_id bigint,
  attrs jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS source_schools_district_idx ON catalog.source_schools(district);
CREATE INDEX IF NOT EXISTS source_schools_name_idx ON catalog.source_schools(school_name);
CREATE INDEX IF NOT EXISTS source_schools_location_idx ON catalog.source_schools(lng,lat);

COMMIT;
