// Browser end-to-end tests for both demo apps against a fresh local service.
// Uses test-only ports so a running demo is not touched.
//   npm run build && npx playwright test -c e2e
// Set PW_CHROMIUM to a Chromium/Chrome binary to skip `npx playwright install chromium`.

import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = process.env.COVEN_E2E_DIR ?? mkdtempSync(join(tmpdir(), "coven-pw-"));
process.env.COVEN_E2E_DIR = dir;
const SERVICE = 8797;

export default defineConfig({
  testDir: ".",
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: join(dir, "results"),
  use: {
    headless: true,
    acceptDownloads: true,
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  webServer: [
    {
      command: `sh -c 'exec ../service/.venv/bin/python -m coven_service --port ${SERVICE} --db "${dir}/e2e.sqlite" > "${dir}/service.log" 2>&1'`,
      cwd: join(import.meta.dirname, "../service"),
      url: `http://127.0.0.1:${SERVICE}/api/personas`,
      reuseExistingServer: false,
    },
    {
      command: "npx vite preview --port 5183",
      cwd: join(import.meta.dirname, "../apps/last-light"),
      env: { COVEN_SERVICE: `http://127.0.0.1:${SERVICE}` },
      url: "http://127.0.0.1:5183",
      reuseExistingServer: false,
    },
    {
      command: "npx vite preview --port 5184",
      cwd: join(import.meta.dirname, "../apps/break-glass"),
      env: { COVEN_SERVICE: `http://127.0.0.1:${SERVICE}` },
      url: "http://127.0.0.1:5184",
      reuseExistingServer: false,
    },
  ],
});
