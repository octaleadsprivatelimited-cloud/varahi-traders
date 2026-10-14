import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

// A database that accepts TCP but never completes its handshake reproduces
// slow hosted migrations without touching any real database or credentials.
const connections = new Set();
const database = createTcpServer(socket => {
  connections.add(socket);
  socket.on('close', () => connections.delete(socket));
});
await new Promise(resolve => database.listen(0, '127.0.0.1', resolve));
const reservation = createHttpServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const began = Date.now();
const child = spawn(process.execPath, ['hostinger.mjs'], {
  cwd: new URL('../', import.meta.url),
  detached: true,
  stdio: 'ignore',
  env: {
    ...process.env,
    PORT: String(port),
    APP_URL: `http://127.0.0.1:${port}`,
    NODE_ENV: 'production',
    USE_DATABASE: 'true',
    DATABASE_URL: `mysql://startup_test:unused@127.0.0.1:${database.address().port}/unused?connect_timeout=15`,
  },
});

try {
  let response;
  while (Date.now() - began < 3000) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(200) });
      break;
    } catch {
      await delay(25);
    }
  }
  assert.ok(response, 'Hostinger must receive a listening port within three seconds, even while MySQL is unresponsive');
  assert.equal(response.status, 503, 'an uninitialized app must never report readiness');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('retry-after'), '1');
  assert.equal((await response.json()).error.code, 'SERVICE_STARTING');
  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(150) }),
    { name: 'TimeoutError' },
    'customer requests should wait for initialization instead of receiving an immediate cold-start error',
  );
  console.log('Hostinger startup smoke passed: port opens within three seconds; readiness stays unavailable and customer requests wait while MySQL initializes.');
} finally {
  // Terminate the Prisma child processes along with the server under test.
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) {
    if (error.code !== 'ESRCH') {
      console.error('Could not terminate the startup smoke test process group.');
      process.exitCode = 1;
    }
  }
  for (const socket of connections) socket.destroy();
  await new Promise(resolve => database.close(resolve));
}
