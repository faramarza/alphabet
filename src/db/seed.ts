/**
 * Database Seed Script
 * Creates initial data including the default policy for Alphabet Trains
 */

import { v4 as uuidv4 } from 'uuid';
import { query, closePool } from './client.js';
import type { PolicyConfig } from '../types/index.js';

const DEFAULT_POLICY: PolicyConfig = {
  // Profit rails (non-negotiable)
  break_even_roas: 4.0,
  target_roas: 5.0,

  // Budget guardrails
  max_daily_spend_cap: 100, // $100 USD
  hard_limit: 300, // $300 USD absolute maximum
  max_step_budget_increase_pct: 10, // 10% max increase per change
  max_step_budget_decrease_pct: 20, // 20% max decrease per change
  cooldown_days_budget_changes: 7, // 7 days between budget changes
  max_weekly_loss_usd: 500, // Stop if weekly loss exceeds $500

  // Safety thresholds
  roas_drop_safety_threshold_pct: 30, // Trigger safety stop if ROAS drops >30%
  min_conversions_for_confidence: 10, // Need 10+ conversions for proposals
  min_data_days_for_proposal: 7, // Need 7+ days of data

  // Fulfillment risk thresholds
  max_lead_time_days_for_scaling: 5, // Don't scale if lead time >5 days
  block_scaling_on_high_fulfillment_risk: true, // Block scaling when fulfillment_risk=high

  // Autopilot settings (conservative default: require approval for everything)
  autopilot_enabled: false,
  autopilot_actions: [], // Empty = all actions require approval
  autopilot_max_budget_change_usd: 10, // Even if autopilot enabled, max $10 change
};

async function seed(): Promise<void> {
  console.log('Seeding database...');

  // Check if policy already exists
  const existing = await query('SELECT id FROM policies WHERE version = 1');
  if (existing.rows.length > 0) {
    console.log('Policy version 1 already exists. Skipping seed.');
    return;
  }

  // Create initial policy
  const policyId = uuidv4();
  await query(
    `INSERT INTO policies (id, version, config, created_by, reason, is_current)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      policyId,
      1,
      JSON.stringify(DEFAULT_POLICY),
      'system',
      'Initial Alphabet Trains policy configuration',
      true,
    ]
  );
  console.log('✓ Created initial policy (version 1)');

  // Update system state with policy version
  await query(
    `UPDATE system_state SET current_policy_version = 1, updated_at = NOW() WHERE id = 1`
  );
  console.log('✓ Updated system state');

  // Create a sample global ops signal
  const opsSignalId = uuidv4();
  await query(
    `INSERT INTO ops_signals (id, campaign_id, fulfillment_risk, lead_time_days, inventory_risk, updated_by)
     VALUES ($1, NULL, $2, $3, $4, $5)`,
    [
      opsSignalId,
      'low',
      3,
      'low',
      'system',
    ]
  );
  console.log('✓ Created global ops signal');

  // Create initial audit event (genesis)
  const genesisHash = '0000000000000000000000000000000000000000000000000000000000000000';
  const auditDetails = {
    policy_version: 1,
    config: DEFAULT_POLICY,
  };
  const auditAction = 'System initialized with default policy';

  // Compute hash for audit event
  const hashInput = [
    'policy_created',
    'policy',
    policyId,
    'system',
    auditAction,
    JSON.stringify(auditDetails),
    new Date().toISOString(),
    genesisHash,
  ].join('|');

  // Simple hash computation (in production, use crypto)
  const hash = await query<{ hash: string }>(
    `SELECT encode(sha256($1::bytea), 'hex') as hash`,
    [hashInput]
  );

  await query(
    `INSERT INTO audit_events (event_type, entity_type, entity_id, actor, action, details, hash, prev_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      'policy_created',
      'policy',
      policyId,
      'system',
      auditAction,
      JSON.stringify(auditDetails),
      hash.rows[0]?.hash ?? genesisHash,
      genesisHash,
    ]
  );
  console.log('✓ Created genesis audit event');

  console.log('\nSeed complete!');
  console.log('\nDefault policy configuration:');
  console.log(JSON.stringify(DEFAULT_POLICY, null, 2));
}

async function main(): Promise<void> {
  try {
    await seed();
  } catch (error) {
    console.error('Seed error:', error);
    process.exit(1);
  } finally {
    await closePool();
  }
}

main();
