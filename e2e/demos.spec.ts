// Drives both apps in a real browser. Fictional data only.
// Also a screen-based rehearsal of AG-01: it checks that card generation and
// printing send no share text to the service and leave none in its log.
// The real AG-01 gate still needs a physically printed card read by a person.

import { test, expect, type Locator, type Page, type Request } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
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
  await expect(linkCard.locator(".bg-relay")).toHaveClass(/\bm-expired\b/); // the release path is drawn cut, not open
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

// Demo reset is confirmed in the app's own dialog, never a native one. Opening
// and cancelling never reset; one confirmation sends exactly one reset. It seeds
// its own disposable data when the service is empty, so it also runs alone
// (-g "Demo reset"). In the full file it runs last: it deletes this test
// service's demo data.
test("Demo reset: in-app confirmation in both apps; cancel never resets; confirm resets once", async ({ page }) => {
  test.setTimeout(240_000);
  const native: string[] = [];
  page.on("dialog", (d) => {
    native.push(d.type());
    void d.dismiss(); // never accept a native dialog
  });
  const isReset = (r: Request) => r.method() === "POST" && new URL(r.url()).pathname === "/api/demo/reset";
  const sent: string[] = [];
  const answered: number[] = [];
  page.on("request", (r) => {
    if (isReset(r)) sent.push(r.url());
  });
  page.on("response", (r) => {
    if (isReset(r.request())) answered.push(r.status());
  });
  const trigger = page.getByRole("group", { name: "Demo controls" }).getByRole("button", { name: "Reset demo", exact: true });
  const dialog = page.getByRole("dialog", { name: "Reset the demo?" });
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  const confirm = dialog.getByRole("button", { name: "Reset all demo data" });
  const keyMarker = (write: boolean) =>
    page.evaluate(
      (w) =>
        new Promise<unknown>((resolve, reject) => {
          const req = indexedDB.open("coven-last-light", 1);
          req.onupgradeneeded = () => req.result.createObjectStore("keys");
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const tx = req.result.transaction("keys", w ? "readwrite" : "readonly");
            const op = w ? tx.objectStore("keys").put("fictional", "e2e:reset-marker") : tx.objectStore("keys").get("e2e:reset-marker");
            tx.oncomplete = () => {
              req.result.close();
              resolve(w ? true : op.result);
            };
            tx.onerror = () => reject(tx.error);
          };
        }),
      write,
    );
  const keyCount = (dbName: string) =>
    page.evaluate(
      (name) =>
        new Promise<number>((resolve, reject) => {
          const req = indexedDB.open(name, 1);
          req.onupgradeneeded = () => req.result.createObjectStore("keys");
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const tx = req.result.transaction("keys", "readonly");
            const count = tx.objectStore("keys").count();
            tx.oncomplete = () => {
              req.result.close();
              resolve(count.result);
            };
            tx.onerror = () => reject(tx.error);
          };
        }),
      dbName,
    );
  const setupButton = page.getByRole("button", { name: "Set up demo" });
  const llReady = page.getByRole("heading", { name: /The Hollow family vault/ });
  const bgReady = page.getByRole("heading", { name: "Sealed items" });
  /** Set up this test's own fictional data if the app has none yet. */
  const seed = async (url: string, ready: Locator) => {
    await page.goto(url);
    await expect(setupButton.or(ready)).toBeVisible({ timeout: 30_000 });
    if (await setupButton.isVisible()) {
      await setupButton.click();
      await expect(ready).toBeVisible({ timeout: 90_000 });
    }
  };
  await seed(LL, llReady);
  await seed(BG, bgReady);

  for (const [url, app, slug] of [[LL, "Last Light", "last-light"], [BG, "Break Glass", "break-glass"]] as const) {
    await page.goto(url);
    await expect(trigger).toBeEnabled();

    // Mouse opens, Escape cancels; focus starts on Cancel and returns to the trigger.
    await trigger.click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("both apps, Last Light and Break Glass, on this demo service");
    await expect(dialog).toContainText(`${app} demo keys stored in this browser`);
    await expect(cancel).toBeFocused();
    expect(await dialog.evaluate((d) => getComputedStyle(d).animationName)).toBe("coven-dialog-in");
    await dialog.evaluate((d) => Promise.all(d.getAnimations().map((a) => a.finished)).then(() => true));
    await page.screenshot({ path: join(dir, `reset-dialog-${slug}.png`) });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    // Keyboard only: Enter opens, Tab reaches the destructive action, Shift+Tab and Enter cancel.
    await page.keyboard.press("Enter");
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(confirm).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    // The Cancel button, with reduced motion: no entrance animation.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await trigger.click();
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((d) => getComputedStyle(d).animationName)).toBe("none");
    await cancel.click();
    await expect(dialog).toBeHidden();
    await page.emulateMedia({ reducedMotion: null });
  }
  expect(sent).toHaveLength(0); // opening and cancelling never reset

  // A failed reset stays visible in the dialog and can be cancelled. The service is not reached.
  await page.route("**/api/demo/reset", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "forced_failure" }) }),
  );
  await trigger.click();
  await confirm.click();
  await expect(dialog.getByRole("alert")).toContainText("The reset did not finish");
  await expect(dialog).toBeVisible();
  await expect(confirm).toBeEnabled();
  await page.unroute("**/api/demo/reset");
  await cancel.click();
  await expect(dialog).toBeHidden();
  expect(answered).toEqual([500]);

  // Confirm for real, on this test service's disposable data only. A double
  // click sends one reset; the app reloads into setup, the other app's data is
  // gone too, and so are the demo keys this browser held for the app.
  await page.goto(LL);
  await expect(llReady).toBeVisible();
  await keyMarker(true);
  expect(await keyCount("coven-last-light")).toBeGreaterThan(0);
  await trigger.click();
  let reloaded = page.waitForEvent("load");
  await confirm.dblclick();
  await reloaded;
  await expect(page.getByRole("heading", { name: "Set up the fictional family" })).toBeVisible({ timeout: 30_000 });
  expect(answered).toEqual([500, 200]);
  expect(sent).toHaveLength(2);
  expect(await keyMarker(false)).toBeUndefined();
  expect(await keyCount("coven-last-light")).toBe(0);

  // Break Glass data went with it. Seed Break Glass again, then reset from Break Glass.
  await page.goto(BG);
  await expect(page.getByRole("heading", { name: "Set up the fictional team" })).toBeVisible({ timeout: 30_000 });
  await seed(BG, bgReady);
  expect(await keyCount("coven-break-glass")).toBeGreaterThan(0);
  await trigger.click();
  reloaded = page.waitForEvent("load");
  await confirm.click();
  await reloaded;
  await expect(page.getByRole("heading", { name: "Set up the fictional team" })).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toBeHidden();
  expect(answered).toEqual([500, 200, 200]);
  expect(sent).toHaveLength(3);
  expect(await keyCount("coven-break-glass")).toBe(0);
  expect(native).toEqual([]);
});

