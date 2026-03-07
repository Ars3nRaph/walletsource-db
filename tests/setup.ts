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
    returns: 'text',
    implementation: () => 'test'
  });

  db.public.registerFunction({
    name: 'version',
    returns: 'text',
    implementation: () => 'PostgreSQL 14 (pg-mem)'
  });

  db.public.registerFunction({
    name: 'now',
    returns: 'timestamp',
    implementation: () => new Date()
  });

  // Load schema
  const schemaPath = path.join(__dirname, '../src/db/schema.sql');
  const schema = await fs.readFile(schemaPath, 'utf-8');

  db.public.none(schema);

  return db;
}
