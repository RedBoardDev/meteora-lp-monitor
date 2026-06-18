import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import type { BaseLogger } from 'pino';

/** Minimal surface used here — avoids coupling to Fastify's logger-typed generics. */
interface GracefulApp {
  server: Server;
  log: Pick<BaseLogger, 'info' | 'error' | 'fatal'>;
  close(): Promise<void>;
}

export interface GracefulShutdownOptions {
  /** Hard cap (ms) on the close sequence — exit 1 if it overruns. */
  forceExitTimeout?: number;
  /** Async cleanup run before app.close() (engine, …); rejections are logged, never block. */
  closeHandlers?: Array<() => Promise<unknown>>;
  /** Signals to handle. uncaughtException / unhandledRejection are always wired. */
  signals?: NodeJS.Signals[];
  /** Process exit — override in tests. */
  exit?: (code: number) => never;
}

const DEFAULT_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];
const SIGNAL_EXIT_CODES: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 128 + 1,
  SIGINT: 128 + 2,
  SIGTERM: 128 + 15,
};

/**
 * Drains the HTTP server on termination. Upgraded WebSocket and idle keep-alive
 * sockets are not owned by the Node HTTP server, so they keep `app.close()` from
 * resolving — we track and destroy them explicitly. No orchestrator grace window
 * here (personal tool, no load balancer): close immediately and exit.
 */
export function installGracefulShutdown(
  app: GracefulApp,
  options: GracefulShutdownOptions = {},
): void {
  const {
    forceExitTimeout = 10_000,
    closeHandlers = [],
    signals = DEFAULT_SIGNALS,
    exit = process.exit,
  } = options;

  const sockets = new Set<Socket>();
  let stopping = false;

  const track = (socket: Socket): void => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  app.server.on('connection', track);
  app.server.on('secureConnection', track);

  const stop = async (reason: string, exitCode = 0, error?: unknown): Promise<void> => {
    if (stopping) return;
    stopping = true;
    app.log.info({ reason, err: error }, 'graceful_shutdown_started');

    const forceExit = setTimeout(() => {
      app.log.fatal({ reason, forceExitTimeout }, 'graceful_shutdown_force_exit');
      exit(1);
    }, forceExitTimeout);
    forceExit.unref();

    const results = await Promise.allSettled(closeHandlers.map((h) => h()));
    for (const r of results) {
      if (r.status === 'rejected') {
        app.log.error({ err: r.reason }, 'graceful_shutdown_handler_failed');
      }
    }

    for (const socket of sockets) socket.destroy();
    sockets.clear();

    try {
      await app.close();
    } catch (err) {
      app.log.error({ err }, 'graceful_shutdown_app_close_failed');
      clearTimeout(forceExit);
      exit(1);
      return;
    }

    clearTimeout(forceExit);
    app.log.info({ reason, exitCode }, 'graceful_shutdown_completed');
    exit(exitCode);
  };

  for (const signal of signals) {
    process.once(signal, () => void stop(signal, SIGNAL_EXIT_CODES[signal] ?? 0));
  }
  // A truly uncaught synchronous exception may leave state corrupt → shut down cleanly (a restart
  // is safer than running on). An unhandled promise rejection (e.g. a background RPC call that
  // rejected) is operational and recoverable → log it loudly but KEEP the API serving.
  process.once('uncaughtException', (err) => void stop('uncaughtException', 1, err));
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandled_rejection');
  });
}
