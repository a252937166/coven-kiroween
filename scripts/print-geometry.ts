// Print-boundary check for the Last Light share card. Value-free: it records
// layout and computed styles of the print subtree in print media, never text.
//
//   node --experimental-strip-types scripts/print-geometry.ts <app-url> <out.json> [<card.pdf>]
//
// Run against a disposable service (fresh database). Compare two outputs with
// `diff` to show a redesign left the printed card unchanged. The optional PDF
// is a share-bearing file: write it only to a private or scratch location.

import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

const [appUrl, out, pdf] = process.argv.slice(2);
const exe = process.env.PW_CHROMIUM;
const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

async function signInAs(name: string) {
  const select = page.getByLabel(/Signed in as|Viewing as/);
  const value = await select.locator("option", { hasText: name }).first().getAttribute("value");
  await select.selectOption(value!);
  await page.waitForFunction((v) => (document.getElementById("persona") as HTMLSelectElement | null)?.value === v, value);
  await page.waitForLoadState("networkidle");
}

await page.goto(appUrl);
await page.getByRole("button", { name: "Set up demo" }).click();
await page.getByRole("heading", { name: /Hollow family/ }).first().waitFor({ timeout: 60_000 });
await signInAs("Bram");
await page.getByRole("button", { name: "Show my card" }).click();
await page.locator(".share-card .words").waitFor();
await page.emulateMedia({ media: "print" });

const geometry = await page.evaluate(() => {
  window.scrollTo(0, 0);
  const root = document.querySelector(".print-area")!;
  const props = ["font-family", "font-size", "font-weight", "line-height", "letter-spacing", "word-spacing", "color",
    "background-color", "border-top-width", "border-top-style", "border-top-color", "border-radius", "padding-top",
    "padding-left", "margin-top", "margin-bottom", "visibility", "position", "display", "width", "height"];
  const nodes: Record<string, unknown>[] = [];
  const walk = (el: Element, path: string) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    nodes.push({
      path,
      tag: el.tagName.toLowerCase(),
      cls: el.getAttribute("class") ?? "",
      rect: [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 10) / 10),
      style: Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)])),
    });
    Array.from(el.children).forEach((c, i) => {
      if (c.tagName.toLowerCase() !== "path") walk(c, `${path}/${i}`);
    });
  };
  walk(root, "print-area");
  const visibleOutside = Array.from(document.body.querySelectorAll("*")).filter(
    (e) => !root.contains(e) && !e.contains(root) && getComputedStyle(e).visibility === "visible" && e.getClientRects().length > 0,
  ).length;
  return { nodes, visibleOutside, bodyBackground: getComputedStyle(document.body).backgroundColor };
});
writeFileSync(out, JSON.stringify(geometry, null, 2) + "\n");
if (pdf) await page.pdf({ path: pdf, format: "A4", printBackground: true });
await browser.close();
console.log(`print subtree nodes: ${geometry.nodes.length}; visible elements outside it: ${geometry.visibleOutside}`);
