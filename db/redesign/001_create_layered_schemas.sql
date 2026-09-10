BEGIN;
CREATE SCHEMA IF NOT EXISTS ingest;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS catalog;

CREATE TABLE IF NOT EXISTS ingest.sources (
  id bigserial PRIMARY KEY,
  source_key text NOT NULL UNIQUE,
  name text NOT NULL,
  base_url text NOT NULL,
  source_kind text NOT NULL DEFAULT 'third_party',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ingest.crawl_runs (
  id bigserial PRIMARY KEY,
  source_id bigint NOT NULL REFERENCES ingest.sources(id),
  source_url text NOT NULL,
  fetched_at timestamptz NOT NULL,
  http_status integer NOT NULL,
  content_hash text NOT NULL,
  parser_version integer NOT NULL,
  page_title text,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_path text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_id, content_hash)
);
CREATE TABLE IF NOT EXISTS ingest.extracted_records (
  id bigserial PRIMARY KEY,
  crawl_run_id bigint NOT NULL REFERENCES ingest.crawl_runs(id) ON DELETE CASCADE,
  record_type text NOT NULL,
  source_key text NOT NULL,
  district text,
  raw jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(crawl_run_id, record_type, source_key)
);

CREATE TABLE IF NOT EXISTS catalog.districts (
  id bigserial PRIMARY KEY,
  canonical_name text NOT NULL UNIQUE,
  display_name text NOT NULL,
  city text NOT NULL DEFAULT '上海',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS catalog.schools (
  id bigserial PRIMARY KEY,
  legacy_id integer UNIQUE,
  canonical_name text NOT NULL,
  district_id bigint NOT NULL REFERENCES catalog.districts(id),
  school_type text NOT NULL,
  school_nature text,
  tier text,
  address text,
  lat double precision,
  lng double precision,
  enrollment_note text,
  pit_risk_level text,
  attrs jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_status text NOT NULL DEFAULT 'migrated',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS catalog_schools_name_idx ON catalog.schools(canonical_name);
CREATE INDEX IF NOT EXISTS catalog_schools_district_idx ON catalog.schools(district_id);
CREATE INDEX IF NOT EXISTS catalog_schools_identity_idx ON catalog.schools(district_id, canonical_name, school_type);
CREATE TABLE IF NOT EXISTS catalog.school_aliases (
  id bigserial PRIMARY KEY,
  school_id bigint NOT NULL REFERENCES catalog.schools(id) ON DELETE CASCADE,
  alias text NOT NULL,
  source_type text NOT NULL DEFAULT 'legacy',
  valid_year integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(school_id, alias)
);
CREATE TABLE IF NOT EXISTS catalog.communities (
  id bigserial PRIMARY KEY,
  legacy_id integer UNIQUE,
  name text NOT NULL,
  district_id bigint NOT NULL REFERENCES catalog.districts(id),
  lng double precision,
  lat double precision,
  address text,
  committee_name text,
  attrs jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(district_id, name)
);
CREATE TABLE IF NOT EXISTS catalog.school_community_assignments (
  id bigserial PRIMARY KEY,
  legacy_id integer UNIQUE,
  school_id bigint NOT NULL REFERENCES catalog.schools(id),
  community_id bigint NOT NULL REFERENCES catalog.communities(id),
  committee_name text,
  year integer NOT NULL,
  source_name text NOT NULL,
  source_url text,
  source_date text,
  verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(school_id, community_id, year)
);
CREATE TABLE IF NOT EXISTS catalog.school_feeder_relations (
  id bigserial PRIMARY KEY,
  from_school_id bigint NOT NULL REFERENCES catalog.schools(id),
  to_school_id bigint REFERENCES catalog.schools(id),
  to_school_name_raw text,
  year integer NOT NULL,
  relation_type text NOT NULL,
  assignment_mode text NOT NULL DEFAULT 'deterministic',
  ratio numeric(6,4),
  source_type text NOT NULL,
  source_name text NOT NULL,
  source_url text,
  confidence text NOT NULL DEFAULT 'medium',
  review_status text NOT NULL DEFAULT 'pending',
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(from_school_id, to_school_name_raw, year, source_name)
);
CREATE TABLE IF NOT EXISTS catalog.policy_documents (
  id bigserial PRIMARY KEY,
  legacy_id integer UNIQUE,
  school_id bigint REFERENCES catalog.schools(id),
  district_id bigint REFERENCES catalog.districts(id),
  scope text NOT NULL,
  year integer NOT NULL,
  title text NOT NULL,
  source_url text,
  content text NOT NULL,
  change_summary text,
  fetched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS catalog.school_ratings (
  id bigserial PRIMARY KEY,
  school_id bigint NOT NULL REFERENCES catalog.schools(id),
  rating_type text NOT NULL,
  rating_value text NOT NULL,
  year integer NOT NULL,
  source_type text NOT NULL,
  source_name text NOT NULL,
  source_url text,
  confidence text NOT NULL DEFAULT 'medium',
  review_status text NOT NULL DEFAULT 'pending',
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(school_id, rating_type, year, source_name)
);

CREATE TABLE IF NOT EXISTS audit.entity_match_candidates (
  id bigserial PRIMARY KEY,
  crawl_run_id bigint NOT NULL REFERENCES ingest.crawl_runs(id),
  source_record_id bigint NOT NULL REFERENCES ingest.extracted_records(id),
  entity_type text NOT NULL,
  catalog_entity_id bigint,
  match_method text NOT NULL,
  match_score numeric(6,4) NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  explanation text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_record_id, entity_type)
);
CREATE TABLE IF NOT EXISTS audit.field_conflicts (
  id bigserial PRIMARY KEY,
  match_candidate_id bigint NOT NULL REFERENCES audit.entity_match_candidates(id) ON DELETE CASCADE,
  field_name text NOT NULL,
  current_value jsonb,
  proposed_value jsonb,
  status text NOT NULL DEFAULT 'pending',
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(match_candidate_id, field_name)
);
CREATE TABLE IF NOT EXISTS audit.release_batches (
  id bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'draft',
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  rolled_back_at timestamptz
);

INSERT INTO catalog.districts(canonical_name, display_name)
SELECT DISTINCT district, district || '区' FROM public.schools
ON CONFLICT(canonical_name) DO NOTHING;
UPDATE catalog.districts SET display_name = CASE canonical_name WHEN '浦东' THEN '浦东新区' ELSE canonical_name || '区' END;

INSERT INTO catalog.schools(legacy_id, canonical_name, district_id, school_type, school_nature, tier, address, lat, lng, enrollment_note, pit_risk_level, attrs, source_status, created_at, updated_at)
SELECT s.id, s.name, d.id, s.type::text, s.school_nature::text, s.tier, s.address, s.lat, s.lng, s.enrollment_note, s.pit_risk_level::text, coalesce(s.attrs,'{}'::jsonb), 'migrated', coalesce(s.created_at,now()), coalesce(s.updated_at,now())
FROM public.schools s JOIN catalog.districts d ON d.canonical_name=s.district
ON CONFLICT(legacy_id) DO UPDATE SET canonical_name=excluded.canonical_name, district_id=excluded.district_id, school_type=excluded.school_type, school_nature=excluded.school_nature, tier=excluded.tier, address=excluded.address, lat=excluded.lat, lng=excluded.lng, enrollment_note=excluded.enrollment_note, pit_risk_level=excluded.pit_risk_level, attrs=excluded.attrs, updated_at=excluded.updated_at;

INSERT INTO catalog.school_aliases(school_id, alias)
SELECT cs.id, alias FROM public.schools s JOIN catalog.schools cs ON cs.legacy_id=s.id CROSS JOIN LATERAL unnest(coalesce(s.aliases,ARRAY[]::text[])) alias WHERE trim(alias)<>''
ON CONFLICT DO NOTHING;

INSERT INTO catalog.communities(legacy_id,name,district_id,lng,lat,address,committee_name,attrs,created_at)
SELECT c.id,c.name,d.id,c.lng,c.lat,c.amap_address,c.source_committee,coalesce(c.attrs,'{}'::jsonb),coalesce(c.created_at,now())
FROM public.communities c JOIN catalog.districts d ON d.canonical_name=c.district
ON CONFLICT(legacy_id) DO UPDATE SET name=excluded.name,district_id=excluded.district_id,lng=excluded.lng,lat=excluded.lat,address=excluded.address,committee_name=excluded.committee_name,attrs=excluded.attrs;

INSERT INTO catalog.school_community_assignments(legacy_id,school_id,community_id,committee_name,year,source_name,source_url,source_date,verified,created_at)
SELECT sc.id,cs.id,cc.id,sc.committee_name,sc.year,sc.source_name,sc.source_url,sc.source_date,sc.verified,now()
FROM public.school_communities sc JOIN catalog.schools cs ON cs.legacy_id=sc.school_id JOIN catalog.communities cc ON cc.legacy_id=sc.community_id
ON CONFLICT(legacy_id) DO UPDATE SET school_id=excluded.school_id,community_id=excluded.community_id,committee_name=excluded.committee_name,year=excluded.year,source_name=excluded.source_name,source_url=excluded.source_url,source_date=excluded.source_date,verified=excluded.verified;

INSERT INTO catalog.policy_documents(legacy_id,school_id,district_id,scope,year,title,source_url,content,change_summary,fetched_at)
SELECT p.id,cs.id,d.id,p.scope::text,p.year,p.title,p.source_url,p.content,p.change_summary,p.fetched_at
FROM public.policies p LEFT JOIN catalog.schools cs ON cs.legacy_id=p.school_id LEFT JOIN catalog.districts d ON d.canonical_name=p.district
ON CONFLICT(legacy_id) DO UPDATE SET school_id=excluded.school_id,district_id=excluded.district_id,scope=excluded.scope,year=excluded.year,title=excluded.title,source_url=excluded.source_url,content=excluded.content,change_summary=excluded.change_summary,fetched_at=excluded.fetched_at;
COMMIT;
