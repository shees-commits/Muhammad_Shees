/**
 * Calls the API with everything an authenticated request needs:
 *   Authorization: Bearer <access token>
 *   X-Request-Timestamp: <unix ms>      (must be within ±300 s of server time)
 *   X-Request-Nonce: <fresh UUID v4>    (single use per token subject)
 *
 * Usage:
 *   TOKEN=<access token> npx tsx scripts/signed-request.ts GET /auth/me
 *   TOKEN=... npx tsx scripts/signed-request.ts POST /chat/messages '{"question":"Hello"}'
 *   TOKEN=... npx tsx scripts/signed-request.ts --curl GET /chat/usage   # print a curl command instead
 *
 * Env: TOKEN (required), API_URL (default http://localhost:3000).
 */
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const printCurl = args[0] === '--curl';
const [method = 'GET', path = '/auth/me', body] = printCurl ? args.slice(1) : args;
const token = process.env['TOKEN'];
const baseUrl = process.env['API_URL'] ?? 'http://localhost:3000';

if (!token) {
  process.stderr.write('Set TOKEN to an Auth0 access token (see README §3).\n');
  process.exit(1);
}

const headers: Record<string, string> = {
  Authorization: `Bearer ${token}`,
  'X-Request-Timestamp': String(Date.now()),
  'X-Request-Nonce': randomUUID(),
  ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
};

if (printCurl) {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const parts = [
    'curl -sS',
    `-X ${method.toUpperCase()}`,
    ...Object.entries(headers).map(([k, v]) => `-H ${quote(`${k}: ${v}`)}`),
    ...(body === undefined ? [] : [`--data ${quote(body)}`]),
    quote(`${baseUrl}${path}`),
  ];
  process.stdout.write(`${parts.join(' \\\n  ')}\n`);
} else {
  const response = await fetch(`${baseUrl}${path}`, {
    method: method.toUpperCase(),
    headers,
    ...(body === undefined ? {} : { body }),
  });
  const text = await response.text();
  process.stdout.write(`HTTP ${response.status}\n`);
  try {
    process.stdout.write(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  } catch {
    process.stdout.write(`${text}\n`);
  }
}
