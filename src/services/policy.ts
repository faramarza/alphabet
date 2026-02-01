/**
 * Policy Engine
 * Deterministic evaluation of metrics against policies
 * Produces proposals with evidence packs (no execution here)
 */

import { v4 as uuidv4 } from 'uuid';
import { query, transaction } from '../db/client.js';
import { logAuditEvent } from './audit.js';
import type {
  Policy,
  PolicyConfig,
  PolicyOverride,
  CampaignSettings,
  OpsSignal,
  CampaignMode,
  RiskLevel,
  AuditEventType,
} from '../types/index.js';

// ============================================================================
// DATABASE ROW TYPES
// ============================================================================

interface PolicyRow {
  id: string;
  version: number;
  config: PolicyConfig;
  created_at: Date;
  created_by: string;
  reason: string;
  is_current: boolean;
}

interface PolicyOverrideRow {
  id: string;
  policy_id: string;
  override_type: string;
  target_campaign_id: string | null;
  override_config: Record<string, unknown>;
  reason: string;
  created_by: string;
  created_at: Date;
  expires_at: Date | null;
  is_active: boolean;
}

interface CampaignSettingsRow {
  id: string;
  campaign_id: string;
  campaign_name: string;
  mode: string;
  is_locked: boolean;
  lock_reason: string | null;
  locked_by: string | null;
  locked_at: Date | null;
  last_budget_change_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface OpsSignalRow {
  id: string;
  campaign_id: string | null;
  product_id: string | null;
  fulfillment_risk: string;
  lead_time_days: number;
  inventory_risk: string;
  is_promo_period: boolean;
  promo_start_date: string | null;
  promo_end_date: string | null;
  creative_fatigue_flag: boolean;
  notes: string | null;
  updated_by: string;
  updated_at: Date;
}

// ============================================================================
// POLICY SERVICE
// ============================================================================

export class PolicyService {
  private static instance: PolicyService | null = null;

  private constructor() {}

  static getInstance(): PolicyService {
    if (!PolicyService.instance) {
      PolicyService.instance = new PolicyService();
    }
    return PolicyService.instance;
  }

  /**
   * Get the current active policy
   */
  async getCurrentPolicy(): Promise<Policy | null> {
    const result = await query<PolicyRow>(
      'SELECT * FROM policies WHERE is_current = TRUE'
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0]!;
    return {
      id: row.id,
      version: row.version,
      config: row.config,
      created_at: row.created_at,
      created_by: row.created_by,
      reason: row.reason,
      is_current: row.is_current,
    };
  }

  /**
   * Get a policy by version
   */
  async getPolicyByVersion(version: number): Promise<Policy | null> {
    const result = await query<PolicyRow>(
      'SELECT * FROM policies WHERE version = $1',
      [version]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0]!;
    return {
      id: row.id,
      version: row.version,
      config: row.config,
      created_at: row.created_at,
      created_by: row.created_by,
      reason: row.reason,
      is_current: row.is_current,
    };
  }

  /**
   * Create a new policy version
   */
  async createPolicy(
    config: PolicyConfig,
    createdBy: string,
    reason: string
  ): Promise<Policy> {
    return transaction(async (client) => {
      // Get the next version number
      const versionResult = await client.query<{ max_version: number | null }>(
        'SELECT MAX(version) as max_version FROM policies'
      );
      const newVersion = (versionResult.rows[0]?.max_version ?? 0) + 1;

      // Get current policy for audit
      const currentResult = await client.query<PolicyRow>(
        'SELECT * FROM policies WHERE is_current = TRUE'
      );
      const oldPolicy = currentResult.rows[0];

      // Mark all existing policies as not current
      await client.query('UPDATE policies SET is_current = FALSE');

      // Insert the new policy
      const id = uuidv4();
      await client.query(
        `INSERT INTO policies (id, version, config, created_by, reason, is_current)
         VALUES ($1, $2, $3, $4, $5, TRUE)`,
        [id, newVersion, JSON.stringify(config), createdBy, reason]
      );

      // Update system state
      await client.query(
        'UPDATE system_state SET current_policy_version = $1, updated_at = NOW() WHERE id = 1',
        [newVersion]
      );

      const newPolicy: Policy = {
        id,
        version: newVersion,
        config,
        created_at: new Date(),
        created_by: createdBy,
        reason,
        is_current: true,
      };

      // Log audit event
      await logAuditEvent({
        event_type: 'policy_created' as AuditEventType,
        entity_type: 'policy',
        entity_id: id,
        actor: createdBy,
        action: `Created policy version ${newVersion}`,
        details: {
          version: newVersion,
          reason,
          config_summary: {
            break_even_roas: config.break_even_roas,
            target_roas: config.target_roas,
            max_daily_spend_cap: config.max_daily_spend_cap,
            hard_limit: config.hard_limit,
          },
        },
        before_state: oldPolicy
          ? { version: oldPolicy.version, config: oldPolicy.config }
          : undefined,
        after_state: { version: newVersion, config },
      });

      return newPolicy;
    });
  }