// ---------------------------------------------------------------------------
// Review blockers: setup across both apps, interrupted setup, lost answers and
// load failures. Each test resets this test service first, so it also runs alone.

const ITEM_IDS = ["aws-root", "registrar-codes", "release-signing"];

async function resetFrom(page: Page, url: string) {
  await page.goto(url);
  await page.getByRole("group", { name: "Demo controls" }).getByRole("button", { name: "Reset demo", exact: true }).click();
  const reloaded = page.waitForEvent("load");
  await page.getByRole("dialog", { name: "Reset the demo?" }).getByRole("button", { name: "Reset all demo data" }).click();
  await reloaded;
}

async function seedLL(page: Page) {
  await page.goto(LL);
  await page.getByRole("button", { name: "Set up demo" }).click();
  await expect(page.getByRole("heading", { name: /The Hollow family vault/ })).toBeVisible({ timeout: 90_000 });
}

async function bgItems(page: Page): Promise<{ item_id: string; seal_version_id: string | null }[]> {
  return page.evaluate(async () => (await fetch("/api/bg/items", { headers: { "X-Coven-App": "break-glass" }, cache: "no-store" })).json());
}

async function seedBG(page: Page) {
  await page.goto(BG);
  await page.getByRole("button", { name: "Set up demo" }).click();
  await expect(page.getByRole("heading", { name: "Sealed items" })).toBeVisible({ timeout: 90_000 });
  const items = await bgItems(page);
  expect(items.map((i) => i.item_id).sort()).toEqual([...ITEM_IDS].sort());
  expect(items.every((i) => i.seal_version_id), "every item sealed, aws-root included").toBe(true);
}

/**
 * Send the request (it commits), then lose its answer: the page gets a gateway
 * error instead of the real 200. The request goes straight to this test
 * service from Node, with the page's own cookies: replaying it through
 * route.fetch() and the preview proxy once stalled with the service already
 * answered, and route.abort() after a fetch did not always fail the page's request.
 */
const SERVICE_URL = "http://127.0.0.1:8797";
const loseAnswer = async (route: import("@playwright/test").Route) => {
  const req = route.request();
  const url = new URL(req.url());
  const cookies = await req.frame().page().context().cookies(req.url());
  const res = await fetch(SERVICE_URL + url.pathname + url.search, {
    method: req.method(),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Coven-App": req.headers()["x-coven-app"] ?? "",
      Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    },
    body: req.method() === "GET" ? undefined : (req.postDataBuffer() ?? undefined),
    signal: AbortSignal.timeout(15_000),
  });
  await res.arrayBuffer();
  await route.fulfill({ status: 502, contentType: "application/json", body: '{"error":"bad_gateway"}' });
};

test("Demo setup: both apps seed in one browser, and a reset from either app lets both seed again", async ({ page }) => {
  test.setTimeout(480_000);
  await resetFrom(page, LL);
  await seedLL(page);
  await seedBG(page);

  // From Last Light: the service forgets every enrollment; only Last Light's browser keys go.
  await resetFrom(page, LL);
  await seedBG(page); // Break Glass re-binds the keys it kept, and seals every item
  await seedLL(page);

  // And the other direction.
  await resetFrom(page, BG);
  await seedLL(page); // Last Light re-binds the keys it kept
  await seedBG(page);
});

