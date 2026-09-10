import assert from "node:assert/strict";import{readFileSync}from"node:fs";import test from"node:test";
const migration=readFileSync("db/redesign/004_create_source_schools.sql","utf8");
test("source schools preserve reference-site product fields without mandatory catalog links",()=>{for(const field of ["evaluation text","admission_mode text","tags jsonb","lng double precision","lat double precision","catalog_school_id bigint,"])assert.match(migration,new RegExp(field));assert.doesNotMatch(migration,/catalog_school_id bigint[^,]*REFERENCES/i)});
