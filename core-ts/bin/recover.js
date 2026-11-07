#!/usr/bin/env node
// Entry point for the offline recovery tool: node core-ts/bin/recover.js bundle.json --share ...
// Loads the TypeScript source directly. Node 23.6+ strips types by default;
// on Node 22.6+ this re-runs itself with --experimental-strip-types.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const source = new URL("../src/recover-cli.ts", import.meta.url);

let mod;
try {
  mod = await import(source.href);
} catch (e) {
  if (e && e.code === "ERR_UNKNOWN_FILE_EXTENSION" && !process.execArgv.includes("--experimental-strip-types")) {
    const r = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      { stdio: "inherit" },
    );
    process.exit(r.status ?? 1);
  }
  throw e;
}

process.exitCode = await mod.main(process.argv.slice(2), mod.nodeIo);