  /**
   * List all policy versions
   */
  async listPolicies(limit = 20): Promise<Policy[]> {
    const result = await query<PolicyRow>(
      'SELECT * FROM policies ORDER BY version DESC LIMIT $1',
      [limit]
    );

    return result.rows.map((row) => ({
      id: row.id,
      version: row.version,
      config: row.config,
      created_at: row.created_at,
      created_by: row.created_by,
      reason: row.reason,
      is_current: row.is_current,
    }));
  }

  /**
   * Create a policy override
   */
  async createOverride(
    overrideType: PolicyOverride['override_type'],
    config: Record<string, unknown>,
    reason: string,
    createdBy: string,
    targetCampaignId?: string,
    expiresAt?: Date
  ): Promise<PolicyOverride> {
    const policy = await this.getCurrentPolicy();
    if (!policy) {
      throw new Error('No current policy exists');
    }

    const id = uuidv4();

    await query(
      `INSERT INTO policy_overrides (id, policy_id, override_type, target_campaign_id, override_config, reason, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        policy.id,
        overrideType,
        targetCampaignId ?? null,
        JSON.stringify(config),
        reason,
        createdBy,
        expiresAt ?? null,
      ]
    );

    const override: PolicyOverride = {
      id,
      policy_id: policy.id,
      override_type: overrideType,
      target_campaign_id: targetCampaignId,
      override_config: config,
      reason,
      created_by: createdBy,
      created_at: new Date(),
      expires_at: expiresAt,
      is_active: true,
    };

    // Log audit event
    await logAuditEvent({
      event_type: 'policy_override_created' as AuditEventType,
      entity_type: 'policy',
      entity_id: id,
      actor: createdBy,
      action: `Created policy override: ${overrideType}`,
      details: {
        override_type: overrideType,
        target_campaign_id: targetCampaignId,
        config,
        reason,
        expires_at: expiresAt?.toISOString(),
      },
    });

    return override;
  }

  /**
   * Get active overrides for a campaign
   */
  async getActiveOverrides(campaignId?: string): Promise<PolicyOverride[]> {
    let sql = `
      SELECT * FROM policy_overrides
      WHERE is_active = TRUE
        AND (expires_at IS NULL OR expires_at > NOW())
    `;
    const params: unknown[] = [];

    if (campaignId) {
      sql += ` AND (target_campaign_id IS NULL OR target_campaign_id = $1)`;
      params.push(campaignId);
    }

    sql += ' ORDER BY created_at DESC';

    const result = await query<PolicyOverrideRow>(sql, params);

    return result.rows.map((row) => ({
      id: row.id,
      policy_id: row.policy_id,
      override_type: row.override_type as PolicyOverride['override_type'],
      target_campaign_id: row.target_campaign_id ?? undefined,
      override_config: row.override_config,
      reason: row.reason,
      created_by: row.created_by,
      created_at: row.created_at,
      expires_at: row.expires_at ?? undefined,
      is_active: row.is_active,
    }));
  }

  /**
   * Deactivate an override
   */
  async deactivateOverride(overrideId: string, actor: string): Promise<void> {
    await query(
      'UPDATE policy_overrides SET is_active = FALSE WHERE id = $1',
      [overrideId]
    );

    await logAuditEvent({
      event_type: 'policy_override_expired' as AuditEventType,
      entity_type: 'policy',
      entity_id: overrideId,
      actor,
      action: 'Deactivated policy override',
      details: { override_id: overrideId },
    });
  }

  /**
   * Expire outdated overrides
   */
  async expireOutdatedOverrides(): Promise<number> {
    const result = await query<{ id: string }>(
      `UPDATE policy_overrides
       SET is_active = FALSE
       WHERE is_active = TRUE AND expires_at < NOW()
       RETURNING id`
    );

    for (const row of result.rows) {
      await logAuditEvent({
        event_type: 'policy_override_expired' as AuditEventType,
        entity_type: 'policy',
        entity_id: row.id,
        actor: 'system',
        action: 'Policy override auto-expired',
        details: { override_id: row.id },
      });
    }

    return result.rowCount ?? 0;
  }

  /**
   * Get effective config (policy + active overrides)
   */
  async getEffectiveConfig(campaignId?: string): Promise<PolicyConfig> {
    const policy = await this.getCurrentPolicy();
    if (!policy) {
      throw new Error('No current policy exists');
    }

    let effectiveConfig = { ...policy.config };

    const overrides = await this.getActiveOverrides(campaignId);
    for (const override of overrides) {
      // Apply override config on top of base config
      if (override.override_type === 'raise_cap') {
        const newCap = override.override_config['max_daily_spend_cap'];
        if (typeof newCap === 'number') {
          effectiveConfig.max_daily_spend_cap = newCap;
        }
      } else if (override.override_type === 'disable_autopilot') {
        effectiveConfig.autopilot_enabled = false;
      }
      // Custom overrides can set arbitrary fields
      else if (override.override_type === 'custom') {
        effectiveConfig = { ...effectiveConfig, ...override.override_config } as PolicyConfig;
      }
    }

    return effectiveConfig;
  }
}

// ============================================================================
// CAMPAIGN SETTINGS SERVICE
// ============================================================================

export class CampaignSettingsService {
  private static instance: CampaignSettingsService | null = null;

  private constructor() {}

  static getInstance(): CampaignSettingsService {
    if (!CampaignSettingsService.instance) {
      CampaignSettingsService.instance = new CampaignSettingsService();
    }
    return CampaignSettingsService.instance;
  }

  /**
   * Get or create campaign settings
   */
  async getOrCreate(campaignId: string, campaignName: string): Promise<CampaignSettings> {
    // Try to get existing
    const existing = await query<CampaignSettingsRow>(
      'SELECT * FROM campaign_settings WHERE campaign_id = $1',
      [campaignId]
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0]!;
      return {
        id: row.id,
        campaign_id: row.campaign_id,
        campaign_name: row.campaign_name,
        mode: row.mode as CampaignMode,
        is_locked: row.is_locked,
        lock_reason: row.lock_reason ?? undefined,
        locked_by: row.locked_by ?? undefined,
        locked_at: row.locked_at ?? undefined,
        last_budget_change_at: row.last_budget_change_at ?? undefined,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    }

    // Create new
    const id = uuidv4();
    await query(
      `INSERT INTO campaign_settings (id, campaign_id, campaign_name, mode)
       VALUES ($1, $2, $3, $4)`,
      [id, campaignId, campaignName, 'EXPLOIT']
    );

    return {
      id,
      campaign_id: campaignId,
      campaign_name: campaignName,
      mode: CampaignMode.EXPLOIT,
      is_locked: false,
      created_at: new Date(),
      updated_at: new Date(),
    };
  }

  /**
   * Update campaign mode
   */
  async setMode(
    campaignId: string,
    mode: CampaignMode,
    actor: string
  ): Promise<void> {
    const before = await this.getOrCreate(campaignId, '');

    await query(
      'UPDATE campaign_settings SET mode = $1, updated_at = NOW() WHERE campaign_id = $2',
      [mode, campaignId]
    );

    await logAuditEvent({
      event_type: 'campaign_mode_changed' as AuditEventType,
      entity_type: 'campaign',
      entity_id: campaignId,
      actor,
      action: `Changed campaign mode to ${mode}`,
      details: { mode },
      before_state: { mode: before.mode },
      after_state: { mode },
    });
  }

  /**
   * Lock a campaign (prevents any changes)
   */
  async lock(campaignId: string, reason: string, actor: string): Promise<void> {
    await query(
      `UPDATE campaign_settings
       SET is_locked = TRUE, lock_reason = $1, locked_by = $2, locked_at = NOW(), updated_at = NOW()
       WHERE campaign_id = $3`,
      [reason, actor, campaignId]
    );

    await logAuditEvent({
      event_type: 'campaign_mode_changed' as AuditEventType,
      entity_type: 'campaign',
      entity_id: campaignId,
      actor,
      action: 'Locked campaign',
      details: { reason },
    });
  }

  /**
   * Unlock a campaign
   */
  async unlock(campaignId: string, actor: string): Promise<void> {
    await query(
      `UPDATE campaign_settings
       SET is_locked = FALSE, lock_reason = NULL, locked_by = NULL, locked_at = NULL, updated_at = NOW()
       WHERE campaign_id = $1`,
      [campaignId]
    );

    await logAuditEvent({
      event_type: 'campaign_mode_changed' as AuditEventType,
      entity_type: 'campaign',
      entity_id: campaignId,
      actor,
      action: 'Unlocked campaign',
      details: {},
    });
  }

  /**
   * Record budget change timestamp
   */
  async recordBudgetChange(campaignId: string): Promise<void> {
    await query(
      'UPDATE campaign_settings SET last_budget_change_at = NOW(), updated_at = NOW() WHERE campaign_id = $1',
      [campaignId]
    );
  }

  /**
   * Check if cooldown period has passed
   */
  async isCooldownPassed(campaignId: string, cooldownDays: number): Promise<boolean> {
    const result = await query<CampaignSettingsRow>(
      'SELECT last_budget_change_at FROM campaign_settings WHERE campaign_id = $1',
      [campaignId]
    );

    if (result.rows.length === 0 || !result.rows[0]?.last_budget_change_at) {
      return true; // No previous budget change
    }

    const lastChange = result.rows[0].last_budget_change_at;
    const cooldownMs = cooldownDays * 24 * 60 * 60 * 1000;
    return Date.now() - lastChange.getTime() >= cooldownMs;
  }
}

// ============================================================================
// OPS SIGNALS SERVICE
// ============================================================================

export class OpsSignalsService {
  private static instance: OpsSignalsService | null = null;

  private constructor() {}

  static getInstance(): OpsSignalsService {
    if (!OpsSignalsService.instance) {
      OpsSignalsService.instance = new OpsSignalsService();
    }
    return OpsSignalsService.instance;
  }

  /**
   * Get ops signals for a campaign (or global if campaign-specific not found)
   */
  async getSignals(campaignId?: string): Promise<OpsSignal | null> {
    // Try campaign-specific first
    if (campaignId) {
      const result = await query<OpsSignalRow>(
        'SELECT * FROM ops_signals WHERE campaign_id = $1 ORDER BY updated_at DESC LIMIT 1',
        [campaignId]
      );
      if (result.rows.length > 0) {
        return this.rowToOpsSignal(result.rows[0]!);
      }
    }

    // Fall back to global
    const globalResult = await query<OpsSignalRow>(
      'SELECT * FROM ops_signals WHERE campaign_id IS NULL ORDER BY updated_at DESC LIMIT 1'
    );

    if (globalResult.rows.length > 0) {
      return this.rowToOpsSignal(globalResult.rows[0]!);
    }

    return null;
  }

  /**
   * Update ops signals
   */
  async updateSignals(
    signals: Partial<OpsSignal>,
    actor: string,
    campaignId?: string
  ): Promise<OpsSignal> {
    const existing = await this.getSignals(campaignId);

    if (existing && existing.campaign_id === campaignId) {
      // Update existing
      await query(
        `UPDATE ops_signals SET
          fulfillment_risk = COALESCE($1, fulfillment_risk),
          lead_time_days = COALESCE($2, lead_time_days),
          inventory_risk = COALESCE($3, inventory_risk),
          is_promo_period = COALESCE($4, is_promo_period),
          promo_start_date = $5,
          promo_end_date = $6,
          creative_fatigue_flag = COALESCE($7, creative_fatigue_flag),
          notes = $8,
          updated_by = $9,
          updated_at = NOW()
         WHERE id = $10`,
        [
          signals.fulfillment_risk,
          signals.lead_time_days,
          signals.inventory_risk,
          signals.is_promo_period,
          signals.promo_start_date ?? null,
          signals.promo_end_date ?? null,
          signals.creative_fatigue_flag,
          signals.notes ?? null,
          actor,
          existing.id,
        ]
      );
    } else {
      // Create new
      const id = uuidv4();
      await query(
        `INSERT INTO ops_signals (id, campaign_id, fulfillment_risk, lead_time_days, inventory_risk, is_promo_period, promo_start_date, promo_end_date, creative_fatigue_flag, notes, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          id,
          campaignId ?? null,
          signals.fulfillment_risk ?? 'low',
          signals.lead_time_days ?? 3,
          signals.inventory_risk ?? 'low',
          signals.is_promo_period ?? false,
          signals.promo_start_date ?? null,
          signals.promo_end_date ?? null,
          signals.creative_fatigue_flag ?? false,
          signals.notes ?? null,
          actor,
        ]
      );
    }

