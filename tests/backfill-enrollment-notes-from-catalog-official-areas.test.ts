import assert from "node:assert/strict";
import test from "node:test";
import { buildOfficialAreaNote } from "../scripts/backfill-enrollment-notes-from-catalog-official-areas";

test("aggregates unique official administrative areas into an enrollment note", () => {
  const note = buildOfficialAreaNote([
    { district: "徐汇", source_year: 2026, area: "天平居委", committee_name: "天平居委" },
    { district: "徐汇", source_year: 2026, area: "天平居委", committee_name: "天平居委" },
    { district: "徐汇", source_year: 2026, area: "康平居委", committee_name: "康平居委" },
  ]);
  assert.equal(note, "2026年徐汇区官方招生区域（行政/居委口径）：天平居委、康平居委。");
});

test("returns an empty note when no area evidence is present", () => {
  assert.equal(buildOfficialAreaNote([{ district: "徐汇", source_year: 2026, area: null, committee_name: null }]), "");
});
