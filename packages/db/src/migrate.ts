import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getDb, closeDb } from "./client";

async function main() {
  console.log("Running migrations…");
  const db = getDb();
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("✓ migrations applied");
}

main()
  .catch((err) => {
    console.error("✗ migration failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
