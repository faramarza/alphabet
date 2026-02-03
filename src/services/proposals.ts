/**
 * Proposal Generator Service
 *
 * Generates proposals with evidence packs based on policy evaluation.
 *
 * DOCTRINE: No-Action Is a First-Class Outcome
 * - If signals are ambiguous, delayed, contaminated, or weak: NO ACTION
 * - 60-70% of evaluation cycles should result in no proposal
 * - Doing nothing is success when conditions are unclear
 *
 * CRITICAL: All proposals include ranges, not single-number promises
 */

import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/client.js';
import { logAuditEvent } from './audit.js';
import { getPolicyService, getCampaignSettingsService, getOpsSignalsService } from './policy.js';
import { getSnapshotsService } from './snapshots.js';
import { getSystemStateService } from './system-state.js';
import { checkMeasurementHealth, getCampaignLagAdjustedROAS } from './measurement-integrity.js';
import { checkProposalEligibility } from './proposal-quality.js';
import {
  runGovernanceCheck,
  classifyReversibility,
  isAutopilotAllowed,
  buildInactionJustification,
  checkImpressionShareDoctrine,
  recordCycleOutcome,
  type ReversibilityClassification,
  type InactionJustification,
  type RollbackPlan,
} from './governance.js';
import {
  ProposalStatus,
  ProposalType,
  AuditEventType,
  type Proposal,
  type EvidencePack,
  type ImpactRange,
  type AggregatedMetrics,
  type PolicyConfig,
  type ExecutionResult,
} from '../types/index.js';

// ============================================================================
// DATABASE ROW TYPE
// ============================================================================

interface ProposalRow {
  id: string;
  type: string;
  status: string;
  campaign_id: string;
  campaign_name: string;
  current_value: string;
  proposed_value: string;
  change_pct: string | null;
  evidence: EvidencePack;
  requires_approval: boolean;
  auto_execute_after: Date | null;
  experiment_id: string | null;
  experiment_max_spend: string | null;
  experiment_start_date: string | null;
  experiment_end_date: string | null;
  created_at: Date;
  expires_at: Date;
  approved_by: string | null;
  approved_at: Date | null;
  approved_value: string | null;
  rejection_reason: string | null;
  rejected_by: string | null;
  rejected_at: Date | null;
  executed_at: Date | null;
  execution_result: ExecutionResult | null;
}

// ============================================================================
// REASON CODES
// ============================================================================

const REASON_CODES = {
  // Budget increase reasons
  A1: 'ROAS consistently above target across all windows (7d/14d/30d)',
  A2: 'Budget utilization consistently at or near cap',
  A3: 'Significant impression share lost to budget',
  A4: 'Spend pacing indicates budget limiting',
  A5: 'Conversion volume trending up with stable ROAS',

  // Budget decrease reasons
  B1: 'ROAS below break-even threshold',
  B2: 'ROAS declining trend over multiple windows',
  B3: 'Low conversion volume with high spend',
  B4: 'Ops signals indicate fulfillment/inventory risk',
  B5: 'Budget significantly underutilized',

  // Blocking reasons
  C1: 'Cooldown period not passed',
  C2: 'Campaign is locked',
  C3: 'Kill switch is enabled',
  C4: 'Insufficient data for proposal',
  C5: 'Ops signals block scaling (high fulfillment risk)',
  C6: 'Conversion tracking suspected broken',
} as const;

// ============================================================================
// PROPOSAL GENERATOR SERVICE
// ============================================================================

export class ProposalGeneratorService {
  private static instance: ProposalGeneratorService | null = null;

  private constructor() {}

  static getInstance(): ProposalGeneratorService {
    if (!ProposalGeneratorService.instance) {
      ProposalGeneratorService.instance = new ProposalGeneratorService();
    }
    return ProposalGeneratorService.instance;
  }

