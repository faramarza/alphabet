/**
 * Snapshots Service
 * Manages metrics snapshots and aggregated metrics computation
 */

import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/client.js';
import { logAuditEvent } from './audit.js';
import type { MetricsSnapshot, AggregatedMetrics, AuditEventType } from '../types/index.js';

// ============================================================================
// DATABASE ROW TYPE
// ============================================================================

interface SnapshotRow {
  id: string;
  campaign_id: string;
  asset_group_id: string | null;
  snapshot_date: string;
  snapshot_hour: number | null;
  cost_micros: string;
  conversions: string;
  conversion_value_micros: string;
  impressions: string;
  clicks: string;
  roas: string | null;
  cpa_micros: string | null;
  ctr: string | null;
  budget_amount_micros: string | null;
  budget_utilization_pct: string | null;
  data_freshness_hours: number;
  is_complete: boolean;
  created_at: Date;
}

// ============================================================================
// SNAPSHOTS SERVICE
// ============================================================================

export class SnapshotsService {
  private static instance: SnapshotsService | null = null;

  private constructor() {}

  static getInstance(): SnapshotsService {
    if (!SnapshotsService.instance) {
      SnapshotsService.instance = new SnapshotsService();
    }
    return SnapshotsService.instance;
  }

  /**
   * Store a daily snapshot
   */
  async storeSnapshot(snapshot: Omit<MetricsSnapshot, 'id' | 'created_at'>): Promise<MetricsSnapshot> {
    const id = uuidv4();

    // Compute derived metrics
    const costNum = Number(snapshot.cost_micros);
    const convValueNum = Number(snapshot.conversion_value_micros);
    const roas = costNum > 0 ? convValueNum / costNum : null;
    const cpaMicros = snapshot.conversions > 0 ? BigInt(Math.round(costNum / snapshot.conversions)) : null;
    const ctr = snapshot.impressions > 0 ? snapshot.clicks / snapshot.impressions : null;

    await query(
      `INSERT INTO snapshots (
        id, campaign_id, asset_group_id, snapshot_date, snapshot_hour,
        cost_micros, conversions, conversion_value_micros, impressions, clicks,
        roas, cpa_micros, ctr, budget_amount_micros, budget_utilization_pct,
        data_freshness_hours, is_complete
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      ON CONFLICT (campaign_id, snapshot_date, asset_group_id)
      WHERE snapshot_hour IS NULL
      DO UPDATE SET
        cost_micros = EXCLUDED.cost_micros,
        conversions = EXCLUDED.conversions,
        conversion_value_micros = EXCLUDED.conversion_value_micros,
        impressions = EXCLUDED.impressions,
        clicks = EXCLUDED.clicks,
        roas = EXCLUDED.roas,
        cpa_micros = EXCLUDED.cpa_micros,
        ctr = EXCLUDED.ctr,
        budget_amount_micros = EXCLUDED.budget_amount_micros,
        budget_utilization_pct = EXCLUDED.budget_utilization_pct,
        data_freshness_hours = EXCLUDED.data_freshness_hours,
        is_complete = EXCLUDED.is_complete`,
      [
        id,
        snapshot.campaign_id,
        snapshot.asset_group_id ?? null,
        snapshot.snapshot_date,
        snapshot.snapshot_hour ?? null,
        snapshot.cost_micros.toString(),
        snapshot.conversions,
        snapshot.conversion_value_micros.toString(),
        snapshot.impressions,
        snapshot.clicks,
        roas,
        cpaMicros?.toString() ?? null,
        ctr,
        snapshot.budget_amount_micros?.toString() ?? null,
        snapshot.budget_utilization_pct ?? null,
        snapshot.data_freshness_hours,
        snapshot.is_complete,
      ]
    );

    await logAuditEvent({
      event_type: 'snapshot_pulled' as AuditEventType,
      entity_type: 'campaign',
      entity_id: snapshot.campaign_id,
      actor: 'system',
      action: `Stored snapshot for ${snapshot.snapshot_date}`,
      details: {
        date: snapshot.snapshot_date,
        cost_usd: Number(snapshot.cost_micros) / 1_000_000,
        conversions: snapshot.conversions,
        roas,
        is_complete: snapshot.is_complete,
      },
    });

    return {
      id,
      ...snapshot,
      roas: roas ?? undefined,
      cpa_micros: cpaMicros ?? undefined,
      ctr: ctr ?? undefined,
      created_at: new Date(),
    };
  }

