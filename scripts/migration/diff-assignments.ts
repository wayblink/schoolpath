// Phase A3：catalog.school_community_assignments vs public.school_communities 差异报告。
// 输出 CSV + 控制台摘要。用法：npx tsx scripts/migration/diff-assignments.ts <outCsv>
import { writeFileSync } from "node:fs";
import pg from "pg";

async function main() {
  const outCsv = process.argv[2];
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const c = new pg.Client(url);
  await c.connect();

  // 交集：assignments 经 public_school_id 映射后与 school_communities 的 (school_id, community_id) 对
  const both = await c.query(`
    select a.id assignment_id, sc.id school_community_id, a.public_school_id school_id,
           a.community_id, a.year, a.committee_name, a.source_name, a.verified, sc.year sc_year,
           sc.verified sc_verified, sc.source_name sc_source_name
    from catalog.school_community_assignments a
    join public.school_communities sc
      on sc.school_id = a.public_school_id and sc.community_id = a.community_id
    order by a.id
  `);
  const onlyAssignments = await c.query(`
    select a.id assignment_id, a.public_school_id school_id, a.community_id, a.year,
           a.committee_name, a.source_name, a.source_url, a.verified, a.legacy_id
    from catalog.school_community_assignments a
    where not exists (
      select 1 from public.school_communities sc
      where sc.school_id = a.public_school_id and sc.community_id = a.community_id
    )
    order by a.id
  `);
  const onlySC = await c.query(`
    select sc.id school_community_id, sc.school_id, sc.community_id, sc.year,
           sc.committee_name, sc.source_name, sc.source_url, sc.verified, sc.notes
    from public.school_communities sc
    where not exists (
      select 1 from catalog.school_community_assignments a
      where a.public_school_id = sc.school_id and a.community_id = sc.community_id
    )
    order by sc.id
  `);

  // 交集行的字段差异（year / verified / committee_name / source_name 不一致）
  const conflicts = both.rows.filter(
    (r) =>
      r.year !== r.sc_year ||
      Boolean(r.verified) !== Boolean(r.sc_verified) ||
      r.committee_name !== r.sc_committee_name ||
      r.source_name !== r.sc_source_name,
  );

  const esc = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [
    "bucket,assignment_id,school_community_id,school_id,community_id,year,sc_year,committee_name,source_name,verified,sc_verified",
    ...both.rows.map((r) =>
      ["both", r.assignment_id, r.school_community_id, r.school_id, r.community_id, r.year, r.sc_year, r.committee_name, r.source_name, r.verified, r.sc_verified].map(esc).join(","),
    ),
    ...onlyAssignments.rows.map((r) =>
      ["only_assignments", r.assignment_id, "", r.school_id, r.community_id, r.year, "", r.committee_name, r.source_name, r.verified, ""].map(esc).join(","),
    ),
    ...onlySC.rows.map((r) =>
      ["only_school_communities", "", r.school_community_id, r.school_id, r.community_id, "", r.year, r.committee_name, r.source_name, "", r.verified].map(esc).join(","),
    ),
  ].join("\n");
  if (outCsv) writeFileSync(outCsv, csv);

  const bySource = await c.query(`
    select a.source_name, count(*) n
    from catalog.school_community_assignments a
    where not exists (
      select 1 from public.school_communities sc
      where sc.school_id = a.public_school_id and sc.community_id = a.community_id
    )
    group by 1 order by 2 desc
  `);
  const verifiedOnlyA = await c.query(`
    select count(*) filter (where a.verified) verified, count(*) total
    from catalog.school_community_assignments a
    where not exists (
      select 1 from public.school_communities sc
      where sc.school_id = a.public_school_id and sc.community_id = a.community_id
    )
  `);

  await c.end();
  console.log(
    JSON.stringify(
      {
        both: both.rowCount,
        onlyAssignments: onlyAssignments.rowCount,
        onlySchoolCommunities: onlySC.rowCount,
        fieldConflictsInBoth: conflicts.length,
        onlyAssignmentsBySource: bySource.rows,
        onlyAssignmentsVerified: verifiedOnlyA.rows[0],
        csv: outCsv,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