  /**
   * Generate budget change proposals for a campaign
   *
   * DOCTRINE ENFORCEMENT:
   * - Governance check (OBSERVE-ONLY mode, measurement integrity)
   * - Reversibility classification
   * - Inaction justification ("why is action safer than inaction")
   * - Rollback plan
   * - Impression share doctrine compliance
   */
  async generateBudgetProposals(
    campaignId: string,
    campaignName: string,
    currentBudgetMicros: bigint
  ): Promise<Proposal | null> {
    const policyService = getPolicyService();
    const settingsService = getCampaignSettingsService();
    const opsService = getOpsSignalsService();
    const snapshotsService = getSnapshotsService();
    const systemState = getSystemStateService();

    // =========================================================================
    // STEP 0: Check Measurement Integrity First (for governance check)
    // =========================================================================
    const measurementHealth = await checkMeasurementHealth(campaignId);

    // =========================================================================
    // STEP 1: Run Governance Check (OBSERVE-ONLY, kill switch, action rate)
    // =========================================================================
    const governanceDecision = await runGovernanceCheck({
      campaignId,
      measurementHealth: {
        canPropose: measurementHealth.canPropose,
        confidence: measurementHealth.confidence,
        issues: measurementHealth.issues,
      },
    });

    if (governanceDecision.action !== 'NO_ACTION') {
      console.log(`[Proposal] Governance: ${governanceDecision.action} - ${governanceDecision.reason}`);
      return null;
    }

    // =========================================================================
    // STEP 2: Check Proposal Quality Gates
    // =========================================================================
    const eligibility = await checkProposalEligibility(campaignId);

    if (!eligibility.eligible) {
      console.log(`[Proposal] Not eligible for ${campaignId}: ${eligibility.reason}`);
      await recordCycleOutcome({
        action: 'NO_ACTION',
        reason: eligibility.reason ?? 'Not eligible',
        timestamp: new Date(),
      }, campaignId);
      return null;
    }

    // Get policy config
    const policy = await policyService.getEffectiveConfig(campaignId);

    // Get campaign settings
    const settings = await settingsService.getOrCreate(campaignId, campaignName);

    // Check blocking conditions
    const blockingReasons: string[] = [];

    // Check kill switch
    const writesAllowed = await systemState.areWritesAllowed();
    if (!writesAllowed.allowed) {
      blockingReasons.push('C3');
    }

    // Check lock
    if (settings.is_locked) {
      blockingReasons.push('C2');
    }

    // Cooldown now handled by proposal-quality service, but keep legacy check
    const cooldownPassed = await settingsService.isCooldownPassed(
      campaignId,
      policy.cooldown_days_budget_changes
    );
    if (!cooldownPassed) {
      blockingReasons.push('C1');
    }

    // Check ops signals
    const opsBlocking = await opsService.isScalingBlocked(campaignId, policy);
    if (opsBlocking.blocked) {
      blockingReasons.push('C5');
    }

    // If blocking reasons exist, no proposal
    if (blockingReasons.length > 0) {
      console.log(`[Proposal] Blocked for ${campaignId}: ${blockingReasons.join(', ')}`);
      return null;
    }

    // Get aggregated metrics for all windows
    const metrics7d = await snapshotsService.computeAggregatedMetrics(campaignId, 7);
    const metrics14d = await snapshotsService.computeAggregatedMetrics(campaignId, 14);
    const metrics30d = await snapshotsService.computeAggregatedMetrics(campaignId, 30);

    // Check data sufficiency
    if (!metrics7d || !metrics14d) {
      console.log(`[Proposal] Insufficient data for ${campaignId}`);
      return null;
    }

    // Use 30d if available, otherwise extrapolate from 14d
    const metrics30dEffective = metrics30d ?? this.extrapolateMetrics(metrics14d, 30);

    // Check for conversion tracking issues (enhanced with measurement integrity)
    if (this.suspectConversionTrackingBroken(metrics7d)) {
      await systemState.triggerSafetyStop(
        `Suspected conversion tracking issue: ${campaignId} - conversions dropped to near zero while spend continues`
      );
      return null;
    }

    // Get lag-adjusted ROAS for more accurate decisions
    const lagAdjustedData = await getCampaignLagAdjustedROAS(campaignId);
    console.log(`[Proposal] ${campaignId} lag-adjusted ROAS: ${lagAdjustedData.roas.toFixed(2)} (confidence: ${(lagAdjustedData.confidence * 100).toFixed(0)}%)`);
    console.log(`[Proposal] ${campaignId} raw ROAS: ${lagAdjustedData.rawROAS.toFixed(2)} (includes last ${measurementHealth.lagAdjustedWindow.excludedDays} days with incomplete conversions)`);

    // Evaluate budget direction
    const evaluation = this.evaluateBudgetDirection(
      metrics7d,
      metrics14d,
      metrics30dEffective,
      policy,
      currentBudgetMicros
    );

    if (!evaluation.shouldChange) {
      console.log(`[Proposal] No budget change needed for ${campaignId}`);
      await recordCycleOutcome({
        action: 'NO_ACTION',
        reason: 'No budget change needed - metrics within acceptable range',
        details: { roas: lagAdjustedData.roas, confidence: lagAdjustedData.confidence },
        timestamp: new Date(),
      }, campaignId);
      return null;
    }

    // =========================================================================
    // STEP 3: Classify Reversibility (DOCTRINE REQUIREMENT)
    // =========================================================================
    const currentBudgetUsd = Number(currentBudgetMicros) / 1_000_000;
    const proposedBudgetMicros = this.calculateProposedBudget(
      currentBudgetMicros,
      evaluation.direction,
      evaluation.changePct,
      policy
    );
    const proposedBudgetUsd = Number(proposedBudgetMicros) / 1_000_000;

    const reversibility = classifyReversibility(
      evaluation.type,
      currentBudgetUsd,
      proposedBudgetUsd,
      { campaignId, isExperiment: false, affectsLearning: false }
    );

    console.log(`[Proposal] ${campaignId} reversibility: ${reversibility.level} - ${reversibility.description}`);

    // =========================================================================
    // STEP 4: Check Impression Share Doctrine Compliance
    // =========================================================================
    const impressionShareCheck = checkImpressionShareDoctrine(
      evaluation.reasons.join(' '),
      evaluation.reasons.map(code => REASON_CODES[code as keyof typeof REASON_CODES] ?? code)
    );

    if (!impressionShareCheck.compliant) {
      console.log(`[Proposal] DOCTRINE VIOLATION for ${campaignId}: ${impressionShareCheck.violation}`);
      await recordCycleOutcome({
        action: 'NO_ACTION',
        reason: `Impression share doctrine violation: ${impressionShareCheck.violation}`,
        timestamp: new Date(),
      }, campaignId);
      return null;
    }

    // =========================================================================
    // STEP 5: Build Inaction Justification (DOCTRINE REQUIREMENT)
    // =========================================================================
    const avgDailySpendUsd = Number(metrics7d.avg_daily_cost_micros) / 1_000_000;
    const budgetUtilization = (avgDailySpendUsd / currentBudgetUsd) * 100;

    const inactionJustification = buildInactionJustification(
      evaluation.type,
      {
        roas: lagAdjustedData.roas,
        targetRoas: policy.target_roas,
        breakEvenRoas: policy.break_even_roas,
        confidence: measurementHealth.confidence,
        budgetUtilization,
      },
      reversibility
    );

    // If confidence in safety is too low, don't propose
    if (inactionJustification.confidenceInSafety < 50) {
      console.log(`[Proposal] Confidence in safety too low (${inactionJustification.confidenceInSafety}%) for ${campaignId}`);
      await recordCycleOutcome({
        action: 'NO_ACTION',
        reason: `Confidence in safety (${inactionJustification.confidenceInSafety}%) below threshold`,
        timestamp: new Date(),
      }, campaignId);
      return null;
    }

    // =========================================================================
    // STEP 6: Build Evidence Pack (enhanced with governance data)
    // =========================================================================
    const evidence = this.buildEvidencePack(
      metrics7d,
      metrics14d,
      metrics30dEffective,
      evaluation,
      currentBudgetMicros,
      proposedBudgetMicros,
      policy,
      {
        lagAdjustedROAS: lagAdjustedData.roas,
        measurementConfidence: measurementHealth.confidence,
        evidenceScore: eligibility.evidenceScore,
        measurementIssues: measurementHealth.issues,
        // NEW: Governance doctrine requirements
        reversibility,
        inactionJustification,
      }
    );

    // =========================================================================
    // STEP 7: Determine Autopilot Eligibility (DOCTRINE: Reversibility > Confidence)
    // =========================================================================
    const changeUsd = Math.abs(proposedBudgetUsd - currentBudgetUsd);
    const policyAllowsAutopilot =
      policy.autopilot_enabled &&
      policy.autopilot_actions.includes(evaluation.type) &&
      changeUsd <= policy.autopilot_max_budget_change_usd;

    // DOCTRINE: Only fully reversible actions can be autopiloted
    const reversibilityAllowsAutopilot = isAutopilotAllowed(
      reversibility,
      evidence.confidence_score
    );

    const canAutopilot = policyAllowsAutopilot && reversibilityAllowsAutopilot.allowed;

    if (!reversibilityAllowsAutopilot.allowed) {
      console.log(`[Proposal] Autopilot blocked for ${campaignId}: ${reversibilityAllowsAutopilot.reason}`);
    }

    // =========================================================================
    // STEP 8: Create Proposal with Full Governance Data
    // =========================================================================
    // Note: Governance metadata (reversibility, rollback_plan, inaction_justification)
    // is included in the evidence pack, not passed separately
    const proposal = await this.createProposal({
      type: evaluation.type,
      campaign_id: campaignId,
      campaign_name: campaignName,
      current_value: currentBudgetUsd.toFixed(2),
      proposed_value: proposedBudgetUsd.toFixed(2),
      change_pct: evaluation.changePct,
      evidence,
      requires_approval: !canAutopilot,
      auto_execute_after: canAutopilot ? new Date(Date.now() + 60 * 60 * 1000) : undefined,
    });

    // Record that we generated a proposal
    await recordCycleOutcome({
      action: 'PROPOSE_ACTION',
      reason: `Generated ${evaluation.type} proposal`,
      details: {
        change_pct: evaluation.changePct,
        reversibility: reversibility.level,
        confidence: evidence.confidence_score,
      },
      timestamp: new Date(),
    }, campaignId);

    return proposal;
  }

