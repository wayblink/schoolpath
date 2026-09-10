import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { collectXuequzhushouSite } from "../lib/ingest/xuequzhushou-site";

async function main() {
  const { values } = parseArgs({ options: {
    "output-root": { type: "string" }, "run-id": { type: "string" },
    "max-resources": { type: "string" }, "max-bytes": { type: "string" },
    "max-total-bytes": { type: "string" }, "timeout-ms": { type: "string" },
    "delay-ms": { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) {
    console.log("Usage: pnpm exec tsx scripts/collect-xuequzhushou-site.ts [--output-root PATH] [--run-id ID] [--max-resources 512] [--max-bytes 33554432] [--max-total-bytes 268435456] [--timeout-ms 20000] [--delay-ms 300]\nFetch-only archive. Exit 2 means the manifest contains unreachable or limited resources.");
    return;
  }
  const numeric = (name: "max-resources" | "max-bytes" | "max-total-bytes" | "timeout-ms" | "delay-ms") => values[name] === undefined ? undefined : Number(values[name]);
  const { directory, manifest } = await collectXuequzhushouSite({
    outputRoot: values["output-root"] ? path.resolve(values["output-root"]) : fileURLToPath(new URL("../data/ingest/xuequzhushou-site/", import.meta.url)),
    runId: values["run-id"], maxResources: numeric("max-resources"), maxBytes: numeric("max-bytes"),
    maxTotalBytes: numeric("max-total-bytes"), timeoutMs: numeric("timeout-ms"), delayMs: numeric("delay-ms"),
    onResource: (resource) => console.log(`${resource.status ?? "ERR"} ${new URL(resource.url).pathname} ${resource.bytes} bytes${resource.error ? `: ${resource.error}` : ""}`),
  });
  console.log(JSON.stringify({ directory, resources: manifest.resources.length, failures: manifest.resources.filter((resource) => resource.error).length, complete: manifest.complete }, null, 2));
  if (!manifest.complete) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
