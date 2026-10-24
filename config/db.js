// config/db.js
require("dotenv").config();
const { Pool } = require("pg");

const env = process.env.NODE_ENV || "development";

const pool = new Pool({
  connectionString:
    env === "production"
      ? process.env.RENDER_DATABASE_URL_INTERNAL
      : process.env.RENDER_DATABASE_URL_EXTERNAL,

  ssl: {
    rejectUnauthorized: false, // Required for some managed cloud databases
  },
});

module.exports = pool;
