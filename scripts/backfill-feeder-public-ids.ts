/**
 * Backfill the public.schools identity projection for existing feeder rows.
 *
 * This only copies an already-established catalog.schools.legacy_id mapping.
 * It does not change the source, review status, confidence, or relationship
 * semantics, so third-party feeder facts remain pending for human review.
 * Dry-run is the default; pass --apply to commit.
 */
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");

type Candidate = {
  id: number;
  fromCatalogId: number;
  toCatalogId: number;
  fromPublicId: number | null;
  toPublicId: number | null;
  fromLegacyId: number | null;
  toLegacyId: number | null;
  reviewStatus: string;
};

async function main() {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const candidates = (
      await client.query<Candidate>(`
        SELECT
          f.id,
          f.from_school_id AS "fromCatalogId",
          f.to_school_id AS "toCatalogId",
          f.from_public_school_id AS "fromPublicId",
          f.to_public_school_id AS "toPublicId",
          source.legacy_id AS "fromLegacyId",
          target.legacy_id AS "toLegacyId",
          f.review_status AS "reviewStatus"
        FROM catalog.school_feeder_relations f
        JOIN catalog.schools source ON source.id = f.from_school_id
        LEFT JOIN catalog.schools target ON target.id = f.to_school_id
        WHERE source.legacy_id IS NOT NULL
           OR target.legacy_id IS NOT NULL
        ORDER BY f.id
      `)
    ).rows;

    let updated = 0;
    await client.query("BEGIN");
    for (const row of candidates) {
      const fromChanged = row.fromLegacyId !== null && row.fromPublicId !== row.fromLegacyId;
      const toChanged = row.toLegacyId !== null && row.toPublicId !== row.toLegacyId;
      if (!fromChanged && !toChanged) continue;
      if (apply) {
        const result = await client.query(
          `
            UPDATE catalog.school_feeder_relations
               SET from_public_school_id = COALESCE($1, from_public_school_id),
                   to_public_school_id = COALESCE($2, to_public_school_id)
             WHERE id = $3
          `,
          [row.fromLegacyId, row.toLegacyId, row.id],
        );
        updated += result.rowCount ?? 0;
      }
    }
    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");

    const missing = candidates.filter((row) => row.fromLegacyId === null || row.toLegacyId === null).length;
    console.log(
      JSON.stringify(
        {
          mode: apply ? "apply" : "dry-run",
          candidates: candidates.length,
          rowsMissingCatalogLegacyId: missing,
          rowsNeedingUpdate: candidates.filter(
            (row) =>
              (row.fromLegacyId !== null && row.fromPublicId !== row.fromLegacyId) ||
              (row.toLegacyId !== null && row.toPublicId !== row.toLegacyId),
          ).length,
          updated,
          reviewStatuses: [...new Set(candidates.map((row) => row.reviewStatus))],
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
