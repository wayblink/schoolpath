import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync(
  new URL("../scripts/backfill-school-locations-citywide.ts", import.meta.url),
  "utf8",
);

test("school location backfill supports resumable, rate-limited provider selection", () => {
  assert.match(script, /valueArg\("--provider"\)/);
  assert.match(script, /nonNegativeIntegerArg\("--after-id"\)/);
  assert.match(script, /nonNegativeIntegerArg\("--delay-ms"\)/);
  assert.match(script, /id > \$\$\{params\.length\}/);
  assert.match(script, /await sleep\(delayMs\)/);
});

