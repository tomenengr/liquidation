import { ethers } from "ethers";

// Multicall3 contract address (same on most chains including mainnet, Arbitrum, Base, etc.)
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

const MULTICALL3_ABI = [
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)"
];

export interface Call3 {
  target: string;
  allowFailure: boolean;
  callData: string;
}

export class MulticallHelper {
  private multicall: ethers.Contract;

  constructor(provider: ethers.Provider) {
    this.multicall = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);
  }

  /**
   * Batch multiple contract calls using Multicall3.
   * Returns array of decoded results (or null on failure if allowFailure=true).
   */
  async aggregate3(calls: Call3[], abiInterface: ethers.Interface): Promise<any[]> {
    const results = await this.multicall.aggregate3(calls);

    return results.map((res: any, i: number) => {
      if (!res.success) {
        return null;
      }
      try {
        return abiInterface.decodeFunctionResult(calls[i].callData.slice(0, 10) as any, res.returnData); // simplistic; better to pass fragment
      } catch {
        return res.returnData; // raw if decode fails
      }
    });
  }

  /**
   * Batch getReserveData for multiple assets using Multicall3.
   * Returns array of decoded ReserveData structs (or null on failure).
   * This reduces RPC calls from O(n) to 1 for initial scans, fixing rate limits.
   */
  async batchGetReservesData(assets: string[], poolInterface: ethers.Interface, poolAddress: string): Promise<any[]> {
    const calls: Call3[] = assets.map(asset => ({
      target: poolAddress,
      allowFailure: true,
      callData: poolInterface.encodeFunctionData("getReserveData", [asset])
    }));

    const rawResults = await this.multicall.aggregate3(calls);

    return rawResults.map((r: any) => {
      if (!r.success || !r.returnData) return null;
      try {
        return poolInterface.decodeFunctionResult("getReserveData", r.returnData);
      } catch {
        return null;
      }
    });
  }

  /**
   * Batch scaledBalanceOf calls for a user across multiple token contracts.
   * Useful for user positions.
   */
  async batchScaledBalances(user: string, tokenAddresses: string[], scaledBalanceInterface: ethers.Interface): Promise<bigint[]> {
    const calls: Call3[] = tokenAddresses.map(addr => ({
      target: addr,
      allowFailure: true,
      callData: scaledBalanceInterface.encodeFunctionData("scaledBalanceOf", [user])
    }));

    const rawResults = await this.multicall.aggregate3(calls);

    return rawResults.map((r: any) => {
      if (!r.success || !r.returnData) return 0n;
      try {
        const decoded = scaledBalanceInterface.decodeFunctionResult("scaledBalanceOf", r.returnData);
        return BigInt(decoded[0]);
      } catch {
        return 0n;
      }
    });
  }

  /**
   * General batch call helper that returns raw results for custom decoding.
   * Perfect for advanced batching in Feeder or other modules.
   */
  async batchCalls(calls: Call3[]): Promise<Array<{success: boolean, returnData: string}>> {
    return this.multicall.aggregate3(calls);
  }
}
