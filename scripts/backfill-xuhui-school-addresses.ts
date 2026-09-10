/**
 * Narrow, audited backfill for missing Xuhui school addresses.
 *
 * Safety properties:
 * - no delete/truncate/seed
 * - only updates the hardcoded id + exact name pairs below
 * - only fills address when it is currently null/blank
 * - dry-run rolls back the transaction after printing planned changes
 */
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
const dryRun = process.argv.includes("--dry-run");

if (!databaseUrl) throw new Error("DATABASE_URL is required.");

type AddressPatch = {
  id: number;
  name: string;
  address: string;
};

const XUHUI_ADDRESSES: AddressPatch[] = [
  { id: 3475, name: "上海师范大学第三附属实验学校", address: "上海市徐汇区三江路310号" },
  { id: 3476, name: "上海市徐汇区康健外国语实验小学", address: "上海市徐汇区百花街2号" },
  { id: 3477, name: "上海市西南位育附属实验学校", address: "上海市徐汇区钦州北路425号" },
  { id: 3478, name: "复旦大学附属徐汇实验学校", address: "上海市徐汇区天钥桥路905弄宛南六村46号" },
  { id: 3479, name: "上海市徐汇区上海小学（本部校区 ）", address: "上海市徐汇区上中路200号" },
  { id: 3480, name: "上海市徐汇区上海小学（龙川校区 ）", address: "上海市徐汇区龙川北路506号" },
  { id: 3481, name: "上海市徐汇区园南小学", address: "上海市徐汇区园南二村71号" },
  { id: 3482, name: "上海市徐汇区教育学院附属实验小学", address: "上海市徐汇区龙瑞路135号" },
  { id: 3483, name: "上海市徐汇区向阳育才小学", address: "上海市徐汇区龙川北路625弄1号" },
  { id: 3484, name: "上海市徐汇区龙华小学", address: "上海市徐汇区龙华西路周家湾57号" },
  { id: 3485, name: "上海市中国中学", address: "上海市徐汇区钦州南路85号" },
  { id: 3486, name: "上海市康健外国语实验中学", address: "上海市徐汇区浦北路105号" },
  { id: 3487, name: "上海市龙苑中学", address: "上海市徐汇区黄石路85号" },
  { id: 3488, name: "上海市徐汇区教育学院附属实验中学", address: "上海市徐汇区上中路50号" },
  { id: 3489, name: "上海市园南中学（总校 ）", address: "上海市徐汇区百色路231号" },
  { id: 3490, name: "上海市园南中学（北校 ）", address: "上海市徐汇区平福路200号" },
  { id: 3491, name: "上海市汾阳中学", address: "上海市徐汇区华发路100弄22号" },
  { id: 3492, name: "上海市徐汇区教育学院 附属实验中学南部分校", address: "上海市徐汇区罗秀路99号" },
  { id: 3493, name: "华东理工大学附属中学", address: "上海市徐汇区梅陇十村76号" },
  { id: 3494, name: "上海市梅园中学", address: "上海市徐汇区梅陇路495号" },
  { id: 3495, name: "上海市徐汇中学（南校区 ）", address: "上海市徐汇区虹桥路68号" },
  { id: 3496, name: "上海师范大学第三附属实验学校（初中）", address: "上海市徐汇区三江路310号" },
  { id: 3497, name: "复旦大学附属徐汇实验学校 （初中 ）", address: "上海市徐汇区天钥桥路905弄宛南六村46号" },
  { id: 3498, name: "上海市西南位育附属实验学校 （初中 ）", address: "上海市徐汇区钦州北路425号" },
];

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  let planned = 0;
  let updated = 0;
  let skipped = 0;

  try {
    await client.query("BEGIN");

    for (const patch of XUHUI_ADDRESSES) {
      const current = await client.query<{ id: number; name: string; address: string | null }>(
        "SELECT id, name, address FROM schools WHERE id = $1 AND name = $2 AND district = '徐汇'",
        [patch.id, patch.name],
      );

      if (current.rowCount !== 1) {
        skipped++;
        console.log(`SKIP missing-name-match id=${patch.id} name=${patch.name}`);
        continue;
      }

      const existing = current.rows[0].address?.trim();
      if (existing) {
        skipped++;
        console.log(`SKIP already-filled id=${patch.id} name=${patch.name} address=${existing}`);
        continue;
      }

      planned++;
      console.log(`${dryRun ? "DRY" : "UPDATE"} id=${patch.id} name=${patch.name} -> ${patch.address}`);

      const result = await client.query(
        `
          UPDATE schools
          SET address = $1, updated_at = now()
          WHERE id = $2
            AND name = $3
            AND district = '徐汇'
            AND (address IS NULL OR btrim(address) = '')
        `,
        [patch.address, patch.id, patch.name],
      );
      updated += result.rowCount ?? 0;
    }

    if (dryRun) {
      await client.query("ROLLBACK");
    } else {
      await client.query("COMMIT");
    }

    console.log(`Done. planned=${planned}, updated=${updated}, skipped=${skipped}, dryRun=${dryRun}`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
