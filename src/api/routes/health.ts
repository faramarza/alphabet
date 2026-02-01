/**
 * Health Check Routes
 */

import { Router } from 'express';
import { healthCheck } from '../../db/client.js';
import { getSystemStateService } from '../../services/system-state.js';
import { getGoogleAdsAdapter } from '../../adapters/google-ads.js';

const router = Router();

/**
 * GET /health
 * Basic health check (unauthenticated for load balancers)
 */
router.get('/', async (_req, res) => {
  const dbHealthy = await healthCheck();
  const systemState = await getSystemStateService().getState();
  const adsAdapter = getGoogleAdsAdapter();

  const status = dbHealthy ? 'healthy' : 'unhealthy';

  res.status(dbHealthy ? 200 : 503).json({
    status,
    timestamp: new Date().toISOString(),
    checks: {
      database: dbHealthy ? 'connected' : 'disconnected',
      kill_switch: systemState.kill_switch_enabled ? 'ENABLED' : 'disabled',
      safety_stop: systemState.safety_stop_active ? 'ACTIVE' : 'inactive',
      google_ads: adsAdapter.isStub() ? 'stub' : 'connected',
    },
    version: process.env['npm_package_version'] ?? '1.0.0',
  });
});

/**
 * GET /health/detailed
 * Detailed health check (authenticated)
 */
router.get('/detailed', async (_req, res) => {
  const dbHealthy = await healthCheck();
  const systemState = await getSystemStateService().getState();

  res.json({
    success: true,
    data: {
      status: dbHealthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      system_state: systemState,
      uptime_seconds: process.uptime(),
      memory: process.memoryUsage(),
    },
  });
});

export default router;
