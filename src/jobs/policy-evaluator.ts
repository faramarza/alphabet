/**
 * Policy Evaluator Job
 * Evaluates metrics against policies and generates proposals
 * Runs daily after data rollup
 */

import { getGoogleAdsAdapter } from '../adapters/google-ads.js';
import { getProposalGeneratorService } from '../services/proposals.js';
import { getPolicyService } from '../services/policy.js';
import { getSystemStateService } from '../services/system-state.js';
import { getNotifier } from '../services/notifier.js';
import { logAuditEvent } from '../services/audit.js';
import type { Proposal, AuditEventType } from '../types/index.js';

// ============================================================================
// POLICY EVALUATOR JOB
// ============================================================================

export async function runPolicyEvaluatorJob(): Promise<{
  campaigns_evaluated: number;
  proposals_generated: number;
  proposals_details: Array<{
    campaign_id: string;
    campaign_name: string;
    type: string;
    change_pct: number;
    confidence_score: number;
  }>;
  errors: string[];
}> {
  console.log('[PolicyEvaluator] Starting policy evaluation...');

  const adsAdapter = getGoogleAdsAdapter();
  const proposalService = getProposalGeneratorService();
  const policyService = getPolicyService();
  const systemState = getSystemStateService();
  const notifier = getNotifier();

  const errors: string[] = [];
  const proposalsGenerated: Proposal[] = [];

  try {
    // Check if system is in a state to generate proposals
    const writesAllowed = await systemState.areWritesAllowed();
    if (!writesAllowed.allowed) {
      console.log(`[PolicyEvaluator] Skipping - writes are blocked: ${writesAllowed.reason}`);
      return {
        campaigns_evaluated: 0,
        proposals_generated: 0,
        proposals_details: [],
        errors: [`Writes blocked: ${writesAllowed.reason}`],
      };
    }

    // Get current policy
    const policy = await policyService.getCurrentPolicy();
    if (!policy) {
      throw new Error('No active policy found');
    }

    // Record policy evaluation run
    await systemState.recordPolicyEvaluation();

    // Expire old proposals first
    const expiredCount = await proposalService.expireOldProposals();
    if (expiredCount > 0) {
      console.log(`[PolicyEvaluator] Expired ${expiredCount} old proposals`);
    }

    // Expire outdated policy overrides
    await policyService.expireOutdatedOverrides();

    // Get all campaigns
    const campaigns = await adsAdapter.listCampaigns();
    console.log(`[PolicyEvaluator] Evaluating ${campaigns.length} campaigns`);

    for (const campaign of campaigns) {
      try {
        // Skip paused campaigns
        if (campaign.status !== 'ENABLED') {
          console.log(`[PolicyEvaluator] Skipping ${campaign.name} - status: ${campaign.status}`);
          continue;
        }

        // Generate budget proposal
        const proposal = await proposalService.generateBudgetProposals(
          campaign.id,
          campaign.name,
          campaign.budget_amount_micros
        );

        if (proposal) {
          proposalsGenerated.push(proposal);
          console.log(`[PolicyEvaluator] Generated ${proposal.type} proposal for ${campaign.name}`);

          // Send notification for pending approval
          if (proposal.requires_approval) {
            await notifier.sendProposalPendingNotification({
              proposal_id: proposal.id,
              campaign_name: proposal.campaign_name,
              proposal_type: proposal.type,
              proposed_change: `$${proposal.current_value} → $${proposal.proposed_value} (${(proposal.change_pct ?? 0) > 0 ? '+' : ''}${(proposal.change_pct ?? 0).toFixed(1)}%)`,
              confidence_score: proposal.evidence.confidence_score,
              expires_at: proposal.expires_at,
            });
          }
        }
      } catch (error) {
        const errorMsg = `Failed to evaluate campaign ${campaign.id}: ${error instanceof Error ? error.message : 'Unknown error'}`;
        console.error(`[PolicyEvaluator] ${errorMsg}`);
        errors.push(errorMsg);
      }
    }

    console.log(`[PolicyEvaluator] Job complete: ${proposalsGenerated.length} proposals generated`);

    return {
      campaigns_evaluated: campaigns.length,
      proposals_generated: proposalsGenerated.length,
      proposals_details: proposalsGenerated.map((p) => ({
        campaign_id: p.campaign_id,
        campaign_name: p.campaign_name,
        type: p.type,
        change_pct: p.change_pct ?? 0,
        confidence_score: p.evidence.confidence_score,
      })),
      errors,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[PolicyEvaluator] Job failed: ${errorMsg}`);
    errors.push(errorMsg);

    await logAuditEvent({
      event_type: 'api_error' as AuditEventType,
      entity_type: 'system',
      actor: 'policy-evaluator',
      action: 'Policy evaluation job failed',
      details: { error: errorMsg },
    });

    return {
      campaigns_evaluated: 0,
      proposals_generated: 0,
      proposals_details: [],
      errors,
    };
  }
}

/**
 * Check for safety conditions and trigger stops if needed
 */
export async function runSafetyCheckJob(): Promise<{
  checks_passed: boolean;
  issues: string[];
}> {
  console.log('[SafetyCheck] Running safety checks...');

  const adsAdapter = getGoogleAdsAdapter();
  const policyService = getPolicyService();
  const systemState = getSystemStateService();
  const notifier = getNotifier();

  const issues: string[] = [];

  try {
    const policy = await policyService.getCurrentPolicy();
    if (!policy) {
      issues.push('No active policy');
      return { checks_passed: false, issues };
    }

    // Get campaigns and check for anomalies
    const campaigns = await adsAdapter.listCampaigns();

    for (const campaign of campaigns) {
      if (campaign.status !== 'ENABLED') continue;

      // Get recent metrics
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 7);

      const metrics = await adsAdapter.getCampaignMetrics(
        campaign.id,
        startDate.toISOString().split('T')[0]!,
        endDate.toISOString().split('T')[0]!
      );

      if (metrics.length === 0) continue;

      // Calculate totals
      let totalSpend = BigInt(0);
      let totalConversions = 0;
      let totalConvValue = BigInt(0);

      for (const m of metrics) {
        totalSpend += m.cost_micros;
        totalConversions += m.conversions;
        totalConvValue += m.conversion_value_micros;
      }

      const spendUsd = Number(totalSpend) / 1_000_000;
      const roas = Number(totalSpend) > 0 ? Number(totalConvValue) / Number(totalSpend) : 0;

      // Check for conversion tracking issues
      if (spendUsd > 50 && totalConversions < 0.1) {
        const issue = `Suspected conversion tracking issue: ${campaign.name} - spent $${spendUsd.toFixed(2)} with near-zero conversions`;
        issues.push(issue);
      }

      // Check for severe ROAS drop
      if (spendUsd > 100 && roas < policy.config.break_even_roas * 0.5) {
        const issue = `Severe ROAS drop: ${campaign.name} - ROAS ${roas.toFixed(2)} is less than 50% of break-even`;
        issues.push(issue);
      }

      // Check for exceeding hard limit (shouldn't happen but verify)
      const budgetUsd = Number(campaign.budget_amount_micros) / 1_000_000;
      if (budgetUsd > policy.config.hard_limit) {
        const issue = `Budget exceeds hard limit: ${campaign.name} - $${budgetUsd.toFixed(2)} > $${policy.config.hard_limit}`;
        issues.push(issue);
      }
    }

    // If there are critical issues, trigger safety stop
    if (issues.length > 0) {
      const state = await systemState.getState();

      if (!state.safety_stop_active) {
        const reason = `Safety check detected ${issues.length} issue(s): ${issues[0]}`;
        await systemState.triggerSafetyStop(reason);

        await notifier.sendSafetyStopNotification({
          reason,
          triggered_at: new Date(),
          affected_campaigns: campaigns.map((c) => c.name),
        });
      }

      return { checks_passed: false, issues };
    }

    console.log('[SafetyCheck] All checks passed');
    return { checks_passed: true, issues: [] };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[SafetyCheck] Check failed: ${errorMsg}`);
    issues.push(errorMsg);
    return { checks_passed: false, issues };
  }
}
