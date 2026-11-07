// Offline recovery tool. Works with the service stopped or gone.
//
//   coven-recover <bundle.json> [--share <text>]... [--record <file>]
//       Rebuild the vault key from k shares (QR payload "coven1:..." or word
//       code) and print every item. With no --share flags, reads one share per
//       line from stdin so shares stay out of shell history.
//   coven-recover verify <bundle.json> --receipt <length>:<head> [--chain <chain.json>]
//       Check a record chain against a retained receipt. Without --chain the
//       bundle's own snapshot is checked. With --chain, also lists entries that
//       differ from the bundle's snapshot.
//
// Shares are never printed, logged or written to disk by this tool.

import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { parseBundle, recoverVault, RecoveryError, BundleError, type Bundle } from "./bundle.ts";
import { diffAgainstSnapshot, verifyReceipt, type RecordEntry, type Receipt } from "./records.ts";

interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  readLines: () => Promise<string[]>;
}

function usage(io: Io): number {
  io.err("usage: coven-recover <bundle.json> [--share <text>]... [--record <file>]");
  io.err("       coven-recover verify <bundle.json> --receipt <length>:<head> [--chain <chain.json>]");
  return 2;
}

function loadBundle(path: string): Bundle {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new BundleError(`cannot read bundle ${path}`);
  }
  return parseBundle(raw);
}

function parseReceipt(s: string): Receipt {
  const m = /^(\d+):([0-9a-f]{64})$/.exec(s.trim());
  if (!m) throw new BundleError("receipt must look like <length>:<64 hex chars>");
  return { length: Number(m[1]), head: m[2] };
}

async function runVerify(args: string[], io: Io): Promise<number> {
  const bundlePath = args[0];
  let receiptText: string | undefined;
  let chainPath: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--receipt") receiptText = args[++i];
    else if (args[i] === "--chain") chainPath = args[++i];
    else return usage(io);
  }
  if (!bundlePath || !receiptText) return usage(io);
  const bundle = loadBundle(bundlePath);
  const receipt = parseReceipt(receiptText);
  let entries: RecordEntry[] = bundle.record.entries;
  if (chainPath) {
    const chain = JSON.parse(readFileSync(chainPath, "utf8"));
    entries = Array.isArray(chain) ? chain : chain.entries;
  }
  const outcome = await verifyReceipt(entries, receipt);
  const label = {
    consistent: `consistent: the first ${receipt.length} entries match the receipt`,
    altered: `witnessed prefix altered: one or more of the first ${receipt.length} entries changed, were removed or were reordered`,
    truncated: `truncated: the chain has ${entries.length} entries, fewer than the receipt's ${receipt.length}`,
  }[outcome];
  io.out(label);
  if (chainPath) {
    const d = await diffAgainstSnapshot(entries, bundle.record.entries);
    if (d.changed.length + d.missing.length === 0) io.out("snapshot comparison: no witnessed entries differ from the bundle snapshot");
    else io.out(`snapshot comparison: changed ${JSON.stringify(d.changed)}, missing ${JSON.stringify(d.missing)}`);
    if (d.added.length > 0) io.out(`entries newer than the snapshot: ${d.added.length}`);
  }
  return outcome === "consistent" ? 0 : 1;
}

async function runRecover(args: string[], io: Io): Promise<number> {
  const bundlePath = args[0];
  const shares: string[] = [];
  let recordPath: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--share" && i + 1 < args.length) shares.push(args[++i]);
    else if (args[i] === "--record" && i + 1 < args.length) recordPath = args[++i];
    else return usage(io);
  }
  if (!bundlePath) return usage(io);
  const bundle = loadBundle(bundlePath);
  if (shares.length === 0) {
    io.err(`Enter ${bundle.vault.threshold} or more shares, one per line (QR text or word code). End with an empty line.`);
    shares.push(...(await io.readLines()));
  }
  io.err(`Vault "${bundle.vault.name}": ${bundle.vault.threshold} of ${bundle.vault.trustees.length} shares needed, ${shares.length} given.`);
  const items = await recoverVault(bundle, shares);
  io.out(`Recovered vault "${bundle.vault.name}" (${items.length} items). Offline recovery ignores earliest release dates.`);
  for (const it of items) {
    io.out("");
    io.out(`== ${it.label}`);
    io.out(`   deliver to: ${it.deliverTo.join(", ") || "(none)"}`);
    if (it.earliestRelease) io.out(`   earliest release (online policy): ${it.earliestRelease}`);
    io.out(it.body);
  }
  if (recordPath) {
    const local = {
      format: "coven/v1-offline-recovery",
      at: new Date().toISOString(),
      vaultId: bundle.vault.id,
      sharesUsed: shares.length,
      bundleReceipt: bundle.record.receipt,
    };
    writeFileSync(recordPath, JSON.stringify(local, null, 2) + "\n");
    io.err(`Local record written to ${recordPath}. It is not added to the online record unless you upload it.`);
  }
  return 0;
}

export async function main(argv: string[], io: Io): Promise<number> {
  try {
    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return usage(io);
    if (argv[0] === "verify") return await runVerify(argv.slice(1), io);
    return await runRecover(argv, io);
  } catch (e) {
    if (e instanceof RecoveryError) {
      io.err(`recovery failed: ${e.message}`);
      for (const p of e.problems) io.err(`  share ${p.position}: ${p.reason}`);
      return 1;
    }
    if (e instanceof BundleError) {
      io.err(`bundle error: ${e.message}`);
      return 1;
    }
    io.err(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

export function stdinLines(): Promise<string[]> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (l) => {
      if (l.trim() === "") rl.close();
      else lines.push(l.trim());
    });
    rl.on("close", () => resolve(lines));
  });
}

export const nodeIo: Io = {
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
  readLines: stdinLines,
};
