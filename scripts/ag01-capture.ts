// AG-01 capture run (docs/acceptance/AG-01-printed-card.md, steps 1 to 3).
//
//   node --experimental-strip-types scripts/ag01-capture.ts <private-run-dir> <app-url>
//
// Drives a fresh, isolated browser context against an isolated Last Light
// preview and service. Records every browser request in a HAR, exports Bram's
// share card as a print-ready PDF and downloads the matching bundle.
//
// Share values are written ONLY to owner-only files in <private-run-dir>.
// This script never prints them, never passes them as arguments and never
// takes screenshots of a card. Fictional data only.

import { chromium } from "@playwright/test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeWordCode, encodeQrPayload } from "../core-ts/src/shares.ts";

const [runDir, appUrl] = process.argv.slice(2);
if (!runDir || !appUrl) {
  console.error("usage: ag01-capture.ts <private-run-dir> <app-url>");
  process.exit(2);
}
const exe = process.env.PW_CHROMIUM;
const priv = (name: string, data: string) => {
  const p = join(runDir, name);
  writeFileSync(p, data, { mode: 0o600 });
  chmodSync(p, 0o600);
  return p;
};

const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
const context = await browser.newContext({
  acceptDownloads: true,
  recordHar: { path: join(runDir, "capture", "browser.har"), content: "embed" },
});
const page = await context.newPage();
page.on("dialog", (d) => d.accept());

async function signInAs(name: string) {
  const select = page.getByLabel("Signed in as");
  const value = await select.locator("option", { hasText: name }).first().getAttribute("value");
  await select.selectOption(value!);
  await page.waitForFunction((v) => (document.getElementById("persona") as HTMLSelectElement | null)?.value === v, value);
  await page.waitForLoadState("networkidle");
}

async function cardWords(): Promise<string> {
  await page.getByRole("button", { name: "Show my card" }).click();
  const words = (await page.locator(".share-card .words").textContent())!.trim();
  decodeWordCode(words); // checksum must pass; throws otherwise (value not printed)
  return words;
}

await page.goto(appUrl);
await page.getByRole("button", { name: "Set up demo" }).click();
await page.getByRole("heading", { name: /The Hollow family vault/ }).waitFor({ timeout: 60_000 });

// Two supplementary fictional shares (Dov, Esme), shown in their own card views.
const others: string[] = [];
for (const name of ["Dov", "Esme"]) {
  await signInAs(name);
  others.push(await cardWords());
  await page.getByRole("button", { name: "Hide card" }).click();
}

// The card to print: Bram's.
await signInAs("Bram");
const bram = await cardWords();
const receipt = (await page.locator(".share-card .mono").textContent())!.trim();
const vaultName = (await page.locator(".share-card p").first().textContent())!.replace(/\s+/g, " ").trim();
await page.pdf({ path: join(runDir, "bram-share-card.pdf"), format: "A4", printBackground: true });
chmodSync(join(runDir, "bram-share-card.pdf"), 0o600);

const bundleSummary = page.locator("summary", { hasText: "Offline bundle" });
if (await bundleSummary.count()) await bundleSummary.click(); // redesigned layout keeps the bundle in a disclosure
const download = page.waitForEvent("download");
await page.getByRole("button", { name: "Download bundle" }).click();
await (await download).saveAs(join(runDir, "bundle.json"));
chmodSync(join(runDir, "bundle.json"), 0o600);

await context.close(); // flushes the HAR
await browser.close();
chmodSync(join(runDir, "capture", "browser.har"), 0o600);

const qr = (w: string) => {
  const d = decodeWordCode(w);
  return encodeQrPayload(d.tag, d.share);
};
// Scanner input: every share shown in this run, as word code and QR text.
priv("secrets.local.txt", [bram, qr(bram), ...others, ...others.map(qr)].join("\n") + "\n");
// Supplementary shares for the offline run (stdin), one per line.
priv("supplementary-shares.local.txt", others.join("\n") + "\n");

// Non-secret run facts.
const facts = {
  gate: "AG-01",
  card_trustee: "Bram (fictional)",
  card_text: vaultName,
  receipt_at_issuance: receipt,
  supplementary_trustees: ["Dov (fictional)", "Esme (fictional)"],
  app_url: appUrl,
  captured_at: new Date().toISOString(),
};
priv("run-facts.json", JSON.stringify(facts, null, 2) + "\n");
console.log("capture complete: card PDF, bundle, HAR and owner-only share files written (values not shown)");
console.log(`receipt at issuance: ${receipt}`);
