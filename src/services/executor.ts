/**
 * Executor Service
 * Executes ONLY approved proposals with re-validation at execution time
 * CRITICAL: Checks all conditions before any write operation
 */

import { getGoogleAdsAdapter, type BudgetUpdateResult } from '../adapters/google-ads.js';
import { getProposalGeneratorService } from './proposals.js';
import { getPolicyService, getCampaignSettingsService, getOpsSignalsService } from './policy.js';
import { getSnapshotsService } from './snapshots.js';
import { getSystemStateService } from './system-state.js';
import { logAuditEvent } from './audit.js';
import { getNotifier } from './notifier.js';
import type {
  Proposal,
  ProposalStatus,
  ProposalType,
  ExecutionResult,
  AuditEventType,
} from '../types/index.js';

// ============================================================================
// EXECUTION VALIDATOR
// ============================================================================

interface ValidationResult {
  valid: boolean;
  reasons: string[];
  conditions: ExecutionResult['conditions_at_execution'];
}

async function validateExecutionConditions(proposal: Proposal): Promise<ValidationResult> {
  const systemState = getSystemStateService();
  const policyService = getPolicyService();
  const settingsService = getCampaignSettingsService();
  const opsService = getOpsSignalsService();
  const snapshotsService = getSnapshotsService();

  const reasons: string[] = [];

  // 1. Check kill switch
  const writesAllowed = await systemState.areWritesAllowed();
  const killSwitchOff = writesAllowed.allowed;
  if (!killSwitchOff) {
    reasons.push(writesAllowed.reason ?? 'Writes are blocked');
  }

  // 2. Check policy still allows
  const policy = await policyService.getEffectiveConfig(proposal.campaign_id);
  let policyStillAllows = true;

  // For budget proposals, validate the proposed value against current policy
  if (proposal.type === ProposalType.BUDGET_INCREASE || proposal.type === ProposalType.BUDGET_DECREASE) {
    const proposedValue = parseFloat(proposal.approved_value ?? proposal.proposed_value);
    if (proposedValue > policy.hard_limit) {
      policyStillAllows = false;
      reasons.push(`Proposed budget $${proposedValue} exceeds hard limit $${policy.hard_limit}`);
    }
  }

  // 3. Check cooldown still respected
  const cooldownRespected = await settingsService.isCooldownPassed(
    proposal.campaign_id,
    policy.cooldown_days_budget_changes
  );
  if (!cooldownRespected) {
    reasons.push('Cooldown period no longer respected (another change may have occurred)');
  }

  // 4. Check ROAS still acceptable
  const metrics7d = await snapshotsService.computeAggregatedMetrics(proposal.campaign_id, 7);
  let roasAcceptable = true;

  if (metrics7d) {
    // For budget increases, ROAS must still be above break-even
    if (proposal.type === ProposalType.BUDGET_INCREASE) {
      if (metrics7d.roas < policy.break_even_roas) {
        roasAcceptable = false;
        reasons.push(`ROAS has dropped to ${metrics7d.roas.toFixed(2)}, below break-even ${policy.break_even_roas}`);
      }
    }
  }

  // 5. Check ops signals
  const opsBlocking = await opsService.isScalingBlocked(proposal.campaign_id, policy);
  if (opsBlocking.blocked && proposal.type === ProposalType.BUDGET_INCREASE) {
    reasons.push(...opsBlocking.reasons);
  }

  // 6. Check campaign not locked
  const settings = await settingsService.getOrCreate(proposal.campaign_id, proposal.campaign_name);
  if (settings.is_locked) {
    reasons.push(`Campaign is locked: ${settings.lock_reason ?? 'No reason provided'}`);
  }

  return {
    valid: reasons.length === 0,
    reasons,
    conditions: {
      kill_switch_off: killSwitchOff,
      policy_still_allows: policyStillAllows,
      cooldown_respected: cooldownRespected,
      roas_acceptable: roasAcceptable,
    },
  };
}

// ============================================================================
// EXECUTOR SERVICE
// ============================================================================

export class ExecutorService {
  private static instance: ExecutorService | null = null;
  private isExecuting = false;

  private constructor() {}

  static getInstance(): ExecutorService {
    if (!ExecutorService.instance) {
      ExecutorService.instance = new ExecutorService();
    }
    return ExecutorService.instance;
  }

