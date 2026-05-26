import { defineConfig } from "drizzle-kit";
import { loadDbEnv } from "./src/env";

const env = loadDbEnv();

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  casing: "snake_case",
  dbCredentials: { url: env.DATABASE_URL },
  strict: true,
  verbose: true,
});
