// Minimal flat ESLint config for the vanilla JS + Bun stack (ADR S-01).
// eslint recommended + browser globals for public/js + node/bun globals for server/.
import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "context/**",
      "reference-context/**",
      "project/**",
      "scripts/**",
      "examples/**",
      "tests/**",
      "upload/**",
      "download/**",
      "tool-results/**",
      "skills/**",
      ".zscripts/**",
      "db/**",
      "prisma/**",
      "public/vendor/**",
      "public/media/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["public/js/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.browser,
        // classic-script global exposed by the vendored socket.io client
        // dist (public/vendor/socket.io.min.js, loaded before the module
        // graph) - not an npm import.
        io: "readonly",
      },
    },
  },
  {
    files: ["server/**/*.js", "mini-services/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
        Bun: "readonly",
      },
    },
  },
];
