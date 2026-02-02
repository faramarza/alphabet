/**
 * Proposal Quality Service
 *
 * Ensures proposals are high-quality and not spammy.
 * Implements evidence thresholds, cooldowns, and weekly aggregation.
 */

import { query } from '../db/client.js';
import { checkMeasurementHealth, getCampaignLagAdjustedROAS } from './measurement-integrity.js';

// Configuration
const CONFIG = {
  // Minimum confidence required to generate a proposal
  MIN_CONFIDENCE_THRESHOLD: 0.6,

  // Minimum ROAS delta to warrant a proposal (10% change)
  MIN_ROAS_DELTA_THRESHOLD: 0.1,

  // Minimum spend to warrant attention ($10/day average)
  MIN_DAILY_SPEND_THRESHOLD: 10_000_000, // $10 in micros

  // Cooldown between proposals for same campaign (hours)
  CAMPAIGN_PROPOSAL_COOLDOWN_HOURS: 24,

  // Cooldown between any budget change proposals (hours)
  BUDGET_PROPOSAL_COOLDOWN_HOURS: 12,

  // Maximum proposals per week (aggregate into decision packets)
  MAX_PROPOSALS_PER_WEEK: 5,

  // Urgent threshold - bypasses weekly aggregation
  URGENT_ROAS_THRESHOLD: 2.0, // Below break-even

  // Evidence requirements
  MIN_DAYS_OF_DATA: 7,
  MIN_CONVERSIONS: 5,
  MIN_SPEND_FOR_DECISION: 50_000_000, // $50 in micros
};

export interface ProposalEligibility {
  eligible: boolean;
  reason?: string;
  urgency: 'normal' | 'urgent' | 'blocked';
  cooldownEndsAt?: Date;
  weeklyQuotaRemaining: number;
  evidenceScore: number;
}

export interface EvidencePacket {
  campaignId: string;
  daysOfData: number;
  totalConversions: number;
  totalSpend: number;
  lagAdjustedROAS: number;
  confidence: number;
  roasDelta: number; // vs target
  meetsThreshold: boolean;
}

/**
 * Check if a campaign is eligible for a new proposal
 */
export async function checkProposalEligibility(campaignId: string): Promise<ProposalEligibility> {
  // Check measurement health first
  const health = await checkMeasurementHealth(campaignId);

  if (!health.canPropose) {
    return {
      eligible: false,
      reason: `Measurement integrity check failed: ${health.issues[0]?.message || 'Unknown issue'}`,
      urgency: 'blocked',
      weeklyQuotaRemaining: 0,
      evidenceScore: health.confidence,
    };
  }

  // Check cooldown for this campaign
  const campaignCooldown = await checkCampaignCooldown(campaignId);
  if (campaignCooldown.inCooldown) {
    return {
      eligible: false,
      reason: `Campaign in cooldown until ${campaignCooldown.endsAt?.toISOString()}`,
      urgency: 'blocked',
      cooldownEndsAt: campaignCooldown.endsAt,
      weeklyQuotaRemaining: await getWeeklyQuotaRemaining(),
      evidenceScore: health.confidence,
    };
  }

  // Check global budget proposal cooldown
  const budgetCooldown = await checkBudgetProposalCooldown();
  if (budgetCooldown.inCooldown) {
    return {
      eligible: false,
      reason: `Budget proposals in cooldown until ${budgetCooldown.endsAt?.toISOString()}`,
      urgency: 'blocked',
      cooldownEndsAt: budgetCooldown.endsAt,
      weeklyQuotaRemaining: await getWeeklyQuotaRemaining(),
      evidenceScore: health.confidence,
    };
  }

  // Check weekly quota
  const weeklyRemaining = await getWeeklyQuotaRemaining();
  if (weeklyRemaining <= 0) {
    return {
      eligible: false,
      reason: 'Weekly proposal quota exhausted. Proposals will resume next week.',
      urgency: 'blocked',
      weeklyQuotaRemaining: 0,
      evidenceScore: health.confidence,
    };
  }

  // Gather evidence
  const evidence = await gatherEvidence(campaignId);

  if (!evidence.meetsThreshold) {
    return {
      eligible: false,
      reason: 'Insufficient evidence for proposal. Need more data or larger performance delta.',
      urgency: 'normal',
      weeklyQuotaRemaining: weeklyRemaining,
      evidenceScore: evidence.confidence,
    };
  }

  // Check if urgent (bypasses some checks)
  const isUrgent = evidence.lagAdjustedROAS < CONFIG.URGENT_ROAS_THRESHOLD && evidence.confidence > 0.7;

  return {
    eligible: true,
    urgency: isUrgent ? 'urgent' : 'normal',
    weeklyQuotaRemaining: weeklyRemaining,
    evidenceScore: evidence.confidence,
  };
}

/**
 * Check campaign-specific cooldown
 */
async function checkCampaignCooldown(campaignId: string): Promise<{ inCooldown: boolean; endsAt?: Date }> {
  try {
    const result = await query<{ created_at: Date }>(`
      SELECT created_at
      FROM proposals
      WHERE campaign_id = $1
        AND created_at > NOW() - INTERVAL '${CONFIG.CAMPAIGN_PROPOSAL_COOLDOWN_HOURS} hours'
      ORDER BY created_at DESC
      LIMIT 1
    `, [campaignId]);

    if (result.rows.length > 0) {
      const lastProposal = new Date(result.rows[0]!.created_at);
      const endsAt = new Date(lastProposal.getTime() + CONFIG.CAMPAIGN_PROPOSAL_COOLDOWN_HOURS * 60 * 60 * 1000);
      return { inCooldown: true, endsAt };
    }
  } catch {
    // Table might not exist
  }

  return { inCooldown: false };
}

