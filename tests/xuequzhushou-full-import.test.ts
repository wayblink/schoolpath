import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildXuequzhushouImport,
  matchPublicSchool,
  reconcileRawRecords,
  importXuequzhushou,
  type ImportClient,
} from "../lib/ingest/xuequzhushou-import";

function fixture(title = "学校（2024年）") {
  return `<title>${title}</title><script>var ALL_DATA = ${JSON.stringify({
    黄浦区: { 区: "黄浦区", 入学制度: "原始制度", 说明: "说明", 街道: ["街道", "街道"],
      futureDistrict: { keep: true }, 小学: [
        { 名称: "同名", 对口居委: ["甲", "甲"], 对口初中: "中学", future: { nested: [1, false, null] } },
        { 名称: "同名", 对口居委: "乙", future: "second" },
      ], 初中: [{ 名称: "中学" }] },
    宝山区: { 区: "宝山区", 入学制度: "", 说明: "", 小学: [{ 名称: "范围外" }] },
  })};\nvar DISTRICTS=["黄浦区"];\nvar JUWOVERLAP={"黄浦区":{"同名":{"m":"中学","future":[1,2]}}};\nvar JUWOVERLAP_MS={"黄浦区":{"中学":[{"p":"同名"},{"p":"另一个"}]}};\nvar TLB={};</script>`;
}

test("full import preserves every occurrence, omitted districts, future fields and title year", () => {
  const plan = buildXuequzhushouImport(fixture());
  assert.equal(plan.sourceYear, 2024);
  assert.equal(plan.schools.length, 4);
  assert.equal(new Set(plan.schools.map(s => s.recordKey)).size, 4);
  assert.equal(new Set(plan.schools.map(s => s.catalogKey)).size, 4);
  assert.equal(plan.schools.find(s => s.school.名称 === "范围外")?.catalogKey, "宝山区:primary:范围外");
  assert.deepEqual(plan.schools[0].school.future, { nested: [1, false, null] });
  assert.equal(plan.records.filter(r => r.recordType === "street").length, 2);
  assert.equal(plan.relations.length, 3);
  assert.equal(plan.records.filter(r => r.recordType === "feeder_link").length, 1);
  assert.equal(plan.records.filter(r => r.recordType === "committee_overlap").length, 1);
  assert.equal(plan.records.filter(r => r.recordType === "middle_school_overlap").length, 1);
  assert.deepEqual(plan.records.find(r => r.recordType === "school")?.raw, plan.schools[0].school);
  const source = plan.records.find(r => r.recordType === "source_document")!;
  assert.equal((source.raw as { content: string }).content, fixture());
  assert.ok(plan.records.find(r => r.recordType === "parsed_payload"));
});

test("source year stays unknown when title evidence is absent or ambiguous", () => {
  assert.equal(buildXuequzhushouImport(fixture("学校信息")).sourceYear, null);
  assert.equal(buildXuequzhushouImport(fixture("2024年与2025年")).sourceYear, null);
});

test("real snapshot school occurrences match parser totals without district filtering", () => {
  const html = readFileSync(new URL("./fixtures/xuequzhushou-20260711.html", import.meta.url), "utf8");
  const plan = buildXuequzhushouImport(html);
  assert.equal(plan.schools.length, 455);
  assert.equal(plan.relations.length, 2764);
  assert.equal(plan.sourceYear, 2026);
});

test("canonical matching requires unique exact name or alias, same district and same stage", () => {
  const schools = [
    { id: 1, name: "正式名称", aliases: ["别名"], district: "黄浦", type: "primary" },
    { id: 2, name: "别名", aliases: [], district: "宝山", type: "primary" },
    { id: 3, name: "别名", aliases: [], district: "黄浦", type: "middle" },
  ];
  assert.equal(matchPublicSchool(schools, "黄浦区", "primary", "别名").id, 1);
  assert.equal(matchPublicSchool(schools, "黄浦区", "primary", "正式").id, null);
  const ambiguous = [...schools, { ...schools[0], id: 4 }];
  assert.equal(matchPublicSchool(ambiguous, "黄浦区", "primary", "别名").status, "conflict");
});

test("reconciliation detects missing, extra and altered raw JSON before commit", () => {
  const records = buildXuequzhushouImport(fixture()).records;
  reconcileRawRecords(records, structuredClone(records));
  assert.throws(() => reconcileRawRecords(records, records.slice(1)), /reconcil/i);
  assert.throws(() => reconcileRawRecords(records, [...records, records[0]]), /reconcil/i);
  const changed = structuredClone(records);
  changed[0].raw = {};
  assert.throws(() => reconcileRawRecords(records, changed), /reconcil/i);
});

