import { DLMM_PROGRAM_ID } from '@binsight/shared';
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { JITO_TIP_ACCOUNTS } from '@/domain/copybot/jito-tip';
import { type WallBIntent, verifyTx } from './wall-b';

const FAKE_BLOCKHASH = Keypair.generate().publicKey.toBase58();
const DLMM = new PublicKey(DLMM_PROGRAM_ID);
const pk = () => Keypair.generate().publicKey;

// Builds a legacy tx then re-deserializes it (like the vault: Transaction.from), to populate the signers.
function buildTx(feePayer: PublicKey, ixs: TransactionInstruction[]): Transaction {
  const t = new Transaction();
  t.feePayer = feePayer;
  t.recentBlockhash = FAKE_BLOCKHASH;
  for (const ix of ixs) t.add(ix);
  return Transaction.from(t.serialize({ requireAllSignatures: false, verifySignatures: false }));
}
const ix = (programId: PublicKey, keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[], data = Buffer.alloc(0)) =>
  new TransactionInstruction({ programId, keys, data });

const owner = pk();
const position = pk();
const pool = pk();
const openIntent = (over: Partial<WallBIntent> = {}): WallBIntent => ({
  owner: owner.toBase58(),
  pool: pool.toBase58(),
  kind: 'open',
  positionPubkey: position.toBase58(),
  ...over,
});
// A valid open: owner + position as signers, DLMM touches the pool.
const validOpen = () =>
  buildTx(owner, [
    ix(DLMM, [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: position, isSigner: true, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: true },
    ]),
  ]);

describe('Wall B — verifyTx', () => {
  it('valid open (owner + position signers, DLMM program, pool referenced) → ok', () => {
    expect(verifyTx(validOpen(), openIntent())).toEqual({ ok: true });
  });

  it('signer #1 ≠ owner → reject signer_not_owner', () => {
    const t = buildTx(pk(), [ix(DLMM, [{ pubkey: pool, isSigner: false, isWritable: true }])]);
    expect(verifyTx(t, openIntent())).toMatchObject({ ok: false, reason: 'signer_not_owner' });
  });

  it('open without the ephemeral position as a signer → reject missing_position_signer', () => {
    const t = buildTx(owner, [
      ix(DLMM, [
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: pool, isSigner: false, isWritable: true },
      ]),
    ]);
    expect(verifyTx(t, openIntent())).toMatchObject({ ok: false, reason: 'missing_position_signer' });
  });

  it('program not in allowlist → reject program_not_allowed', () => {
    const evil = pk();
    const t = buildTx(owner, [
      ix(evil, [
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: position, isSigner: true, isWritable: true },
        { pubkey: pool, isSigner: false, isWritable: true },
      ]),
    ]);
    expect(verifyTx(t, openIntent())).toMatchObject({ ok: false, reason: expect.stringContaining('program_not_allowed') });
  });

  it('pool not referenced → reject pool_not_referenced', () => {
    const t = buildTx(owner, [
      ix(DLMM, [
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: position, isSigner: true, isWritable: true },
      ]),
    ]);
    expect(verifyTx(t, openIntent())).toMatchObject({ ok: false, reason: 'pool_not_referenced' });
  });

  it('outgoing System-Transfer to a third party → reject foreign_sol_destination', () => {
    const attacker = pk();
    const transfer = SystemProgram.transfer({ fromPubkey: owner, toPubkey: attacker, lamports: 1 });
    const t = buildTx(owner, [
      ix(DLMM, [
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: position, isSigner: true, isWritable: true },
        { pubkey: pool, isSigner: false, isWritable: true },
      ]),
      transfer,
    ]);
    expect(verifyTx(t, openIntent())).toMatchObject({ ok: false, reason: 'foreign_sol_destination' });
  });

  it('System-Transfer to self (owner) → tolerated', () => {
    const transfer = SystemProgram.transfer({ fromPubkey: owner, toPubkey: owner, lamports: 1 });
    const t = buildTx(owner, [
      ix(DLMM, [
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: position, isSigner: true, isWritable: true },
        { pubkey: pool, isSigner: false, isWritable: true },
      ]),
      transfer,
    ]);
    expect(verifyTx(t, openIntent())).toEqual({ ok: true });
  });

  const openWithTransfer = (to: PublicKey, lamports: number): Transaction =>
    buildTx(owner, [
      ix(DLMM, [
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: position, isSigner: true, isWritable: true },
        { pubkey: pool, isSigner: false, isWritable: true },
      ]),
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: to, lamports }),
    ]);

  it('a capped tip to a known Jito tip account → tolerated (the one allowed non-owner SOL destination)', () => {
    expect(verifyTx(openWithTransfer(JITO_TIP_ACCOUNTS[0]!, 50_000), openIntent())).toEqual({ ok: true });
  });

  it('an OVERSIZED tip to a Jito account → reject jito_tip_too_large (defense in depth vs an inflated tip)', () => {
    expect(verifyTx(openWithTransfer(JITO_TIP_ACCOUNTS[0]!, 20_000_000), openIntent())).toMatchObject({ ok: false, reason: 'jito_tip_too_large' });
  });

  it('a transfer to a NON-Jito third party is still rejected (the allowlist is exactly the Jito accounts)', () => {
    expect(verifyTx(openWithTransfer(pk(), 50_000), openIntent())).toMatchObject({ ok: false, reason: 'foreign_sol_destination' });
  });

  it('close: no position signer needed', () => {
    const t = buildTx(owner, [
      ix(DLMM, [
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: pool, isSigner: false, isWritable: true },
      ]),
    ]);
    expect(verifyTx(t, openIntent({ kind: 'close' }))).toEqual({ ok: true });
  });
});

