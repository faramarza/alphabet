/**
 * Measurement Integrity Service
 *
 * Provides health checks and confidence scoring that gates proposals.
 * Prevents bad decisions based on unreliable data.
 */

import { getGoogleAdsAdapter } from '../adapters/google-ads.js';
import { query } from '../db/client.js';

// Configuration
const CONFIG = {
  // Exclude last N days from ROAS calculations due to conversion lag
  CONVERSION_LAG_DAYS: 3,

  // Minimum conversions required for statistical confidence
  MIN_CONVERSIONS_FOR_CONFIDENCE: 10,

  // Anomaly: clicks with zero conversions threshold
  ZERO_CONVERSION_CLICK_THRESHOLD: 50,

  // Anomaly: spend with zero conversions threshold
  ZERO_CONVERSION_SPEND_THRESHOLD: 50_000_000, // $50 in micros

  // Minimum data points for trend analysis
  MIN_DAYS_FOR_TREND: 7,

  // ROAS variance threshold for anomaly detection (50% deviation)
  ROAS_VARIANCE_THRESHOLD: 0.5,

  // Feed change freeze window (hours)
  FEED_CHANGE_FREEZE_HOURS: 48,
};

export interface MeasurementHealth {
  healthy: boolean;
  confidence: number; // 0-1 score
  issues: MeasurementIssue[];
  recommendations: string[];
  canPropose: boolean;
  lagAdjustedWindow: {
    startDate: string;
    endDate: string;
    excludedDays: number;
  };
}

export interface MeasurementIssue {
  type: 'conversion_tracking' | 'data_lag' | 'anomaly' | 'insufficient_data' | 'feed_change' | 'brand_leakage';
  severity: 'critical' | 'warning' | 'info';
  message: string;
  details?: Record<string, unknown>;
}

interface MetricsSnapshot {
  date: string;
  clicks: number;
  impressions: number;
  conversions: number;
  cost_micros: bigint;
  conversion_value_micros: bigint;
}

/**
 * Calculate lag-adjusted date window for ROAS decisions
 */
export function getLagAdjustedWindow(endDate: Date = new Date()): { startDate: string; endDate: string; excludedDays: number } {
  // Exclude last N days due to conversion lag
  const adjustedEnd = new Date(endDate);
  adjustedEnd.setDate(adjustedEnd.getDate() - CONFIG.CONVERSION_LAG_DAYS);

  // Start from 30 days before adjusted end
  const adjustedStart = new Date(adjustedEnd);
  adjustedStart.setDate(adjustedStart.getDate() - 30);

  return {
    startDate: adjustedStart.toISOString().split('T')[0] ?? '',
    endDate: adjustedEnd.toISOString().split('T')[0] ?? '',
    excludedDays: CONFIG.CONVERSION_LAG_DAYS,
  };
}

/**
 * Calculate lag-adjusted ROAS from metrics
 */
export function calculateLagAdjustedROAS(metrics: MetricsSnapshot[]): { roas: number; confidence: number; dataPoints: number } {
  // Filter out last N days
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - CONFIG.CONVERSION_LAG_DAYS);

  const validMetrics = metrics.filter(m => new Date(m.date) < cutoffDate);

  if (validMetrics.length === 0) {
    return { roas: 0, confidence: 0, dataPoints: 0 };
  }

  const totalCost = validMetrics.reduce((sum, m) => sum + Number(m.cost_micros), 0);
  const totalValue = validMetrics.reduce((sum, m) => sum + Number(m.conversion_value_micros), 0);
  const totalConversions = validMetrics.reduce((sum, m) => sum + m.conversions, 0);

  const roas = totalCost > 0 ? totalValue / totalCost : 0;

  // Confidence based on conversion volume and data points
  let confidence = 0;
  if (totalConversions >= CONFIG.MIN_CONVERSIONS_FOR_CONFIDENCE) {
    confidence = Math.min(1, totalConversions / (CONFIG.MIN_CONVERSIONS_FOR_CONFIDENCE * 3));
  }
  if (validMetrics.length < CONFIG.MIN_DAYS_FOR_TREND) {
    confidence *= validMetrics.length / CONFIG.MIN_DAYS_FOR_TREND;
  }

  return { roas, confidence, dataPoints: validMetrics.length };
}

/**
 * Detect conversion tracking anomalies
 */
export function detectConversionTrackingAnomaly(metrics: MetricsSnapshot[]): MeasurementIssue | null {
  const recentMetrics = metrics.slice(-7); // Last 7 days

  const totalClicks = recentMetrics.reduce((sum, m) => sum + m.clicks, 0);
  const totalConversions = recentMetrics.reduce((sum, m) => sum + m.conversions, 0);
  const totalSpend = recentMetrics.reduce((sum, m) => sum + Number(m.cost_micros), 0);

  // Zero conversions with significant clicks/spend = likely tracking issue
  if (totalConversions === 0 && totalClicks > CONFIG.ZERO_CONVERSION_CLICK_THRESHOLD) {
    return {
      type: 'conversion_tracking',
      severity: 'critical',
      message: `Zero conversions detected with ${totalClicks} clicks in last 7 days. Possible conversion tracking failure.`,
      details: { clicks: totalClicks, conversions: totalConversions, spend_micros: totalSpend },
    };
  }

  if (totalConversions === 0 && totalSpend > CONFIG.ZERO_CONVERSION_SPEND_THRESHOLD) {
    return {
      type: 'conversion_tracking',
      severity: 'critical',
      message: `Zero conversions with $${(totalSpend / 1_000_000).toFixed(2)} spend in last 7 days. Possible conversion tracking failure.`,
      details: { clicks: totalClicks, conversions: totalConversions, spend_micros: totalSpend },
    };
  }

  return null;
}

