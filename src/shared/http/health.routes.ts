import { Router } from 'express';

export type DatabaseHealthCheck = () => Promise<boolean>;

/**
 * GET /health — the single unauthenticated endpoint (Decision D-09).
 * Orchestrators and load balancers cannot present JWTs. The response carries
 * no versions, hostnames or timings: just up/down for the process and the DB.
 */
export function healthRoutes(checkDatabase: DatabaseHealthCheck): Router {
  const router = Router();
  router.get('/health', async (_req, res) => {
    const databaseUp = await checkDatabase();
    res.setHeader('Cache-Control', 'no-store');
    res
      .status(databaseUp ? 200 : 503)
      .json(
        databaseUp
          ? { status: 'ok', checks: { database: 'ok' } }
          : { status: 'unavailable', checks: { database: 'unreachable' } },
      );
  });
  return router;
}
