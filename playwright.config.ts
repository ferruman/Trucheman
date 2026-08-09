import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  use: { baseURL: "http://127.0.0.1:4174" },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:4174",
    reuseExistingServer: false,
    env: {
      BOOK_TRANSLATOR_PROVIDER: "deterministic",
      BOOK_TRANSLATOR_PORT: "4174",
      BOOK_TRANSLATOR_DATA_DIR: "./test-results/e2e-data",
    },
  },
});