test("Demo setup: an interrupted run shows how to finish, never a ready desk, and finishing adds nothing twice", async ({ page }) => {
  test.setTimeout(480_000);
  await resetFrom(page, LL);

  // Last Light: the vault and one letter are stored, then a letter's answer is lost.
  let lost = 0;
  await page.route((u) => /^\/api\/ll\/vaults\/[^/]+\/items$/.test(u.pathname), async (route) => {
    if (route.request().method() === "POST" && lost++ === 1) return loseAnswer(route);
    return route.continue();
  });
  await page.goto(LL);
  await page.getByRole("button", { name: "Set up demo" }).click();
  await expect(page.locator(".ll-setupcard .error")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole("heading", { name: "Finish the demo setup" })).toBeVisible({ timeout: 30_000 }); // the error stays
  await page.unrouteAll({ behavior: "wait" });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Finish the demo setup" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Setup did not finish · 2 of 3 letters sealed/)).toBeVisible();
  await expect(page.getByRole("heading", { name: /The Hollow family vault/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Set up demo" }).click();
  await expect(page.getByRole("heading", { name: /The Hollow family vault/ })).toBeVisible({ timeout: 90_000 });
  const vaults = await page.evaluate(async () => (await fetch("/api/ll/vaults", { headers: { "X-Coven-App": "last-light" } })).json());
  expect(vaults).toHaveLength(1);
  expect(vaults[0].items.map((i: { label: string }) => i.label).sort()).toEqual(
    ["Home Wi-Fi and router", "Letter for Esme's 18th birthday", "Letter to the family"],
  );

  // Break Glass: aws-root is sealed but its answer is lost.
  await page.route((u) => u.pathname === "/api/bg/items/aws-root/seal-versions", loseAnswer, { times: 1 });
  await page.goto(BG);
  await page.getByRole("button", { name: "Set up demo" }).click();
  await expect(page.locator(".bg-setup .error")).toBeVisible({ timeout: 90_000 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Finish the demo setup" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Sealed items" })).toHaveCount(0);
  const before = (await bgItems(page)).find((i) => i.item_id === "aws-root")!.seal_version_id;
  expect(before).toBeTruthy();
  await page.getByRole("button", { name: "Set up demo" }).click();
  await expect(page.getByRole("heading", { name: "Sealed items" })).toBeVisible({ timeout: 90_000 });
  const after = await bgItems(page);
  expect(after).toHaveLength(3);
  expect(after.every((i) => i.seal_version_id)).toBe(true);
  expect(after.find((i) => i.item_id === "aws-root")!.seal_version_id).toBe(before); // not resealed
});

test("Lost answers: a recovery or petition opened while its answer was lost is adopted here and still opens", async ({ page }) => {
  test.setTimeout(480_000);
  await resetFrom(page, LL);
  await seedLL(page);
  await page.getByRole("button", { name: "+30 days" }).click();
  await page.getByRole("button", { name: "+30 days" }).click();
  await expect(page.getByTestId("lantern-state")).toHaveText("Handover");

  // Ada opens the recovery; the service commits, then the answer and the read-back are both lost.
  await signInAs(page, "Ada");
  let reads = 0;
  await page.route((u) => u.pathname.endsWith("/recoveries"), loseAnswer, { times: 1 });
  await page.route((u) => /^\/api\/ll\/vaults\/[0-9a-f-]{36}$/.test(u.pathname), async (route) => {
    if (reads++ === 1) return route.abort("failed"); // the read-back after the lost answer
    return route.continue();
  });
  await page.getByRole("button", { name: /Open a recovery/ }).click();
  await expect(page.locator(".ll-action .error")).toBeVisible();
  await page.unrouteAll({ behavior: "wait" });

  // On the next load the recovery is adopted by the key this browser kept before the request.
  await page.reload();
  await expect(page.getByText(/Recovery by Ada · Open/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("missing-recovery-key")).toHaveCount(0);
  await expect(page.getByText(/one-time key is not in this browser|does not hold the recovery's one-time key/)).toHaveCount(0);
  await page.getByRole("button", { name: "Use my stored share" }).click();
  await expect(page.getByText(/shares 1 of 3/)).toBeVisible();
  for (const who of ["Bram", "Cleo"]) {
    await signInAs(page, who);
    await page.getByRole("button", { name: "Use my stored share" }).click();
    await expect(page.getByText(new RegExp(`shares ${who === "Bram" ? 2 : 3} of 3`))).toBeVisible();
  }
  await signInAs(page, "Ada");
  await page.getByRole("button", { name: "Fetch the package and rebuild the key here" }).click();
  await expect(page.getByText(/Vault key rebuilt and verified in this browser \(header check passed\)/)).toBeVisible();

  // Break Glass: Robin opens a petition and its answer is lost; the read-back adopts it.
  await resetFrom(page, BG);
  await seedBG(page);
  await signInAs(page, "Robin");
  let dropped = false;
  await page.route((u) => u.pathname === "/api/bg/petitions", async (route) => {
    if (route.request().method() === "POST" && !dropped) {
      dropped = true;
      return loseAnswer(route);
    }
    return route.continue();
  });
  await page.getByRole("button", { name: "New petition" }).click();
  await page.getByLabel("Item", { exact: true }).selectOption({ label: "Domain registrar recovery codes (fictional)" });
  await page.getByLabel("Reason").fill("Lost answer (fictional)");
  await page.getByRole("button", { name: "Open petition" }).click();
  const card = page.getByRole("article").filter({ hasText: "Lost answer (fictional)" });
  await expect(card.getByText("Waiting for approvals. Nothing is released before quorum.")).toBeVisible({ timeout: 30_000 });
  const listed = await page.evaluate(async () => (await fetch("/api/bg/petitions", { headers: { "X-Coven-App": "break-glass" } })).json());
  expect(listed).toHaveLength(1); // no duplicate petition
  for (const who of ["Ash", "Wren"]) {
    await signInAs(page, who);
    await card.getByRole("button", { name: /^Approve:/ }).click();
    await expect(card.getByText(/You approved|Approved/).first()).toBeVisible();
  }
  await signInAs(page, "Robin");
  await card.getByRole("button", { name: "Retrieve and decrypt in this browser" }).click();
  await expect(page.locator(".secret")).toHaveText(/8F2K-QX7M/);
});

test("Load failures: session, list and ticket errors show a retry, never an empty setup", async ({ page }) => {
  test.setTimeout(480_000);
  await resetFrom(page, LL);
  await seedLL(page);

  // Last Light: the vault list fails once.
  await page.route((u) => u.pathname === "/api/ll/vaults", (r) => r.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' }), { times: 1 });
  await page.reload();
  const llAlert = page.getByRole("alert").filter({ hasText: "Could not load the vault." });
  await expect(llAlert).toBeVisible();
  await expect(page.getByRole("heading", { name: "Set up the fictional family" })).toHaveCount(0);
  await llAlert.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: /The Hollow family vault/ })).toBeVisible();

  // The session read fails once at start-up.
  await page.route((u) => u.pathname === "/api/session", (r) =>
    r.request().method() === "GET" ? r.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' }) : r.continue(), { times: 1 });
  await page.reload();
  const sessionAlert = page.getByRole("alert").filter({ hasText: "Could not load your demo session." });
  await expect(sessionAlert).toBeVisible();
  await sessionAlert.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: /The Hollow family vault/ })).toBeVisible();

  // Break Glass: the item list fails once.
  await seedBG(page);
  await page.route((u) => u.pathname === "/api/bg/items", (r) => r.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' }), { times: 1 });
  await page.reload();
  const bgAlert = page.getByRole("alert").filter({ hasText: "Could not load the desk." });
  await expect(bgAlert).toBeVisible();
  await expect(page.getByRole("heading", { name: "Set up the fictional team" })).toHaveCount(0);
  await bgAlert.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Sealed items" })).toBeVisible();

  // A desk request that does not answer for 20 s (the stalled state seen in
  // review): after 12 s the desk says so with a retry instead of waiting silently.
  await page.route((u) => u.pathname === "/api/bg/petitions", async (route) => {
    await sleep(20_000);
    await route.continue().catch(() => undefined);
  }, { times: 1 });
  await page.reload();
  const hungAlert = page.getByRole("alert").filter({ hasText: "Could not load the desk." });
  await expect(hungAlert).toContainText("has not answered", { timeout: 20_000 });
  await hungAlert.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Sealed items" })).toBeVisible();
  await expect(hungAlert).toHaveCount(0);

  // A ticket fails once: the petition shows after a retry.
  await signInAs(page, "Robin");
  await page.getByRole("button", { name: "New petition" }).click();
  await page.getByLabel("Reason").fill("Ticket retry (fictional)");
  await page.getByRole("button", { name: "Open petition" }).click();
  const card = page.getByRole("article").filter({ hasText: "Ticket retry (fictional)" });
  await expect(card).toBeVisible();
  await page.route((u) => /^\/api\/bg\/petitions\/[0-9a-f-]{36}$/.test(u.pathname), (r) =>
    r.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' }), { times: 1 });
  await page.reload();
  const ticketAlert = page.getByRole("alert").filter({ hasText: "Could not load this petition." });
  await expect(ticketAlert).toBeVisible();
  await ticketAlert.getByRole("button", { name: "Try again" }).click();
  await expect(card.getByText("Waiting for approvals. Nothing is released before quorum.")).toBeVisible();
});

// ---------------------------------------------------------------------------
// Review follow-ups: rotation after Hide and reload, reseal drafts bound to one
// item, Deny confirmation, the expiry re-read, the next step and missing-key
// guidance in Last Light, and Refresh status. Each test resets this test service.

/** Move this test service's clock with a direct request (the page is not told) to `left` seconds before the petition ends. */
async function endInSeconds(page: Page, pid: string, left: number) {
  const s = await page.evaluate(
    async (id) => (await fetch(`/api/bg/petitions/${id}`, { headers: { "X-Coven-App": "break-glass" }, cache: "no-store" })).json(),
    pid,
  );
  const advance = Math.floor((Date.parse(s.expires_at) - Date.parse(s.server_now)) / 1000) - left;
  expect(advance).toBeGreaterThan(0);
  const status = await page.evaluate(
    async (seconds) =>
      (
        await fetch("/api/demo/clock", {
          method: "POST",
          headers: { "X-Coven-App": "break-glass", "Content-Type": "application/json" },
          body: JSON.stringify({ advance_seconds: seconds }),
        })
      ).status,
    advance,
  );
  expect(status).toBe(200);
}

/** GET requests for one petition's status, from now on. */
function ticketReads(page: Page, pid: string) {
  const seen: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "GET" && new URL(r.url()).pathname === `/api/bg/petitions/${pid}`) seen.push(r.url());
  });
  return seen;
}

