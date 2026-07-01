import Database from 'better-sqlite3';
import * as path from 'path';
import { config } from './config';

export interface UserRow {
  chain_id: number;
  address: string;
  last_hf?: string;
  total_debt_base?: string;
  is_at_risk: number;
  last_update_block?: number;
}

export interface UserPositionRow {
  chain_id: number;
  user_address: string;
  asset: string;
  collateral_scaled?: string;
  debt_var_scaled?: string;
  debt_stable_scaled?: string;
  e_mode_category_id: number;      // eMode support - added per design NOW
  is_isolated: number;             // isolation mode support - added NOW
  isolation_mode_asset?: string;
  isolation_mode_total_debt?: string;
}

export interface ReserveRow {
  chain_id: number;
  asset: string;
  price_base?: string;
  liquidity_index?: string;
  borrow_index?: string;
}

export interface PriceHistoryRow {
  chain_id: number;
  asset: string;
  ts: number;
  price?: string;
  source?: string;
  block_number?: number;
}

let db: Database.Database | null = null;

function getDbPath(custom?: string): string {
  if (custom) return custom;
  return config.DB_PATH;
}

/**
 * Initialize (or open) the SQLite DB and ensure schema + indexes.
 * Safe to call multiple times (IF NOT EXISTS).
 */
export function initDb(customPath?: string): Database.Database {
  const dbPath = getDbPath(customPath);
  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!require('fs').existsSync(dir)) {
    require('fs').mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create tables (eMode + isolation fields included from day one)
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      chain_id INTEGER NOT NULL,
      address TEXT NOT NULL,
      last_hf TEXT,
      total_debt_base TEXT,
      is_at_risk INTEGER DEFAULT 0,
      last_update_block INTEGER,
      PRIMARY KEY (chain_id, address)
    );

    CREATE TABLE IF NOT EXISTS user_positions (
      chain_id INTEGER NOT NULL,
      user_address TEXT NOT NULL,
      asset TEXT NOT NULL,
      collateral_scaled TEXT,
      debt_var_scaled TEXT,
      debt_stable_scaled TEXT,
      e_mode_category_id INTEGER DEFAULT 0,
      is_isolated INTEGER DEFAULT 0,
      isolation_mode_asset TEXT,
      isolation_mode_total_debt TEXT DEFAULT '0',
      PRIMARY KEY (chain_id, user_address, asset)
    );

    CREATE TABLE IF NOT EXISTS reserves (
      chain_id INTEGER NOT NULL,
      asset TEXT NOT NULL,
      price_base TEXT,
      liquidity_index TEXT,
      borrow_index TEXT,
      PRIMARY KEY (chain_id, asset)
    );

    CREATE TABLE IF NOT EXISTS price_history (
      chain_id INTEGER NOT NULL,
      asset TEXT NOT NULL,
      ts INTEGER NOT NULL,
      price TEXT,
      source TEXT DEFAULT 'subgraph',
      block_number INTEGER,
      PRIMARY KEY (chain_id, asset, ts)
    );

    CREATE INDEX IF NOT EXISTS idx_users_at_risk ON users(chain_id, is_at_risk, total_debt_base DESC);
    CREATE INDEX IF NOT EXISTS idx_pos_user ON user_positions(chain_id, user_address);
    CREATE INDEX IF NOT EXISTS idx_price_asset_ts ON price_history(chain_id, asset, ts DESC);

    -- 3.11: drift history
    CREATE TABLE IF NOT EXISTS drifts (
      chain_id INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      user TEXT NOT NULL,
      source TEXT,
      hf_drift TEXT,
      col_drift TEXT,
      debt_drift TEXT,
      block_number INTEGER,
      PRIMARY KEY (chain_id, ts, user)
    );
    CREATE INDEX IF NOT EXISTS idx_drifts_user ON drifts(chain_id, user, ts DESC);
  `);

  return db;
}

export function getDb(): Database.Database {
  if (!db) {
    return initDb();
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** Upsert a user summary row (accepts partials; fills defaults) */
export function upsertUser(row: Partial<UserRow> & { chain_id: number; address: string }): void {
  const full: any = {
    last_hf: null,
    total_debt_base: null,
    is_at_risk: 0,
    last_update_block: null,
    ...row,
  };
  const stmt = getDb().prepare(`
    INSERT INTO users (chain_id, address, last_hf, total_debt_base, is_at_risk, last_update_block)
    VALUES (@chain_id, @address, @last_hf, @total_debt_base, @is_at_risk, @last_update_block)
    ON CONFLICT(chain_id, address) DO UPDATE SET
      last_hf = excluded.last_hf,
      total_debt_base = excluded.total_debt_base,
      is_at_risk = excluded.is_at_risk,
      last_update_block = excluded.last_update_block
  `);
  stmt.run(full);
}

/** Upsert a single user position (supports eMode + isolation) */
export function upsertUserPosition(row: UserPositionRow): void {
  const stmt = getDb().prepare(`
    INSERT INTO user_positions (
      chain_id, user_address, asset,
      collateral_scaled, debt_var_scaled, debt_stable_scaled,
      e_mode_category_id, is_isolated, isolation_mode_asset, isolation_mode_total_debt
    ) VALUES (
      @chain_id, @user_address, @asset,
      @collateral_scaled, @debt_var_scaled, @debt_stable_scaled,
      @e_mode_category_id, @is_isolated, @isolation_mode_asset, @isolation_mode_total_debt
    ) ON CONFLICT(chain_id, user_address, asset) DO UPDATE SET
      collateral_scaled = excluded.collateral_scaled,
      debt_var_scaled = excluded.debt_var_scaled,
      debt_stable_scaled = excluded.debt_stable_scaled,
      e_mode_category_id = excluded.e_mode_category_id,
      is_isolated = excluded.is_isolated,
      isolation_mode_asset = excluded.isolation_mode_asset,
      isolation_mode_total_debt = excluded.isolation_mode_total_debt
  `);
  stmt.run({
    ...row,
    e_mode_category_id: row.e_mode_category_id ?? 0,
    is_isolated: row.is_isolated ?? 0,
    isolation_mode_total_debt: row.isolation_mode_total_debt ?? '0',
  });
}

/** Query at-risk or high-debt users for a chain (for loading into engine) */
export function getAtRiskUsers(chainId: number, minDebtBase?: bigint): UserRow[] {
  let sql = `
    SELECT * FROM users 
    WHERE chain_id = ? AND (is_at_risk = 1 
  `;
  const params: any[] = [chainId];

  if (minDebtBase != null) {
    sql += ` OR CAST(total_debt_base AS INTEGER) >= ? `;
    params.push(minDebtBase.toString());
  }
  sql += `) ORDER BY CAST(total_debt_base AS INTEGER) DESC LIMIT 2000`;

  const stmt = getDb().prepare(sql);
  return stmt.all(...params) as UserRow[];
}

/** Get all positions for a specific user on chain */
export function getUserPositions(chainId: number, userAddress: string): UserPositionRow[] {
  const stmt = getDb().prepare(`
    SELECT * FROM user_positions 
    WHERE chain_id = ? AND user_address = ? 
    ORDER BY asset
  `);
  return stmt.all(chainId, userAddress.toLowerCase()) as UserPositionRow[];
}

/** Upsert reserve data (prices / indices from subgraph or events) */
export function upsertReserve(row: ReserveRow): void {
  const stmt = getDb().prepare(`
    INSERT INTO reserves (chain_id, asset, price_base, liquidity_index, borrow_index)
    VALUES (@chain_id, @asset, @price_base, @liquidity_index, @borrow_index)
    ON CONFLICT(chain_id, asset) DO UPDATE SET
      price_base = excluded.price_base,
      liquidity_index = excluded.liquidity_index,
      borrow_index = excluded.borrow_index
  `);
  stmt.run(row);
}

/** Record a price point (for volatility later) */
export function insertPriceHistory(row: Partial<PriceHistoryRow> & { chain_id: number; asset: string; ts: number }): void {
  const full = {
    price: null,
    source: 'subgraph',
    block_number: null,
    ...row,
  };
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO price_history (chain_id, asset, ts, price, source, block_number)
    VALUES (@chain_id, @asset, @ts, @price, @source, @block_number)
  `);
  stmt.run(full);
}

