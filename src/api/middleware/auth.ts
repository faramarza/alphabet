/**
 * Authentication Middleware
 * Validates admin token for API access
 * SECURITY: Never accept unauthenticated requests
 */

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../../config/index.js';

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        role: 'admin' | 'viewer';
      };
    }
  }
}

/**
 * Validate Bearer token, Admin token, or Basic auth
 */
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authorization header required',
      },
    });
    return;
  }

  // Support "Bearer <token>", "Admin <token>", and "Basic <base64>" formats
  const [scheme, token] = authHeader.split(' ');

  if (!token) {
    res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid authorization format',
      },
    });
    return;
  }

  // Check for Basic auth (from frontend)
  if (scheme?.toLowerCase() === 'basic') {
    try {
      const credentials = Buffer.from(token, 'base64').toString('utf-8');
      const [username, password] = credentials.split(':');

      if (config.auth.basicAuth &&
          username === config.auth.basicAuth.user &&
          password === config.auth.basicAuth.pass) {
        req.user = { id: 'admin', role: 'admin' };
        next();
        return;
      }
    } catch {
      // Invalid base64, fall through to error
    }

    res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid credentials',
      },
    });
    return;
  }

  // Check for admin token (simple auth for MVP)
  if (scheme?.toLowerCase() === 'admin') {
    if (token === config.auth.adminToken) {
      req.user = { id: 'admin', role: 'admin' };
      next();
      return;
    } else {
      res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid admin token',
        },
      });
      return;
    }
  }

  // Check for JWT Bearer token
  if (scheme?.toLowerCase() === 'bearer') {
    try {
      const payload = jwt.verify(token, config.auth.jwtSecret) as {
        sub: string;
        role: 'admin' | 'viewer';
      };

      req.user = {
        id: payload.sub,
        role: payload.role,
      };
      next();
      return;
    } catch {
      res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid or expired token',
        },
      });
      return;
    }
  }

  res.status(401).json({
    success: false,
    error: {
      code: 'UNAUTHORIZED',
      message: 'Unsupported authorization scheme',
    },
  });
}

/**
 * Require admin role for write operations
 */
export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
      },
    });
    return;
  }

  if (req.user.role !== 'admin') {
    res.status(403).json({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Admin role required for this operation',
      },
    });
    return;
  }

  next();
}

/**
 * Generate a JWT token for a user
 */
export function generateToken(userId: string, role: 'admin' | 'viewer'): string {
  return jwt.sign(
    { sub: userId, role },
    config.auth.jwtSecret,
    { expiresIn: '24h' }
  );
}
