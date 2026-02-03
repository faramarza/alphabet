/**
 * Governance Service
 *
 * Implements the Financial, Measurement & Eligibility Governor doctrine.
 * This service enforces:
 * - Reversibility classification
 * - OBSERVE-ONLY mode
 * - No-action rate tracking
 * - Inaction justification requirements
 * - Impression share doctrine
 *
 * Core Doctrine: No-Action Is a First-Class Outcome
 * Default behavior is inaction. 60-70% of cycles should result in no proposal.
 */

import { query } from '../db/client.js';
import { logAuditEvent } from './audit.js';
import { getSystemStateService } from './system-state.js';
import type { AuditEventType } from '../types/index.js';

// ============================================================================
// TYPES
// ============================================================================

export type ReversibilityLevel = 'full' | 'slow' | 'irreversible';

export interface ReversibilityClassification {
  level: ReversibilityLevel;
  description: string;
  maxAutopilotAllowed: boolean;
  requiredApprovalLevel: 'none' | 'standard' | 'elevated';
  rollbackPlan: RollbackPlan;
}

export interface RollbackPlan {
  canRollback: boolean;
  rollbackSteps: string[];
  estimatedRollbackTime: string;
  potentialRollbackCost: string;
  rollbackTriggers: string[];
}

export interface InactionJustification {
  whyActionSaferThanInaction: string;
  evidenceForSafety: string[];
  downsideOfInaction: string;
  confidenceInSafety: number; // 0-100
}

export interface GovernanceDecision {
  action: 'NO_ACTION' | 'PROPOSE_ACTION' | 'SAFETY_STOP' | 'OBSERVE_ONLY';
  reason: string;
  details?: Record<string, unknown>;
  timestamp: Date;
}

export interface CycleMetrics {
  totalCycles: number;
  noActionCycles: number;
  proposalCycles: number;
  safetyStopCycles: number;
  observeOnlyCycles: number;
  noActionRate: number;
  targetNoActionRate: { min: number; max: number };
  isHealthy: boolean;
}

export interface ObserveOnlyState {
  active: boolean;
  reason?: string;
  activatedAt?: Date;
  activatedBy?: string;
  autoResumeAt?: Date;
  measurementIssues?: string[];
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Target no-action rate (60-70%)
  TARGET_NO_ACTION_RATE_MIN: 0.60,
  TARGET_NO_ACTION_RATE_MAX: 0.70,

  // Alert if action rate exceeds this
  ACTION_RATE_ALERT_THRESHOLD: 0.40,

  // Window for calculating rates
  RATE_CALCULATION_WINDOW_DAYS: 7,

  // Minimum cycles before rate is meaningful
  MIN_CYCLES_FOR_RATE: 10,

  // OBSERVE-ONLY auto-resume hours
  OBSERVE_ONLY_DEFAULT_DURATION_HOURS: 24,

  // Reversibility thresholds
  SLOW_REVERSIBILITY_HOURS: 24,
  IRREVERSIBLE_THRESHOLD_USD: 500,
};

// ============================================================================
// REVERSIBILITY CLASSIFICATION
// ============================================================================

/**
 * Classify the reversibility of a proposed action
 */
