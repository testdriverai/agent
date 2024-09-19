const globals = require("globals");
const pluginJs = require("@eslint/js");

export default [
  { files: ["**/*.js"], languageOptions: { sourceType: "commonjs" } },
  { languageOptions: { globals: globals.browser } },
  { languageOptions: { globals: globals.node } },
  pluginJs.configs.recommended,
  { ignorePatterns: ["lib/subimage/opencv.js"] }, // Add this line
];
