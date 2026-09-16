--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14
-- Dumped by pg_dump version 16.14 (Debian 16.14-1.pgdg13+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pit_risk_level; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pit_risk_level AS ENUM (
    'low',
    'medium',
    'high',
    'unknown'
);


--
-- Name: policy_scope; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.policy_scope AS ENUM (
    'city',
    'district',
    'school'
);


--
-- Name: school_nature; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.school_nature AS ENUM (
    '公立',
    '私立'
);


--
-- Name: school_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.school_type AS ENUM (
    'primary',
    'middle',
    'nine_year'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: communities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.communities (
    id integer NOT NULL,
    name text NOT NULL,
    district text NOT NULL,
    lng double precision,
    lat double precision,
    amap_poi_id text,
    amap_type_code text,
    amap_type_name text,
    amap_address text,
    source_committee text,
    source_query text,
    source_url text,
    source_name text NOT NULL,
    source_date text NOT NULL,
    verified boolean DEFAULT false NOT NULL,
    notes text,
    attrs jsonb,
    osm_polygon jsonb,
    osm_way_id text,
    osm_fetched_at text,
    created_at timestamp with time zone DEFAULT now(),
    entity_kind text DEFAULT 'community'::text NOT NULL
);


--
-- Name: communities_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.communities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: communities_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.communities_id_seq OWNED BY public.communities.id;


--
-- Name: community_price_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.community_price_snapshots (
    id integer NOT NULL,
    community_id integer NOT NULL,
    source_name text NOT NULL,
    source_url text NOT NULL,
    source_period text NOT NULL,
    unit_price_yuan_per_sqm integer NOT NULL,
    raw jsonb,
    fetched_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: community_price_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.community_price_snapshots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: community_price_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.community_price_snapshots_id_seq OWNED BY public.community_price_snapshots.id;


--
-- Name: community_price_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.community_price_sources (
    id integer NOT NULL,
    community_id integer NOT NULL,
    source_name text NOT NULL,
    source_url text NOT NULL,
    source_community_name text,
    source_address text,
    active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: community_price_sources_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.community_price_sources_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: community_price_sources_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.community_price_sources_id_seq OWNED BY public.community_price_sources.id;


--
-- Name: district_boundaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.district_boundaries (
    id integer NOT NULL,
    school_id integer NOT NULL,
    year integer NOT NULL,
    geojson jsonb NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: district_boundaries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.district_boundaries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: district_boundaries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.district_boundaries_id_seq OWNED BY public.district_boundaries.id;


--
-- Name: districts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.districts (
    id bigint NOT NULL,
    canonical_name text NOT NULL,
    display_name text NOT NULL,
    city text DEFAULT '上海'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: districts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.districts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: districts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.districts_id_seq OWNED BY public.districts.id;


--
-- Name: policy_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.policy_documents (
    id bigint NOT NULL,
    legacy_id integer,
    school_id bigint,
    district_id bigint,
    scope text NOT NULL,
    year integer NOT NULL,
    title text NOT NULL,
    source_url text,
    content text NOT NULL,
    change_summary text,
    fetched_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    public_school_id integer
);


--
-- Name: policy_documents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.policy_documents_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: policy_documents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.policy_documents_id_seq OWNED BY public.policy_documents.id;


--
-- Name: school_communities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.school_communities (
    id integer NOT NULL,
    school_id integer NOT NULL,
    community_id integer NOT NULL,
    committee_name text,
    year integer NOT NULL,
    source_name text NOT NULL,
    source_url text,
    source_quote text,
    source_date text NOT NULL,
    verified boolean DEFAULT false NOT NULL,
    notes text,
    release_batch_id bigint
);


--
-- Name: school_communities_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.school_communities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: school_communities_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.school_communities_id_seq OWNED BY public.school_communities.id;


--
-- Name: school_pathways; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.school_pathways (
    id bigint NOT NULL,
    primary_school_id bigint NOT NULL,
    middle_school_id bigint,
    admission_mode text NOT NULL,
    raw_text text NOT NULL,
    source_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT school_pathways_admission_mode_check CHECK ((admission_mode = ANY (ARRAY['assign'::text, 'placement'::text, 'direct'::text, 'partial'::text, 'unknown'::text])))
);


--
-- Name: school_pathways_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.school_pathways_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: school_pathways_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.school_pathways_id_seq OWNED BY public.school_pathways.id;


--
-- Name: schools; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schools (
    id integer NOT NULL,
    name text NOT NULL,
    district text NOT NULL,
    tier text,
    type public.school_type NOT NULL,
    school_nature public.school_nature,
    address text,
    lat double precision,
    lng double precision,
    enrollment_note text,
    recent_score_line text,
    pit_risk_level public.pit_risk_level DEFAULT 'unknown'::public.pit_risk_level,
    attrs jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    website text,
    student_count integer,
    school_scale text,
    faculty text,
    aliases text[] DEFAULT '{}'::text[],
    source_key text,
    source_name text,
    source_url text,
    source_year integer,
    source_tier integer,
    area text,
    street text,
    feeder_middle_school text,
    middle_school_tier integer,
    evaluation text,
    admission_mode text,
    class_count integer,
    tags jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: schools_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.schools_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: schools_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.schools_id_seq OWNED BY public.schools.id;


--
-- Name: web_data_source; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.web_data_source (
    id integer NOT NULL,
    school_id integer NOT NULL,
    source_type text NOT NULL,
    source_name text NOT NULL,
    source_url text,
    source_title text,
    source_date text,
    evidence text,
    confidence text DEFAULT 'high'::text NOT NULL,
    raw jsonb,
    fetched_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: web_data_source_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.web_data_source_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: web_data_source_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.web_data_source_id_seq OWNED BY public.web_data_source.id;


--
-- Name: communities id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.communities ALTER COLUMN id SET DEFAULT nextval('public.communities_id_seq'::regclass);


--
-- Name: community_price_snapshots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_price_snapshots ALTER COLUMN id SET DEFAULT nextval('public.community_price_snapshots_id_seq'::regclass);


--
-- Name: community_price_sources id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_price_sources ALTER COLUMN id SET DEFAULT nextval('public.community_price_sources_id_seq'::regclass);


--
-- Name: district_boundaries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.district_boundaries ALTER COLUMN id SET DEFAULT nextval('public.district_boundaries_id_seq'::regclass);


--
-- Name: districts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.districts ALTER COLUMN id SET DEFAULT nextval('public.districts_id_seq'::regclass);


--
-- Name: policy_documents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_documents ALTER COLUMN id SET DEFAULT nextval('public.policy_documents_id_seq'::regclass);


--
-- Name: school_communities id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_communities ALTER COLUMN id SET DEFAULT nextval('public.school_communities_id_seq'::regclass);


--
-- Name: school_pathways id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_pathways ALTER COLUMN id SET DEFAULT nextval('public.school_pathways_id_seq'::regclass);


--
-- Name: schools id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schools ALTER COLUMN id SET DEFAULT nextval('public.schools_id_seq'::regclass);


--
-- Name: web_data_source id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_data_source ALTER COLUMN id SET DEFAULT nextval('public.web_data_source_id_seq'::regclass);


--
-- Name: communities communities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.communities
    ADD CONSTRAINT communities_pkey PRIMARY KEY (id);


--
-- Name: community_price_snapshots community_price_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_price_snapshots
    ADD CONSTRAINT community_price_snapshots_pkey PRIMARY KEY (id);


--
-- Name: community_price_snapshots community_price_snapshots_uniq_idx; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_price_snapshots
    ADD CONSTRAINT community_price_snapshots_uniq_idx UNIQUE (community_id, source_name, source_period);


--
-- Name: community_price_sources community_price_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_price_sources
    ADD CONSTRAINT community_price_sources_pkey PRIMARY KEY (id);


--
-- Name: district_boundaries district_boundaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.district_boundaries
    ADD CONSTRAINT district_boundaries_pkey PRIMARY KEY (id);


--
-- Name: districts districts_canonical_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.districts
    ADD CONSTRAINT districts_canonical_name_key UNIQUE (canonical_name);


--
-- Name: districts districts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.districts
    ADD CONSTRAINT districts_pkey PRIMARY KEY (id);


--
-- Name: policy_documents policy_documents_legacy_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_documents
    ADD CONSTRAINT policy_documents_legacy_id_key UNIQUE (legacy_id);


--
-- Name: policy_documents policy_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_documents
    ADD CONSTRAINT policy_documents_pkey PRIMARY KEY (id);


--
-- Name: school_communities school_communities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_communities
    ADD CONSTRAINT school_communities_pkey PRIMARY KEY (id);


--
-- Name: school_pathways school_pathways_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_pathways
    ADD CONSTRAINT school_pathways_pkey PRIMARY KEY (id);


--
-- Name: school_pathways school_pathways_primary_school_id_middle_school_id_admissio_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_pathways
    ADD CONSTRAINT school_pathways_primary_school_id_middle_school_id_admissio_key UNIQUE (primary_school_id, middle_school_id, admission_mode);


--
-- Name: schools schools_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schools
    ADD CONSTRAINT schools_pkey PRIMARY KEY (id);


--
-- Name: web_data_source web_data_source_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_data_source
    ADD CONSTRAINT web_data_source_pkey PRIMARY KEY (id);


--
-- Name: communities_name_district_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX communities_name_district_idx ON public.communities USING btree (name, district);


--
-- Name: policy_documents_public_school_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX policy_documents_public_school_idx ON public.policy_documents USING btree (public_school_id);


--
-- Name: school_communities_uniq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX school_communities_uniq_idx ON public.school_communities USING btree (school_id, community_id, year);


--
-- Name: schools_aliases_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX schools_aliases_gin_idx ON public.schools USING gin (aliases);


--
-- Name: schools_district_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX schools_district_type_idx ON public.schools USING btree (district, type);


--
-- Name: schools_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX schools_name_idx ON public.schools USING btree (name);


--
-- Name: schools_source_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX schools_source_key_idx ON public.schools USING btree (source_key) WHERE (source_key IS NOT NULL);


--
-- Name: uq_school_communities_pair; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_school_communities_pair ON public.school_communities USING btree (school_id, community_id);


--
-- Name: web_data_source_school_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX web_data_source_school_id_idx ON public.web_data_source USING btree (school_id);


--
-- Name: web_data_source_school_url_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX web_data_source_school_url_type_idx ON public.web_data_source USING btree (school_id, source_url, source_type);


--
-- Name: web_data_source_url_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX web_data_source_url_idx ON public.web_data_source USING btree (source_url);


--
-- Name: community_price_snapshots community_price_snapshots_community_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_price_snapshots
    ADD CONSTRAINT community_price_snapshots_community_id_fkey FOREIGN KEY (community_id) REFERENCES public.communities(id);


--
-- Name: community_price_sources community_price_sources_community_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_price_sources
    ADD CONSTRAINT community_price_sources_community_id_fkey FOREIGN KEY (community_id) REFERENCES public.communities(id);


--
-- Name: district_boundaries district_boundaries_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.district_boundaries
    ADD CONSTRAINT district_boundaries_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id);


--
-- Name: policy_documents policy_documents_district_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_documents
    ADD CONSTRAINT policy_documents_district_id_fkey FOREIGN KEY (district_id) REFERENCES public.districts(id);


--
-- Name: policy_documents policy_documents_public_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_documents
    ADD CONSTRAINT policy_documents_public_school_id_fkey FOREIGN KEY (public_school_id) REFERENCES public.schools(id);


--
-- Name: policy_documents policy_documents_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_documents
    ADD CONSTRAINT policy_documents_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id);


--
-- Name: school_communities school_communities_community_id_communities_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_communities
    ADD CONSTRAINT school_communities_community_id_communities_id_fk FOREIGN KEY (community_id) REFERENCES public.communities(id);


--
-- Name: school_communities school_communities_school_id_schools_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_communities
    ADD CONSTRAINT school_communities_school_id_schools_id_fk FOREIGN KEY (school_id) REFERENCES public.schools(id);


--
-- Name: school_pathways school_pathways_middle_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_pathways
    ADD CONSTRAINT school_pathways_middle_school_id_fkey FOREIGN KEY (middle_school_id) REFERENCES public.schools(id);


--
-- Name: school_pathways school_pathways_primary_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_pathways
    ADD CONSTRAINT school_pathways_primary_school_id_fkey FOREIGN KEY (primary_school_id) REFERENCES public.schools(id);


--
-- Name: web_data_source web_data_source_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_data_source
    ADD CONSTRAINT web_data_source_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id);


--
-- PostgreSQL database dump complete
--


