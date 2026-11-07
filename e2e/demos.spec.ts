// Drives both apps in a real browser. Fictional data only.
// Also a screen-based rehearsal of AG-01: it checks that card generation and
// printing send no share text to the service and leave none in its log.
// The real AG-01 gate still needs a physically printed card read by a person.

import { test, expect, type Page, type Request } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LL = "http://127.0.0.1:5183";
const BG = "http://127.0.0.1:5184";
const dir = process.env.COVEN_E2E_DIR!;
const root = join(import.meta.dirname, "..");

function recordRequests(page: Page) {
  const seen: string[] = [];
  page.on("request", (r: Request) => seen.push(`${r.method()} ${r.url()}\n${r.postData() ?? ""}`));
  return seen;
}

async function signInAs(page: Page, name: string) {
  const select = page.getByLabel("Signed in as");
  const value = await select.locator("option", { hasText: name }).first().getAttribute("value");
  await select.selectOption(value!);
  await expect(select).toHaveValue(value!);
}

test("Break Glass: quorum, duplicate approval, single-item release, rotation", async ({ page }) => {
  const requests = recordRequests(page);
  page.on("dialog", (d) => d.accept());
  await page.goto(BG);
  await page.getByRole("button", { name: "Set up demo" }).click();
  await expect(page.getByRole("heading", { name: "Sealed items" })).toBeVisible({ timeout: 30_000 });

  await signInAs(page, "Robin");
  await page.getByLabel("Reason").fill("Production database locked out (fictional)");
  await page.getByRole("button", { name: "Open petition" }).click();
  await expect(page.getByText("Waiting for approvals. Nothing is released before quorum.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Retrieve/ })).toHaveCount(0);

  await signInAs(page, "Sage");
  await page.getByRole("button", { name: /Approve/ }).click();
  await expect(page.getByText("You approved. Another approval from you does not count.")).toBeVisible();
  await expect(page.getByText("Approvals 1 of 2 needed")).toBeVisible();

  await signInAs(page, "Robin");
  await expect(page.getByRole("button", { name: /Retrieve/ })).toHaveCount(0);

  await signInAs(page, "Rowan");
  await page.getByRole("button", { name: /Approve/ }).click();
  await expect(page.locator(".badge", { hasText: "Approved" })).toBeVisible();

  await signInAs(page, "Kit");
  await expect(page.getByText("No petitions visible to Kit.")).toBeVisible();

  await signInAs(page, "Robin");
  await page.getByRole("button", { name: "Retrieve and decrypt in this browser" }).click();
  await expect(page.locator(".secret")).toHaveText(/Pumpkin-Lantern-4417/);
  await expect(page.getByText("The credential stays valid until you rotate it in the system that issued it.").first()).toBeVisible();
  await expect(page.getByText("Rotation required.")).toBeVisible();
  await page.screenshot({ path: join(dir, "break-glass-released.png"), fullPage: true });
  await page.getByRole("button", { name: "I rotated it in the issuing system" }).click();
  await expect(page.locator(".badge", { hasText: "rotated" })).toBeVisible();

  // The plaintext never travelled to the service.
  for (const r of requests) expect(r).not.toContain("Pumpkin-Lantern-4417");
  expect(readFileSync(join(dir, "service.log"), "utf8")).not.toContain("Pumpkin-Lantern-4417");
});

test("Last Light: cards, check-in cancels, recovery with a typed code, offline CLI", async ({ page }) => {
  const requests = recordRequests(page);
  page.on("dialog", (d) => d.accept());
  await page.goto(LL);
  await page.getByRole("button", { name: "Set up demo" }).click();
  await expect(page.getByRole("heading", { name: /The Hollow family vault/ })).toBeVisible({ timeout: 30_000 });

  // Each trustee shows (and could print) their card. Read the word codes off the page.
  const words: Record<string, string> = {};
  for (const name of ["Ada", "Bram", "Dov", "Esme"]) {
    await signInAs(page, name);
    await page.getByRole("button", { name: "Show my card" }).click();
    const code = (await page.locator(".share-card .words").textContent())!.trim();
    words[name] = code;
    if (name === "Bram") {
      // What the printer receives: a PDF rendered with print styles.
      await page.pdf({ path: join(dir, "last-light-card.pdf"), format: "A4" });
      await page.emulateMedia({ media: "print" });
      await page.screenshot({ path: join(dir, "last-light-card-print.png"), fullPage: true });
      await page.emulateMedia({ media: "screen" });
    }
    await page.getByRole("button", { name: "Hide card" }).click();
  }

  await signInAs(page, "Mara Hollow");
  await page.getByRole("button", { name: "+30 days" }).click();
  await page.getByRole("button", { name: "+7 days" }).click();
  await expect(page.locator(".badge", { hasText: "Vigil" })).toBeVisible();
  await page.getByRole("button", { name: "Check in: I'm here" }).click();
  await expect(page.locator(".badge", { hasText: "Lit" })).toBeVisible();
  await page.getByRole("button", { name: "+30 days" }).click();
  await page.getByRole("button", { name: "+30 days" }).click();
  await expect(page.locator(".badge", { hasText: "Handover" })).toBeVisible();

  await signInAs(page, "Ada");
  await page.getByRole("button", { name: /Open a recovery/ }).click();
  await page.getByRole("button", { name: "Use my stored share" }).click();
  await expect(page.getByText(/shares 1 of 3/)).toBeVisible();

  await signInAs(page, "Bram");
  await page.getByLabel(/type the word code/).fill(words.Bram.toLowerCase());
  await page.getByRole("button", { name: "Submit share from card" }).click();
  await expect(page.getByText(/shares 2 of 3/)).toBeVisible();

  await signInAs(page, "Cleo");
  await page.getByRole("button", { name: "Use my stored share" }).click();
  await expect(page.getByText(/shares 3 of 3/)).toBeVisible();

  await signInAs(page, "Ada");
  await page.getByRole("button", { name: "Rebuild the vault key here and open" }).click();
  await expect(page.locator(".secret").first()).toContainText("blue pumpkin");
  await expect(page.getByText(/Held online until 2031-06-01/)).toBeVisible();
  await expect(page.locator(".badge", { hasText: "Released" })).toBeVisible();
  await page.screenshot({ path: join(dir, "last-light-released.png"), fullPage: true });

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download bundle" }).click();
  const bundlePath = join(dir, "bundle.json");
  await (await download).saveAs(bundlePath);

  // Offline recovery with three word codes read from the cards.
  const cli = join(root, "core-ts/bin/recover.js");
  const out = spawnSync(process.execPath, [cli, bundlePath, "--share", words.Bram, "--share", words.Dov, "--share", words.Esme], { encoding: "utf8" });
  expect(out.status, out.stderr).toBe(0);
  expect(out.stdout).toContain("blue pumpkin");

  // AG-01 rehearsal scan: no word code (any form) or coven1 payload in requests, the service log or the bundle.
  const log = readFileSync(join(dir, "service.log"), "utf8");
  const bundleText = readFileSync(bundlePath, "utf8");
  const forms = Object.values(words).flatMap((w) => [w, w.replace(/-/g, ""), w.toLowerCase(), w.toLowerCase().replace(/-/g, "")]);
  for (const hay of [...requests, log, bundleText]) {
    for (const f of forms) expect(hay).not.toContain(f);
    expect(hay).not.toContain("coven1:");
  }
});
