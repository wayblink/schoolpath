BEGIN;

ALTER TABLE public.schools
  ADD COLUMN IF NOT EXISTS source_key text,
  ADD COLUMN IF NOT EXISTS source_name text,
  ADD COLUMN IF NOT EXISTS source_url text,
  ADD COLUMN IF NOT EXISTS source_year integer,
  ADD COLUMN IF NOT EXISTS source_tier integer,
  ADD COLUMN IF NOT EXISTS area text,
  ADD COLUMN IF NOT EXISTS street text,
  ADD COLUMN IF NOT EXISTS feeder_middle_school text,
  ADD COLUMN IF NOT EXISTS middle_school_tier integer,
  ADD COLUMN IF NOT EXISTS evaluation text,
  ADD COLUMN IF NOT EXISTS admission_mode text,
  ADD COLUMN IF NOT EXISTS class_count integer,
  ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS schools_source_key_idx
  ON public.schools(source_key) WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS schools_district_type_idx ON public.schools(district,type);
CREATE INDEX IF NOT EXISTS schools_name_idx ON public.schools(name);

ALTER TABLE catalog.source_schools
  ADD COLUMN IF NOT EXISTS public_school_id integer REFERENCES public.schools(id);

-- Existing reviewed catalog matches are authoritative. catalog.schools.legacy_id is
-- the public.schools primary key created by the original layered migration.
UPDATE catalog.source_schools source
SET public_school_id = catalog_school.legacy_id
FROM catalog.schools catalog_school
WHERE source.catalog_school_id = catalog_school.id
  AND catalog_school.legacy_id IS NOT NULL
  AND source.public_school_id IS DISTINCT FROM catalog_school.legacy_id;

-- Import every still-unmatched source row as a first-class public school. This
-- intentionally avoids fuzzy merges: retaining two reviewable rows is safer than
-- silently attaching source facts to the wrong campus.
INSERT INTO public.schools (
  name,district,tier,type,address,lat,lng,attrs,source_key,source_name,
  source_url,source_year,source_tier,area,street,feeder_middle_school,
  middle_school_tier,evaluation,admission_mode,class_count,tags
)
SELECT
  source.school_name,
  CASE source.district WHEN '浦东新区' THEN '浦东' ELSE regexp_replace(source.district,'区$','') END,
  CASE source.tier WHEN 1 THEN '一梯队' WHEN 2 THEN '二梯队' WHEN 3 THEN '三梯队' WHEN 4 THEN '四梯队' END,
  source.school_type::school_type,
  coalesce(source.street,source.area),source.lat,source.lng,
  coalesce(source.attrs,'{}'::jsonb),source.source_key,source.source_name,
  source.source_url,source.source_year,source.tier,source.area,source.street,
  source.feeder_middle_school,source.middle_school_tier,source.evaluation,
  source.admission_mode,source.class_count,coalesce(source.tags,'[]'::jsonb)
FROM catalog.source_schools source
WHERE source.public_school_id IS NULL
ON CONFLICT (source_key) WHERE source_key IS NOT NULL DO NOTHING;

UPDATE catalog.source_schools source
SET public_school_id = school.id
FROM public.schools school
WHERE source.public_school_id IS NULL
  AND school.source_key = source.source_key;

-- Enrich both pre-existing and newly inserted public rows. Legacy operational
-- fields win; source-specific product fields are refreshed from their snapshot.
UPDATE public.schools school
SET source_key = source.source_key,
    source_name = source.source_name,
    source_url = source.source_url,
    source_year = source.source_year,
    source_tier = source.tier,
    area = source.area,
    street = source.street,
    feeder_middle_school = source.feeder_middle_school,
    middle_school_tier = source.middle_school_tier,
    evaluation = source.evaluation,
    admission_mode = source.admission_mode,
    class_count = source.class_count,
    tags = coalesce(source.tags,'[]'::jsonb),
    tier = coalesce(school.tier,CASE source.tier WHEN 1 THEN '一梯队' WHEN 2 THEN '二梯队' WHEN 3 THEN '三梯队' WHEN 4 THEN '四梯队' END),
    lat = coalesce(school.lat,source.lat),
    lng = coalesce(school.lng,source.lng),
    attrs = coalesce(school.attrs,'{}'::jsonb) || coalesce(source.attrs,'{}'::jsonb),
    updated_at = now()
FROM catalog.source_schools source
WHERE source.public_school_id = school.id;

ALTER TABLE catalog.school_district_relations
  ADD COLUMN IF NOT EXISTS school_id integer REFERENCES public.schools(id);

UPDATE catalog.school_district_relations relation
SET school_id = source.public_school_id
FROM catalog.source_schools source
WHERE source.district = relation.district
  AND source.school_name = relation.school_name
  AND source.public_school_id IS NOT NULL
  AND relation.school_id IS DISTINCT FROM source.public_school_id;

-- Normalized and audit rows remain as provenance, but runtime identity always
-- resolves through public.schools.
ALTER TABLE catalog.school_aliases
  ADD COLUMN IF NOT EXISTS public_school_id integer REFERENCES public.schools(id);
ALTER TABLE catalog.school_community_assignments
  ADD COLUMN IF NOT EXISTS public_school_id integer REFERENCES public.schools(id);
