--
-- PostgreSQL database dump
--

\restrict oY4jSN51HNQCDjkQzGdQjTWIJgGYO0O5l2getTRIEDARgqkuG255LfMIjS9CvYr

-- Dumped from database version 16.14
-- Dumped by pg_dump version 16.14

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
-- Name: drizzle; Type: SCHEMA; Schema: -; Owner: house
--

CREATE SCHEMA drizzle;


ALTER SCHEMA drizzle OWNER TO house;

--
-- Name: pit_risk_level; Type: TYPE; Schema: public; Owner: house
--

CREATE TYPE public.pit_risk_level AS ENUM (
    'low',
    'medium',
    'high',
    'unknown'
);


ALTER TYPE public.pit_risk_level OWNER TO house;

--
-- Name: policy_scope; Type: TYPE; Schema: public; Owner: house
--

CREATE TYPE public.policy_scope AS ENUM (
    'city',
    'district',
    'school'
);


ALTER TYPE public.policy_scope OWNER TO house;

--
-- Name: school_nature; Type: TYPE; Schema: public; Owner: house
--

CREATE TYPE public.school_nature AS ENUM (
    '公立',
    '私立'
);


ALTER TYPE public.school_nature OWNER TO house;

--
-- Name: school_type; Type: TYPE; Schema: public; Owner: house
--

CREATE TYPE public.school_type AS ENUM (
    'primary',
    'middle',
    'nine_year'
);


ALTER TYPE public.school_type OWNER TO house;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: __drizzle_migrations; Type: TABLE; Schema: drizzle; Owner: house
--

CREATE TABLE drizzle.__drizzle_migrations (
    id integer NOT NULL,
    hash text NOT NULL,
    created_at bigint
);


ALTER TABLE drizzle.__drizzle_migrations OWNER TO house;

--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE; Schema: drizzle; Owner: house
--

CREATE SEQUENCE drizzle.__drizzle_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNER TO house;

--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: drizzle; Owner: house
--

ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNED BY drizzle.__drizzle_migrations.id;


--
-- Name: communities; Type: TABLE; Schema: public; Owner: house
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
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.communities OWNER TO house;

--
-- Name: communities_id_seq; Type: SEQUENCE; Schema: public; Owner: house
--

CREATE SEQUENCE public.communities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.communities_id_seq OWNER TO house;

--
-- Name: communities_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: house
--

ALTER SEQUENCE public.communities_id_seq OWNED BY public.communities.id;


--
-- Name: community_price_snapshots; Type: TABLE; Schema: public; Owner: house
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


ALTER TABLE public.community_price_snapshots OWNER TO house;

--
-- Name: community_price_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: house
--

CREATE SEQUENCE public.community_price_snapshots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.community_price_snapshots_id_seq OWNER TO house;

--
-- Name: community_price_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: house
--

ALTER SEQUENCE public.community_price_snapshots_id_seq OWNED BY public.community_price_snapshots.id;


--
-- Name: community_price_sources; Type: TABLE; Schema: public; Owner: house
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
    raw jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.community_price_sources OWNER TO house;

--
-- Name: community_price_sources_id_seq; Type: SEQUENCE; Schema: public; Owner: house
--

CREATE SEQUENCE public.community_price_sources_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.community_price_sources_id_seq OWNER TO house;

--
-- Name: community_price_sources_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: house
--

ALTER SEQUENCE public.community_price_sources_id_seq OWNED BY public.community_price_sources.id;


