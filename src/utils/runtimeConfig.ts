import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

const CONFIG_PATH = path.join(process.cwd(), 'runtime-config.json');

let _cache: any = null;
let _cacheTime = 0;
const CACHE_TTL_MS = 3000; // reload every 3s max

export function getRuntimeConfig(): any {
  const now = Date.now();
  if (_cache && (now - _cacheTime) < CACHE_TTL_MS) return _cache;
  
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    _cache = JSON.parse(raw);
    _cacheTime = now;
  } catch (e: any) {
    if (!_cache) {
      logger.warn({ error: e.message }, '⚠️ Failed to load runtime-config.json — using defaults');
      _cache = getDefaults();
      _cacheTime = now;
    }
  }
  return _cache;
}

export function updateRuntimeConfig(patch: any): any {
  const config = getRuntimeConfig();
  deepMerge(config, patch);
  config._updated = new Date().toISOString();
  config._version = (config._version || 0) + 1;
  
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  _cache = config;
  _cacheTime = Date.now();
  
  logger.info({ version: config._version }, '✅ Runtime config updated (no restart)');
  return config;
}

function deepMerge(target: any, source: any) {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) && target[key]) {
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
}

function getDefaults(): any {
  return {
    general: { max_position_sol: 0.35, max_open_positions: 7, hard_stop_pct: -20, fee_reserve_sol: 0.05 },
    tiers: { enabled: true, levels: [30, 60, 100, 200], sell_pct: 0.20, floor_offset_pct: 10 },
    strategies: {
      STD: { trail_default_pct: 22, trail_activate_pct: 15 },
      NEO: { trail_base_pct: 25, trail_tight_pct: 15, trail_activate_pct: 15 },
      SWARM: { trail_base_pct: 18, trail_mid_pct: 13, trail_tight_pct: 8, trail_activate_pct: 30 },
    }
  };
}
