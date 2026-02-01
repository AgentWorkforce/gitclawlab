import { createServer } from './api/server.js';
import { initDatabase } from './db/schema.js';
import { initGitServer } from './git/soft-serve.js';
import { initMoltslackClient } from './moltslack/client.js';

const PORT = process.env.PORT || 3000;
const GIT_PORT = process.env.GIT_PORT || 2222;

async function main() {
  console.log('Starting GitClawLab...');

  // Initialize database
  await initDatabase();
  console.log('Database initialized');

  // Initialize git server (soft-serve) - optional
  try {
    await initGitServer({ port: Number(GIT_PORT) });
    console.log(`Git server running on port ${GIT_PORT}`);
  } catch (err) {
    console.warn('Git server not available (soft-serve not installed)');
    console.warn('Install with: brew install charmbracelet/tap/soft-serve');
  }

  // Initialize Moltslack client for notifications - optional
  try {
    await initMoltslackClient();
    console.log('Moltslack client connected');
  } catch (err) {
    console.warn('Moltslack not configured');
  }

  // Start API server
  const app = createServer();
  app.listen(PORT, () => {
    console.log(`GitClawLab running on http://localhost:${PORT}`);
    console.log(`  Landing:   http://localhost:${PORT}/`);
    console.log(`  SKILL.md:  http://localhost:${PORT}/SKILL.md`);
    console.log(`  Dashboard: http://localhost:${PORT}/app`);
    console.log(`  API:       http://localhost:${PORT}/api`);
  });
}

main().catch((err) => {
  console.error('Failed to start MoltLab:', err);
  process.exit(1);
});