export function classifyReversibility(
  actionType: string,
  currentValue: number,
  proposedValue: number,
  _context: {
    campaignId: string;
    isExperiment?: boolean;
    affectsLearning?: boolean;
  }
): ReversibilityClassification {
  const changeAmount = Math.abs(proposedValue - currentValue);
  const changePercent = currentValue > 0 ? (changeAmount / currentValue) * 100 : 100;
  const isDecrease = proposedValue < currentValue;

  // Budget decreases are always fully reversible
  if (actionType === 'budget_decrease' || (actionType.includes('budget') && isDecrease)) {
    return {
      level: 'full',
      description: 'Budget decrease can be immediately reversed by increasing budget',
      maxAutopilotAllowed: true,
      requiredApprovalLevel: 'none',
      rollbackPlan: {
        canRollback: true,
        rollbackSteps: [
          'Increase budget back to previous level',
          'Monitor for 24h to confirm performance recovery',
        ],
        estimatedRollbackTime: 'Immediate',
        potentialRollbackCost: 'None - may miss some impression share temporarily',
        rollbackTriggers: [
          'ROAS drops below target after decrease',
          'Impression share drops significantly',
        ],
      },
    };
  }

  // Small budget increases (≤10%) are fully reversible
  if (actionType === 'budget_increase' && changePercent <= 10) {
    return {
      level: 'full',
      description: 'Small budget increase can be immediately reversed',
      maxAutopilotAllowed: true,
      requiredApprovalLevel: 'none',
      rollbackPlan: {
        canRollback: true,
        rollbackSteps: [
          'Decrease budget to previous level',
          'No lasting impact expected',
        ],
        estimatedRollbackTime: 'Immediate',
        potentialRollbackCost: `Maximum exposure: $${(changeAmount / 1_000_000).toFixed(2)} daily`,
        rollbackTriggers: [
          'ROAS drops below break-even within 48h',
          'Spend increases without proportional conversions',
        ],
      },
    };
  }

  // Medium budget increases (10-25%) are slowly reversible
  if (actionType === 'budget_increase' && changePercent <= 25) {
    return {
      level: 'slow',
      description: 'Medium budget increase may take 24-48h to stabilize after reversal',
      maxAutopilotAllowed: false,
      requiredApprovalLevel: 'standard',
      rollbackPlan: {
        canRollback: true,
        rollbackSteps: [
          'Decrease budget to previous level',
          'Wait 24-48h for Smart Bidding to re-stabilize',
          'Monitor ROAS during stabilization period',
        ],
        estimatedRollbackTime: '24-48 hours for full stabilization',
        potentialRollbackCost: `Maximum exposure: $${(changeAmount * 7 / 1_000_000).toFixed(2)} over stabilization period`,
        rollbackTriggers: [
          'ROAS drops 20% below target within 72h',
          'CPA increases 30% above historical average',
        ],
      },
    };
  }

  // Large changes or structural changes are irreversible/dangerous
  return {
    level: 'irreversible',
    description: 'Large change may cause learning reset or delayed damage',
    maxAutopilotAllowed: false,
    requiredApprovalLevel: 'elevated',
    rollbackPlan: {
      canRollback: false,
      rollbackSteps: [
        'Cannot fully rollback - may trigger learning phase',
        'Gradual reduction over 7 days recommended',
        'Accept potential 2-week performance impact',
      ],
      estimatedRollbackTime: '7-14 days',
      potentialRollbackCost: 'Unpredictable - may reset Smart Bidding learning',
      rollbackTriggers: [
        'Immediate stop if ROAS drops 50% below break-even',
        'Escalate to human review',
      ],
    },
  };
}

/**
 * Check if autopilot is allowed for a given reversibility level
 */
export function isAutopilotAllowed(
  reversibility: ReversibilityClassification,
  confidenceScore: number
): { allowed: boolean; reason: string } {
  // Only fully reversible actions can be autopiloted
  if (reversibility.level !== 'full') {
    return {
      allowed: false,
      reason: `Action is ${reversibility.level} reversible - requires human approval`,
    };
  }

  // Even fully reversible actions need minimum confidence
  if (confidenceScore < 70) {
    return {
      allowed: false,
      reason: `Confidence score ${confidenceScore}% below 70% threshold for autopilot`,
    };
  }

  return {
    allowed: true,
    reason: 'Action is fully reversible with sufficient confidence',
  };
}

// ============================================================================
// OBSERVE-ONLY MODE
// ============================================================================

/**
 * Get current OBSERVE-ONLY state
 */
