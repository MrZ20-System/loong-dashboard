import type Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { schema } from "./schema.js";

export type LoongBoardDatabase = BetterSQLite3Database<typeof schema>;

export function createDrizzleDatabase(
  database: Database.Database,
): LoongBoardDatabase {
  return drizzle(database, { schema });
}
