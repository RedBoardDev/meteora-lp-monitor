export const DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** Stablecoins counted in the idle wallet balance (USD), converted to SOL via Jupiter. */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

/** How often the idle wallet balance is refreshed (also refreshed on open/close). */
export const WALLET_BALANCE_REFRESH_MS = 30_000;

export const METEORA_API_BASE = 'https://dlmm.datapi.meteora.ag';

/** PositionV2 Anchor account: discriminator (8) + lb_pair (32) + owner (32). */
export const POSITION_V2_OWNER_OFFSET = 40;
export const POSITION_V2_DISCRIMINATOR = [117, 176, 212, 199, 245, 180, 133, 182] as const;
