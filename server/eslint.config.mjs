import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";
import pluginPrettier from "eslint-plugin-prettier";
import configPrettier from "eslint-config-prettier";
import unusedImports from "eslint-plugin-unused-imports";
import dataAccessPlugin from "./utils/dataAccess/eslintPluginDataAccess.mjs";

export default defineConfig([
  {
    ignores: [
      "__tests__/**",
      "node_modules/**",
      "public/**",
      "storage/**",
      "swagger/**",
      "**/syncStaticLists.mjs",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    plugins: {
      js,
      prettier: pluginPrettier,
      "unused-imports": unusedImports,
      "data-access": dataAccessPlugin,
    },
    extends: ["js/recommended"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      ...configPrettier.rules,
      "prettier/prettier": "error",
      "no-case-declarations": "off",
      "no-prototype-builtins": "off",
      "no-async-promise-executor": "off",
      "no-extra-boolean-cast": "off",
      "no-empty": "off",
      "no-unused-private-class-members": "warn",
      "no-unused-vars": "off",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "error",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
        },
      ],
      "data-access/no-direct-data-access": "error",
    },
  },
  { files: ["**/*.js"], languageOptions: { sourceType: "commonjs" } },
]);
