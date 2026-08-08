import { test, expect } from "@playwright/test";
test("opens the new job screen",async({page})=>{await page.goto("/new");await expect(page.getByRole("heading",{name:"New book"})).toBeVisible();});
