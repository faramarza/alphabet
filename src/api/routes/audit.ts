/**
 * Audit Routes
 * View and verify audit logs
 */

import { Router } from 'express';
import { getAuditLogger } from '../../services/audit.js';
import type { AuditEventType } from '../../types/index.js';

const router = Router();

/**
 * GET /audit
 * Query audit events with filters
 */
router.get('/', async (req, res) => {
  try {
    const auditLogger = getAuditLogger();

    const options: Parameters<typeof auditLogger.query>[0] = {};

    if (req.query['entity_type']) {
      options.entity_type = req.query['entity_type'] as string;
    }

    if (req.query['entity_id']) {
      options.entity_id = req.query['entity_id'] as string;
    }

    if (req.query['event_type']) {
      options.event_type = req.query['event_type'] as AuditEventType;
    }

    if (req.query['actor']) {
      options.actor = req.query['actor'] as string;
    }

    if (req.query['start_date']) {
      options.start_date = new Date(req.query['start_date'] as string);
    }

    if (req.query['end_date']) {
      options.end_date = new Date(req.query['end_date'] as string);
    }

    options.limit = parseInt(req.query['limit'] as string) || 100;
    options.offset = parseInt(req.query['offset'] as string) || 0;

    const events = await auditLogger.query(options);
    const total = await auditLogger.count({
      entity_type: options.entity_type,
      event_type: options.event_type,
    });

    res.json({
      success: true,
      data: events,
      pagination: {
        total,
        limit: options.limit,
        offset: options.offset,
        has_more: (options.offset ?? 0) + events.length < total,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

/**
 * GET /audit/entity/:type/:id
 * Get audit trail for a specific entity
 */
router.get('/entity/:type/:id', async (req, res) => {
  try {
    const entityType = req.params['type'];
    const entityId = req.params['id'];

    if (!entityType || !entityId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_PARAMS',
          message: 'Entity type and ID are required',
        },
      });
      return;
    }

    const auditLogger = getAuditLogger();
    const events = await auditLogger.query({
      entity_type: entityType,
      entity_id: entityId,
      limit: 100,
    });

    res.json({
      success: true,
      data: events,
      meta: {
        entity_type: entityType,
        entity_id: entityId,
        count: events.length,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

/**
 * GET /audit/verify
 * Verify the integrity of the audit chain
 */
router.get('/verify', async (req, res) => {
  try {
    const limit = parseInt(req.query['limit'] as string) || 1000;
    const auditLogger = getAuditLogger();
    const result = await auditLogger.verifyChain(limit);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

/**
 * GET /audit/recent
 * Get recent audit events (shortcut)
 */
router.get('/recent', async (req, res) => {
  try {
    const limit = parseInt(req.query['limit'] as string) || 50;
    const auditLogger = getAuditLogger();
    const events = await auditLogger.query({ limit });

    res.json({
      success: true,
      data: events,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

export default router;
