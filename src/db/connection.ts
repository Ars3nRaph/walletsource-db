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

    // Test connection
    await pool.query('SELECT CURRENT_TIMESTAMP');
    logger.info('PostgreSQL connection established');

    // Initialize schema on first call
    if (!schemaInitialized) {
      const schemaPath = path.join(__dirname, 'schema.sql');
      const schemaSql = await fs.readFile(schemaPath, 'utf-8');

      await pool.query(schemaSql);
      schemaInitialized = true;
      logger.info('Database schema initialized');
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
