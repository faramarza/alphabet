/**
 * Observer Job
 * Pulls metrics from Google Ads and stores snapshots
 * Runs hourly for recent data, daily for rollups
 */

import { getGoogleAdsAdapter } from '../adapters/google-ads.js';
import { getMerchantCenterAdapter } from '../adapters/merchant-center.js';
import { getSnapshotsService } from '../services/snapshots.js';
import { getSystemStateService } from '../services/system-state.js';
import { getCampaignSettingsService } from '../services/policy.js';
import { logAuditEvent } from '../services/audit.js';
import type { AuditEventType } from '../types/index.js';

// ============================================================================
// OBSERVER JOB
// ============================================================================

export async function runObserverJob(): Promise<{
  campaigns_processed: number;
  snapshots_created: number;
  errors: string[];
}> {
  console.log('[Observer] Starting observer job...');

  const adsAdapter = getGoogleAdsAdapter();
  const snapshotsService = getSnapshotsService();
  const systemState = getSystemStateService();
  const settingsService = getCampaignSettingsService();

  const errors: string[] = [];
  let snapshotsCreated = 0;

  try {
    // Record job start
    await systemState.recordObserverRun();

    // Get all campaigns
    const campaigns = await adsAdapter.listCampaigns();
    console.log(`[Observer] Found ${campaigns.length} campaigns`);

    // Calculate date range (last 7 days for fresh data)
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);

    const startDateStr = startDate.toISOString().split('T')[0]!;
    const endDateStr = endDate.toISOString().split('T')[0]!;

    for (const campaign of campaigns) {
      try {
        // Ensure campaign settings exist
        await settingsService.getOrCreate(campaign.id, campaign.name);

        // Fetch metrics
        const metrics = await adsAdapter.getCampaignMetrics(
          campaign.id,
          startDateStr,
          endDateStr
        );

        console.log(`[Observer] Got ${metrics.length} metric records for ${campaign.name}`);

        // Store each day as a snapshot
        for (const metric of metrics) {
          const budgetUtilization = campaign.budget_amount_micros > 0
            ? (Number(metric.cost_micros) / Number(campaign.budget_amount_micros)) * 100
            : 0;

          await snapshotsService.storeSnapshot({
            campaign_id: metric.campaign_id,
            snapshot_date: metric.date,
            cost_micros: metric.cost_micros,
            conversions: metric.conversions,
            conversion_value_micros: metric.conversion_value_micros,
            impressions: metric.impressions,
            clicks: metric.clicks,
            budget_amount_micros: campaign.budget_amount_micros,
            budget_utilization_pct: budgetUtilization,
            data_freshness_hours: calculateFreshnessHours(metric.date),
            is_complete: true,
          });

          snapshotsCreated++;
        }
      } catch (error) {
        const errorMsg = `Failed to process campaign ${campaign.id}: ${error instanceof Error ? error.message : 'Unknown error'}`;
        console.error(`[Observer] ${errorMsg}`);
        errors.push(errorMsg);
      }
    }

    // Refresh materialized view
    try {
      await snapshotsService.refreshMaterializedView();
      console.log('[Observer] Refreshed materialized view');
    } catch (error) {
      console.warn('[Observer] Could not refresh materialized view:', error);
    }

    console.log(`[Observer] Job complete: ${snapshotsCreated} snapshots created, ${errors.length} errors`);

    return {
      campaigns_processed: campaigns.length,
      snapshots_created: snapshotsCreated,
      errors,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Observer] Job failed: ${errorMsg}`);
    errors.push(errorMsg);

    await logAuditEvent({
      event_type: 'api_error' as AuditEventType,
      entity_type: 'system',
      actor: 'observer',
      action: 'Observer job failed',
      details: { error: errorMsg },
    });

    return {
      campaigns_processed: 0,
      snapshots_created: 0,
      errors,
    };
  }
}

/**
 * Run Merchant Center diagnostics collection (optional)
 */
export async function runMerchantCenterSync(): Promise<{
  products_synced: number;
  issues_found: number;
}> {
  console.log('[Observer] Starting Merchant Center sync...');

  const mcAdapter = getMerchantCenterAdapter();

  try {
    const diagnostics = await mcAdapter.getDiagnostics();

    console.log(`[Observer] Merchant Center status:`);
    console.log(`  - Total products: ${diagnostics.total_products}`);
    console.log(`  - Active: ${diagnostics.active_products}`);
    console.log(`  - Disapproved: ${diagnostics.disapproved_products}`);
    console.log(`  - Top issues: ${diagnostics.top_issues.length}`);

    // Log if there are concerning issues
    if (diagnostics.disapproved_products > 0) {
      await logAuditEvent({
        event_type: 'snapshot_pulled' as AuditEventType,
        entity_type: 'system',
        actor: 'observer',
        action: 'Merchant Center sync - disapproved products detected',
        details: {
          disapproved_count: diagnostics.disapproved_products,
          top_issues: diagnostics.top_issues,
        },
      });
    }

    return {
      products_synced: diagnostics.total_products,
      issues_found: diagnostics.top_issues.length,
    };
  } catch (error) {
    console.error('[Observer] Merchant Center sync failed:', error);
    return {
      products_synced: 0,
      issues_found: 0,
    };
  }
}

/**
 * Calculate data freshness in hours
 */
function calculateFreshnessHours(dateStr: string): number {
  const snapshotDate = new Date(dateStr + 'T23:59:59Z');
  const now = new Date();
  return Math.round((now.getTime() - snapshotDate.getTime()) / (1000 * 60 * 60));
}
