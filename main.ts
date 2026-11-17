// Entry point: the harness runs this file as `node /bot/main.ts`, and the whole
// job of the process is to let the trial environment (the "env") drive the
// forge it serves. The env owns the trial: it tells this process when the
// suite is finished, and this process leaves when it hears that.
//
// The handshake, in order:
//   * The env's origin comes from MAKEFUN_ENV_URL. No origin, no trial:
//     print a line and leave with code 1.
//   * The forge (app.ts) starts on a port the kernel picks (port 0). The
//     env's own port is not ours to take, so we never bind a fixed port.
//   * We POST the picked port to the env's /register. The env remembers
//     where the request came from plus that port, and dials us from then on.
//     A 200 means it took the registration; a 409 means some other entry
//     got there first, which is also a settled state for us — we wait either
//     way. A 400 or 405 is a contract error and ends the process; anything
//     else (the env still starting, a dropped request) is retried.
//   * We GET the env's /done until it answers {"done": true}. The env
//     answers every poll at once ({"done": false} while the suite runs), so
//     this is a loop with a short pause between tries, not a held request.
//     A poll that fails or times out just means "not done yet".
//   * Once done, the server closes and the process exits 0.
//
// This file only starts the server and talks to the env; all of the forge's
// behaviour lives in app.ts (and the modules it pulls in). No package, no
// Node built-in import, no model call — just the globals the runtime gives.

import { createApp } from './app.ts';

/** How long a single register or done request may run before it is dropped. */
const REQUEST_BUDGET_MS = 30_000;
/** First pause between tries, and the longest pause the backoff may reach. */
const FIRST_PAUSE_MS = 250;
const LONGEST_PAUSE_MS = 2000;

/** The env's origin, with any trailing slashes removed. */
function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end -= 1;
  return url.slice(0, end);
}

const ENV_ORIGIN = stripTrailingSlashes(process.env.MAKEFUN_ENV_URL ?? '');
if (ENV_ORIGIN === '') {
  warn('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with');
  process.exit(1);
}

/** Write a line to stdout. */
function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Write a line to stderr. */
function warn(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** Wait `ms` milliseconds. */
function pause(ms: number): Promise<void> {
  return new Promise((wake) => setTimeout(wake, ms));
}

/**
 * How long to wait after `failures` failed tries: double from FIRST_PAUSE_MS,
 * doubling at most eight times, and never more than LONGEST_PAUSE_MS.
 */
function pauseAfter(failures: number): number {
  let wait = FIRST_PAUSE_MS;
  const doublings = Math.min(failures, 8);
  for (let i = 0; i < doublings; i += 1) wait *= 2;
  return wait > LONGEST_PAUSE_MS ? LONGEST_PAUSE_MS : wait;
}

/** One request to the env, abandoned after REQUEST_BUDGET_MS. */
function askEnv(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${ENV_ORIGIN}${path}`, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
  });
}

/** True when the failure is the env's contract error, which must end the process. */
function isContractError(err: unknown): err is Error {
  return err instanceof Error && err.message.startsWith('register answered HTTP ');
}

/**
 * POST the bound port to the env until it is accepted. 200 is the normal
 * answer; 409 means another entry registered first and is not ours to fix.
 * 400 and 405 are contract errors and end the process; anything else is
 * retried, since the env may still be starting.
 */
async function announcePort(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const reply = await askEnv('/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: port }),
      });
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        throw new Error(`register answered HTTP ${reply.status}: ${await reply.text()}`);
      }
    } catch (err) {
      if (isContractError(err)) throw err;
    }
    await pause(pauseAfter(failures));
    failures += 1;
  }
}

/** GET /done until it answers {"done": true}; never return before that. */
async function awaitDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const reply = await askEnv('/done');
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: not done, poll again.
    }
    await pause(pauseAfter(failures));
    failures += 1;
  }
}

/** Start the forge on a kernel-chosen port and report the server and port. */
async function bindForge(): Promise<{ server: ReturnType<typeof createApp>; port: number }> {
  const forge = createApp();
  await new Promise<void>((done, fail) => {
    forge.once('error', (err) => fail(err));
    forge.listen(0, () => {
      done();
    });
  });
  const bound = forge.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  return { server: forge, port: bound.port };
}

/** The whole life of the process: bind, register, wait for done, shut down. */
async function run(): Promise<void> {
  const { server, port } = await bindForge();
  say(`[entry] listening on port ${port}`);

  await announcePort(port);
  say('[entry] registered; waiting for the env to say done');

  await awaitDone();
  server.close();
  say('[entry] done');
}

run()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    warn(`[entry] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