  /**
   * Evaluate whether budget should change and in which direction
   */
  private evaluateBudgetDirection(
    metrics7d: AggregatedMetrics,
    metrics14d: AggregatedMetrics,
    metrics30d: AggregatedMetrics,
    policy: PolicyConfig,
    currentBudgetMicros: bigint
  ): {
    shouldChange: boolean;
    direction: 'increase' | 'decrease';
    type: ProposalType;
    changePct: number;
    reasons: string[];
  } {
    const reasons: string[] = [];

    // Check for ROAS below break-even (priority 1 - decrease)
    if (
      metrics7d.roas < policy.break_even_roas &&
      metrics14d.roas < policy.break_even_roas
    ) {
      reasons.push('B1');
      return {
        shouldChange: true,
        direction: 'decrease',
        type: ProposalType.BUDGET_DECREASE,
        changePct: Math.min(
          policy.max_step_budget_decrease_pct,
          ((policy.break_even_roas - metrics7d.roas) / policy.break_even_roas) * 100
        ),
        reasons,
      };
    }

    // Check for declining ROAS trend (decrease)
    if (
      metrics7d.roas_trend === 'decreasing' &&
      metrics14d.roas_trend === 'decreasing' &&
      metrics7d.roas < policy.target_roas
    ) {
      reasons.push('B2');
      return {
        shouldChange: true,
        direction: 'decrease',
        type: ProposalType.BUDGET_DECREASE,
        changePct: policy.max_step_budget_decrease_pct * 0.5, // Conservative decrease
        reasons,
      };
    }

    // Check for strong ROAS across all windows (increase)
    if (
      metrics7d.roas >= policy.target_roas &&
      metrics14d.roas >= policy.target_roas &&
      metrics30d.roas >= policy.break_even_roas &&
      metrics7d.has_sufficient_conversions
    ) {
      reasons.push('A1');

      // Check budget utilization
      const avgBudgetUtil = metrics7d.data_coverage_pct; // Proxy for now
      if (avgBudgetUtil >= 90) {
        reasons.push('A2');
      }

      return {
        shouldChange: true,
        direction: 'increase',
        type: ProposalType.BUDGET_INCREASE,
        changePct: policy.max_step_budget_increase_pct,
        reasons,
      };
    }

    // Check for budget underutilization (decrease)
    const currentBudgetUsd = Number(currentBudgetMicros) / 1_000_000;
    const avgDailySpendUsd = Number(metrics7d.avg_daily_cost_micros) / 1_000_000;
    const utilizationPct = (avgDailySpendUsd / currentBudgetUsd) * 100;

    if (utilizationPct < 50 && metrics7d.has_sufficient_conversions) {
      reasons.push('B5');
      return {
        shouldChange: true,
        direction: 'decrease',
        type: ProposalType.BUDGET_DECREASE,
        changePct: Math.min(policy.max_step_budget_decrease_pct, 100 - utilizationPct),
        reasons,
      };
    }

    return {
      shouldChange: false,
      direction: 'increase',
      type: ProposalType.BUDGET_INCREASE,
      changePct: 0,
      reasons: [],
    };
  }

