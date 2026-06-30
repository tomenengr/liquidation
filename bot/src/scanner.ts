import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";

const POOL_ADDRESS = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const BORROW_EVENT = "event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)";

export async function scanBorrowers(provider: ethers.Provider, blocksToScan: number = 100): Promise<string[]> {
    console.log(`🔍 [Scanner] Scanning the last ${blocksToScan} blocks for active Aave borrowers...`);
    const pool = new ethers.Contract(POOL_ADDRESS, [BORROW_EVENT], provider);
    
    const latestBlock = await provider.getBlockNumber();
    const fromBlock = latestBlock - blocksToScan;

    const filter = pool.filters.Borrow();
    const users = new Set<string>();

    // 免费 RPC 节点通常有 `eth_getLogs` 区块跨度限制 (如 Alchemy 限制 10 个区块)
    // 生产级做法：对区块进行分片 (Chunking) 批量查询
    const CHUNK_SIZE = 10;
    
    // 我们为了演示速度，可以调大步长，但为了稳妥我们只扫100个区块
    for (let i = fromBlock; i <= latestBlock; i += CHUNK_SIZE) {
        const to = Math.min(i + CHUNK_SIZE - 1, latestBlock);
        
        try {
            const logs = await pool.queryFilter(filter, i, to);
            for (const log of logs) {
                if ('args' in log && log.args) {
                    users.add((log as any).args[1]); // user 是第二个参数
                }
            }
        } catch (e) {
            // ignore
        }
    }

    console.log(`✅ [Scanner] Discovered ${users.size} unique active borrowers from real on-chain events.`);

    // 将扫描到的数据持久化存放到本地 JSON 文件中
    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    const filePath = path.join(dataDir, 'borrowers.json');
    fs.writeFileSync(filePath, JSON.stringify(Array.from(users), null, 2));
    console.log(`💾 [Scanner] Successfully saved borrowers list to data/borrowers.json`);

    return Array.from(users);
}
