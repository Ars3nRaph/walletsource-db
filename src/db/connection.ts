import pg from 'pg';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { logger } from '../utils/logger.js';
import { ErrorCode, WalletSourceError } from '../types/errors.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pool: pg.Pool | null = null;
let schemaInitialized = false;

export async function getDb(): Promise<pg.Pool> {
  if (pool && schemaInitialized) {
    return pool;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new WalletSourceError(
      ErrorCode.DB_CONNECTION_FAILED,
      'DATABASE_URL not set in environment'
    );
  }

  try {
    pool = new pg.Pool({ connectionString });

    // Force UTC timezone for all connections (fixes Windows timezone issues)
    await pool.query("SET timezone = 'UTC'");

    // Test connection
    await pool.query('SELECT CURRENT_TIMESTAMP');
    logger.info('PostgreSQL connection established (timezone: UTC)');

    // Initialize schema ONLY if tables don't exist (check DB, not memory variable)
    if (!schemaInitialized) {
      // Check if wallet_profiles table exists (indicator that schema is already loaded)
      const tableCheck = await pool.query(
        `SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public'
          AND table_name = 'wallet_profiles'
        )`
      );

      const tablesExist = tableCheck.rows[0].exists;

      if (!tablesExist) {
        // Tables don't exist → run schema.sql (will DROP and CREATE)
        const schemaPath = path.join(__dirname, 'schema.sql');
        const schemaSql = await fs.readFile(schemaPath, 'utf-8');
        await pool.query(schemaSql);
        logger.info('Database schema initialized (tables created)');
      } else {
        // Tables already exist → skip schema execution to preserve data
        logger.info('Database schema already exists (skipping initialization to preserve data)');
      }

      schemaInitialized = true;
    }

    return pool;
  } catch (error) {
    logger.error({ error }, 'Database connection failed');
    throw new WalletSourceError(
      ErrorCode.DB_CONNECTION_FAILED,
      'Failed to connect to PostgreSQL',
      { error }
    );
  }
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    schemaInitialized = false;
    logger.info('PostgreSQL connection closed');
  }
}