  /**
   * Calculate the proposed budget amount
   */
  private calculateProposedBudget(
    currentMicros: bigint,
    direction: 'increase' | 'decrease',
    changePct: number,
    policy: PolicyConfig
  ): bigint {
    const multiplier = direction === 'increase' ? 1 + changePct / 100 : 1 - changePct / 100;
    let proposedMicros = BigInt(Math.round(Number(currentMicros) * multiplier));

    // Apply hard limits
    const maxMicros = BigInt(policy.hard_limit * 1_000_000);
    const minMicros = BigInt(1_000_000); // $1 minimum

    if (proposedMicros > maxMicros) {
      proposedMicros = maxMicros;
    }
    if (proposedMicros < minMicros) {
      proposedMicros = minMicros;
    }

    return proposedMicros;
  }

  /**
   * Build evidence pack with ranges (no single-number promises)
   *
   * DOCTRINE REQUIREMENTS INCLUDED:
   * - Reversibility classification
   * - Inaction justification (why action is safer than inaction)
   * - Rollback plan
   * - Measurement integrity data
   */
  private buildEvidencePack(
    metrics7d: AggregatedMetrics,
    metrics14d: AggregatedMetrics,
    metrics30d: AggregatedMetrics,
    evaluation: { direction: 'increase' | 'decrease'; changePct: number; reasons: string[] },
    currentBudgetMicros: bigint,
    proposedBudgetMicros: bigint,
    policy: PolicyConfig,
    integrityData?: {
      lagAdjustedROAS: number;
      measurementConfidence: number;
      evidenceScore: number;
      measurementIssues: Array<{ type: string; severity: string; message: string }>;
      // NEW: Governance doctrine data
      reversibility?: ReversibilityClassification;
      inactionJustification?: InactionJustification;
    }
  ): EvidencePack {
    const reasonDescriptions = evaluation.reasons.map((code) => REASON_CODES[code as keyof typeof REASON_CODES] ?? code);

    // Calculate impact ranges (NEVER single numbers)
    const budgetChangePct = evaluation.changePct * (evaluation.direction === 'increase' ? 1 : -1);
    const currentDailySpend = Number(metrics7d.avg_daily_cost_micros) / 1_000_000;

    // Conservative range estimation with uncertainty
    const impressionRange = this.calculateImpactRange(
      metrics7d.total_impressions,
      budgetChangePct,
      0.5, // High uncertainty factor
      'impressions'
    );

    const revenueRange = this.calculateRevenueRange(
      metrics7d,
      budgetChangePct,
      policy
    );

    const profitRange = this.calculateProfitRange(
      revenueRange,
      currentDailySpend,
      budgetChangePct
    );

    // Downside scenario
    const downsideMaxLoss = currentDailySpend * 7 * (1 - policy.break_even_roas / metrics7d.roas);

    // Calculate final confidence score (enhanced with measurement integrity)
    const baseConfidence = this.calculateConfidenceScore(metrics7d, metrics14d, metrics30d);
    const adjustedConfidence = integrityData
      ? Math.round(baseConfidence * integrityData.measurementConfidence)
      : baseConfidence;

    return {
      reason_codes: evaluation.reasons,
      reason_descriptions: reasonDescriptions,
      metrics_7d: metrics7d,
      metrics_14d: metrics14d,
      metrics_30d: metrics30d,
      data_freshness_hours: 24, // Assume daily data
      oldest_data_date: metrics30d.start_date,
      newest_data_date: metrics7d.end_date,
      coverage_score: Math.round(
        (metrics7d.data_coverage_pct + metrics14d.data_coverage_pct + metrics30d.data_coverage_pct) / 3
      ),
      confidence_score: adjustedConfidence,
      confidence_factors: this.getConfidenceFactors(metrics7d, metrics14d),
      budget_limited_signals: {
        spend_hitting_cap_days: Math.round(metrics7d.data_coverage_pct / 10), // Estimate
        avg_budget_utilization_pct: (currentDailySpend / (Number(currentBudgetMicros) / 1_000_000)) * 100,
      },
      projected_impressions: impressionRange,
      projected_revenue: revenueRange,
      projected_profit: profitRange,
      downside_scenario: {
        description: `If ROAS drops to break-even (${policy.break_even_roas}), weekly loss could reach the max shown below. Stop-loss will trigger automatically.`,
        probability: evaluation.direction === 'increase' ? 'low' : 'medium',
        max_loss_usd: Math.max(0, downsideMaxLoss),
      },
      stop_loss_condition: {
        metric: 'roas_7d',
        threshold: policy.break_even_roas,
        action: 'Automatic budget decrease or pause',
      },
      // Measurement integrity fields
      lag_adjusted_roas: integrityData?.lagAdjustedROAS,
      measurement_confidence: integrityData?.measurementConfidence,
      evidence_score: integrityData?.evidenceScore,
      measurement_warnings: integrityData?.measurementIssues
        ?.filter(i => i.severity === 'warning')
        .map(i => i.message),

      // DOCTRINE: Governance fields
      reversibility: integrityData?.reversibility ? {
        level: integrityData.reversibility.level,
        description: integrityData.reversibility.description,
        max_autopilot_allowed: integrityData.reversibility.maxAutopilotAllowed,
        required_approval_level: integrityData.reversibility.requiredApprovalLevel,
      } : undefined,
      rollback_plan: integrityData?.reversibility?.rollbackPlan ? {
        can_rollback: integrityData.reversibility.rollbackPlan.canRollback,
        rollback_steps: integrityData.reversibility.rollbackPlan.rollbackSteps,
        estimated_rollback_time: integrityData.reversibility.rollbackPlan.estimatedRollbackTime,
        potential_rollback_cost: integrityData.reversibility.rollbackPlan.potentialRollbackCost,
        rollback_triggers: integrityData.reversibility.rollbackPlan.rollbackTriggers,
      } : undefined,
      inaction_justification: integrityData?.inactionJustification ? {
        why_action_safer_than_inaction: integrityData.inactionJustification.whyActionSaferThanInaction,
        evidence_for_safety: integrityData.inactionJustification.evidenceForSafety,
        downside_of_inaction: integrityData.inactionJustification.downsideOfInaction,
        confidence_in_safety: integrityData.inactionJustification.confidenceInSafety,
      } : undefined,
    };
  }

