import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { eligibleNatureCopy, REVIEWED_DUPLICATES } from "../scripts/backfill-school-nature-from-reviewed-duplicates";

const script = readFileSync("scripts/backfill-school-nature-from-reviewed-duplicates.ts", "utf8");

test("reviewed duplicate nature backfill is limited to the four audited pairs", () => {
  assert.deepEqual(
    REVIEWED_DUPLICATES.map(({ sourceId, targetId }) => [sourceId, targetId]),
    [[5790, 4317], [5793, 4350], [5794, 4347], [5803, 4346]],
  );
  assert.match(script, /school_nature IS NULL/);
  assert.match(script, /canonical-official-provenance-missing/);
});

test("nature copy requires same district and stage plus official provenance", () => {
  const target = {
    id: 4317,
    name: "上海市宝山区第三中心小学",
    district: "宝山",
    type: "primary" as const,
    school_nature: "公立" as const,
    attrs: {
      school_nature_source: { source: "official_catchment_area", policy_url: "https://www.shanghai.gov.cn/example" },
    },
  };
  const source = { ...target, id: 5790, school_nature: null };
  assert.equal(eligibleNatureCopy(source, target), true);
  assert.equal(eligibleNatureCopy({ ...source, district: "徐汇" }, target), false);
  assert.equal(eligibleNatureCopy({ ...source, type: "middle" }, target), false);
  assert.equal(eligibleNatureCopy(source, { ...target, attrs: {} }), false);
});

test("migration keeps dry-run default, snapshots, transaction and source provenance", () => {
  assert.match(script, /process\.argv\.includes\("--apply"\)/);
  assert.match(script, /fileURLToPath\(import\.meta\.url\)/);
  assert.match(script, /BEGIN/);
  assert.match(script, /COMMIT/);
  assert.match(script, /ROLLBACK/);
  assert.match(script, /before/);
  assert.match(script, /canonical_source_url/);
  assert.match(script, /ON CONFLICT \(school_id,source_url,source_type\)/);
  assert.match(script, /RETURNING id/);
});
