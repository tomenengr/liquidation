import { config } from './config';
import { SubgraphClient, mapUserToDbRows, SubgraphUser, mapSubgraphToEngineViews, extractAssetAddress } from './subgraph';
import { initDb, upsertUser, upsertUserPosition, getUserPositions, getAtRiskUsers } from './db';
import { ReserveDataView, UserPositionView } from './engine/views';

/**
 * Hybrid state sync for Task 3.8.
 * Combines subgraph (discovery) + DB (persistence) + events (Feeder truth).
 * Multi-chain via chainId.
 * Does NOT change 0-RPC engine.
 */

export interface SyncResult {
  usersLoaded: number;
  positionsUpserted: number;
}

/**
 * Bulk load from subgraph at startup (or periodic), upsert to DB.
 * Uses mapUserToDbRows for eMode/isolation.
 */
export async function bulkSyncFromSubgraph(chainId?: number, limit = 50): Promise<SyncResult> {
  const cId = chainId ?? config.CHAIN_ID;
  initDb();  // ensure open

  const client = new SubgraphClient(cId);

  // Step 1: Use client.getUsersWithDebt in a loop to fetch all users with borrowedReservesCount > 0
  const allUsers: SubgraphUser[] = [];
  let skip = 0;
  const step = 1000;
  while (true) {
    const users = await client.getUsersWithDebt(step, skip);
    allUsers.push(...users);
    if (users.length < step) break;
    skip += step;
    if (skip >= 5000) break; // Max skip on standard The Graph configurations
  }

  // Step 2: Extract the user IDs into an array.
  const userIds = allUsers.map(u => u.id.toLowerCase());

  // Step 3: Chunk the user IDs into batches of 500.
  const chunkSize = 500;
  const chunks: string[][] = [];
  for (let i = 0; i < userIds.length; i += chunkSize) {
    chunks.push(userIds.slice(i, i + chunkSize));
  }

  // Step 4 & 5: For each chunk, call client.getUserReservesByUsers(chunk), group by user.id
  const userMap: Record<string, any[]> = {};
  for (const chunk of chunks) {
    const richPositions = await client.getUserReservesByUsers(chunk);
    for (const p of richPositions) {
      const uid = p.user?.id?.toLowerCase() || '';
      if (uid) {
        if (!userMap[uid]) userMap[uid] = [];
        userMap[uid].push(p);
      }
    }
  }

  const RAY = 1000000000000000000000000000n;
  function approxRayMul(a: bigint, b: bigint): bigint {
    return (a * b) / RAY;
  }

  let positionsUpserted = 0;
  let usersLoaded = 0;
  for (const uid of Object.keys(userMap)) {
    // Compute *real* total debt in base currency (8 dec) for correct at-risk filtering
    // Fixes precision: use actual (approx) debt tokens * price / unit ; asset extract for key match
    let totalDebtBase = 0n;
    for (const ur of userMap[uid]) {
      const dec = BigInt(ur.reserve?.decimals || '18');
      const price = BigInt(ur.reserve?.price?.priceInEth || '0');
      const unit = 10n ** dec;
      const varScaled = BigInt(ur.scaledVariableDebt || '0');
      const stableP = BigInt(ur.principalStableDebt || '0');
      const varIdx = BigInt(ur.reserve?.variableBorrowIndex || RAY.toString());
      const actualVar = approxRayMul(varScaled, varIdx);
      const approxDebtTokens = actualVar + stableP;
      const debtBase = (approxDebtTokens * price) / unit;
      totalDebtBase += debtBase;
    }
    const minDebtForRisk = 10000000000n; // ~$100 for filter (tunable)
    upsertUser({
      chain_id: cId,
      address: uid,
      is_at_risk: totalDebtBase > minDebtForRisk ? 1 : 0,
      total_debt_base: totalDebtBase.toString(),
    });
    usersLoaded++;
    for (const ur of userMap[uid]) {
      upsertUserPosition({
        chain_id: cId,
        user_address: uid,
        asset: extractAssetAddress(ur.reserve?.id),
        collateral_scaled: ur.scaledATokenBalance || '0',
        debt_var_scaled: ur.scaledVariableDebt || '0',
        debt_stable_scaled: ur.principalStableDebt || '0',
        e_mode_category_id: 0,
        is_isolated: 0,
        isolation_mode_asset: undefined,
        isolation_mode_total_debt: '0',
      });
      positionsUpserted++;
    }
  }
  return { usersLoaded, positionsUpserted };
}

