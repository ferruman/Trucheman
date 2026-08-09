import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixtureEpub } from "../fixtures/build-epubs.js";

let fixtureRoot: string;
let fixturePath: string;
test.beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "book-translator-e2e-"));
  fixturePath = await buildFixtureEpub(join(fixtureRoot, "fixture.epub"));
});
test.afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

test("uploads, analyzes, translates, and exposes the EPUB download", async ({ page }) => {
  await page.goto("/new");
  await page.getByLabel("EPUB file").setInputFiles(fixturePath);
  await page.getByLabel("Title").fill("Fixture book");
  await page.getByRole("button", { name: "Add glossary term" }).click();
  await page.getByLabel("Glossary source term 1").fill("Cthulhu");
  await page.getByLabel("Glossary target term 1").fill("Ктулху");
  await page.getByLabel("Glossary category 1").fill("proper name");
  const configRequest = page.waitForRequest(
    (request) =>
      request.url().includes("/api/jobs/") &&
      request.url().endsWith("/config") &&
      request.method() === "PUT",
  );
  await page.getByRole("button", { name: "Upload and analyze" }).click();
  expect(JSON.parse((await configRequest).postData() ?? "{}").glossary).toEqual([
    expect.objectContaining({
      source: "Cthulhu",
      target: "Ктулху",
      category: "proper name",
      enabled: true,
    }),
  ]);
  await expect(page.getByText("Status: ready.")).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "Start translation" }).click();
  await expect(page.getByText("Status: completed.")).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("link", { name: "Download translated EPUB" })).toBeVisible();
  await page.getByRole("button", { name: "Delete job", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete this job?" });
  await expect(dialog).toContainText("This permanently removes the source EPUB");
  await dialog.getByRole("button", { name: "Delete job", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
});