/**
 * Detect ROAS anomalies (sudden drops that might indicate data issues)
 */
export function detectROASAnomaly(metrics: MetricsSnapshot[]): MeasurementIssue | null {
  if (metrics.length < 14) {
    return null; // Not enough data
  }

  // Compare last 7 days to previous 7 days (excluding lag window)
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - CONFIG.CONVERSION_LAG_DAYS);

  const validMetrics = metrics.filter(m => new Date(m.date) < cutoffDate);

  if (validMetrics.length < 14) {
    return null;
  }

  const recent = validMetrics.slice(-7);
  const previous = validMetrics.slice(-14, -7);

  const recentCost = recent.reduce((sum, m) => sum + Number(m.cost_micros), 0);
  const recentValue = recent.reduce((sum, m) => sum + Number(m.conversion_value_micros), 0);
  const recentROAS = recentCost > 0 ? recentValue / recentCost : 0;

  const prevCost = previous.reduce((sum, m) => sum + Number(m.cost_micros), 0);
  const prevValue = previous.reduce((sum, m) => sum + Number(m.conversion_value_micros), 0);
  const prevROAS = prevCost > 0 ? prevValue / prevCost : 0;

  if (prevROAS > 0) {
    const variance = Math.abs(recentROAS - prevROAS) / prevROAS;

    if (variance > CONFIG.ROAS_VARIANCE_THRESHOLD && recentROAS < prevROAS) {
      return {
        type: 'anomaly',
        severity: 'warning',
        message: `ROAS dropped ${(variance * 100).toFixed(0)}% week-over-week. Verify this is real performance change, not data issue.`,
        details: { recentROAS, prevROAS, variance },
      };
    }
  }

  return null;
}

/**
 * Check for insufficient data
 */
export function detectInsufficientData(metrics: MetricsSnapshot[]): MeasurementIssue | null {
  if (metrics.length < CONFIG.MIN_DAYS_FOR_TREND) {
    return {
      type: 'insufficient_data',
      severity: 'warning',
      message: `Only ${metrics.length} days of data available. Need ${CONFIG.MIN_DAYS_FOR_TREND} days for reliable decisions.`,
      details: { availableDays: metrics.length, requiredDays: CONFIG.MIN_DAYS_FOR_TREND },
    };
  }

  const totalConversions = metrics.reduce((sum, m) => sum + m.conversions, 0);

  if (totalConversions < CONFIG.MIN_CONVERSIONS_FOR_CONFIDENCE) {
    return {
      type: 'insufficient_data',
      severity: 'warning',
      message: `Only ${totalConversions} conversions in dataset. Need ${CONFIG.MIN_CONVERSIONS_FOR_CONFIDENCE} for statistical confidence.`,
      details: { conversions: totalConversions, required: CONFIG.MIN_CONVERSIONS_FOR_CONFIDENCE },
    };
  }

  return null;
}

/**
 * Check for recent feed changes that should freeze inference
 */
export async function checkFeedChangeFreeze(): Promise<MeasurementIssue | null> {
  try {
    // Check audit log for recent feed-related changes
    const result = await query<{ created_at: Date; details: unknown }>(`
      SELECT created_at, details
      FROM audit_log
      WHERE action_type IN ('feed_update', 'product_change', 'merchant_center_update')
        AND created_at > NOW() - INTERVAL '${CONFIG.FEED_CHANGE_FREEZE_HOURS} hours'
      ORDER BY created_at DESC
      LIMIT 1
    `);

    if (result.rows.length > 0) {
      const lastChange = result.rows[0]!;
      return {
        type: 'feed_change',
        severity: 'warning',
        message: `Feed change detected ${new Date(lastChange.created_at).toISOString()}. Inference frozen for ${CONFIG.FEED_CHANGE_FREEZE_HOURS}h.`,
        details: { lastChange: lastChange.created_at, freezeHours: CONFIG.FEED_CHANGE_FREEZE_HOURS },
      };
    }
  } catch {
    // Table might not exist yet, ignore
  }

  return null;
}

/**
 * Main measurement health check
 */
