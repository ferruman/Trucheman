import { test, expect } from "@playwright/test";
test("new job form has labeled controls",async({page})=>{await page.goto("/new");await expect(page.getByLabel("Title")).toBeVisible();await expect(page.getByRole("button",{name:"Upload and analyze"})).toBeVisible();});
