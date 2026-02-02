/**
 * Worker Process
 * Runs scheduled jobs with single-instance locking
 */

import { tryAdvisoryLock, releaseAdvisoryLock, closePool } from './db/client.js';
import { runObserverJob, runMerchantCenterSync } from './jobs/observer.js';
import { runPolicyEvaluatorJob, runSafetyCheckJob } from './jobs/policy-evaluator.js';
import { getExecutorService } from './services/executor.js';
import { getNotifier } from './services/notifier.js';
import { getProposalGeneratorService } from './services/proposals.js';
import { getAuditLogger } from './services/audit.js';
import { AuditEventType } from './types/index.js';

// Lock IDs for advisory locks
const LOCK_IDS = {
  OBSERVER: 1001,
  POLICY_EVALUATOR: 1002,
  EXECUTOR: 1003,
  SAFETY_CHECK: 1004,
};

// Job intervals (in milliseconds)
const INTERVALS = {
  OBSERVER: 60 * 60 * 1000, // 1 hour
  POLICY_EVALUATOR: 24 * 60 * 60 * 1000, // 24 hours
  EXECUTOR: 15 * 60 * 1000, // 15 minutes
  SAFETY_CHECK: 30 * 60 * 1000, // 30 minutes
  DAILY_SUMMARY: 24 * 60 * 60 * 1000, // 24 hours
};

// Track running state
let isShuttingDown = false;
const runningJobs = new Set<string>();

/**
 * Run a job with advisory lock to ensure single instance
 */
async function runWithLock(
  jobName: string,
  lockId: number,
  job: () => Promise<unknown>
): Promise<void> {
  if (isShuttingDown) {
    console.log(`[Worker] Shutdown in progress, skipping ${jobName}`);
    return;
  }

  if (runningJobs.has(jobName)) {
    console.log(`[Worker] ${jobName} already running, skipping`);
    return;
  }

  const acquired = await tryAdvisoryLock(lockId);
  if (!acquired) {
    console.log(`[Worker] Could not acquire lock for ${jobName}, another instance may be running`);
    return;
  }

  runningJobs.add(jobName);
  console.log(`[Worker] Starting ${jobName}...`);

  try {
    await job();
    console.log(`[Worker] ${jobName} completed`);
  } catch (error) {
    console.error(`[Worker] ${jobName} failed:`, error);
  } finally {
    runningJobs.delete(jobName);
    await releaseAdvisoryLock(lockId);
  }
}

/**
 * Schedule a job to run at an interval
 */
function scheduleJob(
  jobName: string,
  lockId: number,
  interval: number,
  job: () => Promise<unknown>,
  runImmediately = false
): NodeJS.Timeout {
  if (runImmediately) {
    // Run immediately (after a short delay to allow initialization)
    setTimeout(() => {
      runWithLock(jobName, lockId, job);
    }, 1000);
  }

  return setInterval(() => {
    runWithLock(jobName, lockId, job);
  }, interval);
}

/**
 * Send daily summary
 */
async function sendDailySummary(): Promise<void> {
  const notifier = getNotifier();
  const proposalService = getProposalGeneratorService();
  const auditLogger = getAuditLogger();

  const today = new Date().toISOString().split('T')[0]!;

  // Get proposals from today
  const proposals = await proposalService.getProposals(undefined, 100);
  const todayProposals = proposals.filter(
    (p) => p.created_at.toISOString().split('T')[0] === today
  );

  const generated = todayProposals.length;
  const executed = todayProposals.filter((p) => p.status === 'executed').length;
  const rejected = todayProposals.filter((p) => p.status === 'rejected').length;

  // Calculate total spend change
  let totalSpendChange = 0;
  const campaignsModified: string[] = [];

  for (const proposal of todayProposals.filter((p) => p.status === 'executed')) {
    const before = parseFloat(String(proposal.current_value));
    const after = parseFloat(String(proposal.execution_result?.after_value ?? proposal.current_value));
    totalSpendChange += after - before;
    campaignsModified.push(proposal.campaign_name);
  }

  // Get safety events from audit
  const auditEvents = await auditLogger.query({
    event_type: AuditEventType.SAFETY_STOP_TRIGGERED,
    start_date: new Date(today),
  });
  const safetyEvents = auditEvents.map((e) => e.action);

  await notifier.sendDailySummary({
    date: today,
    proposals_generated: generated,
    proposals_executed: executed,
    proposals_rejected: rejected,
    total_spend_change_usd: totalSpendChange,
    campaigns_modified: [...new Set(campaignsModified)],
    safety_events: safetyEvents,
  });
}

