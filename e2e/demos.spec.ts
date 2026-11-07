// Drives both apps in a real browser. Fictional data only.
// Also a screen-based rehearsal of AG-01: it checks that card generation and
// printing send no share text to the service and leave none in its log.
// The real AG-01 gate still needs a physically printed card read by a person.

import { test, expect, type Page, type Request } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LL = "http://127.0.0.1:5183";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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

// Proposal acceptance scenario 3: an issued link is reused during the window and after expiry.
const MATERIAL = ["item_ciphertext", "item_header", "envelopes", "approver_share"];

async function fetchRelease(page: Page, pid: string) {
  return page.evaluate(async (id) => {
    const r = await fetch(`/api/bg/petitions/${id}/release`, { headers: { "X-Coven-App": "break-glass" }, cache: "no-store" });
    return { status: r.status, body: await r.text() };
  }, pid);
}

async function openAndApprove(page: Page, item: string, reason: string) {
  await signInAs(page, "Robin");
  await page.getByRole("button", { name: "New petition" }).click();
  await page.getByLabel("Item", { exact: true }).selectOption({ label: item });
  await page.getByLabel("Retrieval window").selectOption("15");
  await page.getByLabel("Reason").fill(reason);
  await page.getByRole("button", { name: "Open petition" }).click();
  const card = page.getByRole("article").filter({ hasText: reason });
  const link = (await card.getByRole("link", { name: "Petition link" }).getAttribute("href"))!;
  for (const who of ["Ash", "Wren"]) {
    await signInAs(page, who);
    await page.getByRole("article").filter({ hasText: reason }).getByRole("button", { name: /^Approve:/ }).click();
    await expect(page.getByRole("article").filter({ hasText: reason }).getByText(/You approved|Approved/).first()).toBeVisible();
  }
  const pid = /#petition=([0-9a-f-]{36})$/.exec(link)![1];
  return { link, pid };
}

// Both Break Glass tests share one browser context: the personas' keys live in its IndexedDB.
test.describe.serial("Break Glass", () => {
let page: Page;
test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage();
});
test.afterAll(async () => {
  await page.context().close();
});

