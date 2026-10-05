import { preview } from 'astro';

// The public API runs in this foreground process without the CLI's shared lock
// or agent-environment background mode. Playwright owns only port 4333.
const server = await preview({
  server: { host: '127.0.0.1', port: 4333 },
  vite: { preview: { strictPort: true } },
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => { await server.stop(); process.exit(0); });
}
await server.closed();