    await logAuditEvent({
      event_type: 'ops_signal_updated' as AuditEventType,
      entity_type: 'ops_signal',
      entity_id: campaignId ?? 'global',
      actor,
      action: 'Updated ops signals',
      details: signals,
      before_state: existing ? { ...existing } : undefined,
    });

    return (await this.getSignals(campaignId))!;
  }

  /**
   * Check if scaling is blocked by ops signals
   */
  async isScalingBlocked(campaignId: string, policy: PolicyConfig): Promise<{
    blocked: boolean;
    reasons: string[];
  }> {
    const signals = await this.getSignals(campaignId);
    const reasons: string[] = [];

    if (!signals) {
      return { blocked: false, reasons: [] };
    }

    if (
      policy.block_scaling_on_high_fulfillment_risk &&
      signals.fulfillment_risk === 'high'
    ) {
      reasons.push('Fulfillment risk is HIGH');
    }

    if (signals.lead_time_days > policy.max_lead_time_days_for_scaling) {
      reasons.push(
        `Lead time (${signals.lead_time_days} days) exceeds maximum (${policy.max_lead_time_days_for_scaling} days)`
      );
    }

    if (signals.inventory_risk === 'high') {
      reasons.push('Inventory/supplier risk is HIGH');
    }

    return {
      blocked: reasons.length > 0,
      reasons,
    };
  }

  private rowToOpsSignal(row: OpsSignalRow): OpsSignal {
    return {
      id: row.id,
      campaign_id: row.campaign_id ?? undefined,
      product_id: row.product_id ?? undefined,
      fulfillment_risk: row.fulfillment_risk as RiskLevel,
      lead_time_days: row.lead_time_days,
      inventory_risk: row.inventory_risk as RiskLevel,
      is_promo_period: row.is_promo_period,
      promo_start_date: row.promo_start_date ?? undefined,
      promo_end_date: row.promo_end_date ?? undefined,
      creative_fatigue_flag: row.creative_fatigue_flag,
      notes: row.notes ?? undefined,
      updated_by: row.updated_by,
      updated_at: row.updated_at,
    };
  }
}

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

export function getPolicyService(): PolicyService {
  return PolicyService.getInstance();
}

export function getCampaignSettingsService(): CampaignSettingsService {
  return CampaignSettingsService.getInstance();
}

export function getOpsSignalsService(): OpsSignalsService {
  return OpsSignalsService.getInstance();
}