test("failure after transaction begins rolls back and never commits", async () => {
  const statements: string[] = [];
  const client: ImportClient = { async query(sql) {
    statements.push(sql);
    if (sql.includes("public.schools")) throw new Error("simulated database failure");
    return { rows: [], rowCount: 0 };
  } };
  await assert.rejects(importXuequzhushou(client, buildXuequzhushouImport(fixture()), { apply: true }), /simulated/);
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.ok(!statements.includes("COMMIT"));
});

// This transaction double checks importer behavior, not PostgreSQL syntax.
// Real database publication is intentionally reserved for the main session.
function transactionDatabase() {
  type Row = Record<string, unknown>;
  let state: { run: boolean; raw: Row[]; schools: Row[]; relations: Row[] } = {
    run: false, raw: [], schools: [], relations: [],
  };
  let backup = structuredClone(state);
  let readOnly = false;
  const statements: string[] = [];
  let corruptReconciliation = false;
  let canonicalReads = 0;
  let corruptCanonical = false;
  const client: ImportClient = { async query(sql, values = []) {
    statements.push(sql);
    const rows = (data: Row[]) => ({ rows: structuredClone(data), rowCount: data.length });
    if (sql.startsWith("BEGIN")) { backup = structuredClone(state); readOnly = sql.includes("READ ONLY"); return rows([]); }
    if (sql === "ROLLBACK") { state = backup; return rows([]); }
    if (sql === "COMMIT") return rows([]);
    if (sql.startsWith("LOCK") || sql.includes("pg_advisory_xact_lock")) return rows([]);
    if (readOnly && /^(insert|update|delete) /i.test(sql)) throw new Error("read-only violation");
    if (sql.startsWith("select to_jsonb")) {
      canonicalReads++;
      return rows([{ document: corruptCanonical && canonicalReads > 1 ? "changed" : "unchanged canonical row" }]);
    }
    if (sql === "select id,name,district,type,aliases from public.schools") return rows([
      { id: 10, name: "同名", district: "黄浦", type: "primary", aliases: [] },
    ]);
    if (sql === "select * from catalog.source_schools") return rows(state.schools);
    if (sql.startsWith("select * from catalog.school_communities")) return rows(state.relations);
    if (sql.startsWith("select r.id from ingest.crawl_runs")) return rows(state.run ? [{ id: "1" }] : []);
    if (sql.startsWith("select record_type")) {
      const raw = state.raw.map(({ recordType, sourceKey, district, raw }) => ({ recordType, sourceKey, district, raw }));
      if (corruptReconciliation && raw.length) raw[0].raw = { corrupted: true };
      return rows(raw);
    }
    if (sql.startsWith("insert into ingest.sources")) return rows([]);
    if (sql.startsWith("insert into ingest.crawl_runs")) { state.run = true; return rows([{ id: "1" }]); }
    if (sql.startsWith("insert into ingest.extracted_records")) {
      for (const record of JSON.parse(String(values[1])) as Row[]) {
        if (!state.raw.some(r => r.sourceKey === record.sourceKey && r.recordType === record.recordType)) {
          state.raw.push({ id: String(state.raw.length + 1), ...record });
        }
      }
      return rows([]);
    }
    if (sql.startsWith("insert into catalog.source_schools")) {
      const columns = ["source_key", "source_name", "source_url", "source_year", "district", "school_name", "school_type",
        "tier", "area", "street", "feeder_middle_school", "middle_school_tier", "evaluation", "admission_mode",
        "class_count", "tags", "lng", "lat", "public_school_id", "attrs"];
      state.schools.push(Object.fromEntries(columns.map((column, i) => [column,
        column === "tags" || column === "attrs" ? JSON.parse(String(values[i])) : values[i]])));
      return rows([]);
    }
    if (sql.startsWith("update catalog.source_schools")) {
      const row = state.schools.find(row => row.source_key === values[0])!;
      row.attrs = JSON.parse(String(values[1]));
      return rows([]);
    }
    if (sql.startsWith("select id,source_key from ingest.extracted_records")) {
      return rows(state.raw.filter(row => row.recordType === "committee_link").map(row => ({ id: row.id, source_key: row.sourceKey })));
    }
    if (sql.startsWith("insert into catalog.school_communities")) {
      // SQL 里 review_status='pending'/verified=false 为字面量，values 仅 $1-$8 + $9(notes) 共 9 个
      const columns = ["source_record_id", "source_name", "source_url", "year", "district", "school_name_raw",
        "committee_name", "school_id", "notes"];
      state.relations.push({ id: String(state.relations.length + 1), verified: false, review_status: "pending", community_id: null,
        ...Object.fromEntries(columns.map((column, i) => [column, values[i]])) });
      return rows([]);
    }
    throw new Error(`Unexpected SQL in test: ${sql}`);
  } };
  return { client, statements, state: () => state,
    corruptRaw: () => { corruptReconciliation = true; },
    corruptCanonical: () => { corruptCanonical = true; },
  };
}

