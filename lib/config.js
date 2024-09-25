/**
 * This file contains application config.
 * It is responsible for loading the config from env,
 * supplying defaults, and formatting values
 */

// Load the env vars from .env
require("dotenv").config();

// Parse out true and false string values
function parseValue(value) {
  if (value === "false") {
    return false;
  }

  if (value === "true") {
    return true;
  }

  return value;
}

// Object for TD related config, with defaults
const config = {
  TD_SPEAK: false,
  TD_ANALYTICS: false,
  TD_NOTIFY: false,
  TD_API_ROOT: "https://replayable-api-production.herokuapp.com",
  TD_DEV: parseValue(process.env["DEV"]),
};

// Find all env vars starting with TD_
for (let key in process.env) {
  if (key.startsWith("TD_")) {
    config[key] = parseValue(process.env[key]);
  }
}

if (config.TD_DEV) {
  console.info("Testdriverai config: ", config);
}

module.exports = config;
