import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**", "eval-results/**", "test-results/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // The remaining `any`s sit on genuinely untyped boundaries — provider JSON and the
      // xmldom node API. Kept visible as warnings instead of blocking the whole lint run.
      "@typescript-eslint/no-explicit-any": "warn",
      // Unused code is the thing this config exists to catch; `_`-prefixed names are the
      // established way this codebase marks deliberate discards.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
  prettier,
);