const JUP = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const inputMint = pk();
const ownerAtaFor = (mint: PublicKey, tokenProgram: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
const ownerAta = (mint: PublicKey): PublicKey => ownerAtaFor(mint, TOKEN_PROGRAM);

const sellIntent = (over: Partial<WallBIntent> = {}): WallBIntent => ({
  owner: owner.toBase58(),
  pool: pool.toBase58(), // provenance only; a sell references no DLMM pool
  kind: 'sell',
  positionPubkey: position.toBase58(),
  inputMint: inputMint.toBase58(),
  ...over,
});
// A valid Jupiter sell: owner signer, Jupiter program, owner's ATA of the residual token referenced.
const validSell = (): Transaction =>
  buildTx(owner, [
    ix(JUP, [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: ownerAta(inputMint), isSigner: false, isWritable: true },
    ]),
  ]);

describe('Wall B — verifyTx (sell / Jupiter token→SOL)', () => {
  it('valid sell (owner signer, Jupiter program, owner ATA of the residual token) → ok', () => {
    expect(verifyTx(validSell(), sellIntent())).toEqual({ ok: true });
  });

  it('sell with no inputMint in the intent → reject swap_missing_token_mint', () => {
    expect(verifyTx(validSell(), sellIntent({ inputMint: undefined }))).toMatchObject({ ok: false, reason: 'swap_missing_token_mint' });
  });

  it('sell not touching owner ATA of the residual token → reject swap_token_not_owner_ata (wrong token)', () => {
    // WHY: binds the swap to the intended residual token, not some other holding of ours.
    const otherMint = pk();
    const t = buildTx(owner, [ix(JUP, [{ pubkey: owner, isSigner: true, isWritable: true }, { pubkey: ownerAta(otherMint), isSigner: false, isWritable: true }])]);
    expect(verifyTx(t, sellIntent())).toMatchObject({ ok: false, reason: 'swap_token_not_owner_ata' });
  });

  it('sell that tries to send SOL to a third party → reject foreign_sol_destination', () => {
    const attacker = pk();
    const t = buildTx(owner, [
      ix(JUP, [{ pubkey: owner, isSigner: true, isWritable: true }, { pubkey: ownerAta(inputMint), isSigner: false, isWritable: true }]),
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: attacker, lamports: 1 }),
    ]);
    expect(verifyTx(t, sellIntent())).toMatchObject({ ok: false, reason: 'foreign_sol_destination' });
  });

  it('sell routed through a non-allowlisted program → reject program_not_allowed', () => {
    const evil = pk();
    const t = buildTx(owner, [ix(evil, [{ pubkey: owner, isSigner: true, isWritable: true }, { pubkey: ownerAta(inputMint), isSigner: false, isWritable: true }])]);
    expect(verifyTx(t, sellIntent())).toMatchObject({ ok: false, reason: expect.stringContaining('program_not_allowed') });
  });

  it('Token-2022 residual sell (ATA derived under Token-2022) → ok (the dormant-token bug fix)', () => {
    // WHY: most pump.fun legs are Token-2022; their ATA uses a different program seed → the classic-only
    // derivation rejected the swap → token stayed dormant. Wall B must accept owner's ATA under EITHER program.
    const t = buildTx(owner, [
      ix(JUP, [
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: ownerAtaFor(inputMint, TOKEN_2022_PROGRAM), isSigner: false, isWritable: true },
      ]),
    ]);
    expect(verifyTx(t, sellIntent())).toEqual({ ok: true });
  });

  it('Token-2022 program is allowlisted (a sell instruction may invoke it) → not program_not_allowed', () => {
    const t = buildTx(owner, [
      ix(TOKEN_2022_PROGRAM, [{ pubkey: owner, isSigner: true, isWritable: true }, { pubkey: ownerAtaFor(inputMint, TOKEN_2022_PROGRAM), isSigner: false, isWritable: true }]),
    ]);
    expect(verifyTx(t, sellIntent())).toEqual({ ok: true });
  });
});

