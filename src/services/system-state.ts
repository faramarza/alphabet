/**
 * System State Service
 * Manages global system state including kill switch and safety stops
 */

import { query } from '../db/client.js';
import { logAuditEvent } from './audit.js';
import type { SystemState, AuditEventType } from '../types/index.js';

// ============================================================================
// DATABASE ROW TYPE
// ============================================================================

interface SystemStateRow {
  id: number;
  kill_switch_enabled: boolean;
  kill_switch_enabled_at: Date | null;
  kill_switch_enabled_by: string | null;
  kill_switch_reason: string | null;
  safety_stop_active: boolean;
  safety_stop_reason: string | null;
  safety_stop_triggered_at: Date | null;
  last_observer_run: Date | null;
  last_policy_evaluation: Date | null;
  last_executor_run: Date | null;
  current_policy_version: number;
  updated_at: Date;
}

// ============================================================================
// SYSTEM STATE SERVICE
// ============================================================================

export class SystemStateService {
  private static instance: SystemStateService | null = null;

  private constructor() {}

  static getInstance(): SystemStateService {
    if (!SystemStateService.instance) {
      SystemStateService.instance = new SystemStateService();
    }
    return SystemStateService.instance;
  }

  /**
   * Get current system state
   */
  async getState(): Promise<SystemState> {
    const result = await query<SystemStateRow>(
      'SELECT * FROM system_state WHERE id = 1'
    );

    if (result.rows.length === 0) {
      // Should not happen due to migration, but handle gracefully
      return {
        kill_switch_enabled: false,
        safety_stop_active: false,
        current_policy_version: 0,
      };
    }

    const row = result.rows[0]!;
    return {
      kill_switch_enabled: row.kill_switch_enabled,
      kill_switch_enabled_at: row.kill_switch_enabled_at ?? undefined,
      kill_switch_enabled_by: row.kill_switch_enabled_by ?? undefined,
      kill_switch_reason: row.kill_switch_reason ?? undefined,
      safety_stop_active: row.safety_stop_active,
      safety_stop_reason: row.safety_stop_reason ?? undefined,
      safety_stop_triggered_at: row.safety_stop_triggered_at ?? undefined,
      last_observer_run: row.last_observer_run ?? undefined,
      last_policy_evaluation: row.last_policy_evaluation ?? undefined,
      last_executor_run: row.last_executor_run ?? undefined,
      current_policy_version: row.current_policy_version,
    };
  }

  /**
   * Enable kill switch - immediately freezes all writes
   */
  async enableKillSwitch(actor: string, reason: string): Promise<void> {
    const before = await this.getState();

    await query(
      `UPDATE system_state SET
        kill_switch_enabled = TRUE,
        kill_switch_enabled_at = NOW(),
        kill_switch_enabled_by = $1,
        kill_switch_reason = $2,
        updated_at = NOW()
       WHERE id = 1`,
      [actor, reason]
    );

    await logAuditEvent({
      event_type: 'kill_switch_enabled' as AuditEventType,
      entity_type: 'system',
      entity_id: 'kill_switch',
      actor,
      action: 'Enabled kill switch',
      details: { reason },
      before_state: { kill_switch_enabled: before.kill_switch_enabled },
      after_state: { kill_switch_enabled: true, reason },
    });

    console.log(`[KILL SWITCH] ENABLED by ${actor}: ${reason}`);
  }

  /**
   * Disable kill switch - allows writes to resume
   */
  async disableKillSwitch(actor: string): Promise<void> {
    const before = await this.getState();

    await query(
      `UPDATE system_state SET
        kill_switch_enabled = FALSE,
        kill_switch_enabled_at = NULL,
        kill_switch_enabled_by = NULL,
        kill_switch_reason = NULL,
        updated_at = NOW()
       WHERE id = 1`
    );

    await logAuditEvent({
      event_type: 'kill_switch_disabled' as AuditEventType,
      entity_type: 'system',
      entity_id: 'kill_switch',
      actor,
      action: 'Disabled kill switch',
      details: {
        previous_reason: before.kill_switch_reason,
        was_enabled_by: before.kill_switch_enabled_by,
      },
      before_state: { kill_switch_enabled: before.kill_switch_enabled },
      after_state: { kill_switch_enabled: false },
    });

    console.log(`[KILL SWITCH] DISABLED by ${actor}`);
  }

  /**
   * Check if writes are allowed
   */
  async areWritesAllowed(): Promise<{ allowed: boolean; reason?: string }> {
    const state = await this.getState();

    if (state.kill_switch_enabled) {
      return {
        allowed: false,
        reason: `Kill switch enabled: ${state.kill_switch_reason ?? 'No reason provided'}`,
      };
    }

    if (state.safety_stop_active) {
      return {
        allowed: false,
        reason: `Safety stop active: ${state.safety_stop_reason ?? 'No reason provided'}`,
      };
    }

    return { allowed: true };
  }

  /**
   * Trigger safety stop
   */
  async triggerSafetyStop(reason: string, actor = 'system'): Promise<void> {
    const before = await this.getState();

    await query(
      `UPDATE system_state SET
        safety_stop_active = TRUE,
        safety_stop_reason = $1,
        safety_stop_triggered_at = NOW(),
        updated_at = NOW()
       WHERE id = 1`,
      [reason]
    );

    await logAuditEvent({
      event_type: 'safety_stop_triggered' as AuditEventType,
      entity_type: 'system',
      entity_id: 'safety_stop',
      actor,
      action: 'Safety stop triggered',
      details: { reason },
      before_state: { safety_stop_active: before.safety_stop_active },
      after_state: { safety_stop_active: true, reason },
    });

    console.error(`[SAFETY STOP] TRIGGERED: ${reason}`);
  }

  /**
   * Clear safety stop
   */
  async clearSafetyStop(actor: string): Promise<void> {
    const before = await this.getState();

    await query(
      `UPDATE system_state SET
        safety_stop_active = FALSE,
        safety_stop_reason = NULL,
        safety_stop_triggered_at = NULL,
        updated_at = NOW()
       WHERE id = 1`
    );

    await logAuditEvent({
      event_type: 'safety_stop_triggered' as AuditEventType, // Reuse for clear
      entity_type: 'system',
      entity_id: 'safety_stop',
      actor,
      action: 'Safety stop cleared',
      details: { previous_reason: before.safety_stop_reason },
      before_state: { safety_stop_active: before.safety_stop_active },
      after_state: { safety_stop_active: false },
    });

    console.log(`[SAFETY STOP] CLEARED by ${actor}`);
  }

  /**
   * Update job timestamps
   */
  async recordObserverRun(): Promise<void> {
    await query(
      'UPDATE system_state SET last_observer_run = NOW(), updated_at = NOW() WHERE id = 1'
    );
  }

  async recordPolicyEvaluation(): Promise<void> {
    await query(
      'UPDATE system_state SET last_policy_evaluation = NOW(), updated_at = NOW() WHERE id = 1'
    );
  }

  async recordExecutorRun(): Promise<void> {
    await query(
      'UPDATE system_state SET last_executor_run = NOW(), updated_at = NOW() WHERE id = 1'
    );
  }
}

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

export function getSystemStateService(): SystemStateService {
  return SystemStateService.getInstance();
}