--
-- Name: district_boundaries; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.district_boundaries (
    id integer NOT NULL,
    school_id integer NOT NULL,
    year integer NOT NULL,
    geojson jsonb NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.district_boundaries OWNER TO house;

--
-- Name: district_boundaries_duplicate_names_backup_20260617_063954; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.district_boundaries_duplicate_names_backup_20260617_063954 (
    id integer,
    school_id integer,
    year integer,
    geojson jsonb,
    notes text,
    created_at timestamp with time zone
);


ALTER TABLE public.district_boundaries_duplicate_names_backup_20260617_063954 OWNER TO house;

--
-- Name: district_boundaries_id_seq; Type: SEQUENCE; Schema: public; Owner: house
--

CREATE SEQUENCE public.district_boundaries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.district_boundaries_id_seq OWNER TO house;

--
-- Name: district_boundaries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: house
--

ALTER SEQUENCE public.district_boundaries_id_seq OWNED BY public.district_boundaries.id;


--
-- Name: district_boundaries_short_names_backup_20260617_065804; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.district_boundaries_short_names_backup_20260617_065804 (
    id integer,
    school_id integer,
    year integer,
    geojson jsonb,
    notes text,
    created_at timestamp with time zone
);


ALTER TABLE public.district_boundaries_short_names_backup_20260617_065804 OWNER TO house;

--
-- Name: district_boundaries_short_names_round2_backup_20260617_070445; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.district_boundaries_short_names_round2_backup_20260617_070445 (
    id integer,
    school_id integer,
    year integer,
    geojson jsonb,
    notes text,
    created_at timestamp with time zone
);


ALTER TABLE public.district_boundaries_short_names_round2_backup_20260617_070445 OWNER TO house;

--
-- Name: district_boundaries_short_names_round2_backup_20260617_071226; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.district_boundaries_short_names_round2_backup_20260617_071226 (
    id integer,
    school_id integer,
    year integer,
    geojson jsonb,
    notes text,
    created_at timestamp with time zone
);


ALTER TABLE public.district_boundaries_short_names_round2_backup_20260617_071226 OWNER TO house;

--
-- Name: district_boundaries_short_names_round2_backup_20260617_071416; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.district_boundaries_short_names_round2_backup_20260617_071416 (
    id integer,
    school_id integer,
    year integer,
    geojson jsonb,
    notes text,
    created_at timestamp with time zone
);


ALTER TABLE public.district_boundaries_short_names_round2_backup_20260617_071416 OWNER TO house;

--
-- Name: district_boundaries_short_names_round2_backup_20260617_071900; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.district_boundaries_short_names_round2_backup_20260617_071900 (
    id integer,
    school_id integer,
    year integer,
    geojson jsonb,
    notes text,
    created_at timestamp with time zone
);


ALTER TABLE public.district_boundaries_short_names_round2_backup_20260617_071900 OWNER TO house;

--
-- Name: district_boundaries_short_names_round3_backup_20260618_073754; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.district_boundaries_short_names_round3_backup_20260618_073754 (
    id integer,
    school_id integer,
    year integer,
    geojson jsonb,
    notes text,
    created_at timestamp with time zone
);


ALTER TABLE public.district_boundaries_short_names_round3_backup_20260618_073754 OWNER TO house;

--
-- Name: district_boundaries_short_names_round4_backup_20260618_075009; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.district_boundaries_short_names_round4_backup_20260618_075009 (
    id integer,
    school_id integer,
    year integer,
    geojson jsonb,
    notes text,
    created_at timestamp with time zone
);


ALTER TABLE public.district_boundaries_short_names_round4_backup_20260618_075009 OWNER TO house;

--
-- Name: policies; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.policies (
    id integer NOT NULL,
    school_id integer,
    scope public.policy_scope NOT NULL,
    district text,
    year integer NOT NULL,
    title text NOT NULL,
    source_url text,
    content text NOT NULL,
    change_summary text,
    fetched_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.policies OWNER TO house;

--
-- Name: policies_duplicate_names_backup_20260617_063954; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.policies_duplicate_names_backup_20260617_063954 (
    id integer,
    school_id integer,
    scope public.policy_scope,
    district text,
    year integer,
    title text,
    source_url text,
    content text,
    change_summary text,
    fetched_at timestamp with time zone
);


ALTER TABLE public.policies_duplicate_names_backup_20260617_063954 OWNER TO house;

--
-- Name: policies_id_seq; Type: SEQUENCE; Schema: public; Owner: house
--

CREATE SEQUENCE public.policies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.policies_id_seq OWNER TO house;

--
-- Name: policies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: house
--

ALTER SEQUENCE public.policies_id_seq OWNED BY public.policies.id;


--
-- Name: policies_short_names_backup_20260617_065804; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.policies_short_names_backup_20260617_065804 (
    id integer,
    school_id integer,
    scope public.policy_scope,
    district text,
    year integer,
    title text,
    source_url text,
    content text,
    change_summary text,
    fetched_at timestamp with time zone
);


ALTER TABLE public.policies_short_names_backup_20260617_065804 OWNER TO house;

--
-- Name: policies_short_names_round2_backup_20260617_070445; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.policies_short_names_round2_backup_20260617_070445 (
    id integer,
    school_id integer,
    scope public.policy_scope,
    district text,
    year integer,
    title text,
    source_url text,
    content text,
    change_summary text,
    fetched_at timestamp with time zone
);


ALTER TABLE public.policies_short_names_round2_backup_20260617_070445 OWNER TO house;

--
-- Name: policies_short_names_round2_backup_20260617_071226; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.policies_short_names_round2_backup_20260617_071226 (
    id integer,
    school_id integer,
    scope public.policy_scope,
    district text,
    year integer,
    title text,
    source_url text,
    content text,
    change_summary text,
    fetched_at timestamp with time zone
);


ALTER TABLE public.policies_short_names_round2_backup_20260617_071226 OWNER TO house;

--
-- Name: policies_short_names_round2_backup_20260617_071416; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.policies_short_names_round2_backup_20260617_071416 (
    id integer,
    school_id integer,
    scope public.policy_scope,
    district text,
    year integer,
    title text,
    source_url text,
    content text,
    change_summary text,
    fetched_at timestamp with time zone
);


ALTER TABLE public.policies_short_names_round2_backup_20260617_071416 OWNER TO house;

--
-- Name: policies_short_names_round2_backup_20260617_071900; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.policies_short_names_round2_backup_20260617_071900 (
    id integer,
    school_id integer,
    scope public.policy_scope,
    district text,
    year integer,
    title text,
    source_url text,
    content text,
    change_summary text,
    fetched_at timestamp with time zone
);


ALTER TABLE public.policies_short_names_round2_backup_20260617_071900 OWNER TO house;

--
-- Name: policies_short_names_round3_backup_20260618_073754; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.policies_short_names_round3_backup_20260618_073754 (
    id integer,
    school_id integer,
    scope public.policy_scope,
    district text,
    year integer,
    title text,
    source_url text,
    content text,
    change_summary text,
    fetched_at timestamp with time zone
);


ALTER TABLE public.policies_short_names_round3_backup_20260618_073754 OWNER TO house;

--
-- Name: policies_short_names_round4_backup_20260618_075009; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.policies_short_names_round4_backup_20260618_075009 (
    id integer,
    school_id integer,
    scope public.policy_scope,
    district text,
    year integer,
    title text,
    source_url text,
    content text,
    change_summary text,
    fetched_at timestamp with time zone
);


ALTER TABLE public.policies_short_names_round4_backup_20260618_075009 OWNER TO house;

--
-- Name: school_communities; Type: TABLE; Schema: public; Owner: house
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
    notes text
);


ALTER TABLE public.school_communities OWNER TO house;

--
-- Name: school_communities_duplicate_names_backup_20260617_063954; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.school_communities_duplicate_names_backup_20260617_063954 (
    id integer,
    school_id integer,
    community_id integer,
    committee_name text,
    year integer,
    source_name text,
    source_url text,
    source_quote text,
    source_date text,
    verified boolean,
    notes text
);


ALTER TABLE public.school_communities_duplicate_names_backup_20260617_063954 OWNER TO house;

--
-- Name: school_communities_id_seq; Type: SEQUENCE; Schema: public; Owner: house
--

CREATE SEQUENCE public.school_communities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.school_communities_id_seq OWNER TO house;

--
-- Name: school_communities_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: house
--

ALTER SEQUENCE public.school_communities_id_seq OWNED BY public.school_communities.id;


--
-- Name: school_communities_short_names_backup_20260617_065804; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.school_communities_short_names_backup_20260617_065804 (
    id integer,
    school_id integer,
    community_id integer,
    committee_name text,
    year integer,
    source_name text,
    source_url text,
    source_quote text,
    source_date text,
    verified boolean,
    notes text
);


ALTER TABLE public.school_communities_short_names_backup_20260617_065804 OWNER TO house;

--
-- Name: school_communities_short_names_round2_backup_20260617_070445; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.school_communities_short_names_round2_backup_20260617_070445 (
    id integer,
    school_id integer,
    community_id integer,
    committee_name text,
    year integer,
    source_name text,
    source_url text,
    source_quote text,
    source_date text,
    verified boolean,
    notes text
);


ALTER TABLE public.school_communities_short_names_round2_backup_20260617_070445 OWNER TO house;

--
-- Name: school_communities_short_names_round2_backup_20260617_071226; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.school_communities_short_names_round2_backup_20260617_071226 (
    id integer,
    school_id integer,
    community_id integer,
    committee_name text,
    year integer,
    source_name text,
    source_url text,
    source_quote text,
    source_date text,
    verified boolean,
    notes text
);


ALTER TABLE public.school_communities_short_names_round2_backup_20260617_071226 OWNER TO house;

--
-- Name: school_communities_short_names_round2_backup_20260617_071416; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.school_communities_short_names_round2_backup_20260617_071416 (
    id integer,
    school_id integer,
    community_id integer,
    committee_name text,
    year integer,
    source_name text,
    source_url text,
    source_quote text,
    source_date text,
    verified boolean,
    notes text
);


ALTER TABLE public.school_communities_short_names_round2_backup_20260617_071416 OWNER TO house;

--
-- Name: school_communities_short_names_round2_backup_20260617_071900; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.school_communities_short_names_round2_backup_20260617_071900 (
    id integer,
    school_id integer,
    community_id integer,
    committee_name text,
    year integer,
    source_name text,
    source_url text,
    source_quote text,
    source_date text,
    verified boolean,
    notes text
);


ALTER TABLE public.school_communities_short_names_round2_backup_20260617_071900 OWNER TO house;

--
-- Name: school_communities_short_names_round3_backup_20260618_073754; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.school_communities_short_names_round3_backup_20260618_073754 (
    id integer,
    school_id integer,
    community_id integer,
    committee_name text,
    year integer,
    source_name text,
    source_url text,
    source_quote text,
    source_date text,
    verified boolean,
    notes text
);


ALTER TABLE public.school_communities_short_names_round3_backup_20260618_073754 OWNER TO house;

--
-- Name: school_communities_short_names_round4_backup_20260618_075009; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.school_communities_short_names_round4_backup_20260618_075009 (
    id integer,
    school_id integer,
    community_id integer,
    committee_name text,
    year integer,
    source_name text,
    source_url text,
    source_quote text,
    source_date text,
    verified boolean,
    notes text
);


ALTER TABLE public.school_communities_short_names_round4_backup_20260618_075009 OWNER TO house;

--
-- Name: school_community_candidates; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.school_community_candidates (
    id integer NOT NULL,
    school_id integer,
    school_name_raw text NOT NULL,
    district text NOT NULL,
    year integer NOT NULL,
    community_id integer,
    community_name_raw text NOT NULL,
    committee_name_raw text,
    source_url text,
    source_title text NOT NULL,
    source_date text,
    source_quote text NOT NULL,
    confidence text DEFAULT 'medium'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    review_notes text,
    raw jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.school_community_candidates OWNER TO house;

--
-- Name: school_community_candidates_id_seq; Type: SEQUENCE; Schema: public; Owner: house
--

CREATE SEQUENCE public.school_community_candidates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.school_community_candidates_id_seq OWNER TO house;

--
-- Name: school_community_candidates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: house
--

ALTER SEQUENCE public.school_community_candidates_id_seq OWNED BY public.school_community_candidates.id;


--
-- Name: school_info; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.school_info (
    id integer NOT NULL,
    school_id integer NOT NULL,
    category text NOT NULL,
    title text,
    content text,
    year integer,
    source_name text NOT NULL,
    source_url text,
    source_date text,
    verified boolean DEFAULT false NOT NULL,
    raw jsonb,
    fetched_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.school_info OWNER TO house;

--
-- Name: school_info_duplicate_names_backup_20260617_063954; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.school_info_duplicate_names_backup_20260617_063954 (
    id integer,
    school_id integer,
    category text,
    title text,
    content text,
    year integer,
    source_name text,
    source_url text,
    source_date text,
    verified boolean,
    raw jsonb,
    fetched_at timestamp with time zone,
    created_at timestamp with time zone
);


ALTER TABLE public.school_info_duplicate_names_backup_20260617_063954 OWNER TO house;

--
-- Name: school_info_id_seq; Type: SEQUENCE; Schema: public; Owner: house
--

CREATE SEQUENCE public.school_info_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.school_info_id_seq OWNER TO house;

--
-- Name: school_info_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: house
--

ALTER SEQUENCE public.school_info_id_seq OWNED BY public.school_info.id;


--
-- Name: school_info_short_names_backup_20260617_065804; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.school_info_short_names_backup_20260617_065804 (
    id integer,
    school_id integer,
    category text,
    title text,
    content text,
    year integer,
    source_name text,
    source_url text,
    source_date text,
    verified boolean,
    raw jsonb,
    fetched_at timestamp with time zone,
    created_at timestamp with time zone
);


ALTER TABLE public.school_info_short_names_backup_20260617_065804 OWNER TO house;

--
-- Name: school_info_short_names_round2_backup_20260617_070445; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.school_info_short_names_round2_backup_20260617_070445 (
    id integer,
    school_id integer,
    category text,
    title text,
    content text,
    year integer,
    source_name text,
    source_url text,
    source_date text,
    verified boolean,
    raw jsonb,
    fetched_at timestamp with time zone,
    created_at timestamp with time zone
);


ALTER TABLE public.school_info_short_names_round2_backup_20260617_070445 OWNER TO house;

--
-- Name: school_info_short_names_round2_backup_20260617_071226; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.school_info_short_names_round2_backup_20260617_071226 (
    id integer,
    school_id integer,
    category text,
    title text,
    content text,
    year integer,
    source_name text,
    source_url text,
    source_date text,
    verified boolean,
    raw jsonb,
    fetched_at timestamp with time zone,
    created_at timestamp with time zone
);


ALTER TABLE public.school_info_short_names_round2_backup_20260617_071226 OWNER TO house;

--
-- Name: school_info_short_names_round2_backup_20260617_071416; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.school_info_short_names_round2_backup_20260617_071416 (
    id integer,
    school_id integer,
    category text,
    title text,
    content text,
    year integer,
    source_name text,
    source_url text,
    source_date text,
    verified boolean,
    raw jsonb,
    fetched_at timestamp with time zone,
    created_at timestamp with time zone
);


ALTER TABLE public.school_info_short_names_round2_backup_20260617_071416 OWNER TO house;

--
-- Name: school_info_short_names_round2_backup_20260617_071900; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.school_info_short_names_round2_backup_20260617_071900 (
    id integer,
    school_id integer,
    category text,
    title text,
    content text,
    year integer,
    source_name text,
    source_url text,
    source_date text,
    verified boolean,
    raw jsonb,
    fetched_at timestamp with time zone,
    created_at timestamp with time zone
);


ALTER TABLE public.school_info_short_names_round2_backup_20260617_071900 OWNER TO house;

--
-- Name: school_info_short_names_round3_backup_20260618_073754; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.school_info_short_names_round3_backup_20260618_073754 (
    id integer,
    school_id integer,
    category text,
    title text,
    content text,
    year integer,
    source_name text,
    source_url text,
    source_date text,
    verified boolean,
    raw jsonb,
    fetched_at timestamp with time zone,
    created_at timestamp with time zone
);


ALTER TABLE public.school_info_short_names_round3_backup_20260618_073754 OWNER TO house;

--
-- Name: school_info_short_names_round4_backup_20260618_075009; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.school_info_short_names_round4_backup_20260618_075009 (
    id integer,
    school_id integer,
    category text,
    title text,
    content text,
    year integer,
    source_name text,
    source_url text,
    source_date text,
    verified boolean,
    raw jsonb,
    fetched_at timestamp with time zone,
    created_at timestamp with time zone
);


ALTER TABLE public.school_info_short_names_round4_backup_20260618_075009 OWNER TO house;

--
-- Name: schools; Type: TABLE; Schema: public; Owner: house
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
    aliases text[] DEFAULT '{}'::text[]
);


ALTER TABLE public.schools OWNER TO house;

--
-- Name: schools_address_backup_20260617_040820; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.schools_address_backup_20260617_040820 (
    id integer,
    name text,
    district text,
    tier text,
    type public.school_type,
    school_nature public.school_nature,
    address text,
    lat double precision,
    lng double precision,
    enrollment_note text,
    recent_score_line text,
    pit_risk_level public.pit_risk_level,
    attrs jsonb,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    website text,
    student_count integer,
    school_scale text,
    faculty text
);


ALTER TABLE public.schools_address_backup_20260617_040820 OWNER TO house;

--
-- Name: schools_address_baidu_backup_20260617_051352; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.schools_address_baidu_backup_20260617_051352 (
    id integer,
    name text,
    district text,
    tier text,
    type public.school_type,
    school_nature public.school_nature,
    address text,
    lat double precision,
    lng double precision,
    enrollment_note text,
    recent_score_line text,
    pit_risk_level public.pit_risk_level,
    attrs jsonb,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    website text,
    student_count integer,
    school_scale text,
    faculty text
);


ALTER TABLE public.schools_address_baidu_backup_20260617_051352 OWNER TO house;

--
-- Name: schools_cleanup_backup_20260617_063036; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.schools_cleanup_backup_20260617_063036 (
    id integer,
    name text,
    district text,
    tier text,
    type public.school_type,
    school_nature public.school_nature,
    address text,
    lat double precision,
    lng double precision,
    enrollment_note text,
    recent_score_line text,
    pit_risk_level public.pit_risk_level,
    attrs jsonb,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    website text,
    student_count integer,
    school_scale text,
    faculty text,
    aliases text[]
);


ALTER TABLE public.schools_cleanup_backup_20260617_063036 OWNER TO house;

--
-- Name: schools_duplicate_names_backup_20260617_063954; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.schools_duplicate_names_backup_20260617_063954 (
    id integer,
    name text,
    district text,
    tier text,
    type public.school_type,
    school_nature public.school_nature,
    address text,
    lat double precision,
    lng double precision,
    enrollment_note text,
    recent_score_line text,
    pit_risk_level public.pit_risk_level,
    attrs jsonb,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    website text,
    student_count integer,
    school_scale text,
    faculty text,
    aliases text[]
);


ALTER TABLE public.schools_duplicate_names_backup_20260617_063954 OWNER TO house;

--
-- Name: schools_id_seq; Type: SEQUENCE; Schema: public; Owner: house
--

CREATE SEQUENCE public.schools_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.schools_id_seq OWNER TO house;

--
-- Name: schools_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: house
--

ALTER SEQUENCE public.schools_id_seq OWNED BY public.schools.id;


--
-- Name: schools_name_backup_20260617_035840; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.schools_name_backup_20260617_035840 (
    id integer,
    name text,
    district text,
    type public.school_type,
    attrs jsonb,
    updated_at timestamp with time zone
);


ALTER TABLE public.schools_name_backup_20260617_035840 OWNER TO house;

--
-- Name: schools_short_names_backup_20260617_065804; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.schools_short_names_backup_20260617_065804 (
    id integer,
    name text,
    district text,
    tier text,
    type public.school_type,
    school_nature public.school_nature,
    address text,
    lat double precision,
    lng double precision,
    enrollment_note text,
    recent_score_line text,
    pit_risk_level public.pit_risk_level,
    attrs jsonb,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    website text,
    student_count integer,
    school_scale text,
    faculty text,
    aliases text[]
);


ALTER TABLE public.schools_short_names_backup_20260617_065804 OWNER TO house;

--
-- Name: schools_short_names_round2_backup_20260617_070445; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.schools_short_names_round2_backup_20260617_070445 (
    id integer,
    name text,
    district text,
    tier text,
    type public.school_type,
    school_nature public.school_nature,
    address text,
    lat double precision,
    lng double precision,
    enrollment_note text,
    recent_score_line text,
    pit_risk_level public.pit_risk_level,
    attrs jsonb,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    website text,
    student_count integer,
    school_scale text,
    faculty text,
    aliases text[]
);


ALTER TABLE public.schools_short_names_round2_backup_20260617_070445 OWNER TO house;

--
-- Name: schools_short_names_round2_backup_20260617_071226; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.schools_short_names_round2_backup_20260617_071226 (
    id integer,
    name text,
    district text,
    tier text,
    type public.school_type,
    school_nature public.school_nature,
    address text,
    lat double precision,
    lng double precision,
    enrollment_note text,
    recent_score_line text,
    pit_risk_level public.pit_risk_level,
    attrs jsonb,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    website text,
    student_count integer,
    school_scale text,
    faculty text,
    aliases text[]
);


ALTER TABLE public.schools_short_names_round2_backup_20260617_071226 OWNER TO house;

--
-- Name: schools_short_names_round2_backup_20260617_071416; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.schools_short_names_round2_backup_20260617_071416 (
    id integer,
    name text,
    district text,
    tier text,
    type public.school_type,
    school_nature public.school_nature,
    address text,
    lat double precision,
    lng double precision,
    enrollment_note text,
    recent_score_line text,
    pit_risk_level public.pit_risk_level,
    attrs jsonb,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    website text,
    student_count integer,
    school_scale text,
    faculty text,
    aliases text[]
);


ALTER TABLE public.schools_short_names_round2_backup_20260617_071416 OWNER TO house;

--
-- Name: schools_short_names_round2_backup_20260617_071900; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.schools_short_names_round2_backup_20260617_071900 (
    id integer,
    name text,
    district text,
    tier text,
    type public.school_type,
    school_nature public.school_nature,
    address text,
    lat double precision,
    lng double precision,
    enrollment_note text,
    recent_score_line text,
    pit_risk_level public.pit_risk_level,
    attrs jsonb,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    website text,
    student_count integer,
    school_scale text,
    faculty text,
    aliases text[]
);


ALTER TABLE public.schools_short_names_round2_backup_20260617_071900 OWNER TO house;

--
-- Name: schools_short_names_round3_backup_20260618_073754; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.schools_short_names_round3_backup_20260618_073754 (
    id integer,
    name text,
    district text,
    tier text,
    type public.school_type,
    school_nature public.school_nature,
    address text,
    lat double precision,
    lng double precision,
    enrollment_note text,
    recent_score_line text,
    pit_risk_level public.pit_risk_level,
    attrs jsonb,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    website text,
    student_count integer,
    school_scale text,
    faculty text,
    aliases text[]
);


ALTER TABLE public.schools_short_names_round3_backup_20260618_073754 OWNER TO house;

--
-- Name: schools_short_names_round4_backup_20260618_075009; Type: TABLE; Schema: public; Owner: house
--

CREATE TABLE public.schools_short_names_round4_backup_20260618_075009 (
    id integer,
    name text,
    district text,
    tier text,
    type public.school_type,
    school_nature public.school_nature,
    address text,
    lat double precision,
    lng double precision,
    enrollment_note text,
    recent_score_line text,
    pit_risk_level public.pit_risk_level,
    attrs jsonb,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    website text,
    student_count integer,
    school_scale text,
    faculty text,
    aliases text[]
);


ALTER TABLE public.schools_short_names_round4_backup_20260618_075009 OWNER TO house;

--
-- Name: web_data_source; Type: TABLE; Schema: public; Owner: house
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


ALTER TABLE public.web_data_source OWNER TO house;

--
-- Name: web_data_source_id_seq; Type: SEQUENCE; Schema: public; Owner: house
--

CREATE SEQUENCE public.web_data_source_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.web_data_source_id_seq OWNER TO house;

--
-- Name: web_data_source_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: house
--

ALTER SEQUENCE public.web_data_source_id_seq OWNED BY public.web_data_source.id;


--
-- Name: __drizzle_migrations id; Type: DEFAULT; Schema: drizzle; Owner: house
--

ALTER TABLE ONLY drizzle.__drizzle_migrations ALTER COLUMN id SET DEFAULT nextval('drizzle.__drizzle_migrations_id_seq'::regclass);


--
-- Name: communities id; Type: DEFAULT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.communities ALTER COLUMN id SET DEFAULT nextval('public.communities_id_seq'::regclass);


--
-- Name: community_price_snapshots id; Type: DEFAULT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.community_price_snapshots ALTER COLUMN id SET DEFAULT nextval('public.community_price_snapshots_id_seq'::regclass);


--
-- Name: community_price_sources id; Type: DEFAULT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.community_price_sources ALTER COLUMN id SET DEFAULT nextval('public.community_price_sources_id_seq'::regclass);


--
-- Name: district_boundaries id; Type: DEFAULT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.district_boundaries ALTER COLUMN id SET DEFAULT nextval('public.district_boundaries_id_seq'::regclass);


--
-- Name: policies id; Type: DEFAULT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.policies ALTER COLUMN id SET DEFAULT nextval('public.policies_id_seq'::regclass);


--
-- Name: school_communities id; Type: DEFAULT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.school_communities ALTER COLUMN id SET DEFAULT nextval('public.school_communities_id_seq'::regclass);


--
-- Name: school_community_candidates id; Type: DEFAULT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.school_community_candidates ALTER COLUMN id SET DEFAULT nextval('public.school_community_candidates_id_seq'::regclass);


--
-- Name: school_info id; Type: DEFAULT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.school_info ALTER COLUMN id SET DEFAULT nextval('public.school_info_id_seq'::regclass);


--
-- Name: schools id; Type: DEFAULT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.schools ALTER COLUMN id SET DEFAULT nextval('public.schools_id_seq'::regclass);


--
-- Name: web_data_source id; Type: DEFAULT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.web_data_source ALTER COLUMN id SET DEFAULT nextval('public.web_data_source_id_seq'::regclass);


--
-- Name: __drizzle_migrations __drizzle_migrations_pkey; Type: CONSTRAINT; Schema: drizzle; Owner: house
--

ALTER TABLE ONLY drizzle.__drizzle_migrations
    ADD CONSTRAINT __drizzle_migrations_pkey PRIMARY KEY (id);


--
-- Name: communities communities_pkey; Type: CONSTRAINT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.communities
    ADD CONSTRAINT communities_pkey PRIMARY KEY (id);


--
-- Name: community_price_snapshots community_price_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.community_price_snapshots
    ADD CONSTRAINT community_price_snapshots_pkey PRIMARY KEY (id);


--
-- Name: community_price_sources community_price_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.community_price_sources
    ADD CONSTRAINT community_price_sources_pkey PRIMARY KEY (id);


--
-- Name: district_boundaries district_boundaries_pkey; Type: CONSTRAINT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.district_boundaries
    ADD CONSTRAINT district_boundaries_pkey PRIMARY KEY (id);


--
-- Name: policies policies_pkey; Type: CONSTRAINT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.policies
    ADD CONSTRAINT policies_pkey PRIMARY KEY (id);


--
-- Name: school_communities school_communities_pkey; Type: CONSTRAINT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.school_communities
    ADD CONSTRAINT school_communities_pkey PRIMARY KEY (id);


--
-- Name: school_community_candidates school_community_candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.school_community_candidates
    ADD CONSTRAINT school_community_candidates_pkey PRIMARY KEY (id);


--
-- Name: school_info school_info_pkey; Type: CONSTRAINT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.school_info
    ADD CONSTRAINT school_info_pkey PRIMARY KEY (id);


--
-- Name: schools schools_pkey; Type: CONSTRAINT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.schools
    ADD CONSTRAINT schools_pkey PRIMARY KEY (id);


--
-- Name: web_data_source web_data_source_pkey; Type: CONSTRAINT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.web_data_source
    ADD CONSTRAINT web_data_source_pkey PRIMARY KEY (id);


--
-- Name: communities_name_district_idx; Type: INDEX; Schema: public; Owner: house
--

CREATE UNIQUE INDEX communities_name_district_idx ON public.communities USING btree (name, district);


--
-- Name: community_price_snapshots_uniq_idx; Type: INDEX; Schema: public; Owner: house
--

CREATE UNIQUE INDEX community_price_snapshots_uniq_idx ON public.community_price_snapshots USING btree (community_id, source_name, source_period);


--
-- Name: community_price_sources_uniq_idx; Type: INDEX; Schema: public; Owner: house
--

CREATE UNIQUE INDEX community_price_sources_uniq_idx ON public.community_price_sources USING btree (community_id, source_name);


--
-- Name: school_communities_uniq_idx; Type: INDEX; Schema: public; Owner: house
--

CREATE UNIQUE INDEX school_communities_uniq_idx ON public.school_communities USING btree (school_id, community_id, year);


--
-- Name: school_community_candidates_school_id_idx; Type: INDEX; Schema: public; Owner: house
--

CREATE INDEX school_community_candidates_school_id_idx ON public.school_community_candidates USING btree (school_id);


--
-- Name: school_community_candidates_status_idx; Type: INDEX; Schema: public; Owner: house
--

CREATE INDEX school_community_candidates_status_idx ON public.school_community_candidates USING btree (status);


--
-- Name: school_community_candidates_uniq_idx; Type: INDEX; Schema: public; Owner: house
--

CREATE UNIQUE INDEX school_community_candidates_uniq_idx ON public.school_community_candidates USING btree (year, district, school_name_raw, community_name_raw, source_url);


--
-- Name: school_community_candidates_year_district_idx; Type: INDEX; Schema: public; Owner: house
--

CREATE INDEX school_community_candidates_year_district_idx ON public.school_community_candidates USING btree (year, district);


--
-- Name: school_info_school_id_idx; Type: INDEX; Schema: public; Owner: house
--

CREATE INDEX school_info_school_id_idx ON public.school_info USING btree (school_id);


--
-- Name: schools_aliases_gin_idx; Type: INDEX; Schema: public; Owner: house
--

CREATE INDEX schools_aliases_gin_idx ON public.schools USING gin (aliases);


--
-- Name: web_data_source_school_id_idx; Type: INDEX; Schema: public; Owner: house
--

CREATE INDEX web_data_source_school_id_idx ON public.web_data_source USING btree (school_id);


--
-- Name: web_data_source_school_url_type_idx; Type: INDEX; Schema: public; Owner: house
--

CREATE UNIQUE INDEX web_data_source_school_url_type_idx ON public.web_data_source USING btree (school_id, source_url, source_type);


--
-- Name: web_data_source_url_idx; Type: INDEX; Schema: public; Owner: house
--

CREATE INDEX web_data_source_url_idx ON public.web_data_source USING btree (source_url);


--
-- Name: community_price_snapshots community_price_snapshots_community_id_communities_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.community_price_snapshots
    ADD CONSTRAINT community_price_snapshots_community_id_communities_id_fk FOREIGN KEY (community_id) REFERENCES public.communities(id);


--
-- Name: community_price_sources community_price_sources_community_id_communities_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.community_price_sources
    ADD CONSTRAINT community_price_sources_community_id_communities_id_fk FOREIGN KEY (community_id) REFERENCES public.communities(id);


--
-- Name: district_boundaries district_boundaries_school_id_schools_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.district_boundaries
    ADD CONSTRAINT district_boundaries_school_id_schools_id_fk FOREIGN KEY (school_id) REFERENCES public.schools(id);


--
-- Name: policies policies_school_id_schools_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.policies
    ADD CONSTRAINT policies_school_id_schools_id_fk FOREIGN KEY (school_id) REFERENCES public.schools(id);


--
-- Name: school_communities school_communities_community_id_communities_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.school_communities
    ADD CONSTRAINT school_communities_community_id_communities_id_fk FOREIGN KEY (community_id) REFERENCES public.communities(id);


--
-- Name: school_communities school_communities_school_id_schools_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.school_communities
    ADD CONSTRAINT school_communities_school_id_schools_id_fk FOREIGN KEY (school_id) REFERENCES public.schools(id);


--
-- Name: school_community_candidates school_community_candidates_community_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.school_community_candidates
    ADD CONSTRAINT school_community_candidates_community_id_fkey FOREIGN KEY (community_id) REFERENCES public.communities(id);


--
-- Name: school_community_candidates school_community_candidates_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.school_community_candidates
    ADD CONSTRAINT school_community_candidates_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id);


--
-- Name: school_info school_info_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.school_info
    ADD CONSTRAINT school_info_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id);


--
-- Name: web_data_source web_data_source_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: house
--

ALTER TABLE ONLY public.web_data_source
    ADD CONSTRAINT web_data_source_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id);


--
-- PostgreSQL database dump complete
--

\unrestrict oY4jSN51HNQCDjkQzGdQjTWIJgGYO0O5l2getTRIEDARgqkuG255LfMIjS9CvYr