test("Break Glass review: rotation after Hide and reload, a reseal draft bound to its item, Deny asks first, the ticket re-reads at expiry", async ({ page, browser }) => {
  test.setTimeout(480_000);
  await resetFrom(page, BG);
  await seedBG(page);
  const ticket = page.getByRole("region", { name: "Selected petition" });

  // (a) Retrieve, Hide, reload: rotation is still recordable, without the credential or a new retrieval.
  const r1 = await openAndApprove(page, "AWS root account (fictional)", "Rotation after reload (fictional)");

  // Another browser signed in as Robin holds no petition key: it says so and offers no retrieval.
  const other = await browser.newContext();
  const page2 = await other.newPage();
  await page2.goto(BG);
  await signInAs(page2, "Robin");
  await page2.goto(r1.link);
  const linkCard2 = page2.getByRole("region", { name: "Petition link" });
  await expect(linkCard2.getByTestId("petition-state")).toHaveText("Approved");
  await expect(linkCard2.locator(".bg-missing-key")).toContainText("This browser does not hold this petition's key");
  await expect(linkCard2.getByRole("button", { name: "Retrieve and decrypt in this browser" })).toHaveCount(0);
  await other.close();

  await signInAs(page, "Robin");
  await page.getByRole("button", { name: /Rotation after reload/ }).click();
  // The first retrieval commits but its answer is lost: the key stays here, and a retry opens it.
  await page.route((u) => u.pathname.endsWith("/release"), loseAnswer, { times: 1 });
  await ticket.getByRole("button", { name: "Retrieve and decrypt in this browser" }).click();
  await expect(ticket.locator(".error")).toBeVisible();
  await expect(ticket.getByTestId("petition-state")).toHaveText("Released");
  await expect(page.locator(".secret")).toHaveCount(0);
  await ticket.getByRole("button", { name: "Retrieve and decrypt in this browser" }).click();
  await expect(page.locator(".secret")).toHaveText(/Pumpkin-Lantern-4417/);
  await page.getByRole("button", { name: "Hide" }).click();
  await expect(page.locator(".secret")).toHaveCount(0);
  const releases: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/release")) releases.push(r.url());
  });
  await page.reload();
  await expect(ticket.getByTestId("petition-state")).toHaveText("Released");
  await expect(ticket.getByText("Opened in this browser; the petition key was deleted after decryption.")).toBeVisible();
  const rotate = ticket.getByRole("button", { name: "I rotated it in the issuing system" });
  await rotate.click();
  await expect(page.getByTestId("rotation-aws-root")).toHaveText("rotated");
  await expect(rotate).toHaveCount(0);
  await expect(page.locator(".secret")).toHaveCount(0);
  expect(releases).toEqual([]);

  // (b) A reseal draft belongs to the item it was typed for: switching or Cancel discards it.
  await signInAs(page, "Quinn");
  const before = await bgItems(page);
  const version = (list: typeof before, id: string) => list.find((i) => i.item_id === id)!.seal_version_id;
  const row = (name: string) => page.locator(".bg-item").filter({ hasText: name });
  const draft = page.locator("#new-secret");
  await row("AWS root account (fictional)").getByRole("button", { name: "Reseal" }).click();
  await draft.fill("Draft typed for AWS root (fictional)");
  await row("Domain registrar recovery codes (fictional)").getByRole("button", { name: "Reseal" }).click();
  await expect(page.getByRole("heading", { name: /^Reseal Domain registrar recovery codes/ })).toBeVisible();
  await expect(draft).toHaveValue("");
  await expect(page.getByRole("button", { name: "Seal new version" })).toBeDisabled();
  await row("AWS root account (fictional)").getByRole("button", { name: "Reseal" }).click();
  await expect(draft).toHaveValue(""); // the old draft does not come back either
  await draft.fill("Draft then cancelled (fictional)");
  await page.locator(".bg-reseal").getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".bg-reseal")).toHaveCount(0);
  await row("Domain registrar recovery codes (fictional)").getByRole("button", { name: "Reseal" }).click();
  await expect(draft).toHaveValue("");
  await draft.fill("NEW-REGISTRAR-CODES-7 (fictional)");
  await page.getByRole("button", { name: "Seal new version" }).click();
  await expect(page.locator(".bg-reseal")).toHaveCount(0);
  const after = await bgItems(page);
  expect(version(after, "aws-root")).toBe(version(before, "aws-root"));
  expect(version(after, "release-signing")).toBe(version(before, "release-signing"));
  expect(version(after, "registrar-codes")).not.toBe(version(before, "registrar-codes"));
  // What was sealed is exactly the text typed for that item.
  await openAndApprove(page, "Domain registrar recovery codes (fictional)", "Reseal check (fictional)");
  await signInAs(page, "Robin");
  await page.getByRole("button", { name: /Reseal check/ }).click();
  await ticket.getByRole("button", { name: "Retrieve and decrypt in this browser" }).click();
  await expect(page.locator(".secret")).toHaveText("NEW-REGISTRAR-CODES-7 (fictional)");
  await page.getByRole("button", { name: "Hide" }).click();

  // (c) Deny is terminal, so it asks first, in the page. Cancel and Escape send nothing.
  const denies: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/deny")) denies.push(r.url());
  });
  await page.getByRole("button", { name: "New petition" }).click();
  await page.getByLabel("Item", { exact: true }).selectOption({ label: "Release signing key passphrase (fictional)" });
  await page.getByLabel("Reason").fill("Deny check one (fictional)");
  await page.getByRole("button", { name: "Open petition" }).click();
  await expect(ticket.getByText("Waiting for approvals. Nothing is released before quorum.")).toBeVisible();
  await signInAs(page, "Sage");
  await page.getByRole("button", { name: /Deny check one/ }).click();
  const deny = ticket.getByRole("button", { name: "Deny", exact: true });
  const confirm = ticket.getByRole("group", { name: "Confirm deny" });
  await deny.click();
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(deny).toBeFocused();
  await deny.click();
  await expect(confirm).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(ticket.getByTestId("petition-state")).toHaveText("Awaiting quorum");
  expect(denies).toEqual([]);
  await deny.click();
  await confirm.getByRole("button", { name: "Deny petition" }).click();
  await expect(ticket.getByTestId("petition-state")).toHaveText("Denied");
  expect(denies).toHaveLength(1);
  // The item admin may deny an Approved petition (decision D2).
  await openAndApprove(page, "Release signing key passphrase (fictional)", "Deny check two (fictional)");
  await signInAs(page, "Quinn");
  await page.getByRole("button", { name: /Deny check two/ }).click();
  await expect(ticket.getByTestId("petition-state")).toHaveText("Approved");
  await ticket.getByRole("button", { name: "Deny as item admin" }).click();
  await confirm.getByRole("button", { name: "Deny petition" }).click();
  await expect(ticket.getByTestId("petition-state")).toHaveText("Denied");
  expect(denies).toHaveLength(2);

  // (d) When the window ends, the ticket reads the service once by itself (no click).
  const e1 = await openAndApprove(page, "Domain registrar recovery codes (fictional)", "Expiry reread one (fictional)");
  await signInAs(page, "Robin");
  await page.getByRole("button", { name: /Expiry reread one/ }).click();
  await expect(ticket.getByTestId("petition-state")).toHaveText("Approved");
  await expect(ticket.getByTestId("action-context")).toContainText("Requester Robin");
  await endInSeconds(page, e1.pid, 12);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(ticket.getByTestId("action-context")).toContainText(/\((1\d|\d) s left\)/);
  const reads1 = ticketReads(page, e1.pid);
  await expect(ticket.getByTestId("petition-state")).toHaveText("Expired", { timeout: 30_000 });
  await expect(ticket.getByText(/This link stopped working at/)).toBeVisible();
  await sleep(2000);
  expect(reads1).toHaveLength(1);

  // A failed re-read keeps the last status, marked possibly out of date, with a retry.
  await page.getByRole("button", { name: "New petition" }).click();
  await page.getByLabel("Retrieval window").selectOption("5");
  await page.getByLabel("Reason").fill("Expiry reread two (fictional)");
  await page.getByRole("button", { name: "Open petition" }).click();
  const card2 = page.getByRole("article").filter({ hasText: "Expiry reread two (fictional)" });
  await expect(card2.getByText("Waiting for approvals. Nothing is released before quorum.")).toBeVisible();
  const e2 = /#petition=([0-9a-f-]{36})$/.exec((await card2.getByRole("link", { name: "Petition link" }).getAttribute("href"))!)![1];
  await endInSeconds(page, e2, 12);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(ticket.getByTestId("action-context")).toContainText(/\((1\d|\d) s left\)/);
  await page.route(
    (u) => u.pathname === `/api/bg/petitions/${e2}`,
    (r) => (r.request().method() === "GET" ? r.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' }) : r.continue()),
    { times: 1 },
  );
  const retry = ticket.getByRole("alert").filter({ hasText: "Could not load the latest petition status." });
  await expect(retry).toBeVisible({ timeout: 30_000 });
  await expect(ticket.getByTestId("petition-state")).toHaveText("Awaiting quorum");
  await retry.getByRole("button", { name: "Try again" }).click();
  await expect(ticket.getByTestId("petition-state")).toHaveText("Expired");
  await expect(retry).toHaveCount(0);
});