  /**
   * Calculate impact range with uncertainty
   */
  private calculateImpactRange(
    currentValue: number,
    changePct: number,
    uncertaintyFactor: number,
    unit: ImpactRange['unit']
  ): ImpactRange {
    const expectedChange = currentValue * (changePct / 100);
    const uncertainty = Math.abs(expectedChange) * uncertaintyFactor;

    return {
      min: Math.round(currentValue + expectedChange - uncertainty),
      expected: Math.round(currentValue + expectedChange),
      max: Math.round(currentValue + expectedChange + uncertainty),
      unit,
      assumptions: [
        'Assumes similar market conditions',
        'Based on historical 7-day performance',
        'Does not account for competitive changes',
        'Actual results may vary significantly',
      ],
    };
  }

  /**
   * Calculate revenue range
   */
  private calculateRevenueRange(
    metrics7d: AggregatedMetrics,
    budgetChangePct: number,
    policy: PolicyConfig
  ): ImpactRange {
    const dailyRevenue = Number(metrics7d.total_conversion_value_micros) / 1_000_000 / 7;
    const expectedChange = dailyRevenue * 7 * (budgetChangePct / 100);

    // Wide uncertainty for revenue
    const pessimistic = expectedChange * 0.3; // 70% below expected
    const optimistic = expectedChange * 1.5; // 50% above expected

    return {
      min: Math.round(pessimistic),
      expected: Math.round(expectedChange),
      max: Math.round(optimistic),
      unit: 'usd',
      assumptions: [
        `Assumes ROAS stays between ${policy.break_even_roas} and ${metrics7d.roas.toFixed(1)}`,
        'Revenue may not scale linearly with budget',
        'Seasonal factors not accounted for',
        'Competitor actions may impact results',
      ],
    };
  }

