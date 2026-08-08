import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixtureEpub } from "../fixtures/build-epubs.js";

let fixtureRoot:string;
let fixturePath:string;
test.beforeAll(async()=>{fixtureRoot=await mkdtemp(join(tmpdir(),"book-translator-e2e-"));fixturePath=await buildFixtureEpub(join(fixtureRoot,"fixture.epub"));});
test.afterAll(async()=>{await rm(fixtureRoot,{recursive:true,force:true});});

test("uploads, analyzes, translates, and exposes the EPUB download",async({page})=>{
  await page.goto("/new");
  await page.getByLabel("EPUB file").setInputFiles(fixturePath);
  await page.getByLabel("Title").fill("Fixture book");
  await page.getByRole("button",{name:"Upload and analyze"}).click();
  await expect(page.getByText("Status: ready.")).toBeVisible({timeout:15000});
  await page.getByRole("button",{name:"Start translation"}).click();
  await expect(page.getByText("Status: completed.")).toBeVisible({timeout:15000});
  await expect(page.getByRole("link",{name:"Download translated EPUB"})).toBeVisible();
});