test("default dry-run issues no writes and leaves the database untouched", async () => {
  const db = transactionDatabase();
  const before = structuredClone(db.state());
  const report = await importXuequzhushou(db.client, buildXuequzhushouImport(fixture()));
  assert.equal(report.mode, "dry-run");
  assert.equal(report.schools.added, 4);
  assert.deepEqual(db.state(), before);
  assert.ok(!db.statements.some(sql => /^(insert|update|delete|lock) /i.test(sql)));
  assert.equal(db.statements.at(-1), "ROLLBACK");
});

test("apply in transaction double preserves duplicates, maps exact identities and is idempotent", async () => {
  const db = transactionDatabase();
  const plan = buildXuequzhushouImport(fixture());
  const first = await importXuequzhushou(db.client, plan, { apply: true });
  assert.equal(first.reconciled, true);
  assert.equal(first.schools.added, 4);
  assert.equal(first.relations.added, 2);
  assert.equal(first.relations.unchanged, 1);
  assert.equal(first.canonicalBefore, first.canonicalAfter);
  assert.equal(db.state().schools[0].public_school_id, 10);
  assert.equal(db.state().schools[1].public_school_id, 10);
  assert.equal(db.state().schools[2].public_school_id, null);
  assert.equal(db.state().relations[0].review_status, "pending");
  assert.equal(db.state().relations[0].verified, false);
  assert.equal(db.state().relations[0].community_id, null);
  const before = structuredClone(db.state());
  const second = await importXuequzhushou(db.client, plan, { apply: true });
  assert.equal(second.records.added, 0);
  assert.equal(second.schools.added, 0);
  assert.equal(second.schools.changed, 0);
  assert.equal(second.relations.added, 0);
  assert.equal(second.reconciled, true);
  assert.deepEqual(db.state(), before);
});

test("legacy accepted relations and source school mappings are never overwritten", async () => {
  const db = transactionDatabase();
  const plan = buildXuequzhushouImport(fixture());
  await importXuequzhushou(db.client, plan, { apply: true });
  const source = db.state().schools[0];
  source.public_school_id = 999;
  source.tier = 1;
  source.attrs = { reviewed: "accepted" };
  const relation = db.state().relations[0];
  relation.verified = true;
  relation.review_status = "accepted";
  relation.school_id = 998;
  relation.source_record_id = "legacy-123";
  relation.attrs = { manuallyAccepted: true };
  const accepted = structuredClone(relation);
  const result = await importXuequzhushou(db.client, plan, { apply: true });
  assert.equal(db.state().schools[0].public_school_id, 999);
  assert.equal(db.state().schools[0].tier, 1);
  assert.deepEqual((db.state().schools[0].attrs as Record<string, unknown>).rawSchool, plan.schools[0].school);
  assert.equal((db.state().schools[0].attrs as Record<string, unknown>).reviewed, "accepted");
  assert.deepEqual(db.state().relations[0], accepted);
  assert.ok(result.schools.conflict > 0);
  assert.ok(result.relations.conflict > 0);
  assert.equal(result.relations.added, 0);
});

test("late raw reconciliation failure rolls back every inserted row", async () => {
  const db = transactionDatabase();
  db.corruptRaw();
  const before = structuredClone(db.state());
  await assert.rejects(importXuequzhushou(db.client, buildXuequzhushouImport(fixture()), { apply: true }), /reconciliation/);
  assert.ok(db.statements.some(sql => sql.startsWith("insert into catalog.school_communities")));
  assert.deepEqual(db.state(), before);
  assert.equal(db.statements.at(-1), "ROLLBACK");
  assert.ok(!db.statements.includes("COMMIT"));
});

test("changed canonical digest aborts and rolls back publication", async () => {
  const db = transactionDatabase();
  db.corruptCanonical();
  const before = structuredClone(db.state());
  await assert.rejects(importXuequzhushou(db.client, buildXuequzhushouImport(fixture()), { apply: true }), /Canonical school digest changed/);
  assert.deepEqual(db.state(), before);
  assert.equal(db.statements.at(-1), "ROLLBACK");
});
