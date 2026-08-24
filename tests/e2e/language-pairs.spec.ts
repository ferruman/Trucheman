import { test, expect } from "@playwright/test";
test("shows the supported language pair controls", async ({ page }) => {
  await page.goto("/new");
  await expect(page.getByLabel("Source")).toBeVisible();
  await expect(page.getByLabel("Target")).toBeVisible();
  await expect(page.getByLabel("Quality mode")).toHaveValue("standard");
});
