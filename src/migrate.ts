import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "..", "migrations");

async function main() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`
  );
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM schema_migrations WHERE name = $1`, [f]);
    if (rowCount) {
      console.log(`  skip ${f}`);
      continue;
    }
    await pool.query(readFileSync(join(dir, f), "utf8"));
    await pool.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [f]);
    console.log(`  applied ${f}`);
  }
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