test("Last Light review: the next step is in the stage, a second browser is told where the key is, Refresh status shows a new share", async ({ page, browser }) => {
  test.setTimeout(480_000);
  await resetFrom(page, LL);
  await seedLL(page);

  // Bram reads the word code off his card while the vault is lit.
  await signInAs(page, "Bram");
  await page.getByRole("button", { name: "Show my card" }).click();
  const bramWords = (await page.locator(".share-card .words").textContent())!.trim();
  await page.getByRole("button", { name: "Hide card" }).click();

  await signInAs(page, "Mara Hollow");
  await page.getByRole("button", { name: "+30 days" }).click();
  await page.getByRole("button", { name: "+30 days" }).click();
  await expect(page.getByTestId("lantern-state")).toHaveText("Handover");

  // One next step, in the stage and above the fold. Its button only moves focus to the existing control.
  await signInAs(page, "Ada");
  const next = page.locator(".ll-nextstep");
  await expect(next).toContainText("Open a recovery");
  await expect(next).toBeInViewport();
  const opens: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/recoveries")) opens.push(r.url());
  });
  await next.getByRole("button", { name: "Jump to the recovery controls" }).click();
  await expect(page.getByRole("button", { name: /Open a recovery as Ada/ })).toBeFocused();
  expect(opens).toEqual([]);
  await page.getByRole("button", { name: /Open a recovery as Ada/ }).click();
  await page.getByRole("button", { name: "Use my stored share" }).click();
  await expect(page.getByText(/shares 1 of 3/)).toBeVisible();
  expect(opens).toHaveLength(1);
  await expect(next).toContainText("Wait for more shares");
  await expect(page.getByTestId("missing-recovery-key")).toHaveCount(0);

  // A second browser signed in as the same Ada holds no recovery key, and says so.
  const other = await browser.newContext();
  const page2 = await other.newPage();
  const requests2 = recordRequests(page2);
  await page2.goto(LL);
  await signInAs(page2, "Ada");
  await expect(page2.getByText(/Recovery by Ada · Open/)).toBeVisible();
  await expect(page2.getByTestId("missing-recovery-key")).toBeVisible();
  await expect(page2.getByRole("button", { name: "Fetch the package and rebuild the key here" })).toBeDisabled();
  const next2 = page2.locator(".ll-nextstep");
  await expect(next2).toContainText("Fetch in the browser that opened this recovery");
  await next2.getByRole("button", { name: "Jump to the offline bundle" }).click();
  await expect(page2.locator('details[data-next="bundle"]')).toHaveAttribute("open", "");
  await expect(page2.locator('details[data-next="bundle"] > summary')).toBeFocused();

  // Bram adds his share from the second browser, typing the word code from his card.
  await signInAs(page2, "Bram");
  await page2.getByLabel(/type the word code/).fill(bramWords);
  await page2.getByRole("button", { name: "Submit share from card" }).click();
  await expect(page2.getByText(/shares 2 of 3/)).toBeVisible();

  // The first browser shows it after Refresh status: no reload, no role switch.
  await page.evaluate(() => ((window as unknown as { noReload?: boolean }).noReload = true));
  await expect(page.getByText(/shares 1 of 3/)).toBeVisible();
  await page.locator(".ll-readout").getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByText(/shares 2 of 3/)).toBeVisible();
  await expect(page.locator(".ll-status")).toHaveText("1 share to go");
  expect(await page.evaluate(() => (window as unknown as { noReload?: boolean }).noReload)).toBe(true);
  await expect(page.getByLabel("Signed in as")).toHaveValue("user:ada");

  // At quorum the second browser says the key is elsewhere; the first rebuilds it.
  await signInAs(page, "Cleo");
  await page.getByRole("button", { name: "Use my stored share" }).click();
  await expect(page.getByText(/shares 3 of 3/)).toBeVisible();
  await signInAs(page2, "Ada");
  await expect(page2.locator(".ll-status")).toHaveText("Quorum reached · key not in this browser");
  await signInAs(page, "Ada");
  await expect(next).toContainText("Fetch the package to rebuild the key here.");
  await page.getByRole("button", { name: "Fetch the package and rebuild the key here" }).click();
  await expect(page.getByText(/Vault key rebuilt and verified in this browser \(header check passed\)/)).toBeVisible();
  await page2.locator(".ll-readout").getByRole("button", { name: "Refresh status" }).click();
  await expect(page2.locator(".ll-status")).toHaveText("Package sent to Ada · key not in this browser");
  await expect(page2.locator(".secret")).toHaveCount(0);

  // The typed word code left the second browser only inside the sealed envelope.
  const forms = [bramWords, bramWords.replace(/-/g, ""), bramWords.toLowerCase(), bramWords.toLowerCase().replace(/-/g, "")];
  for (const r of requests2) for (const f of forms) expect(r).not.toContain(f);
  await other.close();
});

