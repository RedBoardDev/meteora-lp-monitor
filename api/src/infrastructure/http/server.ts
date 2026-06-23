import { randomBytes } from 'node:crypto';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { AppConfig } from '@/config/env';
import {
  buildSiwsMessage,
  createJwt,
  hashPassword,
  isValidSolanaAddress,
  TOKEN_TTL_SECONDS,
  verifyJwt,
  verifyPassword,
  verifyWalletSignature,
} from './auth';
import { type RouteDeps, registerRoutes } from './routes';
import { registerWebSocket } from './websocket';

declare module 'fastify' {
  interface FastifyRequest {
    account?: { id: string; isOwner: boolean; address: string; tokenVersion: number; jti: string };
  }
}

const WS_TICKET_TTL_SECONDS = 60;

// Fixed pause after every failed auth attempt — slows credential stuffing without any lockout state
// that could be weaponised (see slowFail in buildServer for why the hard lockout was removed).
const LOGIN_FAIL_DELAY_MS = 300;

/** Everything registerRoutes needs (RouteDeps) plus the server-only app config. */
export type ServerDeps = RouteDeps & { config: AppConfig };

export async function buildServer(deps: ServerDeps) {
  const app = Fastify({ logger: { level: deps.config.LOG_LEVEL } });

  // Allowlist for browsers — Auth is the real boundary; this is defense-in-depth.
  await app.register(cors, {
    origin: deps.config.WEB_ORIGINS.split(',').map((o) => o.trim()),
  });
  // maxPayload caps inbound WS frames — client messages (subscribe/presence/ping) are tiny, so 1 MB is
  // generous; it stops a hostile client from pushing huge frames into the server's receive buffer.
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  // Catch-all error handler: log the real error, return a clean shape (no stack/internals leaked).
  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'request error');
    const statusCode = (err as { statusCode?: number }).statusCode;
    const status = typeof statusCode === 'number' && statusCode >= 400 ? statusCode : 500;
    const message = err instanceof Error ? err.message : 'error';
    reply.code(status).send({ error: status >= 500 ? 'internal error' : message });
  });

  // ── Auth: wallet-address identity. A one-time signature proves ownership at register; thereafter
  // address + password is exchanged for a session JWT, and everything else requires that JWT. ───────
  const secret = deps.config.AUTH_SECRET;

  // SIWS binding: derive a STABLE domain/uri from the first allowed web origin. The same values build
  // the challenge at /auth/nonce and reconstruct it at verify — the client-sent message is never trusted.
  const primaryOrigin = deps.config.WEB_ORIGINS.split(',')[0]?.trim() || 'http://localhost:3000';
  const siwsDomain = (() => {
    try {
      return new URL(primaryOrigin).host;
    } catch {
      return 'binsight';
    }
  })();
  const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes — long enough to read a wallet prompt, short for replay
  const newNonce = (): string => randomBytes(24).toString('base64url');
  const challengeFor = (address: string, nonce: string): string =>
    buildSiwsMessage({ domain: siwsDomain, uri: primaryOrigin, address, nonce });

  // Every failed auth attempt pauses for a fixed delay — that, plus the whitelist gate and slow scrypt,
  // is the credential-stuffing friction. There is deliberately NO hard lockout: behind the BFF every
  // browser request shares one server-side IP, so an IP lockout 429'd ALL web users on one user's
  // failures (S04), and a per-account key let an attacker lock out any victim by their public address
  // (S05) — both DoS vectors, and the keyed Map grew unbounded (S06). A pause has none of those.
  const slowFail = (): Promise<void> => new Promise((r) => setTimeout(r, LOGIN_FAIL_DELAY_MS));
  // A fixed dummy hash so /auth/login runs scrypt even for an unknown address — equalises response
  // timing so the endpoint can't be used to enumerate which addresses are registered (L2).
  const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(16).toString('hex'));
  // Each issued JWT gets a random session id (jti) + a row in the session allowlist, so logout / reset
  // can revoke it before its TTL (real per-session revocation).
  const newJti = (): string => randomBytes(16).toString('base64url');
  const issueSession = async (
    userId: string,
    ver: number,
  ): Promise<{ token: string; expiresInSeconds: number }> => {
    const jti = newJti();
    await deps.accounts.createSession(jti, userId, Date.now() + TOKEN_TTL_SECONDS * 1000);
    return { token: createJwt(secret, userId, ver, jti), expiresInSeconds: TOKEN_TTL_SECONDS };
  };

  // Register step 1: hand back a single-use nonce + the exact message to sign — ONLY for a whitelisted
  // address (non-approved wallets can't even start, and the UI gets a clean "not approved" signal).
  app.post('/auth/nonce', async (req, reply) => {
    const address = (req.body as { address?: unknown } | undefined)?.address;
    if (!isValidSolanaAddress(address)) {
      await slowFail();
      return reply.code(400).send({ error: 'invalid Solana address' });
    }
    if (!(await deps.accounts.isWhitelisted(address))) {
      await slowFail();
      return reply.code(403).send({ error: 'not approved', notWhitelisted: true });
    }
    if (await deps.accounts.findByAddress(address)) {
      return reply.code(409).send({ error: 'account already exists, sign in instead' });
    }
    const nonce = newNonce();
    await deps.accounts.issueNonce(address, nonce, Date.now() + NONCE_TTL_MS, 'register');
    return reply.send({ nonce, message: challengeFor(address, nonce) });
  });

  // Register step 2: verify the signature over the exact challenge, then create the account, set its
  // password, auto-watch the address, and issue a session. Whitelist + nonce are re-checked server-side.
  app.post('/auth/register', async (req, reply) => {
    const body = req.body as
      | { address?: unknown; signature?: unknown; password?: unknown; nonce?: unknown }
      | undefined;
    const address = body?.address;
    const signature = body?.signature;
    const nonce = body?.nonce;
    const password = typeof body?.password === 'string' ? body.password : '';
    if (
      !isValidSolanaAddress(address) ||
      typeof signature !== 'string' ||
      typeof nonce !== 'string' ||
      password.length < 8
    ) {
      await slowFail();
      return reply
        .code(400)
        .send({ error: 'address, signature, nonce and password (≥8) required' });
    }
    if (!(await deps.accounts.isWhitelisted(address))) {
      await slowFail();
      return reply.code(403).send({ error: 'not approved', notWhitelisted: true });
    }
    if (await deps.accounts.findByAddress(address)) {
      return reply.code(409).send({ error: 'account already exists' });
    }
    // Consume the nonce FIRST (single-use) so a replay can't pass even with an otherwise-valid signature.
    if (!(await deps.accounts.consumeNonce(address, nonce, 'register'))) {
      await slowFail();
      return reply.code(401).send({ error: 'expired or invalid challenge, restart' });
    }
    if (!verifyWalletSignature(challengeFor(address, nonce), signature, address)) {
      await slowFail();
      return reply.code(401).send({ error: 'signature verification failed' });
    }
    const user = await deps.accounts.createUser({
      address,
      passwordHash: hashPassword(password),
      isOwner: address === deps.config.OWNER_ADDRESS,
    });
    await deps.accounts.addWatch(user.id, { address });
    await deps.engine.addWallet(address);
    return reply.send(await issueSession(user.id, user.tokenVersion));
  });

  // Login (web + Apple apps): address + password → a session JWT. No signature.
  app.post('/auth/login', async (req, reply) => {
    const body = req.body as { address?: unknown; password?: unknown } | undefined;
    const address = body?.address;
    const password = body?.password;
    if (!isValidSolanaAddress(address) || typeof password !== 'string') {
      await slowFail();
      return reply.code(400).send({ error: 'address and password required' });
    }
    const found = await deps.accounts.findByAddress(address);
    // Always run scrypt (against a dummy hash when the account is missing) so the response time can't
    // reveal whether the address is registered (L2 enumeration guard).
    const ok = verifyPassword(password, found ? found.passwordHash : DUMMY_PASSWORD_HASH);
    if (!found || !ok) {
      await slowFail();
      return reply.code(401).send({ error: 'invalid address or password' });
    }
    return reply.send(await issueSession(found.user.id, found.user.tokenVersion));
  });

  // Password reset step 1: hand back a nonce + message for ANY valid address (no existence check — so
  // the endpoint cannot be used to enumerate which addresses are registered).
  app.post('/auth/reset/nonce', async (req, reply) => {
    const address = (req.body as { address?: unknown } | undefined)?.address;
    if (!isValidSolanaAddress(address)) {
      await slowFail();
      return reply.code(400).send({ error: 'invalid Solana address' });
    }
    const nonce = newNonce();
    await deps.accounts.issueNonce(address, nonce, Date.now() + NONCE_TTL_MS, 'reset');
    return reply.send({ nonce, message: challengeFor(address, nonce) });
  });

  // Password reset step 2: prove ownership of the registration wallet → set a new password and
  // invalidate every existing session (resetPassword bumps tokenVersion).
  app.post('/auth/reset', async (req, reply) => {
    const body = req.body as
      | { address?: unknown; signature?: unknown; password?: unknown; nonce?: unknown }
      | undefined;
    const address = body?.address;
    const signature = body?.signature;
    const nonce = body?.nonce;
    const password = typeof body?.password === 'string' ? body.password : '';
    if (
      !isValidSolanaAddress(address) ||
      typeof signature !== 'string' ||
      typeof nonce !== 'string' ||
      password.length < 8
    ) {
      await slowFail();
      return reply
        .code(400)
        .send({ error: 'address, signature, nonce and password (≥8) required' });
    }
    if (!(await deps.accounts.consumeNonce(address, nonce, 'reset'))) {
      await slowFail();
      return reply.code(401).send({ error: 'expired or invalid challenge, restart' });
    }
    if (!verifyWalletSignature(challengeFor(address, nonce), signature, address)) {
      await slowFail();
      return reply.code(401).send({ error: 'signature verification failed' });
    }
    const found = await deps.accounts.findByAddress(address);
    if (!found) {
      await slowFail();
      return reply.code(404).send({ error: 'no account for this wallet' });
    }
    await deps.accounts.resetPassword(found.user.id, hashPassword(password));
    await deps.accounts.deleteUserSessions(found.user.id); // revoke every existing session    // Re-fetch so the freshly-minted token carries the bumped version (keeping this new session valid).
    const fresh = await deps.accounts.findById(found.user.id);
    return reply.send(
      await issueSession(found.user.id, fresh?.tokenVersion ?? found.user.tokenVersion + 1),
    );
  });

  // Real logout: revoke this token's session (its jti) so it can't be replayed even within its TTL.
  app.post('/auth/logout', async (req) => {
    if (req.account) await deps.accounts.deleteSession(req.account.jti);
    return { ok: true };
  });

  // Short-lived WebSocket ticket (behind the Bearer hook) — encodes the caller's identity so the
  // socket scopes to that account's watchlist. The web BFF mints one per connection.
  app.get('/auth/ws-ticket', async (req) => ({
    token: createJwt(
      secret,
      req.account!.id,
      req.account!.tokenVersion,
      req.account!.jti,
      WS_TICKET_TTL_SECONDS,
    ),
    expiresInSeconds: WS_TICKET_TTL_SECONDS,
  }));

  app.get('/auth/verify', async () => ({ ok: true }));

  // The caller's own account (address + owner flag) — drives the web identity badge and gates the
  // owner-only admin surface client-side (the backend re-checks isOwner on every admin route).
  app.get('/auth/me', async (req) => ({
    address: req.account!.address,
    isOwner: req.account!.isOwner,
  }));

  // Resolve the caller's account from the Bearer JWT. Deny by default; reject a token whose version is
  // stale (a password reset bumped it) so a reset really does kill every older session.
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (
      path === '/live' || // exact match (self-authenticates) — a prefix match would exempt /live-*
      path === '/health' ||
      path === '/auth/nonce' ||
      path === '/auth/register' ||
      path === '/auth/login' ||
      path === '/auth/reset/nonce' ||
      path === '/auth/reset'
    ) {
      return;
    }
    const auth = req.headers.authorization;
    const payload = auth?.startsWith('Bearer ') ? verifyJwt(secret, auth.slice(7)) : null;
    if (!payload) {
      reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    // One JOIN: the account AND its jti session must both be valid. The session allowlist is the real
    // revocation (logout/reset deletes the jti), so a revoked token is rejected despite a valid signature.
    const user = await deps.accounts.findByIdWithSession(payload.sub, payload.jti);
    if (!user || user.tokenVersion !== payload.ver) {
      reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    req.account = {
      id: user.id,
      isOwner: user.isOwner,
      address: user.address,
      tokenVersion: user.tokenVersion,
      jti: payload.jti,
    };
  });

  // ServerDeps ⊇ RouteDeps, so hand the deps straight through (no field-by-field re-listing).
  registerRoutes(app, deps);
  registerWebSocket(
    app,
    secret,
    deps.engine,
    deps.bus,
    deps.presence,
    deps.accounts,
    deps.config.WEB_ORIGINS.split(',').map((o) => o.trim()),
  );

  return app;
}
