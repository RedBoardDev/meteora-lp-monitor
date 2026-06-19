import { BorshCoder } from '@coral-xyz/anchor';
import { DLMM_PROGRAM_ID } from '@binsight/shared';
import dlmmIdl from './dlmm-idl.json';

/** The Meteora DLMM on-chain program. */
export { DLMM_PROGRAM_ID };

/**
 * One IDL-driven Borsh coder for the whole engine — decodes DLMM events AND accounts by name from the
 * OFFICIAL program IDL (bundled). No hand-rolled byte offsets anywhere: the IDL is the contract, so
 * every event/account variant (present and future) decodes automatically and stays correct across
 * program upgrades.
 */
// biome-ignore lint/suspicious/noExplicitAny: the bundled IDL is the program's own contract definition.
export const dlmmCoder = new BorshCoder(dlmmIdl as any);