  /**
   * Calculate profit range
   */
  private calculateProfitRange(
    revenueRange: ImpactRange,
    currentDailySpend: number,
    budgetChangePct: number
  ): ImpactRange {
    const spendChange = currentDailySpend * 7 * (budgetChangePct / 100);

    return {
      min: revenueRange.min - spendChange * 1.2, // Pessimistic: higher spend, lower revenue
      expected: revenueRange.expected - spendChange,
      max: revenueRange.max - spendChange * 0.8, // Optimistic: lower spend, higher revenue
      unit: 'usd',
      assumptions: [
        'Profit = Revenue change - Spend change',
        'Does not include COGS or other costs',
        'Assumes similar conversion rates',
      ],
    };
  }

  /**
   * Calculate confidence score (0-100)
   */
  private calculateConfidenceScore(
    metrics7d: AggregatedMetrics,
    metrics14d: AggregatedMetrics,
    metrics30d: AggregatedMetrics
  ): number {
    let score = 50; // Base score

    // Data coverage
    score += (metrics7d.data_coverage_pct - 50) * 0.2;

    // Conversion volume
    if (metrics7d.has_sufficient_conversions) score += 15;
    if (metrics14d.has_sufficient_conversions) score += 10;

    // Trend consistency
    if (metrics7d.roas_trend === metrics14d.roas_trend) score += 10;

    // ROAS stability
    const roasVariance = Math.abs(metrics7d.roas - metrics14d.roas) / metrics14d.roas;
    if (roasVariance < 0.1) score += 10;
    else if (roasVariance > 0.3) score -= 15;

    return Math.min(100, Math.max(0, Math.round(score)));
  }

  /**
   * Get confidence factors
   */
  private getConfidenceFactors(
    metrics7d: AggregatedMetrics,
    metrics14d: AggregatedMetrics
  ): string[] {
    const factors: string[] = [];

    if (metrics7d.has_sufficient_conversions) {
      factors.push(`Sufficient conversions (${metrics7d.total_conversions.toFixed(0)} in 7d)`);
    } else {
      factors.push(`Low conversion volume (${metrics7d.total_conversions.toFixed(0)} in 7d)`);
    }

    if (metrics7d.data_coverage_pct >= 95) {
      factors.push('Complete data for analysis window');
    } else {
      factors.push(`Data gaps present (${metrics7d.data_coverage_pct.toFixed(0)}% coverage)`);
    }

    if (metrics7d.roas_trend === metrics14d.roas_trend) {
      factors.push(`Consistent ${metrics7d.roas_trend} ROAS trend`);
    } else {
      factors.push('Inconsistent ROAS trend between windows');
    }

    return factors;
  }

