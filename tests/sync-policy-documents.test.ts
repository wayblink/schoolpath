import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("scripts/sync-policy-documents.ts", "utf8");

test("policy document sync is keyed by public policy legacy id and district", () => {
  assert.match(script, /public\.policies/);
  assert.match(script, /catalog\.policy_documents/);
  assert.match(script, /legacy_id/);
  assert.match(script, /catalog\.districts/);
  assert.match(script, /ON CONFLICT \(legacy_id\)/);
});

test("policy document sync is dry-run by default and transactional", () => {
  assert.match(script, /process\.argv\.includes\("--apply"\)/);
  assert.match(script, /BEGIN/);
  assert.match(script, /COMMIT/);
  assert.match(script, /ROLLBACK/);
  assert.match(script, /report/);
});
