/**
 * Control Plane API Server
 * HTTP server for managing the Google Ads Co-Pilot
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';
import { authMiddleware } from './middleware/auth.js';

// Routes
import healthRoutes from './routes/health.js';
import policyRoutes from './routes/policies.js';
import proposalRoutes from './routes/proposals.js';
import systemRoutes from './routes/system.js';
import auditRoutes from './routes/audit.js';
import snapshotRoutes from './routes/snapshots.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  },
}));
app.use(cors({
  origin: config.nodeEnv === 'development' ? '*' : false,
  credentials: true,
}));

// Body parsing
app.use(express.json());

// Request logging
app.use((req, _res, next) => {
  console.log(`[API] ${req.method} ${req.path}`);
  next();
});

// Health check (unauthenticated)
app.use('/health', healthRoutes);

// Serve static UI files (unauthenticated for the page, API calls authenticated)
app.use('/ui', express.static(path.join(__dirname, '../../public')));

// API routes (authenticated)
app.use('/api/policies', authMiddleware, policyRoutes);
app.use('/api/proposals', authMiddleware, proposalRoutes);
app.use('/api/system', authMiddleware, systemRoutes);
app.use('/api/audit', authMiddleware, auditRoutes);
app.use('/api/snapshots', authMiddleware, snapshotRoutes);

// Root redirect to UI
app.get('/', (_req, res) => {
  res.redirect('/ui');
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: 'Endpoint not found',
    },
  });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[API] Error:', err);
  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: config.nodeEnv === 'development' ? err.message : 'Internal server error',
    },
  });
});

// Start server
const port = config.port;
app.listen(port, () => {
  console.log(`[API] Alphabet Trains Google Ads Co-Pilot running on port ${port}`);
  console.log(`[API] Environment: ${config.nodeEnv}`);
  console.log(`[API] UI: http://localhost:${port}/ui`);
  console.log(`[API] Health: http://localhost:${port}/health`);
  console.log(`[API] Google Ads: ${config.googleAds.isConfigured ? 'Configured' : 'Using stub'}`);
});

export default app;
