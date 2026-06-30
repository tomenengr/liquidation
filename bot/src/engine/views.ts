export interface ReserveDataView {
    asset: string;                // 资产合约地址
    decimals: bigint;             // 资产本身的精度 (如 WETH 是 18，USDC 是 6)
    priceInBaseCurrency: bigint;  // 预言机返回的 Base 计价价格 (Aave V3 默认 Base 通常为 USD，8位精度)
    liquidityIndex: bigint;       // 全局存款利息指数 (精度: RAY 1e27)
    variableBorrowIndex: bigint;  // 全局浮动借款利息指数 (精度: RAY 1e27)
    liquidationThreshold: bigint; // 清算阈值 (精度: PERCENTAGE 1e4, e.g. 8500 = 85%)
    liquidationBonus: bigint;     // 清算奖励 (精度: PERCENTAGE 1e4, e.g. 10500 = 5% bonus)
}

export interface UserReservePosition {
    isUsingAsCollateral: boolean; // 用户是否开启了该资产作为抵押物
    scaledATokenBalance: bigint;  // 静态 aToken 缩放余额
    scaledVariableDebt: bigint;   // 静态浮动借款缩放余额
    principalStableDebt: bigint;  // 稳定利率借款本金
    stableBorrowRate: bigint;     // 用户的稳定借款利率 (RAY 1e27)
    stableRateLastUpdated: bigint; // 用户的稳定借款最后更新时间戳
}

export interface UserPositionView {
    user: string;                 // 用户地址
    reservesData: Map<string, UserReservePosition>; // assetAddress -> 用户的单资产持仓明细
}

export interface UserAccountData {
    totalCollateralBase: bigint;
    totalDebtBase: bigint;
    avgLiquidationThreshold: bigint;
    healthFactor: bigint;
    // Granular Base outputs for liquidation pairing
    collateralAssetsBase: Map<string, bigint>;
    debtAssetsBase: Map<string, bigint>;
    // Exact Token outputs to prevent Base-to-Token precision loss (Dust Reverts)
    collateralAssetsToken: Map<string, bigint>;
    debtAssetsToken: Map<string, bigint>;
}
