import { newDb } from 'pg-mem';
import type { IMemoryDb } from 'pg-mem';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function createTestDb(): Promise<IMemoryDb> {
  const db = newDb();

  // Register common PostgreSQL functions that pg-mem doesn't implement by default
  db.public.registerFunction({
    name: 'current_database',
    returns: 'text' as never,
    implementation: () => 'test'
  });

  db.public.registerFunction({
    name: 'version',
    returns: 'text' as never,
    implementation: () => 'PostgreSQL 14 (pg-mem)'
  });

  db.public.registerFunction({
    name: 'now',
    returns: 'timestamp' as never,
    implementation: () => new Date()
  });

  // Note: PERCENTILE_CONT is not supported by pg-mem
  // This is a known limitation and works correctly in production PostgreSQL

  // Load schema
  const schemaPath = path.join(__dirname, '../src/db/schema.sql');
  const schema = await fs.readFile(schemaPath, 'utf-8');

  db.public.none(schema);

  // Load v4.0 migration
  const migrationPath = path.join(__dirname, '../src/db/migrations/v4_ride_the_rugger.sql');
  const migration = await fs.readFile(migrationPath, 'utf-8');

  db.public.none(migration);

  return db;
}