export async function getObserveOnlyState(): Promise<ObserveOnlyState> {
  try {
    const result = await query<{
      observe_only_active: boolean;
      observe_only_reason: string | null;
      observe_only_activated_at: Date | null;
      observe_only_activated_by: string | null;
      observe_only_auto_resume_at: Date | null;
    }>(`
      SELECT
        observe_only_active,
        observe_only_reason,
        observe_only_activated_at,
        observe_only_activated_by,
        observe_only_auto_resume_at
      FROM system_state
      WHERE id = 1
    `);

    const row = result.rows[0];
    if (!row) {
      return { active: false };
    }

    return {
      active: row.observe_only_active,
      reason: row.observe_only_reason ?? undefined,
      activatedAt: row.observe_only_activated_at ?? undefined,
      activatedBy: row.observe_only_activated_by ?? undefined,
      autoResumeAt: row.observe_only_auto_resume_at ?? undefined,
    };
  } catch {
    // Column might not exist yet
    return { active: false };
  }
}

/**
 * Enter OBSERVE-ONLY mode
 */
export async function enterObserveOnlyMode(
  reason: string,
  activatedBy: string,
  measurementIssues: string[] = [],
  durationHours: number = CONFIG.OBSERVE_ONLY_DEFAULT_DURATION_HOURS
): Promise<void> {
  const autoResumeAt = new Date(Date.now() + durationHours * 60 * 60 * 1000);

  try {
    await query(`
      UPDATE system_state SET
        observe_only_active = true,
        observe_only_reason = $1,
        observe_only_activated_at = NOW(),
        observe_only_activated_by = $2,
        observe_only_auto_resume_at = $3,
        updated_at = NOW()
      WHERE id = 1
    `, [reason, activatedBy, autoResumeAt]);
  } catch {
    // Column might not exist - add it
    await query(`
      ALTER TABLE system_state
        ADD COLUMN IF NOT EXISTS observe_only_active BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS observe_only_reason TEXT,
        ADD COLUMN IF NOT EXISTS observe_only_activated_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS observe_only_activated_by VARCHAR(255),
        ADD COLUMN IF NOT EXISTS observe_only_auto_resume_at TIMESTAMPTZ
    `);

    await query(`
      UPDATE system_state SET
        observe_only_active = true,
        observe_only_reason = $1,
        observe_only_activated_at = NOW(),
        observe_only_activated_by = $2,
        observe_only_auto_resume_at = $3,
        updated_at = NOW()
      WHERE id = 1
    `, [reason, activatedBy, autoResumeAt]);
  }

  await logAuditEvent({
    event_type: 'system_state_changed' as AuditEventType,
    entity_type: 'system',
    entity_id: 'observe_only',
    actor: activatedBy,
    action: 'Entered OBSERVE-ONLY mode',
    details: {
      reason,
      measurement_issues: measurementIssues,
      auto_resume_at: autoResumeAt.toISOString(),
      duration_hours: durationHours,
    },
  });

  console.log(`[Governance] OBSERVE-ONLY MODE ACTIVATED: ${reason}`);
  console.log(`[Governance] Auto-resume scheduled for: ${autoResumeAt.toISOString()}`);
}

/**
 * Exit OBSERVE-ONLY mode
 */
export async function exitObserveOnlyMode(exitedBy: string, reason: string): Promise<void> {
  const currentState = await getObserveOnlyState();

  if (!currentState.active) {
    return;
  }

  await query(`
    UPDATE system_state SET
      observe_only_active = false,
      observe_only_reason = NULL,
      observe_only_activated_at = NULL,
      observe_only_activated_by = NULL,
      observe_only_auto_resume_at = NULL,
      updated_at = NOW()
    WHERE id = 1
  `);

  await logAuditEvent({
    event_type: 'system_state_changed' as AuditEventType,
    entity_type: 'system',
    entity_id: 'observe_only',
    actor: exitedBy,
    action: 'Exited OBSERVE-ONLY mode',
    details: {
      reason,
      was_active_since: currentState.activatedAt?.toISOString(),
      original_reason: currentState.reason,
    },
  });

  console.log(`[Governance] OBSERVE-ONLY MODE DEACTIVATED: ${reason}`);
}

