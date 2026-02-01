/**
 * Policy Routes
 * CRUD operations for policies and overrides
 */

import { Router } from 'express';
import { z } from 'zod';
import { getPolicyService } from '../../services/policy.js';
import { getNotifier } from '../../services/notifier.js';
import { requireAdmin } from '../middleware/auth.js';
import type { PolicyConfig, ProposalType } from '../../types/index.js';

const router = Router();

// Validation schemas
const policyConfigSchema = z.object({
  break_even_roas: z.number().positive(),
  target_roas: z.number().positive(),
  max_daily_spend_cap: z.number().positive(),
  hard_limit: z.number().positive(),
  max_step_budget_increase_pct: z.number().min(0).max(100),
  max_step_budget_decrease_pct: z.number().min(0).max(100),
  cooldown_days_budget_changes: z.number().int().min(0),
  max_weekly_loss_usd: z.number().positive(),
  roas_drop_safety_threshold_pct: z.number().min(0).max(100),
  min_conversions_for_confidence: z.number().int().min(0),
  min_data_days_for_proposal: z.number().int().min(1),
  max_lead_time_days_for_scaling: z.number().int().min(0),
  block_scaling_on_high_fulfillment_risk: z.boolean(),
  autopilot_enabled: z.boolean(),
  autopilot_actions: z.array(z.enum(['budget_increase', 'budget_decrease', 'product_exclusion', 'asset_replacement'])),
  autopilot_max_budget_change_usd: z.number().min(0),
});

const createPolicySchema = z.object({
  config: policyConfigSchema,
  reason: z.string().min(1),
});

const createOverrideSchema = z.object({
  override_type: z.enum(['raise_cap', 'lock_campaign', 'disable_autopilot', 'custom']),
  target_campaign_id: z.string().optional(),
  override_config: z.record(z.unknown()),
  reason: z.string().min(1),
  expires_at: z.string().datetime().optional(),
});

/**
 * GET /policies/current
 * Get the current active policy
 */
router.get('/current', async (_req, res) => {
  try {
    const policyService = getPolicyService();
    const policy = await policyService.getCurrentPolicy();

    if (!policy) {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'No active policy found',
        },
      });
      return;
    }

    res.json({
      success: true,
      data: policy,
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
 * GET /policies
 * List all policy versions
 */
router.get('/', async (req, res) => {
  try {
    const limit = parseInt(req.query['limit'] as string) || 20;
    const policyService = getPolicyService();
    const policies = await policyService.listPolicies(limit);

    res.json({
      success: true,
      data: policies,
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
 * GET /policies/:version
 * Get a specific policy version
 */
router.get('/:version', async (req, res) => {
  try {
    const version = parseInt(req.params['version'] ?? '');
    if (isNaN(version)) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_VERSION',
          message: 'Version must be a number',
        },
      });
      return;
    }

    const policyService = getPolicyService();
    const policy = await policyService.getPolicyByVersion(version);

    if (!policy) {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: `Policy version ${version} not found`,
        },
      });
      return;
    }

    res.json({
      success: true,
      data: policy,
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
 * POST /policies
 * Create a new policy version (requires admin)
 */
router.post('/', requireAdmin, async (req, res) => {
  try {
    const validation = createPolicySchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid policy configuration',
          details: validation.error.format(),
        },
      });
      return;
    }

    const { config, reason } = validation.data;
    const actor = req.user?.id ?? 'unknown';

    const policyService = getPolicyService();
    const currentPolicy = await policyService.getCurrentPolicy();

    const newPolicy = await policyService.createPolicy(
      config as PolicyConfig,
      actor,
      reason
    );

    // Send notification
    const notifier = getNotifier();
    const keyChanges: string[] = [];

    if (currentPolicy) {
      // Identify key changes
      if (config.hard_limit !== currentPolicy.config.hard_limit) {
        keyChanges.push(`Hard limit: $${currentPolicy.config.hard_limit} → $${config.hard_limit}`);
      }
      if (config.target_roas !== currentPolicy.config.target_roas) {
        keyChanges.push(`Target ROAS: ${currentPolicy.config.target_roas} → ${config.target_roas}`);
      }
      if (config.autopilot_enabled !== currentPolicy.config.autopilot_enabled) {
        keyChanges.push(`Autopilot: ${currentPolicy.config.autopilot_enabled ? 'enabled' : 'disabled'} → ${config.autopilot_enabled ? 'enabled' : 'disabled'}`);
      }
    }

    await notifier.sendPolicyChangeNotification({
      policy_version: newPolicy.version,
      changed_by: actor,
      reason,
      key_changes: keyChanges.length > 0 ? keyChanges : ['Full policy replacement'],
    });

    res.status(201).json({
      success: true,
      data: newPolicy,
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
 * POST /policies/override
 * Create a policy override (requires admin)
 */
router.post('/override', requireAdmin, async (req, res) => {
  try {
    const validation = createOverrideSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid override configuration',
          details: validation.error.format(),
        },
      });
      return;
    }

    const { override_type, target_campaign_id, override_config, reason, expires_at } = validation.data;
    const actor = req.user?.id ?? 'unknown';

    const policyService = getPolicyService();
    const override = await policyService.createOverride(
      override_type,
      override_config,
      reason,
      actor,
      target_campaign_id,
      expires_at ? new Date(expires_at) : undefined
    );

    // Send notification
    const notifier = getNotifier();
    await notifier.sendPolicyChangeNotification({
      policy_version: -1, // Indicate override
      changed_by: actor,
      reason: `Policy override created: ${override_type}`,
      key_changes: [
        `Override type: ${override_type}`,
        target_campaign_id ? `Target campaign: ${target_campaign_id}` : 'Global override',
        `Reason: ${reason}`,
      ],
    });

    res.status(201).json({
      success: true,
      data: override,
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
 * GET /policies/overrides/active
 * Get active overrides
 */
router.get('/overrides/active', async (req, res) => {
  try {
    const campaignId = req.query['campaign_id'] as string | undefined;
    const policyService = getPolicyService();
    const overrides = await policyService.getActiveOverrides(campaignId);

    res.json({
      success: true,
      data: overrides,
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
 * DELETE /policies/overrides/:id
 * Deactivate an override (requires admin)
 */
router.delete('/overrides/:id', requireAdmin, async (req, res) => {
  try {
    const overrideId = req.params['id'];
    if (!overrideId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Override ID required',
        },
      });
      return;
    }

    const actor = req.user?.id ?? 'unknown';
    const policyService = getPolicyService();
    await policyService.deactivateOverride(overrideId, actor);

    res.json({
      success: true,
      data: { message: 'Override deactivated' },
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