export async function checkMeasurementHealth(campaignId?: string): Promise<MeasurementHealth> {
  const issues: MeasurementIssue[] = [];
  const recommendations: string[] = [];

  const lagWindow = getLagAdjustedWindow();

  // Get metrics from database (using snapshots table)
  interface SnapshotRow {
    date: string;
    clicks: string | number;
    impressions: string | number;
    conversions: string | number;
    cost_micros: string | number | null;
    conversion_value_micros: string | number | null;
  }

  let metrics: MetricsSnapshot[] = [];
  try {
    const metricsQuery = campaignId
      ? `SELECT snapshot_date as date, clicks, impressions, conversions, cost_micros, conversion_value_micros
         FROM snapshots WHERE campaign_id = $1 AND snapshot_hour IS NULL ORDER BY snapshot_date DESC LIMIT 30`
      : `SELECT snapshot_date as date, SUM(clicks) as clicks, SUM(impressions) as impressions,
                SUM(conversions) as conversions, SUM(cost_micros) as cost_micros,
                SUM(conversion_value_micros) as conversion_value_micros
         FROM snapshots WHERE snapshot_hour IS NULL GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT 30`;

    const result = campaignId
      ? await query<SnapshotRow>(metricsQuery, [campaignId])
      : await query<SnapshotRow>(metricsQuery);

    metrics = result.rows.map(row => ({
      date: row.date,
      clicks: Number(row.clicks),
      impressions: Number(row.impressions),
      conversions: Number(row.conversions),
      cost_micros: BigInt(row.cost_micros || 0),
      conversion_value_micros: BigInt(row.conversion_value_micros || 0),
    }));
  } catch {
    // No metrics available
    issues.push({
      type: 'insufficient_data',
      severity: 'critical',
      message: 'No campaign metrics available in database.',
    });
  }

  // Run all checks
  const conversionAnomaly = detectConversionTrackingAnomaly(metrics);
  if (conversionAnomaly) {
    issues.push(conversionAnomaly);
    recommendations.push('Verify conversion tracking is properly configured in Google Ads.');
    recommendations.push('Check Google Tag Manager or gtag.js implementation.');
  }

  const roasAnomaly = detectROASAnomaly(metrics);
  if (roasAnomaly) {
    issues.push(roasAnomaly);
    recommendations.push('Investigate cause of ROAS change before making budget decisions.');
  }

  const dataIssue = detectInsufficientData(metrics);
  if (dataIssue) {
    issues.push(dataIssue);
    recommendations.push('Wait for more data before making optimization decisions.');
  }

  const feedFreeze = await checkFeedChangeFreeze();
  if (feedFreeze) {
    issues.push(feedFreeze);
    recommendations.push('Wait for feed changes to stabilize before adjusting budgets.');
  }

  // Calculate overall confidence
  const { confidence } = calculateLagAdjustedROAS(metrics);

  // Determine if proposals should be blocked
  const hasCriticalIssue = issues.some(i => i.severity === 'critical');
  const hasWarnings = issues.some(i => i.severity === 'warning');

  // Can propose only if no critical issues and confidence > 0.5
  const canPropose = !hasCriticalIssue && confidence >= 0.5;

  // Adjust confidence based on issues
  let adjustedConfidence = confidence;
  if (hasCriticalIssue) adjustedConfidence = 0;
  if (hasWarnings) adjustedConfidence *= 0.7;

  return {
    healthy: issues.length === 0,
    confidence: adjustedConfidence,
    issues,
    recommendations,
    canPropose,
    lagAdjustedWindow: lagWindow,
  };
}

/**
 * Get lag-adjusted ROAS for a campaign
 */
export async function getCampaignLagAdjustedROAS(campaignId: string): Promise<{
  roas: number;
  confidence: number;
  window: { startDate: string; endDate: string };
  rawROAS: number;
}> {
  const window = getLagAdjustedWindow();

  interface SnapshotRow {
    date: string;
    clicks: string | number;
    impressions: string | number;
    conversions: string | number;
    cost_micros: string | number | null;
    conversion_value_micros: string | number | null;
  }

  try {
    const result = await query<SnapshotRow>(`
      SELECT snapshot_date as date, clicks, impressions, conversions, cost_micros, conversion_value_micros
      FROM snapshots
      WHERE campaign_id = $1
        AND snapshot_date >= $2
        AND snapshot_date <= $3
        AND snapshot_hour IS NULL
      ORDER BY snapshot_date
    `, [campaignId, window.startDate, window.endDate]);

    const metrics: MetricsSnapshot[] = result.rows.map(row => ({
      date: row.date,
      clicks: Number(row.clicks),
      impressions: Number(row.impressions),
      conversions: Number(row.conversions),
      cost_micros: BigInt(row.cost_micros || 0),
      conversion_value_micros: BigInt(row.conversion_value_micros || 0),
    }));

    const { roas, confidence } = calculateLagAdjustedROAS(metrics);

    // Also calculate raw ROAS (including lag period) for comparison
    const totalCost = metrics.reduce((sum, m) => sum + Number(m.cost_micros), 0);
    const totalValue = metrics.reduce((sum, m) => sum + Number(m.conversion_value_micros), 0);
    const rawROAS = totalCost > 0 ? totalValue / totalCost : 0;

    return { roas, confidence, window, rawROAS };
  } catch {
    return { roas: 0, confidence: 0, window, rawROAS: 0 };
  }
}

export const measurementIntegrityConfig = CONFIG;