/**
 * Main worker loop
 */
async function main(): Promise<void> {
  console.log('[Worker] Starting Alphabet Trains worker...');
  console.log('[Worker] Job intervals:');
  console.log(`  - Observer: every ${INTERVALS.OBSERVER / 60000} minutes`);
  console.log(`  - Policy Evaluator: every ${INTERVALS.POLICY_EVALUATOR / 3600000} hours`);
  console.log(`  - Executor: every ${INTERVALS.EXECUTOR / 60000} minutes`);
  console.log(`  - Safety Check: every ${INTERVALS.SAFETY_CHECK / 60000} minutes`);

  // Schedule jobs
  const timers: NodeJS.Timeout[] = [];

  // Observer job - runs hourly, run immediately on start
  timers.push(
    scheduleJob('Observer', LOCK_IDS.OBSERVER, INTERVALS.OBSERVER, async () => {
      const result = await runObserverJob();
      if (result.errors.length > 0) {
        console.warn(`[Worker] Observer had ${result.errors.length} errors`);
      }
      // Also run Merchant Center sync
      await runMerchantCenterSync();
    }, true)
  );

  // Policy evaluator - runs daily, run on start
  timers.push(
    scheduleJob('PolicyEvaluator', LOCK_IDS.POLICY_EVALUATOR, INTERVALS.POLICY_EVALUATOR, async () => {
      const result = await runPolicyEvaluatorJob();
      console.log(`[Worker] PolicyEvaluator generated ${result.proposals_generated} proposals`);
    }, true)
  );

  // Executor - runs every 15 minutes
  timers.push(
    scheduleJob('Executor', LOCK_IDS.EXECUTOR, INTERVALS.EXECUTOR, async () => {
      const executor = getExecutorService();
      const result = await executor.executeApprovedProposals();
      console.log(`[Worker] Executor: ${result.executed} executed, ${result.failed} failed, ${result.skipped} skipped`);
    }, false)
  );

  // Safety check - runs every 30 minutes
  timers.push(
    scheduleJob('SafetyCheck', LOCK_IDS.SAFETY_CHECK, INTERVALS.SAFETY_CHECK, async () => {
      const result = await runSafetyCheckJob();
      if (!result.checks_passed) {
        console.warn(`[Worker] Safety check failed: ${result.issues.join(', ')}`);
      }
    }, true)
  );

  // Daily summary - calculate when to run (e.g., at midnight)
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const msUntilMidnight = tomorrow.getTime() - now.getTime();

  // Schedule first daily summary at midnight, then every 24 hours
  setTimeout(() => {
    sendDailySummary();
    timers.push(
      setInterval(() => {
        sendDailySummary();
      }, INTERVALS.DAILY_SUMMARY)
    );
  }, msUntilMidnight);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[Worker] Received ${signal}, shutting down...`);
    isShuttingDown = true;

    // Clear all timers
    for (const timer of timers) {
      clearInterval(timer);
    }

    // Wait for running jobs to complete (max 30 seconds)
    const maxWait = 30000;
    const startWait = Date.now();
    while (runningJobs.size > 0 && Date.now() - startWait < maxWait) {
      console.log(`[Worker] Waiting for ${runningJobs.size} jobs to complete...`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (runningJobs.size > 0) {
      console.warn(`[Worker] ${runningJobs.size} jobs did not complete in time`);
    }

    // Close database pool
    await closePool();
    console.log('[Worker] Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  console.log('[Worker] Ready. Press Ctrl+C to stop.');
}

main().catch((error) => {
  console.error('[Worker] Fatal error:', error);
  process.exit(1);
});
