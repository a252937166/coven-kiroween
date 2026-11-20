// Hosted mode in a real browser. Two browser profiles (separate cookie jars and
// IndexedDB) use the same hosted apps, and each gets a private demo space. A
// sets up, switches personas, moves its demo clock and resets while B
// completes its own petition and its own recovery. Fictional data only.
// The stack (playwright.config.ts): service 8798 with --spaces-dir and the
// production cookie settings, Last Light on 5185, Break Glass on 5186.

import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HLL = "http://127.0.0.1:5185";
const HBG = "http://127.0.0.1:5186";
const dir = process.env.COVEN_E2E_DIR!;
const root = join(import.meta.dirname, "..");
const hostedLog = () => readFileSync(join(dir, "hosted-service.log"), "utf8");

async function profile(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests: string[] = [];
  page.on("request", (r) => requests.push(`${r.method()} ${r.url()}\n${r.postData() ?? ""}`));
  return { context, page, requests };
}

async function signInAs(page: Page, name: string) {
  const select = page.getByLabel("Signed in as");
  const value = await select.locator("option", { hasText: name }).first().getAttribute("value");
  await select.selectOption(value!);
  await expect(select).toHaveValue(value!);
}

/** Read an API route with this page's own cookies, as the app would. */
async function apiGet(page: Page, app: string, path: string) {
  return page.evaluate(
    async ([a, p]) => {
      const r = await fetch(p, { headers: { "X-Coven-App": a }, cache: "no-store" });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [app, path] as const,
  );
}

async function cookieJar(context: BrowserContext) {
  // Each profile here visits one hosted app only, so every cookie in it is that app's.
  return Object.fromEntries((await context.cookies()).map((c) => [c.name, c]));
}

/** Both cookies are host-only, Secure, HttpOnly, SameSite=Strict, and live for the idle lifetime. */
async function expectSpaceCookies(context: BrowserContext, slug: "ll" | "bg") {
  const jar = await cookieJar(context);
  for (const name of [`__Host-coven_space_${slug}`, `__Host-coven_session_${slug}`]) {
    const c = jar[name];
    expect(c, name).toBeTruthy();
    expect(c.httpOnly, name).toBe(true);
    expect(c.secure, name).toBe(true);
    expect(c.sameSite, name).toBe("Strict");
    expect(c.path, name).toBe("/");
    expect(c.domain, name).toBe("127.0.0.1"); // host-only: no leading dot
    expect(c.expires, name).toBeGreaterThan(Date.now() / 1000 + 6.9 * 86400);
  }
  return jar[`__Host-coven_space_${slug}`].value;
}

async function setUp(page: Page, url: string, empty: string, ready: string | RegExp) {
  await page.goto(url);
  await expect(page.getByRole("heading", { name: empty })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Set up demo" }).click();
  await expect(page.getByRole("heading", { name: ready })).toBeVisible({ timeout: 90_000 });
}

/** Reset from the app's own dialog, which names this browser's private space. */
async function resetHere(page: Page, app: "Last Light" | "Break Glass") {
  await page.getByRole("group", { name: "Demo controls" }).getByRole("button", { name: "Reset demo", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Reset the demo?" });
  await expect(dialog).toContainText(`your private ${app} demo space, which only this browser uses`);
  await expect(dialog).toContainText("Other people's demos are not affected.");
  await expect(dialog).not.toContainText("both apps");
  const reloaded = page.waitForEvent("load");
  await dialog.getByRole("button", { name: "Reset all demo data" }).click();
  await reloaded;
}

async function openPetition(page: Page, reason: string, item?: string) {
  await signInAs(page, "Robin");
  await page.getByRole("button", { name: "New petition" }).click();
  if (item) await page.getByLabel("Item", { exact: true }).selectOption({ label: item });
  await page.getByLabel("Retrieval window").selectOption("15");
  await page.getByLabel("Reason").fill(reason);
  await page.getByRole("button", { name: "Open petition" }).click();
  const card = page.getByRole("article").filter({ hasText: reason });
  await expect(card.getByText("Waiting for approvals. Nothing is released before quorum.")).toBeVisible();
  const link = (await card.getByRole("link", { name: "Petition link" }).getAttribute("href"))!;
  return { card, pid: /#petition=([0-9a-f-]{36})$/.exec(link)![1] };
}

test("Hosted Break Glass: two browsers keep private spaces while A moves its clock and resets and B completes a petition", async ({ browser }) => {
  test.setTimeout(480_000);
  const A = await profile(browser);
  const B = await profile(browser);

  // A sets up first; B still starts from an empty desk, then sets up its own.
  await setUp(A.page, HBG, "Set up the fictional team", "Sealed items");
  await setUp(B.page, HBG, "Set up the fictional team", "Sealed items");
  const spaceA = await expectSpaceCookies(A.context, "bg");
  const spaceB = await expectSpaceCookies(B.context, "bg");
  expect(spaceA).not.toBe(spaceB);

  // B: Robin opens a 15-minute petition; Sage approves.
  const b = await openPetition(B.page, "Petition in space B (fictional)");
  await signInAs(B.page, "Sage");
  await b.card.getByRole("button", { name: /^Approve:/ }).click();
  await expect(b.card.getByText("You approved. Another approval from you does not count.")).toBeVisible();

  // A: its own petition, then an hour on its own clock: A's petition expires.
  const a = await openPetition(A.page, "Petition in space A (fictional)", "Domain registrar recovery codes (fictional)");
  await signInAs(A.page, "Quinn");
  await signInAs(A.page, "Robin");
  await A.page.getByRole("button", { name: "+30 min" }).click();
  await A.page.getByRole("button", { name: "+30 min" }).click();
  await expect(a.card.getByTestId("petition-state")).toHaveText("Expired");
  expect((await apiGet(A.page, "break-glass", "/api/demo/clock")).body.offset_seconds).toBe(3600);
  expect((await apiGet(B.page, "break-glass", "/api/demo/clock")).body.offset_seconds).toBe(0);
  expect((await apiGet(B.page, "break-glass", `/api/bg/petitions/${a.pid}`)).status).toBe(404); // not in B's space
  expect((await apiGet(A.page, "break-glass", `/api/bg/petitions/${b.pid}`)).status).toBe(404);

  // A resets while B's petition still needs one approval.
  await resetHere(A.page, "Break Glass");
  await expect(A.page.getByRole("heading", { name: "Set up the fictional team" })).toBeVisible({ timeout: 30_000 });

  // B: Rowan approves; Robin retrieves and decrypts in B's browser, inside the window B's clock kept.
  await signInAs(B.page, "Rowan");
  await b.card.getByRole("button", { name: /^Approve:/ }).click();
  const ticketB = B.page.getByRole("region", { name: "Selected petition" });
  await expect(ticketB.getByTestId("petition-state")).toHaveText("Approved");
  await signInAs(B.page, "Robin");
  await B.page.getByRole("button", { name: /Petition in space B/ }).click();
  await ticketB.getByRole("button", { name: "Retrieve and decrypt in this browser" }).click();
  await expect(B.page.locator(".secret")).toHaveText(/Pumpkin-Lantern-4417/);

  // B's session survives a reload: the same persona, the same space, the petition Released.
  await B.page.reload();
  await expect(B.page.getByLabel("Signed in as")).toHaveValue("user:robin");
  await expect(ticketB.getByTestId("petition-state")).toHaveText("Released");
  expect(await expectSpaceCookies(B.context, "bg")).toBe(spaceB);

  // A starts over in its own space (same cookie, emptied), its clock back at zero.
  await A.page.getByRole("button", { name: "Set up demo" }).click();
  await expect(A.page.getByRole("heading", { name: "Sealed items" })).toBeVisible({ timeout: 90_000 });
  expect((await apiGet(A.page, "break-glass", "/api/demo/clock")).body.offset_seconds).toBe(0);
  expect(await expectSpaceCookies(A.context, "bg")).toBe(spaceA);

  // Neither the credential nor any cookie value reached a request body or the hosted service log.
  const log = hostedLog();
  const values = [...Object.values(await cookieJar(A.context)), ...Object.values(await cookieJar(B.context))].map((c) => c.value);
  for (const v of values) expect(log).not.toContain(v);
  for (const hay of [log, ...A.requests, ...B.requests]) expect(hay).not.toContain("Pumpkin-Lantern-4417");
  await A.context.close();
  await B.context.close();
});

test("Hosted Last Light: B completes a recovery and an offline recovery while A moves its clock and resets", async ({ browser }) => {
  test.setTimeout(480_000);
  const A = await profile(browser);
  const B = await profile(browser);
  await setUp(A.page, HLL, "Set up the fictional family", /The Hollow family vault/);
  await setUp(B.page, HLL, "Set up the fictional family", /The Hollow family vault/);
  const spaceB = await expectSpaceCookies(B.context, "ll");
  expect(await expectSpaceCookies(A.context, "ll")).not.toBe(spaceB);

  // B: three trustees read the word codes off their own cards.
  const words: Record<string, string> = {};
  for (const name of ["Bram", "Dov", "Esme"]) {
    await signInAs(B.page, name);
    await B.page.getByRole("button", { name: "Show my card" }).click();
    words[name] = (await B.page.locator(".share-card .words").textContent())!.trim();
    await B.page.getByRole("button", { name: "Hide card" }).click();
  }

  // B's clock reaches Handover; A's vault stays Lit.
  await signInAs(B.page, "Mara Hollow");
  await B.page.getByRole("button", { name: "+30 days" }).click();
  await B.page.getByRole("button", { name: "+30 days" }).click();
  await expect(B.page.getByTestId("lantern-state")).toHaveText("Handover");
  await A.page.reload();
  await expect(A.page.getByTestId("lantern-state")).toHaveText("Lit");

  // B: Ada opens the recovery and adds her stored share.
  await signInAs(B.page, "Ada");
  await B.page.getByRole("button", { name: /Open a recovery as Ada/ }).click();
  await B.page.getByRole("button", { name: "Use my stored share" }).click();
  await expect(B.page.getByText(/shares 1 of 3/)).toBeVisible();

  // A, in the middle of B's recovery: its own clock to Handover and past, a persona switch, a reset.
  for (let i = 0; i < 3; i++) await A.page.getByRole("button", { name: "+30 days" }).click();
  await expect(A.page.getByTestId("lantern-state")).toHaveText("Handover");
  await signInAs(A.page, "Cleo");
  await resetHere(A.page, "Last Light");
  await expect(A.page.getByRole("heading", { name: "Set up the fictional family" })).toBeVisible({ timeout: 30_000 });

  // B, after a reload: still Ada, still Handover, still one share in.
  await B.page.reload();
  await expect(B.page.getByLabel("Signed in as")).toHaveValue("user:ada");
  await expect(B.page.getByTestId("lantern-state")).toHaveText("Handover");
  await expect(B.page.getByText(/shares 1 of 3/)).toBeVisible();
  await signInAs(B.page, "Bram");
  await B.page.getByLabel(/type the word code/).fill(words.Bram);
  await B.page.getByRole("button", { name: "Submit share from card" }).click();
  await expect(B.page.getByText(/shares 2 of 3/)).toBeVisible();
  await signInAs(B.page, "Cleo");
  await B.page.getByRole("button", { name: "Use my stored share" }).click();
  await expect(B.page.getByText(/shares 3 of 3/)).toBeVisible();
  await signInAs(B.page, "Ada");
  await B.page.getByRole("button", { name: "Fetch the package and rebuild the key here" }).click();
  await expect(B.page.getByText(/Vault key rebuilt and verified in this browser \(header check passed\)/)).toBeVisible();
  await expect(B.page.locator(".secret").first()).toContainText("blue pumpkin");
  await expect(B.page.getByTestId("lantern-state")).toHaveText("Released");

  // The paper format is unchanged: B's three printed word codes open B's bundle offline.
  await B.page.locator("summary", { hasText: "Offline bundle" }).click();
  const download = B.page.waitForEvent("download");
  await B.page.getByRole("button", { name: "Download bundle" }).click();
  const bundlePath = join(dir, "hosted-bundle.json");
  await (await download).saveAs(bundlePath);
  const cli = join(root, "core-ts/bin/recover.js");
  const out = spawnSync(process.execPath, [cli, bundlePath, "--share", words.Bram, "--share", words.Dov, "--share", words.Esme], { encoding: "utf8" });
  expect(out.status, out.stderr).toBe(0);
  expect(out.stdout).toContain("blue pumpkin");

  // A sets up again in its own, emptied space.
  await A.page.getByRole("button", { name: "Set up demo" }).click();
  await expect(A.page.getByRole("heading", { name: /The Hollow family vault/ })).toBeVisible({ timeout: 90_000 });
  await expect(A.page.getByTestId("lantern-state")).toHaveText("Lit");

  // No word code, card payload or cookie value in B's requests or the hosted service log.
  const log = hostedLog();
  const forms = Object.values(words).flatMap((w) => [w, w.replace(/-/g, ""), w.toLowerCase(), w.toLowerCase().replace(/-/g, "")]);
  for (const hay of [log, ...B.requests]) {
    for (const f of forms) expect(hay).not.toContain(f);
    expect(hay).not.toContain("coven1:");
  }
  const values = [...Object.values(await cookieJar(A.context)), ...Object.values(await cookieJar(B.context))].map((c) => c.value);
  for (const v of values) expect(log).not.toContain(v);
  expect(log).not.toMatch(/[A-Za-z0-9_-]{40,}/); // no token or space name at all
  await A.context.close();
  await B.context.close();
});