describe('Wall B — verifyTx (buy / Jupiter SOL→token, two-sided copy)', () => {
  // A buy binds to owner's ATA of the OUTPUT token (the token being bought) — intent.inputMint = that token.
  const buyMint = pk();
  const buyIntent = (over: Partial<WallBIntent> = {}): WallBIntent => ({
    owner: owner.toBase58(),
    pool: pool.toBase58(),
    kind: 'buy',
    positionPubkey: position.toBase58(),
    inputMint: buyMint.toBase58(),
    ...over,
  });

  it('valid buy (owner signer, Jupiter program, owner ATA of the bought token) → ok', () => {
    const t = buildTx(owner, [ix(JUP, [{ pubkey: owner, isSigner: true, isWritable: true }, { pubkey: ownerAta(buyMint), isSigner: false, isWritable: true }])]);
    expect(verifyTx(t, buyIntent())).toEqual({ ok: true });
  });

  it('buy not touching owner ATA of the bought token → reject swap_token_not_owner_ata', () => {
    const t = buildTx(owner, [ix(JUP, [{ pubkey: owner, isSigner: true, isWritable: true }, { pubkey: ownerAta(pk()), isSigner: false, isWritable: true }])]);
    expect(verifyTx(t, buyIntent())).toMatchObject({ ok: false, reason: 'swap_token_not_owner_ata' });
  });

  it('buy that tries to send SOL to a third party → reject foreign_sol_destination', () => {
    const attacker = pk();
    const t = buildTx(owner, [
      ix(JUP, [{ pubkey: owner, isSigner: true, isWritable: true }, { pubkey: ownerAta(buyMint), isSigner: false, isWritable: true }]),
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: attacker, lamports: 1 }),
    ]);
    expect(verifyTx(t, buyIntent())).toMatchObject({ ok: false, reason: 'foreign_sol_destination' });
  });
});

describe('Wall B — verifyTx (add / remove: proportional adjustments, no position signer)', () => {
  // An add/remove touches OUR existing position (no ephemeral signer) — verified like a close.
  const adjustTx = () =>
    buildTx(owner, [
      ix(DLMM, [
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: pool, isSigner: false, isWritable: true },
      ]),
    ]);

  it('valid add (owner signer, DLMM, pool referenced) → ok', () => {
    expect(verifyTx(adjustTx(), openIntent({ kind: 'add' }))).toEqual({ ok: true });
  });

  it('valid remove → ok', () => {
    expect(verifyTx(adjustTx(), openIntent({ kind: 'remove' }))).toEqual({ ok: true });
  });

  it('remove that sends SOL to a third party → reject foreign_sol_destination', () => {
    const attacker = pk();
    const t = buildTx(owner, [
      ix(DLMM, [{ pubkey: owner, isSigner: true, isWritable: true }, { pubkey: pool, isSigner: false, isWritable: true }]),
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: attacker, lamports: 1 }),
    ]);
    expect(verifyTx(t, openIntent({ kind: 'remove' }))).toMatchObject({ ok: false, reason: 'foreign_sol_destination' });
  });

  it('add not referencing the pool → reject pool_not_referenced', () => {
    const t = buildTx(owner, [ix(DLMM, [{ pubkey: owner, isSigner: true, isWritable: true }])]);
    expect(verifyTx(t, openIntent({ kind: 'add' }))).toMatchObject({ ok: false, reason: 'pool_not_referenced' });
  });
});