test("Break Glass: quorum, duplicate approval, single-item release, rotation", async () => {
  const requests = recordRequests(page);
  page.on("dialog", (d) => d.accept());
  await page.goto(BG);
  await page.getByRole("button", { name: "Set up demo" }).click();
  await expect(page.getByRole("heading", { name: "Sealed items" })).toBeVisible({ timeout: 30_000 });

  await signInAs(page, "Robin");
  await page.getByRole("button", { name: "New petition" }).click();
  await page.getByLabel("Reason").fill("Production database locked out (fictional)");
  await page.getByRole("button", { name: "Open petition" }).click();
  await expect(page.getByText("Waiting for approvals. Nothing is released before quorum.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Retrieve/ })).toHaveCount(0);

  await signInAs(page, "Sage");
  await page.getByRole("button", { name: /^Approve:/ }).click();
  await expect(page.getByText("You approved. Another approval from you does not count.")).toBeVisible();
  await expect(page.getByText("Approvals 1 of 2 needed")).toBeVisible();

  await signInAs(page, "Robin");
  await expect(page.getByRole("button", { name: /Retrieve/ })).toHaveCount(0);

  await signInAs(page, "Rowan");
  await page.getByRole("button", { name: /^Approve:/ }).click();
  await expect(page.getByRole("region", { name: "Selected petition" }).getByTestId("petition-state")).toHaveText("Approved");

  await signInAs(page, "Kit");
  await expect(page.getByText("No petitions visible to Kit.")).toBeVisible();

  await signInAs(page, "Robin");
  await page.getByRole("button", { name: "Retrieve and decrypt in this browser" }).click();
  await expect(page.locator(".secret")).toHaveText(/Pumpkin-Lantern-4417/);
  await expect(page.getByText("The credential stays valid until you rotate it in the system that issued it.").first()).toBeVisible();
  await expect(page.getByText("Rotation required.")).toBeVisible();
  await page.screenshot({ path: join(dir, "break-glass-released.png"), fullPage: true });
  await page.getByRole("button", { name: "I rotated it in the issuing system" }).click();
  await expect(page.getByTestId("rotation-aws-root")).toHaveText("rotated");
  // Hide clears the plaintext; reselecting the ticket does not reveal it again.
  await page.getByRole("button", { name: "Hide" }).click();
  await expect(page.locator(".secret")).toHaveCount(0);
  await page.getByRole("button", { name: /Production database locked out/ }).click();
  await expect(page.locator(".secret")).toHaveCount(0);

  // The plaintext never travelled to the service.
  for (const r of requests) expect(r).not.toContain("Pumpkin-Lantern-4417");
  expect(readFileSync(join(dir, "service.log"), "utf8")).not.toContain("Pumpkin-Lantern-4417");
});

test("Break Glass scenario 3: a reused petition link works in the window and is refused after expiry", async () => {
  page.on("dialog", (d) => d.accept());
  await page.goto(BG);
  await expect(page.getByRole("heading", { name: "Sealed items" })).toBeVisible();

  // A: retrieved through the link inside the window. B: approved, key kept in this browser, not retrieved.
  const a = await openAndApprove(page, "Domain registrar recovery codes (fictional)", "Registrar locked (fictional) A");
  const b = await openAndApprove(page, "Release signing key passphrase (fictional)", "Hotfix signing (fictional) B");
  expect(a.link.startsWith(BG + "/#petition=")).toBe(true);
  expect(new URL(a.link).search).toBe("");

  await signInAs(page, "Robin");
  await page.goto(a.link);
  const linkCard = page.getByRole("region", { name: "Petition link" });
  await expect(linkCard.getByTestId("petition-state")).toHaveText("Approved");
  await linkCard.getByRole("button", { name: "Retrieve and decrypt in this browser" }).click();
  await expect(page.locator(".secret")).toHaveText(/8F2K-QX7M/);
  await expect(page.getByText("Anything you already copied or downloaded stays usable after that.").first()).toBeVisible();

  await page.goto(b.link);
  await expect(linkCard.getByRole("button", { name: "Retrieve and decrypt in this browser" })).toBeVisible(); // key is local

  // An ineligible user with a valid session gets nothing from either link.
  await signInAs(page, "Kit");
  for (const p of [a, b]) {
    await page.goto(p.link);
    await expect(page.getByText("This petition is not available to Kit.")).toBeVisible();
    const r = await fetchRelease(page, p.pid);
    expect(r.status).toBe(404);
    for (const f of MATERIAL) expect(r.body).not.toContain(f);
  }
  // An eligible approver is not the requester either.
  await signInAs(page, "Ash");
  expect((await fetchRelease(page, b.pid)).status).toBe(404);

  // The window ends (15 minutes; the labelled demo clock moves 30).
  await signInAs(page, "Robin");
  await page.goto(b.link);
  await page.getByRole("button", { name: "+30 min" }).click();
  await expect(linkCard.getByTestId("petition-state")).toHaveText("Expired");
  await expect(linkCard.getByText(/This link stopped working at/)).toBeVisible();
  await expect(linkCard.getByText("Anything you already copied or downloaded stays usable after that.")).toBeVisible();

  // B: the requester still holds the petition key and a valid session; the service refuses.
  await linkCard.getByRole("button", { name: "Retrieve and decrypt in this browser" }).click();
  await expect(linkCard.getByText(/Retrieval refused: the petition is expired/)).toBeVisible();
  await expect(linkCard.getByRole("button", { name: "Retrieve and decrypt in this browser" })).toHaveCount(0);
  await expect(page.getByText("moonlit-cauldron")).toHaveCount(0);
  await page.screenshot({ path: join(dir, "break-glass-link-expired.png"), fullPage: true });

  for (const p of [a, b]) {
    const r = await fetchRelease(page, p.pid);
    expect(r.status).toBe(410);
    for (const f of MATERIAL) expect(r.body).not.toContain(f);
  }
  await page.goto(a.link);
  await expect(linkCard.getByText(/This link stopped working at/)).toBeVisible();

  await signInAs(page, "Kit");
  expect((await fetchRelease(page, b.pid)).status).toBe(404);
});

test("Break Glass role isolation: a late release across a persona switch, leaving the ticket, a new petition from a link", async () => {
  const c = await openAndApprove(page, "AWS root account (fictional)", "Isolation check (fictional) C");
  await signInAs(page, "Robin");
  await page.getByRole("button", { name: /Isolation check/ }).click();
  const ticket = page.getByRole("region", { name: "Selected petition" });

  // The release response is held for 1.5 s; Robin switches to Sage (an eligible approver) meanwhile.
  let held = 0;
  // Send now (as Robin), hold only the RESPONSE: a late answer to Robin's request.
  await page.route("**/api/bg/petitions/*/release", async (route) => {
    held++;
    const response = await route.fetch();
    await sleep(1500);
    await route.fulfill({ response });
  });
  const sent = page.waitForRequest((r) => r.url().endsWith("/release"));
  await ticket.getByRole("button", { name: "Retrieve and decrypt in this browser" }).click();
  await sent; // Robin's request is on the wire; its answer is held
  await signInAs(page, "Sage");
  await sleep(2500);
  expect(held).toBe(1); // the response really arrived after the switch
  await expect(page.locator(".secret")).toHaveCount(0);
  await expect(page.getByText(/Decrypted and verified in this browser/)).toHaveCount(0);
  await expect(page.getByText(/Isolation check/).first()).toBeVisible(); // Sage's own view of the ticket
  await page.unroute("**/api/bg/petitions/*/release");

  // The late result was discarded before decryption, so Robin's key is still here.
  await signInAs(page, "Robin");
  await page.getByRole("button", { name: /Isolation check/ }).click();
  await ticket.getByRole("button", { name: "Retrieve and decrypt in this browser" }).click();
  await expect(page.locator(".secret")).toHaveText(/Pumpkin-Lantern-4417/);
  await expect(page.getByText(/Decrypted and verified in this browser/)).toBeVisible();

  // Leaving the ticket drops the plaintext; coming back does not reveal it.
  await page.getByRole("button", { name: /Production database locked out/ }).click();
  await expect(page.locator(".secret")).toHaveCount(0);
  await page.getByRole("button", { name: /Isolation check/ }).click();
  await expect(page.locator(".secret")).toHaveCount(0);

  // A new petition opened while an old link is shown replaces the link selection.
  await page.goto(c.link);
  await expect(page.getByRole("region", { name: "Petition link" })).toBeVisible();
  await page.getByRole("button", { name: "New petition" }).click();
  await page.getByLabel("Reason").fill("Fresh petition from a link view (fictional) D");
  await page.getByRole("button", { name: "Open petition" }).click();
  await expect(page.getByRole("region", { name: "Selected petition" })).toContainText("Fresh petition from a link view");
  await expect(page.getByRole("region", { name: "Petition link" })).toHaveCount(0);
  expect(new URL(page.url()).hash).toBe("");
});

test("Break Glass session lock: one sign-in at a time, UI inactive meanwhile, persona matches the session", async () => {
  await signInAs(page, "Robin");
  await expect(page.getByRole("button", { name: "New petition" })).toBeVisible();
  let posts = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  await page.route("**/api/session", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const response = await route.fetch();
    await sleep(1500); // hold the sign-in answer (and its Set-Cookie)
    await route.fulfill({ response });
    inFlight--;
  });

  const select = page.getByLabel("Signed in as");
  await select.selectOption({ label: "Sage · Approver" });
  // While pending: the selector, the desk and the demo controls are inactive.
  await expect(select).toBeDisabled();
  await expect(page.locator("main#desk")).toHaveAttribute("inert", "");
  await expect(page.locator("main#desk")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator(".bg-demo")).toHaveAttribute("inert", "");
  await expect(page.getByRole("button", { name: "New petition" })).toHaveCount(0); // desk not shown while pending
  // Demo controls stay visible but cannot be focused or used: they sit under an inert ancestor.
  for (const name of ["+5 min", "+30 min", "Reset demo"]) {
    const inactive = await page.getByRole("button", { name }).evaluate((el: HTMLElement) => {
      el.focus();
      return el.closest("[inert]") !== null && document.activeElement !== el;
    });
    expect(inactive, name).toBe(true);
  }
  // A second switch forced onto the disabled selector must not start another sign-in.
  await select.selectOption({ label: "Kit · Engineer" }, { force: true }).catch(() => {});
  await expect(select).toBeEnabled({ timeout: 10_000 });
  expect(posts).toBe(1);
  expect(maxInFlight).toBe(1);
  await page.unroute("**/api/session");

  // The UI persona is the one the session cookie actually holds.
  const actual = await page.evaluate(async () => {
    const r = await fetch("/api/session", { headers: { "X-Coven-App": "break-glass" }, cache: "no-store" });
    return (await r.json()).user as string;
  });
  expect(actual).toBe("user:sage");
  await expect(select).toHaveValue(actual);
  await expect(page.locator("main#desk")).not.toHaveAttribute("inert", "");
  await expect(page.getByRole("button", { name: "New petition" })).toBeVisible();

  // Re-selecting the current persona sends no sign-in.
  let repeat = 0;
  const onReq = (r: Request) => {
    if (r.method() === "POST" && r.url().endsWith("/api/session")) repeat++;
  };
  page.on("request", onReq);
  await select.selectOption({ label: "Sage · Approver" });
  await sleep(500);
  page.off("request", onReq);
  expect(repeat).toBe(0);
});
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

  // A late share-card response must not survive a persona switch, nor trigger
  // a "card issued" request under the next persona's session.
  const cardIssued: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/card-issued")) cardIssued.push(r.url());
  });
  await signInAs(page, "Bram");
  let heldShares = 0;
  // Send now (as Bram), hold only the RESPONSE: a late answer to Bram's request.
  await page.route("**/api/ll/vaults/*/my-share", async (route) => {
    heldShares++;
    const response = await route.fetch();
    await sleep(1500);
    await route.fulfill({ response });
  });
  const issuedBefore = cardIssued.length;
  const shareSent = page.waitForRequest((r) => r.url().endsWith("/my-share"));
  await page.getByRole("button", { name: "Show my card" }).click();
  await shareSent; // Bram's request is on the wire; its answer is held
  await signInAs(page, "Cleo");
  await sleep(2500);
  expect(heldShares).toBe(1);
  await expect(page.locator(".share-card")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show my card" })).toBeVisible();
  expect(cardIssued.length).toBe(issuedBefore);
  await page.unroute("**/api/ll/vaults/*/my-share");

  await signInAs(page, "Mara Hollow");
  await page.getByRole("button", { name: "+30 days" }).click();
  await page.getByRole("button", { name: "+7 days" }).click();
  await expect(page.getByTestId("lantern-state")).toHaveText("Vigil");
  await page.getByRole("button", { name: "Check in: I'm here" }).click();
  await expect(page.getByTestId("lantern-state")).toHaveText("Lit");
  await page.getByRole("button", { name: "+30 days" }).click();
  await page.getByRole("button", { name: "+30 days" }).click();
  await expect(page.getByTestId("lantern-state")).toHaveText("Handover");

  await signInAs(page, "Ada");
  await page.getByRole("button", { name: /Open a recovery/ }).click();
  await page.getByRole("button", { name: "Use my stored share" }).click();
  await expect(page.getByText(/shares 1 of 3/)).toBeVisible();

  // A code pasted but not submitted does not follow a persona switch.
  await signInAs(page, "Dov");
  await page.getByLabel(/type the word code/).fill(words.Dov);
  await signInAs(page, "Cleo");
  await expect(page.getByLabel(/type the word code/)).toHaveValue("");
  await signInAs(page, "Dov");
  await expect(page.getByLabel(/type the word code/)).toHaveValue("");

  await signInAs(page, "Bram");
  await page.getByLabel(/type the word code/).fill(words.Bram.toLowerCase());
  await page.getByRole("button", { name: "Submit share from card" }).click();
  await expect(page.getByText(/shares 2 of 3/)).toBeVisible();

  await signInAs(page, "Cleo");
  await page.getByRole("button", { name: "Use my stored share" }).click();
  await expect(page.getByText(/shares 3 of 3/)).toBeVisible();

  await signInAs(page, "Ada");
  await expect(page.getByText(/Fetching the package marks the vault Released/)).toBeVisible();
  await page.getByRole("button", { name: "Fetch the package and rebuild the key here" }).click();
  await expect(page.getByText(/Vault key rebuilt and verified in this browser \(header check passed\)/)).toBeVisible();
  await expect(page.locator(".secret").first()).toContainText("blue pumpkin");
  await expect(page.locator(".ll-opened").getByText(/Held online until 2031-06-01/)).toBeVisible();
  await expect(page.getByTestId("lantern-state")).toHaveText("Released");
  await page.screenshot({ path: join(dir, "last-light-released.png"), fullPage: true });

  await page.locator("summary", { hasText: "Offline bundle" }).click();
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