/**
 * Check and auto-resume if scheduled time has passed
 */
export async function checkObserveOnlyAutoResume(): Promise<boolean> {
  const state = await getObserveOnlyState();

  if (state.active && state.autoResumeAt && new Date() > state.autoResumeAt) {
    await exitObserveOnlyMode('system', 'Auto-resume time reached');
    return true;
  }

  return false;
}

// ============================================================================
// NO-ACTION RATE TRACKING
// ============================================================================

/**
 * Record a governance cycle outcome
 */
export async function recordCycleOutcome(
  decision: GovernanceDecision,
  campaignId?: string
): Promise<void> {
  try {
    await query(`
      INSERT INTO governance_cycles (
        decision_type,
        reason,
        campaign_id,
        details,
        created_at
      ) VALUES ($1, $2, $3, $4, NOW())
    `, [decision.action, decision.reason, campaignId ?? null, JSON.stringify(decision.details ?? {})]);
  } catch {
    // Table might not exist - create it
    await query(`
      CREATE TABLE IF NOT EXISTS governance_cycles (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        decision_type VARCHAR(50) NOT NULL,
        reason TEXT NOT NULL,
        campaign_id VARCHAR(255),
        details JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await query(`
      INSERT INTO governance_cycles (
        decision_type,
        reason,
        campaign_id,
        details,
        created_at
      ) VALUES ($1, $2, $3, $4, NOW())
    `, [decision.action, decision.reason, campaignId ?? null, JSON.stringify(decision.details ?? {})]);
  }
}

/**
 * Get cycle metrics for monitoring
 */
export async function getCycleMetrics(): Promise<CycleMetrics> {
  try {
    const result = await query<{
      decision_type: string;
      count: string;
    }>(`
      SELECT decision_type, COUNT(*) as count
      FROM governance_cycles
      WHERE created_at > NOW() - INTERVAL '${CONFIG.RATE_CALCULATION_WINDOW_DAYS} days'
      GROUP BY decision_type
    `);

    let totalCycles = 0;
    let noActionCycles = 0;
    let proposalCycles = 0;
    let safetyStopCycles = 0;
    let observeOnlyCycles = 0;

    for (const row of result.rows) {
      const count = Number(row.count);
      totalCycles += count;

      switch (row.decision_type) {
        case 'NO_ACTION':
          noActionCycles = count;
          break;
        case 'PROPOSE_ACTION':
          proposalCycles = count;
          break;
        case 'SAFETY_STOP':
          safetyStopCycles = count;
          break;
        case 'OBSERVE_ONLY':
          observeOnlyCycles = count;
          break;
      }
    }

    const noActionRate = totalCycles > 0 ? noActionCycles / totalCycles : 1;
    const isHealthy = totalCycles < CONFIG.MIN_CYCLES_FOR_RATE ||
      (noActionRate >= CONFIG.TARGET_NO_ACTION_RATE_MIN && noActionRate <= CONFIG.TARGET_NO_ACTION_RATE_MAX);

    return {
      totalCycles,
      noActionCycles,
      proposalCycles,
      safetyStopCycles,
      observeOnlyCycles,
      noActionRate,
      targetNoActionRate: {
        min: CONFIG.TARGET_NO_ACTION_RATE_MIN,
        max: CONFIG.TARGET_NO_ACTION_RATE_MAX,
      },
      isHealthy,
    };
  } catch {
    // Table might not exist
    return {
      totalCycles: 0,
      noActionCycles: 0,
      proposalCycles: 0,
      safetyStopCycles: 0,
      observeOnlyCycles: 0,
      noActionRate: 1,
      targetNoActionRate: {
        min: CONFIG.TARGET_NO_ACTION_RATE_MIN,
        max: CONFIG.TARGET_NO_ACTION_RATE_MAX,
      },
      isHealthy: true,
    };
  }
}

/**
 * Check if action rate is healthy
 */
export async function checkActionRateHealth(): Promise<{
  healthy: boolean;
  message: string;
  metrics: CycleMetrics;
}> {
  const metrics = await getCycleMetrics();

  if (metrics.totalCycles < CONFIG.MIN_CYCLES_FOR_RATE) {
    return {
      healthy: true,
      message: `Insufficient cycles (${metrics.totalCycles}) for rate calculation`,
      metrics,
    };
  }

  const actionRate = 1 - metrics.noActionRate;

  if (actionRate > CONFIG.ACTION_RATE_ALERT_THRESHOLD) {
    return {
      healthy: false,
      message: `Action rate ${(actionRate * 100).toFixed(0)}% exceeds ${(CONFIG.ACTION_RATE_ALERT_THRESHOLD * 100).toFixed(0)}% threshold. System may be too aggressive.`,
      metrics,
    };
  }

  if (metrics.noActionRate < CONFIG.TARGET_NO_ACTION_RATE_MIN) {
    return {
      healthy: false,
      message: `No-action rate ${(metrics.noActionRate * 100).toFixed(0)}% below ${(CONFIG.TARGET_NO_ACTION_RATE_MIN * 100).toFixed(0)}% target. Consider tightening thresholds.`,
      metrics,
    };
  }

  return {
    healthy: true,
    message: `No-action rate ${(metrics.noActionRate * 100).toFixed(0)}% within target range`,
    metrics,
  };
}

// ============================================================================
// INACTION JUSTIFICATION
// ============================================================================

/**
 * Build justification for why action is safer than inaction
 */
export function buildInactionJustification(
  actionType: string,
  metrics: {
    roas: number;
    targetRoas: number;
    breakEvenRoas: number;
    confidence: number;
    budgetUtilization: number;
  },
  reversibility: ReversibilityClassification
): InactionJustification {
  const evidenceForSafety: string[] = [];
  let whyActionSaferThanInaction = '';
  let downsideOfInaction = '';
  let confidenceInSafety = 0;

  if (actionType === 'budget_decrease') {
    // Decreasing budget when ROAS is poor
    whyActionSaferThanInaction = `Current ROAS (${metrics.roas.toFixed(2)}) is below break-even (${metrics.breakEvenRoas.toFixed(2)}). Continuing current spend loses money with each dollar spent.`;

    evidenceForSafety.push(`ROAS ${metrics.roas.toFixed(2)} < break-even ${metrics.breakEvenRoas.toFixed(2)}`);
    evidenceForSafety.push(`Action is ${reversibility.level} reversible`);
    evidenceForSafety.push(`Confidence in measurement: ${(metrics.confidence * 100).toFixed(0)}%`);

    downsideOfInaction = `Continuing at current budget wastes approximately $${((1 - metrics.roas / metrics.breakEvenRoas) * 100).toFixed(0)}% of daily spend.`;

    confidenceInSafety = Math.min(95, metrics.confidence * 100 + 20); // Higher confidence for protective actions

  } else if (actionType === 'budget_increase') {
    // Increasing budget when ROAS is strong
    const roasBuffer = metrics.roas - metrics.targetRoas;

    whyActionSaferThanInaction = `ROAS (${metrics.roas.toFixed(2)}) significantly exceeds target (${metrics.targetRoas.toFixed(2)}) with ${(roasBuffer).toFixed(2)} buffer. Budget appears to be constraining profitable spend.`;

    evidenceForSafety.push(`ROAS ${metrics.roas.toFixed(2)} > target ${metrics.targetRoas.toFixed(2)}`);
    evidenceForSafety.push(`Budget utilization: ${(metrics.budgetUtilization).toFixed(0)}%`);
    evidenceForSafety.push(`Action is ${reversibility.level} reversible`);
    evidenceForSafety.push(`Rollback time: ${reversibility.rollbackPlan.estimatedRollbackTime}`);

    downsideOfInaction = `Missing potential profitable conversions due to budget constraint. Opportunity cost estimated based on current performance.`;

    // Lower confidence for increases - they're riskier
    confidenceInSafety = Math.min(80, metrics.confidence * 100 - 10);
  }

  return {
    whyActionSaferThanInaction,
    evidenceForSafety,
    downsideOfInaction,
    confidenceInSafety,
  };
}

// ============================================================================
// IMPRESSION SHARE DOCTRINE
// ============================================================================

/**
 * Check if a proposal violates the impression share doctrine
 *
 * Impression share is an emergent outcome, not a target.
 * We NEVER attempt to optimize impression share directly.
 */
export function checkImpressionShareDoctrine(
  proposalReason: string,
  evidenceReasons: string[]
): { compliant: boolean; violation?: string } {
  const lowerReason = proposalReason.toLowerCase();
  const allReasons = [lowerReason, ...evidenceReasons.map(r => r.toLowerCase())].join(' ');

  // Check for direct impression share optimization
  const violationPatterns = [
    /increase.*impression.*share/,
    /improve.*impression.*share/,
    /boost.*impression.*share/,
    /maximize.*impression/,
    /impression.*share.*target/,
    /low.*impression.*share.*therefore/,
    /impression.*share.*too.*low/,
  ];

  for (const pattern of violationPatterns) {
    if (pattern.test(allReasons)) {
      return {
        compliant: false,
        violation: 'Proposal attempts to directly optimize impression share. Impression share is an emergent outcome, not a target.',
      };
    }
  }

  // Allowed: impression share as supporting evidence, not primary reason
  return { compliant: true };
}

/**
 * Classify the legitimate reason for impression share improvement
 */
export function classifyImpressionShareAction(
  reason: string
): 'eligibility' | 'signal_clarity' | 'budget_permissioning' | 'not_allowed' {
  const lower = reason.toLowerCase();

  // A. Removing Eligibility Constraints
  if (
    lower.includes('disapproval') ||
    lower.includes('merchant center') ||
    lower.includes('feed') ||
    lower.includes('gtin') ||
    lower.includes('policy') ||
    lower.includes('eligibility')
  ) {
    return 'eligibility';
  }

  // B. Improving Signal Clarity
  if (
    lower.includes('tracking') ||
    lower.includes('conversion') ||
    lower.includes('measurement') ||
    lower.includes('lag') ||
    lower.includes('attribution')
  ) {
    return 'signal_clarity';
  }

  // C. Permissioning Incremental Budget
  if (
    lower.includes('budget') &&
    (lower.includes('binding') || lower.includes('constrain') || lower.includes('limit') || lower.includes('cap'))
  ) {
    return 'budget_permissioning';
  }

  // Not a legitimate impression share action
  return 'not_allowed';
}

// ============================================================================
// EXPLORE MODE ISOLATION RULES
// ============================================================================

/**
 * EXPLORE mode campaign isolation rules.
 *
 * EXPLORE mode is for limited experiments with explicit hypothesis & cap.
 * These campaigns MUST be isolated to prevent contamination of EXPLOIT learnings.
 */

export interface ExploreModeConfig {
  campaignId: string;
  hypothesis: string;
  maxExperimentSpend: number;
  startDate: Date;
  endDate: Date;
  isolationRules: ExploreIsolationRules;
}

export interface ExploreIsolationRules {
  // Budget isolation - EXPLORE campaigns have separate budget pools
  budgetIsolated: boolean;
  maxDailySpendUsd: number;
  totalBudgetCapUsd: number;

  // Learning isolation - prevent Smart Bidding learning contamination
  excludeFromPortfolioBidding: boolean;
  separateConversionAction: boolean;

  // Audience isolation - prevent audience overlap
  excludeFromRemarketingLists: boolean;
  audienceExclusionList: string[];

  // Attribution isolation
  separateAttributionWindow: boolean;

  // Auto-termination conditions
  terminateIfRoasBelowBreakeven: boolean;
  terminateIfSpendExceedsCap: boolean;
  terminateOnEndDate: boolean;
}

/**
 * Check if a campaign is in EXPLORE mode
 */
export async function isExploreModeActive(campaignId: string): Promise<{
  active: boolean;
  config?: ExploreModeConfig;
}> {
  try {
    const result = await query<{
      campaign_id: string;
      mode: string;
      explore_hypothesis: string | null;
      explore_max_spend: string | null;
      explore_start_date: Date | null;
      explore_end_date: Date | null;
    }>(`
      SELECT campaign_id, mode, explore_hypothesis, explore_max_spend,
             explore_start_date, explore_end_date
      FROM campaign_settings
      WHERE campaign_id = $1 AND mode = 'EXPLORE'
    `, [campaignId]);

    if (result.rows.length === 0) {
      return { active: false };
    }

    const row = result.rows[0]!;

    return {
      active: true,
      config: {
        campaignId: row.campaign_id,
        hypothesis: row.explore_hypothesis ?? 'No hypothesis specified',
        maxExperimentSpend: Number(row.explore_max_spend ?? 0),
        startDate: row.explore_start_date ?? new Date(),
        endDate: row.explore_end_date ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        isolationRules: getDefaultExploreIsolationRules(),
      },
    };
  } catch {
    return { active: false };
  }
}

/**
 * Get default isolation rules for EXPLORE mode
 */
function getDefaultExploreIsolationRules(): ExploreIsolationRules {
  return {
    budgetIsolated: true,
    maxDailySpendUsd: 50,
    totalBudgetCapUsd: 500,
    excludeFromPortfolioBidding: true,
    separateConversionAction: false, // Requires manual setup
    excludeFromRemarketingLists: true,
    audienceExclusionList: [],
    separateAttributionWindow: false, // Use standard attribution
    terminateIfRoasBelowBreakeven: true,
    terminateIfSpendExceedsCap: true,
    terminateOnEndDate: true,
  };
}

/**
 * Check if EXPLORE mode campaign should be terminated
 */
export async function checkExploreTermination(
  campaignId: string,
  metrics: {
    totalSpend: number;
    currentRoas: number;
    breakEvenRoas: number;
  }
): Promise<{ shouldTerminate: boolean; reason?: string }> {
  const exploreStatus = await isExploreModeActive(campaignId);

  if (!exploreStatus.active || !exploreStatus.config) {
    return { shouldTerminate: false };
  }

  const { config } = exploreStatus;
  const rules = config.isolationRules;

  // Check spend cap
  if (rules.terminateIfSpendExceedsCap && metrics.totalSpend >= rules.totalBudgetCapUsd) {
    return {
      shouldTerminate: true,
      reason: `EXPLORE budget cap exceeded: $${metrics.totalSpend.toFixed(2)} >= $${rules.totalBudgetCapUsd.toFixed(2)}`,
    };
  }

  // Check ROAS below break-even
  if (rules.terminateIfRoasBelowBreakeven && metrics.currentRoas < metrics.breakEvenRoas) {
    return {
      shouldTerminate: true,
      reason: `EXPLORE ROAS (${metrics.currentRoas.toFixed(2)}) below break-even (${metrics.breakEvenRoas.toFixed(2)})`,
    };
  }

  // Check end date
  if (rules.terminateOnEndDate && new Date() > config.endDate) {
    return {
      shouldTerminate: true,
      reason: `EXPLORE experiment end date reached: ${config.endDate.toISOString()}`,
    };
  }

  return { shouldTerminate: false };
}

/**
 * Validate EXPLORE mode proposal
 *
 * EXPLORE proposals have stricter requirements:
 * - Must have explicit hypothesis
 * - Must have spending cap
 * - Must not exceed isolation rules
 */
export function validateExploreProposal(
  config: ExploreModeConfig,
  proposedChange: {
    type: string;
    currentValue: number;
    proposedValue: number;
  }
): { valid: boolean; violations: string[] } {
  const violations: string[] = [];

  // Check hypothesis exists
  if (!config.hypothesis || config.hypothesis === 'No hypothesis specified') {
    violations.push('EXPLORE proposals require an explicit hypothesis');
  }

  // Check budget cap would not be exceeded
  if (proposedChange.type === 'budget_increase') {
    const dailyIncrease = proposedChange.proposedValue - proposedChange.currentValue;
    if (proposedChange.proposedValue > config.isolationRules.maxDailySpendUsd) {
      violations.push(
        `Proposed daily budget ($${proposedChange.proposedValue.toFixed(2)}) exceeds EXPLORE limit ($${config.isolationRules.maxDailySpendUsd.toFixed(2)})`
      );
    }
  }

  // EXPLORE mode should generally avoid budget increases
  if (proposedChange.type === 'budget_increase') {
    violations.push(
      'EXPLORE mode is for testing hypotheses, not scaling. Budget increases require mode change to EXPLOIT.'
    );
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

// ============================================================================
// MAIN GOVERNANCE CHECK
// ============================================================================

/**
 * Run full governance check before any action
 */
export async function runGovernanceCheck(context: {
  campaignId: string;
  proposedAction?: string;
  measurementHealth: { canPropose: boolean; confidence: number; issues: Array<{ message: string }> };
}): Promise<GovernanceDecision> {
  const systemState = getSystemStateService();

  // Check OBSERVE-ONLY mode
  await checkObserveOnlyAutoResume();
  const observeOnlyState = await getObserveOnlyState();

  if (observeOnlyState.active) {
    const decision: GovernanceDecision = {
      action: 'OBSERVE_ONLY',
      reason: `System in OBSERVE-ONLY mode: ${observeOnlyState.reason}`,
      details: {
        activatedAt: observeOnlyState.activatedAt,
        autoResumeAt: observeOnlyState.autoResumeAt,
      },
      timestamp: new Date(),
    };
    await recordCycleOutcome(decision, context.campaignId);
    return decision;
  }

  // Check kill switch
  const writesAllowed = await systemState.areWritesAllowed();
  if (!writesAllowed.allowed) {
    const decision: GovernanceDecision = {
      action: 'SAFETY_STOP',
      reason: writesAllowed.reason ?? 'Kill switch or safety stop active',
      timestamp: new Date(),
    };
    await recordCycleOutcome(decision, context.campaignId);
    return decision;
  }

  // Check measurement integrity - enter OBSERVE-ONLY if failed
  if (!context.measurementHealth.canPropose) {
    const issues = context.measurementHealth.issues.map(i => i.message);

    await enterObserveOnlyMode(
      'Measurement integrity insufficient for safe inference',
      'system',
      issues
    );

    const decision: GovernanceDecision = {
      action: 'OBSERVE_ONLY',
      reason: 'Measurement integrity insufficient for safe inference',
      details: { issues },
      timestamp: new Date(),
    };
    await recordCycleOutcome(decision, context.campaignId);
    return decision;
  }

  // Check action rate health
  const rateHealth = await checkActionRateHealth();
  if (!rateHealth.healthy) {
    console.log(`[Governance] WARNING: ${rateHealth.message}`);
    // Don't block, just warn - but log it
    await logAuditEvent({
      event_type: 'policy_warning' as AuditEventType,
      entity_type: 'system',
      entity_id: 'action_rate',
      actor: 'system',
      action: 'Action rate warning',
      details: {
        message: rateHealth.message,
        metrics: rateHealth.metrics,
      },
    });
  }

  // All checks passed - allow evaluation to continue
  return {
    action: 'NO_ACTION', // Default - will be overridden if proposal is generated
    reason: 'Governance checks passed - evaluation may proceed',
    timestamp: new Date(),
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

export const governanceConfig = CONFIG;
