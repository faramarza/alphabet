/**
 * Control Plane API Server
 * HTTP server for managing the Google Ads Co-Pilot
 *
 * SECURITY LAYERS:
 * 1. HTTP Basic Auth (blocks unauthorized access to entire site)
 * 2. Admin Token auth (for API operations)
 * 3. Rate limiting
 * 4. Security headers (helmet)
 * 5. No CORS in production
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

// Trust proxy when behind nginx/load balancer
if (config.trustProxy) {
  app.set('trust proxy', 1);
}

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
    },
  },
  hsts: config.isProduction ? {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  } : false,
  noSniff: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// Disable X-Powered-By header
app.disable('x-powered-by');

// CORS - disabled in production
if (!config.isProduction) {
  app.use(cors({
    origin: '*',
    credentials: true,
  }));
}

// Rate limiting (simple in-memory implementation)
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

function rateLimiter(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = config.rateLimit.windowMs;
  const maxRequests = config.rateLimit.maxRequests;

  const record = rateLimitStore.get(ip);

  if (!record || now > record.resetTime) {
    rateLimitStore.set(ip, { count: 1, resetTime: now + windowMs });
    next();
    return;
  }

  if (record.count >= maxRequests) {
    res.status(429).json({
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please try again later.',
      },
    });
    return;
  }

  record.count++;
  next();
}

// Clean up rate limit store periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitStore.entries()) {
    if (now > record.resetTime) {
      rateLimitStore.delete(ip);
    }
  }
}, 60000);

// HTTP Basic Auth middleware (first layer of protection in production)
function basicAuthMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  // Skip basic auth if not configured
  if (!config.auth.basicAuth) {
    next();
    return;
  }

  // Allow health checks without basic auth
  if (req.path === '/health' || req.path === '/robots.txt') {
    next();
    return;
  }

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Alphabet Trains"');
    res.status(401).send('Authentication required');
    return;
  }

  const base64Credentials = authHeader.split(' ')[1];
  if (!base64Credentials) {
    res.set('WWW-Authenticate', 'Basic realm="Alphabet Trains"');
    res.status(401).send('Authentication required');
    return;
  }

  const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
  const [username, password] = credentials.split(':');

  if (username === config.auth.basicAuth.user && password === config.auth.basicAuth.pass) {
    next();
    return;
  }

  res.set('WWW-Authenticate', 'Basic realm="Alphabet Trains"');
  res.status(401).send('Invalid credentials');
}

// Apply rate limiting
app.use(rateLimiter);

// Apply HTTP Basic Auth (production only, or if configured)
app.use(basicAuthMiddleware);

// Body parsing
app.use(express.json({ limit: '1mb' }));

// Request logging (minimal in production)
app.use((req, _res, next) => {
  if (!config.isProduction || config.logLevel === 'debug') {
    console.log(`[API] ${req.method} ${req.path}`);
  }
  next();
});

// Serve robots.txt (block crawlers)
app.get('/robots.txt', (_req, res) => {
  res.sendFile(path.join(__dirname, '../../public/robots.txt'));
});

// Health check (unauthenticated - for load balancer)
app.use('/health', healthRoutes);

// Serve static UI files
app.use('/ui', express.static(path.join(__dirname, '../../public'), {
  index: 'index.html',
  maxAge: config.isProduction ? '1h' : 0,
}));

// Serve index.html for root
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '../../public/index.html'));
});

// API routes (require Admin token auth)
app.use('/api/policies', authMiddleware, policyRoutes);
app.use('/api/proposals', authMiddleware, proposalRoutes);
app.use('/api/system', authMiddleware, systemRoutes);
app.use('/api/audit', authMiddleware, auditRoutes);
app.use('/api/snapshots', authMiddleware, snapshotRoutes);

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
  console.error('[API] Error:', err.message);
  if (!config.isProduction) {
    console.error(err.stack);
  }
  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: config.isProduction ? 'Internal server error' : err.message,
    },
  });
});

// Start server
const port = config.port;
app.listen(port, () => {
  console.log('========================================');
  console.log('Alphabet Trains - Google Ads Co-Pilot');
  console.log('========================================');
  console.log(`Environment: ${config.nodeEnv}`);
  console.log(`Port: ${port}`);
  console.log(`Google Ads: ${config.googleAds.isConfigured ? 'Connected' : 'Stub mode'}`);
  console.log(`Basic Auth: ${config.auth.basicAuth ? 'Enabled' : 'Disabled'}`);
  console.log(`Rate Limit: ${config.rateLimit.maxRequests} requests per ${config.rateLimit.windowMs / 60000} min`);
  console.log('========================================');
  if (!config.isProduction) {
    console.log(`UI: http://localhost:${port}`);
    console.log(`Health: http://localhost:${port}/health`);
  }
});

export default app;
