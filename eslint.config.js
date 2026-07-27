import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    ignores: ["**/dist/**", "eslint.config.js", "scripts/check-docs.mjs", "**/examples/**/*.js", "**/examples/**/*.mjs", "packages/core/test/workspace-layout.test.mjs", "packages/core/test/herdr.test.ts"],
  },
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: { "@typescript-eslint/require-await": "off" },
  },
);