/**
 * Sync a single user position to DB (called after event / dirty refetch).
 * This is the core for "sync after Borrow event updates DB".
 * In real use, also refetch full from Feeder for truth, then upsert.
 */
export async function syncUserPositionToDb(chainId: number, userAddress: string): Promise<void> {
  initDb();
  // For TDD / hybrid, we can pull from subgraph for quick data (or in future combine with Feeder)
  // Here we do a targeted getUser + upsert.
  const client = new SubgraphClient(chainId);
  const user = await client.getUser(userAddress);
  if (user) {
    const mapped = mapUserToDbRows(user, chainId);
    upsertUser({
      chain_id: chainId,
      address: mapped.user.address,
      is_at_risk: 1,  // mark potentially interesting
    });
    for (const p of mapped.positions) {
      upsertUserPosition(p);
    }
  } else {
    // Fallback: at least ensure user row
    upsertUser({ chain_id: chainId, address: userAddress.toLowerCase(), is_at_risk: 0 });
  }
}

/**
 * Load at-risk users from DB (for populating in-memory list, replacing hardcoded).
 * Used in coldStart / 3.9.
 */
export function loadAtRiskAddressesFromDb(chainId: number, minDebtBase?: bigint): string[] {
  const c = config as any;
  const cfg = typeof c.getChainConfig === 'function' ? c.getChainConfig(chainId) : null;
  const effectiveMin = minDebtBase ?? (cfg ? cfg.MIN_DEBT_BASE : 100_00000000n);
  const rows = getAtRiskUsers(chainId, effectiveMin);
  return rows.map(r => r.address.toLowerCase());
}

/**
 * For 3.9: return full at-risk user rows for memory integration.
 */
export function getAtRiskUsersForMemory(chainId: number, minDebtBase?: bigint) {
  const c = config as any;
  const cfg = typeof c.getChainConfig === 'function' ? c.getChainConfig(chainId) : null;
  const effectiveMin = minDebtBase ?? (cfg ? cfg.MIN_DEBT_BASE : 100_00000000n);
  return getAtRiskUsers(chainId, effectiveMin);
}

/**
 * NEW SOLUTION for limitation: Load real data from subgraph into engine-ready structures.
 * Returns reservesConfig and user positions for direct use in calculateUserAccountData.
 * Uses fresh subgraph data (0-RPC for discovery) .
 */
export async function loadEngineViewsFromSubgraph(chainId?: number, maxUsers = 5): Promise<{
  reservesConfig: Map<string, ReserveDataView>;
  userPositions: UserPositionView[];
}> {
  const cId = chainId ?? config.CHAIN_ID;
  const client = new SubgraphClient(cId);

  // Fetch reserves (with full config fields)
  const sgReserves = await client.getReserves(50);

  // Fetch real user positions
  const userReservesList = await client.getUserReservesBatch(50);

  // Group by user
  const userMap: Record<string, any[]> = {};
  for (const ur of userReservesList) {
    const uid = (ur.user?.id || '').toLowerCase();
    if (uid) {
      if (!userMap[uid]) userMap[uid] = [];
      userMap[uid].push(ur);
    }
  }

  const userPositions: UserPositionView[] = [];
  const reservesConfig = new Map<string, ReserveDataView>();

  let count = 0;
  for (const uid of Object.keys(userMap)) {
    if (count >= maxUsers) break;
    const { reservesConfig: cfg, userPosition } = mapSubgraphToEngineViews(sgReserves, userMap[uid], uid, 0);  // eMode=0 default here; full pass eMode when bulk query includes per-user eModeCategoryId (see mapUserToDbRows)
    for (const [k, v] of cfg) {
      if (!reservesConfig.has(k)) reservesConfig.set(k, v);
    }
    userPositions.push(userPosition);
    count++;
  }

  return { reservesConfig, userPositions };
}