/**
 * Check global budget proposal cooldown
 */
async function checkBudgetProposalCooldown(): Promise<{ inCooldown: boolean; endsAt?: Date }> {
  try {
    const result = await query<{ created_at: Date }>(`
      SELECT created_at
      FROM proposals
      WHERE proposal_type = 'budget_change'
        AND created_at > NOW() - INTERVAL '${CONFIG.BUDGET_PROPOSAL_COOLDOWN_HOURS} hours'
      ORDER BY created_at DESC
      LIMIT 1
    `);

    if (result.rows.length > 0) {
      const lastProposal = new Date(result.rows[0]!.created_at);
      const endsAt = new Date(lastProposal.getTime() + CONFIG.BUDGET_PROPOSAL_COOLDOWN_HOURS * 60 * 60 * 1000);
      return { inCooldown: true, endsAt };
    }
  } catch {
    // Table might not exist
  }

  return { inCooldown: false };
}

/**
 * Get remaining weekly proposal quota
 */
async function getWeeklyQuotaRemaining(): Promise<number> {
  try {
    const result = await query<{ count: string }>(`
      SELECT COUNT(*) as count
      FROM proposals
      WHERE created_at > NOW() - INTERVAL '7 days'
    `);

    const used = Number(result.rows[0]?.count || 0);
    return Math.max(0, CONFIG.MAX_PROPOSALS_PER_WEEK - used);
  } catch {
    return CONFIG.MAX_PROPOSALS_PER_WEEK;
  }
}

/**
 * Gather evidence for a campaign
 */
async function gatherEvidence(campaignId: string): Promise<EvidencePacket> {
  const roasData = await getCampaignLagAdjustedROAS(campaignId);

  // Get additional metrics
  let daysOfData = 0;
  let totalConversions = 0;
  let totalSpend = 0;

  try {
    const result = await query<{ days: string; conversions: string; spend: string }>(`
      SELECT
        COUNT(DISTINCT snapshot_date) as days,
        COALESCE(SUM(conversions), 0) as conversions,
        COALESCE(SUM(cost_micros), 0) as spend
      FROM snapshots
      WHERE campaign_id = $1
        AND snapshot_date >= NOW() - INTERVAL '30 days'
        AND snapshot_hour IS NULL
    `, [campaignId]);

    if (result.rows[0]) {
      daysOfData = Number(result.rows[0].days);
      totalConversions = Number(result.rows[0].conversions);
      totalSpend = Number(result.rows[0].spend);
    }
  } catch {
    // Table might not exist
  }

  // Get target ROAS from policy
  let targetROAS = 5.0;
  try {
    const policyResult = await query<{ value: string }>(`
      SELECT value FROM policies WHERE key = 'target_roas' AND is_active = true LIMIT 1
    `);
    if (policyResult.rows[0]) {
      targetROAS = Number(policyResult.rows[0].value);
    }
  } catch {
    // Use default
  }

  const roasDelta = Math.abs(roasData.roas - targetROAS) / targetROAS;

  // Check if evidence meets thresholds
  const meetsThreshold =
    daysOfData >= CONFIG.MIN_DAYS_OF_DATA &&
    totalConversions >= CONFIG.MIN_CONVERSIONS &&
    totalSpend >= CONFIG.MIN_SPEND_FOR_DECISION &&
    roasData.confidence >= CONFIG.MIN_CONFIDENCE_THRESHOLD &&
    roasDelta >= CONFIG.MIN_ROAS_DELTA_THRESHOLD;

  return {
    campaignId,
    daysOfData,
    totalConversions,
    totalSpend,
    lagAdjustedROAS: roasData.roas,
    confidence: roasData.confidence,
    roasDelta,
    meetsThreshold,
  };
}

/**
 * Get pending proposals aggregated into a decision packet
 */
export async function getWeeklyDecisionPacket(): Promise<{
  proposals: Array<{
    id: string;
    campaignId: string;
    type: string;
    recommendation: string;
    evidence: EvidencePacket;
  }>;
  summary: string;
  totalImpact: { budgetDelta: number; expectedROASChange: number };
}> {
  try {
    interface ProposalRow {
      id: string;
      campaign_id: string;
      proposal_type: string;
      recommendation: string;
      metadata: unknown;
    }

    const result = await query<ProposalRow>(`
      SELECT id, campaign_id, proposal_type, recommendation, metadata
      FROM proposals
      WHERE status = 'pending'
        AND created_at > NOW() - INTERVAL '7 days'
      ORDER BY created_at DESC
      LIMIT ${CONFIG.MAX_PROPOSALS_PER_WEEK}
    `);

    const proposals = await Promise.all(
      result.rows.map(async (row) => ({
        id: row.id,
        campaignId: row.campaign_id,
        type: row.proposal_type,
        recommendation: row.recommendation,
        evidence: await gatherEvidence(row.campaign_id),
      }))
    );

    // Calculate total impact
    let totalBudgetDelta = 0;
    for (const p of proposals) {
      if (p.type === 'budget_change') {
        // Extract from metadata if available
        totalBudgetDelta += 0; // Would need to parse from recommendation
      }
    }

    return {
      proposals,
      summary: `${proposals.length} pending proposals this week`,
      totalImpact: { budgetDelta: totalBudgetDelta, expectedROASChange: 0 },
    };
  } catch {
    return {
      proposals: [],
      summary: 'No pending proposals',
      totalImpact: { budgetDelta: 0, expectedROASChange: 0 },
    };
  }
}

/**
 * Record that a proposal was generated (for cooldown tracking)
 */
export async function recordProposalGenerated(campaignId: string, proposalType: string): Promise<void> {
  // This is tracked automatically by the proposals table
  // This function exists for explicit cooldown management if needed
}

export const proposalQualityConfig = CONFIG;
