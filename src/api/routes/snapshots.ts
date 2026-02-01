/**
 * Snapshots Routes
 * View metrics snapshots and aggregated data
 */

import { Router } from 'express';
import { getSnapshotsService } from '../../services/snapshots.js';
import { getGoogleAdsAdapter } from '../../adapters/google-ads.js';

const router = Router();

/**
 * GET /snapshots
 * Get snapshots for a campaign
 */
router.get('/', async (req, res) => {
  try {
    const campaignId = req.query['campaign_id'] as string;
    if (!campaignId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'MISSING_PARAM',
          message: 'campaign_id is required',
        },
      });
      return;
    }

    const range = req.query['range'] as string || '7d';
    const days = parseInt(range.replace('d', '')) || 7;

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const snapshotsService = getSnapshotsService();
    const snapshots = await snapshotsService.getSnapshots(
      campaignId,
      startDate.toISOString().split('T')[0]!,
      endDate.toISOString().split('T')[0]!
    );

    res.json({
      success: true,
      data: snapshots,
      meta: {
        campaign_id: campaignId,
        range,
        start_date: startDate.toISOString().split('T')[0],
        end_date: endDate.toISOString().split('T')[0],
        count: snapshots.length,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

/**
 * GET /snapshots/metrics
 * Get aggregated metrics for a campaign
 */
router.get('/metrics', async (req, res) => {
  try {
    const campaignId = req.query['campaign_id'] as string;
    if (!campaignId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'MISSING_PARAM',
          message: 'campaign_id is required',
        },
      });
      return;
    }

    const snapshotsService = getSnapshotsService();

    // Get metrics for all standard windows
    const [metrics7d, metrics14d, metrics30d] = await Promise.all([
      snapshotsService.computeAggregatedMetrics(campaignId, 7),
      snapshotsService.computeAggregatedMetrics(campaignId, 14),
      snapshotsService.computeAggregatedMetrics(campaignId, 30),
    ]);

    res.json({
      success: true,
      data: {
        metrics_7d: metrics7d,
        metrics_14d: metrics14d,
        metrics_30d: metrics30d,
      },
      meta: {
        campaign_id: campaignId,
        has_7d: !!metrics7d,
        has_14d: !!metrics14d,
        has_30d: !!metrics30d,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

/**
 * GET /snapshots/gaps
 * Check for data gaps
 */
router.get('/gaps', async (req, res) => {
  try {
    const campaignId = req.query['campaign_id'] as string;
    if (!campaignId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'MISSING_PARAM',
          message: 'campaign_id is required',
        },
      });
      return;
    }

    const days = parseInt(req.query['days'] as string) || 30;
    const snapshotsService = getSnapshotsService();
    const gaps = await snapshotsService.checkDataGaps(campaignId, days);

    res.json({
      success: true,
      data: {
        campaign_id: campaignId,
        missing_dates: gaps,
        gap_count: gaps.length,
        coverage_pct: ((days - gaps.length) / days) * 100,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

/**
 * GET /snapshots/campaigns
 * List all campaigns with basic info
 */
router.get('/campaigns', async (_req, res) => {
  try {
    const adsAdapter = getGoogleAdsAdapter();
    const campaigns = await adsAdapter.listCampaigns();

    res.json({
      success: true,
      data: campaigns.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        type: c.campaign_type,
        budget_usd: Number(c.budget_amount_micros) / 1_000_000,
      })),
      meta: {
        count: campaigns.length,
        is_stub: adsAdapter.isStub(),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

export default router;