// After a real decryption, the fixture value and Hide are both fully on screen,
// with no scrolling and nothing over them, at both desktop sizes. Motion and
// reduced motion both keep that. Hide, reload and rotation still work after.
test("Break Glass layout: the decrypted value and Hide are on screen at 1280x720 and 1440x900", async ({ page }) => {
  test.setTimeout(480_000);
  await resetFrom(page, BG);
  await seedBG(page);
  const ticket = page.getByRole("region", { name: "Selected petition" });
  const passes = [
    { w: 1280, h: 720, motion: "no-preference" as const },
    { w: 1440, h: 900, motion: "no-preference" as const },
    { w: 1280, h: 720, motion: "reduce" as const },
  ];
  for (const [i, pass] of passes.entries()) {
    const reason = `Layout check ${pass.w}x${pass.h} ${pass.motion} (fictional)`;
    await openAndApprove(page, "AWS root account (fictional)", reason);
    await signInAs(page, "Robin");
    await page.emulateMedia({ reducedMotion: pass.motion });
    await page.setViewportSize({ width: pass.w, height: pass.h });
    await page.getByRole("button", { name: new RegExp(reason.replace(/[()]/g, "\\$&")) }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await ticket.getByRole("button", { name: "Retrieve and decrypt in this browser" }).click();
    const view = page.getByTestId("released-view");
    const secret = view.locator(".secret");
    const hide = view.getByRole("button", { name: "Hide", exact: true });
    await expect(secret).toHaveText("root@hollow-example.test / Pumpkin-Lantern-4417 (fictional)");
    await expect(ticket.locator(".bg-relay")).toHaveClass(/\bm-opened\b/);
    // Motion: the reveal runs (and finishes) with motion on; reduced motion has no animation at all.
    const anim = await view.evaluate((el) => getComputedStyle(el).animationName);
    expect(anim).toBe(pass.motion === "reduce" ? "none" : "bg-reveal");
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity));

    const geo = await page.evaluate(() => {
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
      };
      const view = document.querySelector('[data-testid="released-view"]')!;
      const secret = view.querySelector(".secret")!;
      const hide = Array.from(view.querySelectorAll("button")).find((b) => b.textContent === "Hide")!;
      // What a pointer near each corner and at the centre would hit: it must be the element itself.
      // (6 px in from each edge, inside any rounded corner.)
      const unobstructed = (el: Element) => {
        const r = el.getBoundingClientRect();
        const pts = [[r.x + 6, r.y + 6], [r.right - 6, r.y + 6], [r.x + 6, r.bottom - 6], [r.right - 6, r.bottom - 6], [r.x + r.width / 2, r.y + r.height / 2]];
        const misses = pts
          .map(([x, y]) => ({ x, y, hit: document.elementFromPoint(x, y) }))
          .filter((p) => !(p.hit !== null && (p.hit === el || el.contains(p.hit))))
          .map((p) => `${Math.round(p.x)},${Math.round(p.y)}:${p.hit ? `${p.hit.tagName}.${p.hit.className}` : "none"}`);
        return misses;
      };
      return {
        vw: window.innerWidth, vh: window.innerHeight, scrollY: window.scrollY, scrollX: window.scrollX,
        overflowX: document.documentElement.scrollWidth - window.innerWidth,
        secret: box(secret), hide: box(hide),
        secretClear: unobstructed(secret), hideClear: unobstructed(hide),
        secretClipped: secret.scrollWidth > secret.clientWidth || secret.scrollHeight > secret.clientHeight,
      };
    });
    const inView = (b: typeof geo.secret) => b.x >= 0 && b.y >= 0 && b.right <= geo.vw && b.bottom <= geo.vh && b.w > 0 && b.h > 0;
    const overlap = !(geo.secret.right <= geo.hide.x || geo.hide.right <= geo.secret.x || geo.secret.bottom <= geo.hide.y || geo.hide.bottom <= geo.secret.y);
    writeFileSync(join(dir, `break-glass-released-${pass.w}x${pass.h}-${pass.motion}.json`), JSON.stringify(geo, null, 2) + "\n");
    expect(geo.scrollY, "no scrolling").toBe(0);
    expect(geo.overflowX).toBe(0);
    expect(inView(geo.secret), `value on screen ${JSON.stringify(geo.secret)}`).toBe(true);
    expect(inView(geo.hide), `Hide on screen ${JSON.stringify(geo.hide)}`).toBe(true);
    expect(overlap, "value and Hide do not overlap").toBe(false);
    expect(geo.secretClear, "nothing covers the value").toEqual([]);
    expect(geo.hideClear, "nothing covers Hide").toEqual([]);
    expect(geo.secretClipped, "the value is not cut off").toBe(false);
    // Fictional fixture value only: this frame is the evidence for this size.
    await page.screenshot({ path: join(dir, `break-glass-released-${pass.w}x${pass.h}-${pass.motion}.png`) });

    // Hide still clears it; after a reload the metadata-only rotation action is still there.
    await hide.click();
    await expect(page.locator(".secret")).toHaveCount(0);
    if (i === 0) {
      await page.reload();
      await expect(ticket.getByTestId("petition-state")).toHaveText("Released");
      await expect(page.locator(".secret")).toHaveCount(0);
      await ticket.getByRole("button", { name: "I rotated it in the issuing system" }).click();
      await expect(page.getByTestId("rotation-aws-root")).toHaveText("rotated");
    }
  }
  await page.emulateMedia({ reducedMotion: "no-preference" });
});
