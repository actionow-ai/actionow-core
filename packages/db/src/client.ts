import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema/index.js';

export type Database = ReturnType<typeof createDb>;

export function createDb(url: string): PostgresJsDatabase<typeof schema> {
  const sql = postgres(url, { max: 10 });
  return drizzle(sql, { schema });
}