  /**
   * Execute all approved proposals that are ready
   */
  async executeApprovedProposals(): Promise<{
    executed: number;
    failed: number;
    skipped: number;
  }> {
    if (this.isExecuting) {
      console.log('[Executor] Already executing, skipping');
      return { executed: 0, failed: 0, skipped: 0 };
    }

    this.isExecuting = true;
    const systemState = getSystemStateService();
    const proposalService = getProposalGeneratorService();

    let executed = 0;
    let failed = 0;
    let skipped = 0;

    try {
      await systemState.recordExecutorRun();

      // Get approved proposals
      const proposals = await proposalService.getProposals(ProposalStatus.APPROVED);

      for (const proposal of proposals) {
        try {
          const result = await this.executeProposal(proposal);
          if (result.executed) {
            executed++;
          } else if (result.failed) {
            failed++;
          } else {
            skipped++;
          }
        } catch (error) {
          console.error(`[Executor] Error executing proposal ${proposal.id}:`, error);
          failed++;
        }
      }

      // Also check for autopilot proposals ready for execution
      const autopilotResults = await this.executeAutopilotProposals();
      executed += autopilotResults.executed;
      failed += autopilotResults.failed;
      skipped += autopilotResults.skipped;

    } finally {
      this.isExecuting = false;
    }

    console.log(`[Executor] Completed: ${executed} executed, ${failed} failed, ${skipped} skipped`);
    return { executed, failed, skipped };
  }

  /**
   * Execute autopilot proposals that have passed their delay
   */
  private async executeAutopilotProposals(): Promise<{
    executed: number;
    failed: number;
    skipped: number;
  }> {
    const proposalService = getProposalGeneratorService();
    const proposals = await proposalService.getProposals(ProposalStatus.PENDING);

    let executed = 0;
    let failed = 0;
    let skipped = 0;

    for (const proposal of proposals) {
      // Check if this is an autopilot proposal ready for execution
      if (
        !proposal.requires_approval &&
        proposal.auto_execute_after &&
        new Date() >= proposal.auto_execute_after
      ) {
        try {
          // Auto-approve
          await proposalService.approveProposal(proposal.id, 'autopilot');

          // Execute
          const updatedProposal = await proposalService.getProposal(proposal.id);
          if (updatedProposal) {
            const result = await this.executeProposal(updatedProposal);
            if (result.executed) {
              executed++;
            } else if (result.failed) {
              failed++;
            } else {
              skipped++;
            }
          }
        } catch (error) {
          console.error(`[Executor] Autopilot execution failed for ${proposal.id}:`, error);
          failed++;
        }
      }
    }

    return { executed, failed, skipped };
  }

