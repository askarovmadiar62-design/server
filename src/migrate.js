import "dotenv/config";
import { readFile } from "node:fs/promises";
import { pool } from "./db.js";

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  const sql = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
  await pool.query(sql);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