  /**
   * Check for suspected conversion tracking issues
   */
  private suspectConversionTrackingBroken(metrics7d: AggregatedMetrics): boolean {
    const avgDailyCost = Number(metrics7d.avg_daily_cost_micros) / 1_000_000;
    const avgDailyConversions = metrics7d.avg_daily_conversions;

    // If spending significant amounts but zero/near-zero conversions
    return avgDailyCost > 10 && avgDailyConversions < 0.1;
  }

  /**
   * Extrapolate metrics for a longer window
   */
  private extrapolateMetrics(source: AggregatedMetrics, targetDays: number): AggregatedMetrics {
    const ratio = targetDays / source.window_days;

    return {
      ...source,
      window_days: targetDays,
      total_cost_micros: BigInt(Math.round(Number(source.total_cost_micros) * ratio)),
      total_conversions: source.total_conversions * ratio,
      total_conversion_value_micros: BigInt(Math.round(Number(source.total_conversion_value_micros) * ratio)),
      total_impressions: Math.round(source.total_impressions * ratio),
      total_clicks: Math.round(source.total_clicks * ratio),
      // ROAS and rates stay the same
      data_coverage_pct: source.data_coverage_pct * 0.8, // Reduce confidence for extrapolated data
    };
  }

  /**
   * Create a proposal in the database
   */
  async createProposal(data: {
    type: ProposalType;
    campaign_id: string;
    campaign_name: string;
    current_value: string;
    proposed_value: string;
    change_pct: number;
    evidence: EvidencePack;
    requires_approval: boolean;
    auto_execute_after?: Date;
    experiment_id?: string;
    experiment_max_spend?: number;
    experiment_start_date?: string;
    experiment_end_date?: string;
  }): Promise<Proposal> {
    const id = uuidv4();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await query(
      `INSERT INTO proposals (
        id, type, status, campaign_id, campaign_name,
        current_value, proposed_value, change_pct, evidence,
        requires_approval, auto_execute_after,
        experiment_id, experiment_max_spend, experiment_start_date, experiment_end_date,
        expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        id,
        data.type,
        'pending',
        data.campaign_id,
        data.campaign_name,
        data.current_value,
        data.proposed_value,
        data.change_pct,
        JSON.stringify(data.evidence),
        data.requires_approval,
        data.auto_execute_after ?? null,
        data.experiment_id ?? null,
        data.experiment_max_spend ?? null,
        data.experiment_start_date ?? null,
        data.experiment_end_date ?? null,
        expiresAt,
      ]
    );

    const proposal: Proposal = {
      id,
      type: data.type,
      status: ProposalStatus.PENDING,
      campaign_id: data.campaign_id,
      campaign_name: data.campaign_name,
      current_value: data.current_value,
      proposed_value: data.proposed_value,
      change_pct: data.change_pct,
      evidence: data.evidence,
      requires_approval: data.requires_approval,
      auto_execute_after: data.auto_execute_after,
      experiment_id: data.experiment_id,
      experiment_max_spend: data.experiment_max_spend,
      experiment_start_date: data.experiment_start_date,
      experiment_end_date: data.experiment_end_date,
      created_at: new Date(),
      expires_at: expiresAt,
    };

    await logAuditEvent({
      event_type: 'proposal_created' as AuditEventType,
      entity_type: 'proposal',
      entity_id: id,
      actor: 'system',
      action: `Created ${data.type} proposal`,
      details: {
        campaign_id: data.campaign_id,
        current_value: data.current_value,
        proposed_value: data.proposed_value,
        change_pct: data.change_pct,
        confidence_score: data.evidence.confidence_score,
        requires_approval: data.requires_approval,
      },
    });

    return proposal;
  }

  /**
   * Get proposals by status
   */
  async getProposals(status?: ProposalStatus, limit = 50): Promise<Proposal[]> {
    let sql = 'SELECT * FROM proposals';
    const params: unknown[] = [];

    if (status) {
      sql += ' WHERE status = $1';
      params.push(status);
    }

    sql += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
    params.push(limit);

    const result = await query<ProposalRow>(sql, params);
    return result.rows.map((row) => this.rowToProposal(row));
  }

  /**
   * Get a proposal by ID
   */
  async getProposal(id: string): Promise<Proposal | null> {
    const result = await query<ProposalRow>(
      'SELECT * FROM proposals WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.rowToProposal(result.rows[0]!);
  }

  /**
   * Approve a proposal (with optional modification)
   */
  async approveProposal(
    id: string,
    actor: string,
    modifiedValue?: string
  ): Promise<Proposal> {
    const proposal = await this.getProposal(id);
    if (!proposal) {
      throw new Error('Proposal not found');
    }

    if (proposal.status !== ProposalStatus.PENDING) {
      throw new Error(`Cannot approve proposal in ${proposal.status} status`);
    }

    const approvedValue = modifiedValue ?? proposal.proposed_value;

    await query(
      `UPDATE proposals SET
        status = 'approved',
        approved_by = $1,
        approved_at = NOW(),
        approved_value = $2
       WHERE id = $3`,
      [actor, approvedValue, id]
    );

    await logAuditEvent({
      event_type: 'proposal_approved' as AuditEventType,
      entity_type: 'proposal',
      entity_id: id,
      actor,
      action: 'Approved proposal',
      details: {
        original_proposed_value: proposal.proposed_value,
        approved_value: approvedValue,
        was_modified: approvedValue !== proposal.proposed_value,
      },
      before_state: { status: proposal.status },
      after_state: { status: 'approved', approved_value: approvedValue },
    });

    return {
      ...proposal,
      status: ProposalStatus.APPROVED,
      approved_by: actor,
      approved_at: new Date(),
      approved_value: approvedValue,
    };
  }

  /**
   * Reject a proposal
   */
  async rejectProposal(id: string, actor: string, reason: string): Promise<Proposal> {
    const proposal = await this.getProposal(id);
    if (!proposal) {
      throw new Error('Proposal not found');
    }

    if (proposal.status !== ProposalStatus.PENDING) {
      throw new Error(`Cannot reject proposal in ${proposal.status} status`);
    }

    await query(
      `UPDATE proposals SET
        status = 'rejected',
        rejected_by = $1,
        rejected_at = NOW(),
        rejection_reason = $2
       WHERE id = $3`,
      [actor, reason, id]
    );

    await logAuditEvent({
      event_type: 'proposal_rejected' as AuditEventType,
      entity_type: 'proposal',
      entity_id: id,
      actor,
      action: 'Rejected proposal',
      details: { reason },
      before_state: { status: proposal.status },
      after_state: { status: 'rejected', reason },
    });

    return {
      ...proposal,
      status: ProposalStatus.REJECTED,
      rejected_by: actor,
      rejected_at: new Date(),
      rejection_reason: reason,
    };
  }

  /**
   * Mark a proposal as executed
   */
  async markExecuted(id: string, result: ExecutionResult): Promise<void> {
    await query(
      `UPDATE proposals SET
        status = 'executed',
        executed_at = NOW(),
        execution_result = $1
       WHERE id = $2`,
      [JSON.stringify(result), id]
    );

    await logAuditEvent({
      event_type: 'proposal_executed' as AuditEventType,
      entity_type: 'proposal',
      entity_id: id,
      actor: 'system',
      action: result.success ? 'Executed proposal successfully' : 'Proposal execution failed',
      details: {
        success: result.success,
        before_value: result.before_value,
        after_value: result.after_value,
        api_operation_id: result.api_operation_id,
        error: result.error_message,
      },
      api_response_id: result.api_operation_id,
    });
  }

  /**
   * Expire old pending proposals
   */
  async expireOldProposals(): Promise<number> {
    const result = await query<{ id: string }>(
      `UPDATE proposals SET status = 'expired'
       WHERE status = 'pending' AND expires_at < NOW()
       RETURNING id`
    );

    for (const row of result.rows) {
      await logAuditEvent({
        event_type: 'proposal_expired' as AuditEventType,
        entity_type: 'proposal',
        entity_id: row.id,
        actor: 'system',
        action: 'Proposal expired',
        details: {},
      });
    }

    return result.rowCount ?? 0;
  }

  private rowToProposal(row: ProposalRow): Proposal {
    return {
      id: row.id,
      type: row.type as ProposalType,
      status: row.status as ProposalStatus,
      campaign_id: row.campaign_id,
      campaign_name: row.campaign_name,
      current_value: row.current_value,
      proposed_value: row.proposed_value,
      change_pct: row.change_pct ? parseFloat(row.change_pct) : undefined,
      evidence: row.evidence,
      requires_approval: row.requires_approval,
      auto_execute_after: row.auto_execute_after ?? undefined,
      experiment_id: row.experiment_id ?? undefined,
      experiment_max_spend: row.experiment_max_spend ? parseFloat(row.experiment_max_spend) : undefined,
      experiment_start_date: row.experiment_start_date ?? undefined,
      experiment_end_date: row.experiment_end_date ?? undefined,
      created_at: row.created_at,
      expires_at: row.expires_at,
      approved_by: row.approved_by ?? undefined,
      approved_at: row.approved_at ?? undefined,
      approved_value: row.approved_value ?? undefined,
      rejection_reason: row.rejection_reason ?? undefined,
      rejected_by: row.rejected_by ?? undefined,
      rejected_at: row.rejected_at ?? undefined,
      executed_at: row.executed_at ?? undefined,
      execution_result: row.execution_result ?? undefined,
    };
  }
}

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

export function getProposalGeneratorService(): ProposalGeneratorService {
  return ProposalGeneratorService.getInstance();
}