  /**
   * Execute a single proposal
   */
  async executeProposal(proposal: Proposal): Promise<{
    executed: boolean;
    failed: boolean;
    result?: ExecutionResult;
  }> {
    const proposalService = getProposalGeneratorService();
    const settingsService = getCampaignSettingsService();
    const notifier = getNotifier();
    const adsAdapter = getGoogleAdsAdapter();

    console.log(`[Executor] Validating proposal ${proposal.id}`);

    // Re-validate all conditions at execution time
    const validation = await validateExecutionConditions(proposal);

    if (!validation.valid) {
      console.log(`[Executor] Validation failed for ${proposal.id}: ${validation.reasons.join(', ')}`);

      const failedResult: ExecutionResult = {
        success: false,
        before_value: proposal.current_value,
        after_value: proposal.current_value,
        error_message: `Execution blocked: ${validation.reasons.join('; ')}`,
        conditions_at_execution: validation.conditions,
      };

      await proposalService.markExecuted(proposal.id, failedResult);

      await logAuditEvent({
        event_type: 'execution_failed' as AuditEventType,
        entity_type: 'proposal',
        entity_id: proposal.id,
        actor: 'system',
        action: 'Execution blocked by validation',
        details: {
          reasons: validation.reasons,
          conditions: validation.conditions,
        },
      });

      return { executed: false, failed: true, result: failedResult };
    }

    console.log(`[Executor] Executing proposal ${proposal.id}`);

    // Execute based on proposal type
    let apiResult: BudgetUpdateResult | null = null;

    try {
      switch (proposal.type) {
        case ProposalType.BUDGET_INCREASE:
        case ProposalType.BUDGET_DECREASE:
          apiResult = await this.executeBudgetChange(proposal);
          break;

        case ProposalType.PRODUCT_EXCLUSION:
          // Stub for product exclusion
          console.log(`[Executor] Product exclusion not yet implemented`);
          apiResult = {
            success: false,
            previous_amount_micros: BigInt(0),
            new_amount_micros: BigInt(0),
            error: 'Not implemented',
          };
          break;

        case ProposalType.ASSET_REPLACEMENT:
          // Stub for asset replacement
          console.log(`[Executor] Asset replacement not yet implemented`);
          apiResult = {
            success: false,
            previous_amount_micros: BigInt(0),
            new_amount_micros: BigInt(0),
            error: 'Not implemented',
          };
          break;
      }

      if (!apiResult) {
        throw new Error('No execution result returned');
      }

      const executionResult: ExecutionResult = {
        success: apiResult.success,
        api_operation_id: apiResult.operation_id,
        before_value: (Number(apiResult.previous_amount_micros) / 1_000_000).toFixed(2),
        after_value: (Number(apiResult.new_amount_micros) / 1_000_000).toFixed(2),
        error_message: apiResult.error,
        conditions_at_execution: validation.conditions,
      };

      await proposalService.markExecuted(proposal.id, executionResult);

      if (apiResult.success) {
        // Record budget change for cooldown tracking
        await settingsService.recordBudgetChange(proposal.campaign_id);

        // Send notification for budget change
        await notifier.sendBudgetChangeNotification({
          campaign_id: proposal.campaign_id,
          campaign_name: proposal.campaign_name,
          proposal_id: proposal.id,
          proposal_type: proposal.type,
          previous_budget: executionResult.before_value,
          new_budget: executionResult.after_value,
          change_pct: proposal.change_pct ?? 0,
          approved_by: proposal.approved_by ?? 'autopilot',
          reason_codes: proposal.evidence.reason_codes,
        });

        console.log(`[Executor] Successfully executed ${proposal.id}`);
        return { executed: true, failed: false, result: executionResult };
      } else {
        console.error(`[Executor] API error for ${proposal.id}: ${apiResult.error}`);
        return { executed: false, failed: true, result: executionResult };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Executor] Exception executing ${proposal.id}:`, error);

      const failedResult: ExecutionResult = {
        success: false,
        before_value: proposal.current_value,
        after_value: proposal.current_value,
        error_message: errorMessage,
        conditions_at_execution: validation.conditions,
      };

      await proposalService.markExecuted(proposal.id, failedResult);

      await logAuditEvent({
        event_type: 'api_error' as AuditEventType,
        entity_type: 'proposal',
        entity_id: proposal.id,
        actor: 'system',
        action: 'API error during execution',
        details: { error: errorMessage },
      });

      return { executed: false, failed: true, result: failedResult };
    }
  }

  /**
   * Execute a budget change
   */
  private async executeBudgetChange(proposal: Proposal): Promise<BudgetUpdateResult> {
    const adsAdapter = getGoogleAdsAdapter();

    // Get the value to use (approved value takes precedence)
    const targetBudgetUsd = parseFloat(proposal.approved_value ?? proposal.proposed_value);
    const targetBudgetMicros = BigInt(Math.round(targetBudgetUsd * 1_000_000));

    console.log(`[Executor] Updating budget for ${proposal.campaign_id} to $${targetBudgetUsd}`);

    return adsAdapter.updateCampaignBudget(proposal.campaign_id, targetBudgetMicros);
  }

  /**
   * Execute a single proposal by ID (for manual triggering)
   */
  async executeById(proposalId: string): Promise<ExecutionResult> {
    const proposalService = getProposalGeneratorService();
    const proposal = await proposalService.getProposal(proposalId);

    if (!proposal) {
      throw new Error('Proposal not found');
    }

    if (proposal.status !== ProposalStatus.APPROVED) {
      throw new Error(`Cannot execute proposal in ${proposal.status} status`);
    }

    const result = await this.executeProposal(proposal);

    if (!result.result) {
      throw new Error('No execution result');
    }

    return result.result;
  }
}

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

export function getExecutorService(): ExecutorService {
  return ExecutorService.getInstance();
}
