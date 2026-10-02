import { execFileSync } from 'node:child_process';
import { TEST_DATABASE_URL } from './testDatabase.js';

/** Brings the test database schema up to date before any integration file runs. */
export default function setup(): void {
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
  });
}
