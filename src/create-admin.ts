import { randomBytes } from "node:crypto";
import { pool } from "./db.js";
import { hashPassword } from "./password.js";
import { generateUniqueTag } from "./tag.js";

// Accounts are admin-created, not self-registered (see CLAUDE.md) -- which
// means something has to create the very first one. Run once against a
// fresh database: node dist/src/create-admin.js <username> [password]

async function main() {
  const [username, givenPassword] = process.argv.slice(2);
  if (!username) {
    console.error("usage: create-admin <username> [password]");
    process.exit(1);
  }

  const password = givenPassword ?? randomBytes(9).toString("base64url");
  const tag = await generateUniqueTag(pool);
  const passwordHash = await hashPassword(password);

  const { rows } = await pool.query(
    `INSERT INTO users (username, tag, password_hash, is_admin) VALUES ($1, $2, $3, TRUE)
     RETURNING id, username, tag`,
    [username, tag, passwordHash]
  );

  console.log(`Created admin ${rows[0].username} (${rows[0].id})`);
  console.log(`  tag:      ${rows[0].tag}`);
  if (!givenPassword) console.log(`  password: ${password}  (generated -- shown once, not stored anywhere else)`);

  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
