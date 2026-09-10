import test from "node:test";
import assert from "node:assert/strict";
import { inferCachedSourceUrl } from "../scripts/backfill-official-policy-cache";

test("derives the official enrollment URL from a cached policy filename", () => {
  assert.equal(
    inferCachedSourceUrl("shrxbm.edu.sh.gov.cn_zszc_policy_310101_zszchtml_201601594.html.html"),
    "https://shrxbm.edu.sh.gov.cn/zszc/policy/310101/zszchtml_201601594.html",
  );
});

test("rejects non-policy cache filenames", () => {
  assert.equal(inferCachedSourceUrl("example.html"), null);
});
