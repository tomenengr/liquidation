import { config } from './config';
import { ReserveDataView, UserPositionView, UserReservePosition } from './engine/views';

/**
 * SubgraphClient for Aave V3 hosted subgraph (The Graph).
 * Task 3.6
 *
 * - Multi-chain via config
 * - Uses GRAPH_API_KEY when present
 * - Queries for borrowers + positions (with eMode / isolation support)
 * - Pagination ready
 */

export interface SubgraphReserve {
  id: string;
  price?: { priceInEth?: string };
  liquidityIndex?: string;
  variableBorrowIndex?: string;
  decimals?: number | string;
  reserveLiquidationThreshold?: number | string;
  reserveLiquidationBonus?: number | string;
  symbol?: string;
  eModeCategoryId?: number | string;  // for E-Mode support, if subgraph exposes per-reserve category
}

export interface SubgraphUserReserve {
  user?: { id: string };
  scaledATokenBalance?: string;
  scaledVariableDebt?: string;
  principalStableDebt?: string;
  stableBorrowRate?: string;
  stableRateLastUpdated?: number;
  usageAsCollateralEnabledOnUser?: boolean;
  reserve: SubgraphReserve;
}

export interface SubgraphUser {
  id: string;
  borrowedReservesCount?: string | number;
  userReserves: SubgraphUserReserve[];
  // eMode fields (subgraph dependent; we map what exists)
  eModeCategoryId?: number | string;
}

export class SubgraphClient {
  private endpoint: string;
  private apiKey: string;
  private chainId: number;

  constructor(chainId?: number) {
    this.chainId = chainId ?? config.CHAIN_ID;
    this.apiKey = config.getGraphApiKey();

    const base = config.getSubgraphUrl(this.chainId);
    const key = this.apiKey;

    // Prefer modern gateway if we have a real key.
    // 1. If the configured URL is already a full gateway URL, use it as-is.
    // 2. Otherwise, if we have a key + legacy name URL, auto-rewrite using known IDs.
    if (base.includes('/api/') && base.includes('/subgraphs/id/')) {
      // User provided a full gateway URL (possibly with key already in it)
      this.endpoint = base;
    } else if (key && key.length > 8 && key !== 'your_graph_api_key_here') {
      // Use official Aave Protocol V3 subgraphs (support reserves + userReserves queries + correct data)
      const subgraphIds: Record<number, string> = {
        1: 'Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g',       // Aave V3 Ethereum official
        42161: 'DLuE98kEb5pQNXAcKFQGQgfSQ57Xdou4jnVbAEqMfy3B',  // Aave V3 Arbitrum official
        8453: 'GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF',   // Aave V3 Base official
      };
      const id = subgraphIds[this.chainId];
      if (id) {
        this.endpoint = `https://gateway.thegraph.com/api/${key}/subgraphs/id/${id}`;
      } else {
        this.endpoint = base;
      }
    } else {
      this.endpoint = base;
    }
  }

