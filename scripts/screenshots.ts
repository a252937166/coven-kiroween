// Publishable screenshots of both apps at 1440 px and 390 px, against a
// disposable service. Revealed content (released credential, opened letters)
// is masked; no share card is ever on screen. Also checks for horizontal
// overflow and captures one keyboard-focus frame per app.
//
//   node --experimental-strip-types scripts/screenshots.ts <ll-url> <bg-url> <out-dir>

import { chromium, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [LL, BG, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const exe = process.env.PW_CHROMIUM;
const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
const report: Record<string, unknown>[] = [];

async function signInAs(page: Page, name: string) {
  const select = page.getByLabel("Signed in as");
  const value = await select.locator("option", { hasText: name }).first().getAttribute("value");
  await select.selectOption(value!);
  await page.waitForFunction((v) => (document.getElementById("persona") as HTMLSelectElement | null)?.value === v, value);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(250);
}

async function shoot(page: Page, name: string, maskSel: string[] = []) {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.waitForTimeout(250);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const file = join(out, `${name}-${width}.png`);
    await page.screenshot({ path: file, fullPage: true, mask: maskSel.map((s) => page.locator(s)), maskColor: "#5d6b7a" });
    report.push({ file, width, horizontalOverflowPx: overflow });
  }
}

// ---------------- Last Light
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  await page.goto(LL);
  await page.getByRole("button", { name: "Set up demo" }).waitFor();
  await shoot(page, "last-light-first-run");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Set up demo" }).click();
  await page.getByRole("heading", { name: /Hollow family/ }).first().waitFor({ timeout: 60_000 });
  await shoot(page, "last-light-owner");
  // keyboard focus frame
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.screenshot({ path: join(out, "last-light-focus-390.png") });
  report.push({ file: join(out, "last-light-focus-390.png"), focused: await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80)) });
  // Through to the main outcome: recovery by Ada with three stored shares.
  await page.getByRole("button", { name: "+30 days" }).click();
  await page.getByRole("button", { name: "+30 days" }).click();
  await page.getByTestId("lantern-state").filter({ hasText: "Handover" }).waitFor();
  await signInAs(page, "Ada");
  await page.getByRole("button", { name: /Open a recovery/ }).click();
  await page.getByRole("button", { name: "Use my stored share" }).click();
  for (const t of ["Bram", "Cleo"]) {
    await signInAs(page, t);
    await page.getByRole("button", { name: "Use my stored share" }).click();
    await page.getByText(/You submitted your share|shares 3 of 3/).first().waitFor();
  }
  await signInAs(page, "Ada");
  await shoot(page, "last-light-trustee-ready");
  await page.getByRole("button", { name: "Fetch the package and rebuild the key here" }).click();
  await page.getByText(/Vault key rebuilt and verified in this browser/).waitFor();
  await shoot(page, "last-light-released", [".ll-letter-body"]);
  await ctx.close();
}

// ---------------- Break Glass
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  await page.goto(BG);
  await page.getByRole("button", { name: "Set up demo" }).waitFor();
  await shoot(page, "break-glass-first-run");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Set up demo" }).click();
  await page.getByRole("heading", { name: "Sealed items" }).waitFor({ timeout: 60_000 });
  await signInAs(page, "Robin");
  await page.getByRole("button", { name: "New petition" }).click();
  await page.getByLabel("Reason").fill("Production database locked out (fictional)");
  await page.getByRole("button", { name: "Open petition" }).click();
  await page.getByText("Waiting for approvals. Nothing is released before quorum.").waitFor();
  await signInAs(page, "Sage");
  await page.getByRole("button", { name: /^Approve:/ }).click();
  await page.getByText("You approved. Another approval from you does not count.").waitFor();
  await signInAs(page, "Rowan");
  await shoot(page, "break-glass-approver");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.screenshot({ path: join(out, "break-glass-focus-390.png") });
  report.push({ file: join(out, "break-glass-focus-390.png"), focused: await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80)) });
  await page.getByRole("button", { name: /^Approve:/ }).click();
  await signInAs(page, "Robin");
  await page.getByRole("button", { name: "Retrieve and decrypt in this browser" }).click();
  await page.locator(".secret").waitFor();
  await shoot(page, "break-glass-released", [".secret"]);
  await ctx.close();
}

await browser.close();
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report.map((r) => ({ f: String(r.file).split("/").pop(), o: r.horizontalOverflowPx, focus: r.focused }))));