  /**
   * Get snapshots for a campaign within a date range
   */
  async getSnapshots(
    campaignId: string,
    startDate: string,
    endDate: string
  ): Promise<MetricsSnapshot[]> {
    const result = await query<SnapshotRow>(
      `SELECT * FROM snapshots
       WHERE campaign_id = $1
         AND snapshot_date >= $2
         AND snapshot_date <= $3
         AND snapshot_hour IS NULL
       ORDER BY snapshot_date DESC`,
      [campaignId, startDate, endDate]
    );

    return result.rows.map((row) => this.rowToSnapshot(row));
  }

  /**
   * Compute aggregated metrics for a window
   */
  async computeAggregatedMetrics(
    campaignId: string,
    windowDays: number
  ): Promise<AggregatedMetrics | null> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - windowDays);

    const startDateStr = startDate.toISOString().split('T')[0]!;
    const endDateStr = endDate.toISOString().split('T')[0]!;

    const result = await query<{
      total_cost_micros: string;
      total_conversions: string;
      total_conversion_value_micros: string;
      total_impressions: string;
      total_clicks: string;
      days_with_data: string;
      complete_days: string;
      min_date: string;
      max_date: string;
    }>(
      `SELECT
        COALESCE(SUM(cost_micros), 0) as total_cost_micros,
        COALESCE(SUM(conversions), 0) as total_conversions,
        COALESCE(SUM(conversion_value_micros), 0) as total_conversion_value_micros,
        COALESCE(SUM(impressions), 0) as total_impressions,
        COALESCE(SUM(clicks), 0) as total_clicks,
        COUNT(*) as days_with_data,
        COUNT(*) FILTER (WHERE is_complete = TRUE) as complete_days,
        MIN(snapshot_date) as min_date,
        MAX(snapshot_date) as max_date
       FROM snapshots
       WHERE campaign_id = $1
         AND snapshot_date >= $2
         AND snapshot_date <= $3
         AND snapshot_hour IS NULL`,
      [campaignId, startDateStr, endDateStr]
    );

    if (result.rows.length === 0 || parseInt(result.rows[0]!.days_with_data, 10) === 0) {
      return null;
    }

    const row = result.rows[0]!;
    const totalCost = BigInt(row.total_cost_micros);
    const totalConvValue = BigInt(row.total_conversion_value_micros);
    const totalConversions = parseFloat(row.total_conversions);
    const totalImpressions = parseInt(row.total_impressions, 10);
    const totalClicks = parseInt(row.total_clicks, 10);
    const daysWithData = parseInt(row.days_with_data, 10);
    const completeDays = parseInt(row.complete_days, 10);

    const roas = Number(totalCost) > 0 ? Number(totalConvValue) / Number(totalCost) : 0;
    const cpaMicros = totalConversions > 0 ? BigInt(Math.round(Number(totalCost) / totalConversions)) : BigInt(0);
    const ctr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;

    // Compute trends by comparing first half to second half of window
    const trend = await this.computeTrend(campaignId, windowDays);

    return {
      campaign_id: campaignId,
      window_days: windowDays,
      start_date: row.min_date,
      end_date: row.max_date,
      total_cost_micros: totalCost,
      total_conversions: totalConversions,
      total_conversion_value_micros: totalConvValue,
      total_impressions: totalImpressions,
      total_clicks: totalClicks,
      avg_daily_cost_micros: BigInt(Math.round(Number(totalCost) / daysWithData)),
      avg_daily_conversions: totalConversions / daysWithData,
      roas,
      cpa_micros: cpaMicros,
      ctr,
      roas_trend: trend.roas_trend,
      spend_trend: trend.spend_trend,
      data_coverage_pct: (completeDays / windowDays) * 100,
      has_sufficient_conversions: totalConversions >= 10, // Configurable threshold
    };
  }

  /**
   * Compute trend by comparing halves of window
   */
  private async computeTrend(
    campaignId: string,
    windowDays: number
  ): Promise<{ roas_trend: 'increasing' | 'stable' | 'decreasing'; spend_trend: 'increasing' | 'stable' | 'decreasing' }> {
    const halfWindow = Math.floor(windowDays / 2);

    const endDate = new Date();
    const midDate = new Date();
    midDate.setDate(midDate.getDate() - halfWindow);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - windowDays);

    // First half metrics
    const firstHalf = await query<{ roas: string; cost: string }>(
      `SELECT
        CASE WHEN SUM(cost_micros) > 0 THEN SUM(conversion_value_micros)::numeric / SUM(cost_micros)::numeric ELSE 0 END as roas,
        SUM(cost_micros) as cost
       FROM snapshots
       WHERE campaign_id = $1
         AND snapshot_date >= $2
         AND snapshot_date < $3
         AND snapshot_hour IS NULL`,
      [campaignId, startDate.toISOString().split('T')[0], midDate.toISOString().split('T')[0]]
    );

    // Second half metrics
    const secondHalf = await query<{ roas: string; cost: string }>(
      `SELECT
        CASE WHEN SUM(cost_micros) > 0 THEN SUM(conversion_value_micros)::numeric / SUM(cost_micros)::numeric ELSE 0 END as roas,
        SUM(cost_micros) as cost
       FROM snapshots
       WHERE campaign_id = $1
         AND snapshot_date >= $2
         AND snapshot_date <= $3
         AND snapshot_hour IS NULL`,
      [campaignId, midDate.toISOString().split('T')[0], endDate.toISOString().split('T')[0]]
    );

    const firstRoas = parseFloat(firstHalf.rows[0]?.roas ?? '0');
    const secondRoas = parseFloat(secondHalf.rows[0]?.roas ?? '0');
    const firstCost = parseFloat(firstHalf.rows[0]?.cost ?? '0');
    const secondCost = parseFloat(secondHalf.rows[0]?.cost ?? '0');

    // 10% threshold for trend detection
    const roasChange = firstRoas > 0 ? (secondRoas - firstRoas) / firstRoas : 0;
    const costChange = firstCost > 0 ? (secondCost - firstCost) / firstCost : 0;

    const roas_trend: 'increasing' | 'stable' | 'decreasing' =
      roasChange > 0.1 ? 'increasing' : roasChange < -0.1 ? 'decreasing' : 'stable';

    const spend_trend: 'increasing' | 'stable' | 'decreasing' =
      costChange > 0.1 ? 'increasing' : costChange < -0.1 ? 'decreasing' : 'stable';

    return { roas_trend, spend_trend };
  }

  /**
   * Get the latest snapshot date for a campaign
   */
  async getLatestSnapshotDate(campaignId: string): Promise<string | null> {
    const result = await query<{ max_date: string }>(
      `SELECT MAX(snapshot_date) as max_date FROM snapshots WHERE campaign_id = $1 AND snapshot_hour IS NULL`,
      [campaignId]
    );

    return result.rows[0]?.max_date ?? null;
  }

  /**
   * Check for data gaps
   */
  async checkDataGaps(campaignId: string, days: number): Promise<string[]> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // Get all dates that should have data
    const expectedDates: string[] = [];
    const current = new Date(startDate);
    while (current <= endDate) {
      expectedDates.push(current.toISOString().split('T')[0]!);
      current.setDate(current.getDate() + 1);
    }

    // Get dates that have data
    const result = await query<{ snapshot_date: string }>(
      `SELECT DISTINCT snapshot_date FROM snapshots
       WHERE campaign_id = $1
         AND snapshot_date >= $2
         AND snapshot_date <= $3
         AND snapshot_hour IS NULL`,
      [campaignId, startDate.toISOString().split('T')[0], endDate.toISOString().split('T')[0]]
    );

    const existingDates = new Set(result.rows.map((r) => r.snapshot_date));

    // Find missing dates
    return expectedDates.filter((d) => !existingDates.has(d));
  }

  /**
   * Refresh the materialized view for 7-day metrics
   */
  async refreshMaterializedView(): Promise<void> {
    await query('REFRESH MATERIALIZED VIEW CONCURRENTLY campaign_metrics_7d');
  }

  private rowToSnapshot(row: SnapshotRow): MetricsSnapshot {
    return {
      id: row.id,
      campaign_id: row.campaign_id,
      asset_group_id: row.asset_group_id ?? undefined,
      snapshot_date: row.snapshot_date,
      snapshot_hour: row.snapshot_hour ?? undefined,
      cost_micros: BigInt(row.cost_micros),
      conversions: parseFloat(row.conversions),
      conversion_value_micros: BigInt(row.conversion_value_micros),
      impressions: parseInt(row.impressions, 10),
      clicks: parseInt(row.clicks, 10),
      roas: row.roas ? parseFloat(row.roas) : undefined,
      cpa_micros: row.cpa_micros ? BigInt(row.cpa_micros) : undefined,
      ctr: row.ctr ? parseFloat(row.ctr) : undefined,
      budget_amount_micros: row.budget_amount_micros ? BigInt(row.budget_amount_micros) : undefined,
      budget_utilization_pct: row.budget_utilization_pct ? parseFloat(row.budget_utilization_pct) : undefined,
      data_freshness_hours: row.data_freshness_hours,
      is_complete: row.is_complete,
      created_at: row.created_at,
    };
  }
}

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

export function getSnapshotsService(): SnapshotsService {
  return SnapshotsService.getInstance();
}
