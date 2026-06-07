import { compose } from './composition';
import { loadConfig } from './config/env';

// Signals & process-error handling live in installGracefulShutdown (registered in compose).
const config = loadConfig();
const app = compose(config);

app.start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
