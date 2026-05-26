import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { loadDbEnv } from "./env";
import * as schema from "./schema";

let _client: ReturnType<typeof postgres> | null = null;
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getClient() {
  if (!_client) {
    const { DATABASE_URL } = loadDbEnv();
    _client = postgres(DATABASE_URL, {
      max: Number(process.env.DB_POOL_MAX ?? 10),
      idle_timeout: 30,
      connect_timeout: 10,
      prepare: false,
    });
  }
  return _client;
}

export function getDb() {
  if (!_db) {
    _db = drizzle(getClient(), { schema, casing: "snake_case" });
  }
  return _db;
}

export async function closeDb() {
  if (_client) {
    await _client.end({ timeout: 5 });
    _client = null;
    _db = null;
  }
}

export type Database = ReturnType<typeof getDb>;
