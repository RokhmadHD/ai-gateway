import { getDb, closeDb } from "./client";
import { sql } from "drizzle-orm";

async function main() {
  const db = getDb();
  console.log("⚠  Dropping public schema…");
  await db.execute(sql`DROP SCHEMA public CASCADE`);
  await db.execute(sql`CREATE SCHEMA public`);
  console.log("✓ schema dropped & recreated");
}

main()
  .catch((err) => {
    console.error("✗ drop failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
