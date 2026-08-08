import { test, expect } from "@playwright/test";
test("shows the supported language pair controls",async({page})=>{await page.goto("/new");await expect(page.locator("select")).toHaveCount(2);});