  /**
   * Low-level GraphQL POST.
   * Injects api_key when available (for hosted).
   */
  private async fetchGraphQL<T>(query: string, variables: Record<string, any> = {}): Promise<T> {
    let url = this.endpoint;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Only append key for old-style endpoints that expect ?api_key=
    if (this.apiKey && this.apiKey.length > 8 && this.apiKey !== 'your_graph_api_key_here' && !url.includes('/api/')) {
      const sep = url.includes('?') ? '&' : '?';
      if (!url.includes('api_key=')) {
        url = `${url}${sep}api_key=${this.apiKey}`;
      }
    }

    const body = JSON.stringify({ query, variables });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Subgraph HTTP ${res.status}: ${text.slice(0, 180)}`);
      }

      const json = await res.json();

      if (json.errors && json.errors.length) {
        throw new Error(`GraphQL errors: ${JSON.stringify(json.errors).slice(0, 300)}`);
      }

      return json.data as T;
    } catch (err: any) {
      // Without a real GRAPH_API_KEY we tolerate network / deprecated endpoint issues
      // by returning empty data (test/demo). With key we let the error surface.
      if (this.apiKey && this.apiKey.length > 8) {
        throw err;
      }
      console.warn(`[SubgraphClient] fetch warning (no/invalid GRAPH_API_KEY or endpoint issue): ${err?.message || err}. Returning [] for graceful operation.`);
      return {} as T;  // caller will see empty arrays
    }
  }

  /**
   * Primary discovery: users who have borrowed (paginated).
   * Uses borrowedReservesCount > 0 as simple filter.
   * Later can add debt threshold post-filter or advanced where.
   */
  async getUsersWithDebt(first = 100, skip = 0): Promise<SubgraphUser[]> {
    const q = `
      query UsersWithDebt($first: Int!, $skip: Int!) {
        users(
          first: $first,
          skip: $skip,
          where: { borrowedReservesCount_gt: 0 },
          orderBy: borrowedReservesCount,
          orderDirection: desc
        ) {
          id
          borrowedReservesCount
          eModeCategoryId
          # Note: userReserves relation name can vary by subgraph deployment.
          # We keep it minimal here for compatibility.
        }
      }
    `;

    const data = await this.fetchGraphQL<{ users: SubgraphUser[] }>(q, { first, skip });
    return data?.users || [];
  }

  /**
   * Fetch detailed reserves data (prices, indices) - useful for price monitoring (Task 3.10)
   */
  async getReserves(first = 50): Promise<SubgraphReserve[]> {
    const q = `
      query GetReserves($first: Int!) {
        reserves(first: $first) {
          id
          symbol
          decimals
          price { priceInEth }
          liquidityIndex
          variableBorrowIndex
          reserveLiquidationThreshold
          reserveLiquidationBonus
        }
      }
    `;
    const data = await this.fetchGraphQL<{ reserves: SubgraphReserve[] }>(q, { first });
    return data?.reserves || [];
  }

  /**
   * Future: fetch single user full position (for dirty refetch)
   */
  async getUser(userAddress: string): Promise<SubgraphUser | null> {
    const q = `
      query GetUser($id: ID!) {
        user(id: $id) {
          id
          borrowedReservesCount
          eModeCategoryId
        }
      }
    `;
    const data = await this.fetchGraphQL<{ user: SubgraphUser | null }>(q, { id: userAddress.toLowerCase() });
    return data?.user || null;
  }

  /**
   * Fetch detailed user positions using userReserves entity for accurate scaled data.
   * Used for 0-RPC engine mapping.
   */
  async getUserReservesForUser(userAddress: string): Promise<SubgraphUserReserve[]> {
    const q = `
      query GetUserReserves($user: String!) {
        userReserves(where: { user: $user }) {
          scaledATokenBalance
          scaledVariableDebt
          principalStableDebt
          usageAsCollateralEnabledOnUser
          reserve {
            id
            symbol
            decimals
            price { priceInEth }
            liquidityIndex
            variableBorrowIndex
            reserveLiquidationThreshold
            reserveLiquidationBonus
          }
        }
      }
    `;
    const data = await this.fetchGraphQL<{ userReserves: SubgraphUserReserve[] }>(q, { user: userAddress.toLowerCase() });
    return data?.userReserves || [];
  }

  async getUserReservesBatch(first = 50): Promise<SubgraphUserReserve[]> {
    const q = `
      query GetUserReservesBatch($first: Int!) {
        userReserves(first: $first, where: { scaledVariableDebt_gt: "0" }) {
          user { id }
          scaledATokenBalance
          scaledVariableDebt
          principalStableDebt
          usageAsCollateralEnabledOnUser
          reserve {
            id
            symbol
            decimals
            price { priceInEth }
            liquidityIndex
            variableBorrowIndex
            reserveLiquidationThreshold
            reserveLiquidationBonus
          }
        }
      }
    `;
    const data = await this.fetchGraphQL<{ userReserves: SubgraphUserReserve[] }>(q, { first });
    return data?.userReserves || [];
  }

  async getUserReservesByUsers(users: string[]): Promise<SubgraphUserReserve[]> {
    let allReserves: SubgraphUserReserve[] = [];
    let skip = 0;
    const first = 1000;
    while (true) {
      const q = `
        query GetUserReservesByUsers($users: [String!]!, $first: Int!, $skip: Int!) {
          userReserves(first: $first, skip: $skip, where: { user_in: $users, scaledVariableDebt_gt: "0" }) {
            user { id }
            scaledATokenBalance
            scaledVariableDebt
            principalStableDebt
            usageAsCollateralEnabledOnUser
            reserve {
              id
              symbol
              decimals
              price { priceInEth }
              liquidityIndex
              variableBorrowIndex
              reserveLiquidationThreshold
              reserveLiquidationBonus
            }
          }
        }
      `;
      const data = await this.fetchGraphQL<{ userReserves: SubgraphUserReserve[] }>(q, { users, first, skip });
      const reserves = data?.userReserves || [];
      allReserves = allReserves.concat(reserves);
      if (reserves.length < first) {
        break;
      }
      skip += first;
      if (skip >= 5000) break; // Subgraph standard skip limit
    }
    return allReserves;
  }
}

/**
 * Extract pure asset address from Aave subgraph reserve.id which is often
 * `${assetAddress}${poolAddress}` concatenation (42+42 chars).
 * Critical for precision: ensures keys match on-chain pure addresses used in engine/Feeder.
 */
export function extractAssetAddress(concatId: string | undefined): string {
  if (!concatId) return '';
  const s = concatId.toLowerCase();
  if (s.length >= 42 && s.startsWith('0x')) {
    return s.slice(0, 42);
  }
  return s;
}

// Re-export for convenience in state/monitor
export { extractAssetAddress as extractAssetId };

// Convenience for simple usage without class
export async function fetchUsersWithDebt(chainId?: number, first = 50, skip = 0): Promise<SubgraphUser[]> {
  const client = new SubgraphClient(chainId);
  return client.getUsersWithDebt(first, skip);
}

/**
 * Map a SubgraphUser (from getUsersWithDebt) into shape ready for bot DB (Task 3.7/3.8).
 * Extracts eMode + isolation where available.
 */
export function mapUserToDbRows(user: SubgraphUser, chainId: number): {
  user: { chain_id: number; address: string; borrowedReservesCount?: number };
  positions: Array<{
    chain_id: number;
    user_address: string;
    asset: string;
    collateral_scaled?: string;
    debt_var_scaled?: string;
    debt_stable_scaled?: string;
    e_mode_category_id: number;
    is_isolated: number;
  }>;
} {
  const addr = user.id.toLowerCase();
  const positions = (user.userReserves || []).map((ur) => {
    const asset = extractAssetAddress(ur.reserve?.id);
    const eMode = Number(user.eModeCategoryId ?? 0) || 0;

    return {
      chain_id: chainId,
      user_address: addr,
      asset,
      collateral_scaled: ur.scaledATokenBalance || '0',
      debt_var_scaled: ur.scaledVariableDebt || '0',
      debt_stable_scaled: ur.principalStableDebt || '0',
      e_mode_category_id: eMode,
      is_isolated: 0, // subgraph isolation data may be in different field; default 0 for now
    };
  });

  return {
    user: {
      chain_id: chainId,
      address: addr,
      borrowedReservesCount: Number(user.borrowedReservesCount || 0),
    },
    positions,
  };
}

/**
 * NEW: Map subgraph data directly to 0-RPC engine input structures (UserPositionView + ReserveDataView).
 * This solves the limitation of feeding real subgraph data into calculateUserAccountData.
 * Prices from subgraph (priceInEth) are treated as base currency (aligns with current engine usage).
 * Decimals, LT, bonus from subgraph.
 * isUsingAsCollateral defaults to true if collateral balance >0 (conservative for liquidation discovery).
 */
export function mapSubgraphToEngineViews(
  subgraphReserves: SubgraphReserve[],
  userReserves: SubgraphUserReserve[],
  userAddress: string,
  eModeCategoryId: number = 0,  // UPDATED for E-Mode + Isolation support per task. Pass user eModeCategoryId from subgraph/DB/Feeder.
  isolationModeAsset?: string,
  isolationModeTotalDebt?: string
): { reservesConfig: Map<string, ReserveDataView>; userPosition: UserPositionView } {
  const reservesConfig = new Map<string, ReserveDataView>();
  const reservesData = new Map<string, UserReservePosition>();

  // Build reservesConfig
  for (const r of subgraphReserves) {
    const asset = extractAssetAddress(r.id);
    const dec = BigInt(r.decimals || 18);
    const price = BigInt(r.price?.priceInEth || '0');
    const liqIdx = BigInt(r.liquidityIndex || '1000000000000000000000000000');
    const varIdx = BigInt(r.variableBorrowIndex || '1000000000000000000000000000');
    const lt = BigInt(r.reserveLiquidationThreshold || '8000'); // default 80%
    const bonus = BigInt(r.reserveLiquidationBonus || '10500'); // default 5%
    const eModeCat = Number(r.eModeCategoryId ?? 0) || 0;

    reservesConfig.set(asset, {
      asset,
      decimals: dec,
      priceInBaseCurrency: price,
      liquidityIndex: liqIdx,
      variableBorrowIndex: varIdx,
      liquidationThreshold: lt,
      liquidationBonus: bonus,
      eModeCategory: eModeCat,
    });
  }

  // Also build from embedded in user reserves (robustness: covers assets not in top reserves list)
  for (const ur of userReserves) {
    const r = ur.reserve;
    if (!r) continue;
    const asset = extractAssetAddress(r.id);
    if (reservesConfig.has(asset)) continue;
    const dec = BigInt(r.decimals || 18);
    const price = BigInt(r.price?.priceInEth || '0');
    const liqIdx = BigInt(r.liquidityIndex || '1000000000000000000000000000');
    const varIdx = BigInt(r.variableBorrowIndex || '1000000000000000000000000000');
    const lt = BigInt(r.reserveLiquidationThreshold || '8000');
    const bonus = BigInt(r.reserveLiquidationBonus || '10500');
    const eModeCat = Number((r as any).eModeCategoryId ?? 0) || 0;
    reservesConfig.set(asset, {
      asset,
      decimals: dec,
      priceInBaseCurrency: price,
      liquidityIndex: liqIdx,
      variableBorrowIndex: varIdx,
      liquidationThreshold: lt,
      liquidationBonus: bonus,
      eModeCategory: eModeCat,
    });
  }

  // Build user position data
  // Also ensure reservesConfig includes assets from user's ur (embedded data), in case global subgraphReserves query missed some (e.g. limit/ordering)
  // This guarantees calc never misses for loaded positions.
  for (const ur of userReserves) {
    const asset = extractAssetAddress(ur.reserve?.id);
    const collBal = BigInt(ur.scaledATokenBalance || '0');
    const varDebt = BigInt(ur.scaledVariableDebt || '0');
    const stableDebt = BigInt(ur.principalStableDebt || '0');
    const stableRate = BigInt(ur.stableBorrowRate || '0');
    const stableUpdated = BigInt(ur.stableRateLastUpdated || '0');

    // Use usageAsCollateralEnabledOnUser if present, else conservative (has collateral)
    const isUsingAsCollateral = ur.usageAsCollateralEnabledOnUser ?? (collBal > 0n);

    reservesData.set(asset, {
      isUsingAsCollateral,
      scaledATokenBalance: collBal,
      scaledVariableDebt: varDebt,
      principalStableDebt: stableDebt,
      stableBorrowRate: stableRate,
      stableRateLastUpdated: stableUpdated,
    });

    // Backfill cfg from embedded reserve info if this asset not yet in reservesConfig (prevents "missing" in calc)
    if (!reservesConfig.has(asset) && ur.reserve) {
      const r = ur.reserve;
      const dec = BigInt(r.decimals || 18);
      const price = BigInt(r.price?.priceInEth || '0');
      const liqIdx = BigInt(r.liquidityIndex || '1000000000000000000000000000');
      const varIdx = BigInt(r.variableBorrowIndex || '1000000000000000000000000000');
      const lt = BigInt(r.reserveLiquidationThreshold || '8000');
      const bonus = BigInt(r.reserveLiquidationBonus || '10500');
      const eModeCat = Number((r as any).eModeCategoryId ?? 0) || 0;
      reservesConfig.set(asset, {
        asset,
        decimals: dec,
        priceInBaseCurrency: price,
        liquidityIndex: liqIdx,
        variableBorrowIndex: varIdx,
        liquidationThreshold: lt,
        liquidationBonus: bonus,
        eModeCategory: eModeCat,
      });
    }
  }

  const userPosition: UserPositionView = {
    user: userAddress.toLowerCase(),
    eModeCategoryId,  // UPDATED: now passed explicitly from callers (supports eModeCategoryId from getUsersWithDebt / getUser / Feeder)
    reservesData,
    isolationModeAsset,
    isolationModeTotalDebt: isolationModeTotalDebt ? BigInt(isolationModeTotalDebt) : undefined,
  };

  return { reservesConfig, userPosition };
}
