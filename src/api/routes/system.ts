/**
 * System Routes
 * Kill switch, safety stop, and system operations
 */

import { Router } from 'express';
import { z } from 'zod';
import { getSystemStateService } from '../../services/system-state.js';
import { getNotifier } from '../../services/notifier.js';
import { requireAdmin } from '../middleware/auth.js';

const router = Router();

// Validation schemas
const killSwitchSchema = z.object({
  reason: z.string().min(1).optional(),
});

/**
 * GET /system/state
 * Get current system state
 */
router.get('/state', async (_req, res) => {
  try {
    const systemState = getSystemStateService();
    const state = await systemState.getState();

    res.json({
      success: true,
      data: state,
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
 * POST /system/killswitch/enable
 * Enable kill switch - immediately freezes all writes
 */
router.post('/killswitch/enable', requireAdmin, async (req, res) => {
  try {
    const validation = killSwitchSchema.safeParse(req.body);
    const reason = validation.success ? validation.data.reason : 'Manual activation';

    const actor = req.user?.id ?? 'unknown';
    const systemState = getSystemStateService();

    await systemState.enableKillSwitch(actor, reason ?? 'Manual activation');

    // Send notification
    const notifier = getNotifier();
    await notifier.sendKillSwitchNotification(true, actor, reason);

    res.json({
      success: true,
      data: {
        message: 'Kill switch enabled - all writes are now frozen',
        enabled_by: actor,
        reason,
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
 * POST /system/killswitch/disable
 * Disable kill switch - allows writes to resume
 */
router.post('/killswitch/disable', requireAdmin, async (req, res) => {
  try {
    const actor = req.user?.id ?? 'unknown';
    const systemState = getSystemStateService();

    await systemState.disableKillSwitch(actor);

    // Send notification
    const notifier = getNotifier();
    await notifier.sendKillSwitchNotification(false, actor);

    res.json({
      success: true,
      data: {
        message: 'Kill switch disabled - writes are now allowed',
        disabled_by: actor,
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
 * POST /system/safety-stop/clear
 * Clear a safety stop (requires investigation first)
 */
router.post('/safety-stop/clear', requireAdmin, async (req, res) => {
  try {
    const actor = req.user?.id ?? 'unknown';
    const systemState = getSystemStateService();

    const currentState = await systemState.getState();
    if (!currentState.safety_stop_active) {
      res.status(400).json({
        success: false,
        error: {
          code: 'NO_SAFETY_STOP',
          message: 'No active safety stop to clear',
        },
      });
      return;
    }

    await systemState.clearSafetyStop(actor);

    res.json({
      success: true,
      data: {
        message: 'Safety stop cleared',
        cleared_by: actor,
        previous_reason: currentState.safety_stop_reason,
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
 * GET /system/writes-allowed
 * Check if writes are currently allowed
 */
router.get('/writes-allowed', async (_req, res) => {
  try {
    const systemState = getSystemStateService();
    const result = await systemState.areWritesAllowed();

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

export default router;