export function getRecentPrices(chainId: number, asset: string, limit = 100): PriceHistoryRow[] {
  const stmt = getDb().prepare(`
    SELECT * FROM price_history 
    WHERE chain_id = ? AND asset = ? 
    ORDER BY ts DESC LIMIT ?
  `);
  return stmt.all(chainId, asset.toLowerCase(), limit) as PriceHistoryRow[];
}

/** 3.11: insert drift record */
export function insertDrift(row: Partial<{ chain_id: number; ts: number; user: string; source?: string; hf_drift?: string; col_drift?: string; debt_drift?: string; block_number?: number }> & { chain_id: number; ts: number; user: string }): void {
  const full = { source: null, hf_drift: null, col_drift: null, debt_drift: null, block_number: null, ...row };
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO drifts (chain_id, ts, user, source, hf_drift, col_drift, debt_drift, block_number)
    VALUES (@chain_id, @ts, @user, @source, @hf_drift, @col_drift, @debt_drift, @block_number)
  `);
  stmt.run(full);
}

export function getRecentDrifts(chainId: number, user: string, limit = 10): any[] {
  const stmt = getDb().prepare(`
    SELECT * FROM drifts WHERE chain_id = ? AND user = ? ORDER BY ts DESC LIMIT ?
  `);
  return stmt.all(chainId, user.toLowerCase(), limit);
}