ALTER TABLE catalog.school_feeder_relations
  ADD COLUMN IF NOT EXISTS from_public_school_id integer REFERENCES public.schools(id),
  ADD COLUMN IF NOT EXISTS to_public_school_id integer REFERENCES public.schools(id);
ALTER TABLE catalog.policy_documents
  ADD COLUMN IF NOT EXISTS public_school_id integer REFERENCES public.schools(id);
ALTER TABLE catalog.school_ratings
  ADD COLUMN IF NOT EXISTS public_school_id integer REFERENCES public.schools(id);
ALTER TABLE audit.entity_match_candidates
  ADD COLUMN IF NOT EXISTS public_school_id integer REFERENCES public.schools(id);
ALTER TABLE audit.school_community_relation_candidates
  ADD COLUMN IF NOT EXISTS public_school_id integer REFERENCES public.schools(id);

UPDATE catalog.school_aliases row
SET public_school_id = school.legacy_id
FROM catalog.schools school
WHERE row.school_id = school.id AND school.legacy_id IS NOT NULL
  AND row.public_school_id IS DISTINCT FROM school.legacy_id;

UPDATE catalog.school_community_assignments row
SET public_school_id = school.legacy_id
FROM catalog.schools school
WHERE row.school_id = school.id AND school.legacy_id IS NOT NULL
  AND row.public_school_id IS DISTINCT FROM school.legacy_id;

UPDATE catalog.school_feeder_relations row
SET from_public_school_id = source_school.legacy_id
FROM catalog.schools source_school
WHERE row.from_school_id = source_school.id AND source_school.legacy_id IS NOT NULL
  AND row.from_public_school_id IS DISTINCT FROM source_school.legacy_id;

UPDATE catalog.school_feeder_relations row
SET to_public_school_id = target_school.legacy_id
FROM catalog.schools target_school
WHERE row.to_school_id = target_school.id AND target_school.legacy_id IS NOT NULL
  AND row.to_public_school_id IS DISTINCT FROM target_school.legacy_id;

UPDATE catalog.policy_documents row
SET public_school_id = school.legacy_id
FROM catalog.schools school
WHERE row.school_id = school.id AND school.legacy_id IS NOT NULL
  AND row.public_school_id IS DISTINCT FROM school.legacy_id;

UPDATE catalog.school_ratings row
SET public_school_id = school.legacy_id
FROM catalog.schools school
WHERE row.school_id = school.id AND school.legacy_id IS NOT NULL
  AND row.public_school_id IS DISTINCT FROM school.legacy_id;

UPDATE audit.entity_match_candidates candidate
SET public_school_id = school.legacy_id
FROM catalog.schools school
WHERE candidate.entity_type = 'school' AND candidate.catalog_entity_id = school.id
  AND school.legacy_id IS NOT NULL
  AND candidate.public_school_id IS DISTINCT FROM school.legacy_id;

UPDATE audit.entity_match_candidates candidate
SET public_school_id = source.public_school_id
FROM ingest.extracted_records extracted
JOIN catalog.source_schools source ON source.source_key = extracted.source_key
WHERE candidate.entity_type = 'school'
  AND candidate.source_record_id = extracted.id
  AND source.public_school_id IS NOT NULL
  AND candidate.public_school_id IS DISTINCT FROM source.public_school_id;

UPDATE audit.school_community_relation_candidates candidate
SET public_school_id = school.legacy_id
FROM catalog.schools school
WHERE candidate.catalog_school_id = school.id AND school.legacy_id IS NOT NULL
  AND candidate.public_school_id IS DISTINCT FROM school.legacy_id;

UPDATE audit.school_community_relation_candidates candidate
SET public_school_id = source.public_school_id
FROM catalog.source_schools source
WHERE source.district = candidate.district
  AND source.school_name = candidate.school_name_raw
  AND source.public_school_id IS NOT NULL
  AND candidate.public_school_id IS DISTINCT FROM source.public_school_id;

CREATE INDEX IF NOT EXISTS source_schools_public_school_idx
  ON catalog.source_schools(public_school_id);
CREATE INDEX IF NOT EXISTS school_district_relations_school_idx
  ON catalog.school_district_relations(school_id);
CREATE INDEX IF NOT EXISTS school_aliases_public_school_idx
  ON catalog.school_aliases(public_school_id);
CREATE INDEX IF NOT EXISTS school_community_assignments_public_school_idx
  ON catalog.school_community_assignments(public_school_id);
CREATE INDEX IF NOT EXISTS school_feeder_relations_from_public_school_idx
  ON catalog.school_feeder_relations(from_public_school_id);
CREATE INDEX IF NOT EXISTS school_feeder_relations_to_public_school_idx
  ON catalog.school_feeder_relations(to_public_school_id);
CREATE INDEX IF NOT EXISTS policy_documents_public_school_idx
  ON catalog.policy_documents(public_school_id);
CREATE INDEX IF NOT EXISTS school_ratings_public_school_idx
  ON catalog.school_ratings(public_school_id);
CREATE INDEX IF NOT EXISTS entity_match_candidates_public_school_idx
  ON audit.entity_match_candidates(public_school_id);
CREATE INDEX IF NOT EXISTS relation_candidates_public_school_idx
  ON audit.school_community_relation_candidates(public_school_id);

COMMIT;
