/**
 * Google Ads API Adapter
 * Uses the google-ads-api library for proper API integration
 */

import { GoogleAdsApi, Customer } from 'google-ads-api';
import { config } from '../config/index.js';

// ============================================================================
// TYPES
// ============================================================================

export interface CampaignInfo {
  id: string;
  name: string;
  status: 'ENABLED' | 'PAUSED' | 'REMOVED';
  budget_id: string;
  budget_amount_micros: bigint;
  campaign_type: string;
}

export interface CampaignMetrics {
  campaign_id: string;
  date: string;
  cost_micros: bigint;
  conversions: number;
  conversion_value_micros: bigint;
  impressions: number;
  clicks: number;
  search_impression_share?: number;
  search_lost_impression_share_budget?: number;
}

export interface BudgetUpdateResult {
  success: boolean;
  operation_id?: string;
  previous_amount_micros: bigint;
  new_amount_micros: bigint;
  error?: string;
}

// ============================================================================
// STUB IMPLEMENTATION
// When Google Ads API is not configured, use stub data for development
// ============================================================================

class GoogleAdsStub {
  isStub = true;
  private mockCampaigns: Map<string, CampaignInfo> = new Map();
  private mockMetrics: Map<string, CampaignMetrics[]> = new Map();

  constructor() {
    // Initialize with sample campaign
    const sampleCampaign: CampaignInfo = {
      id: 'campaign_12345',
      name: 'Alphabet Trains - PMax',
      status: 'ENABLED',
      budget_id: 'budget_67890',
      budget_amount_micros: BigInt(50_000_000), // $50
      campaign_type: 'PERFORMANCE_MAX',
    };
    this.mockCampaigns.set(sampleCampaign.id, sampleCampaign);

    // Generate mock metrics for past 30 days
    const metrics: CampaignMetrics[] = [];
    for (let i = 30; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0]!;

      // Simulate realistic PMax campaign data
      const dailySpend = Math.random() * 40 + 10; // $10-50 per day
      const conversions = Math.random() * 3 + 0.5; // 0.5-3.5 conversions
      const roas = 4 + Math.random() * 2; // 4-6 ROAS

      metrics.push({
        campaign_id: sampleCampaign.id,
        date: dateStr,
        cost_micros: BigInt(Math.round(dailySpend * 1_000_000)),
        conversions: Math.round(conversions * 100) / 100,
        conversion_value_micros: BigInt(Math.round(dailySpend * roas * 1_000_000)),
        impressions: Math.round(dailySpend * 100 + Math.random() * 500),
        clicks: Math.round(dailySpend * 2 + Math.random() * 20),
        search_impression_share: 0.3 + Math.random() * 0.3, // 30-60%
        search_lost_impression_share_budget: 0.1 + Math.random() * 0.2, // 10-30%
      });
    }
    this.mockMetrics.set(sampleCampaign.id, metrics);
  }

  async listCampaigns(): Promise<CampaignInfo[]> {
    return Array.from(this.mockCampaigns.values());
  }

  async getCampaign(campaignId: string): Promise<CampaignInfo | null> {
    return this.mockCampaigns.get(campaignId) ?? null;
  }

  async getCampaignMetrics(
    campaignId: string,
    startDate: string,
    endDate: string
  ): Promise<CampaignMetrics[]> {
    const metrics = this.mockMetrics.get(campaignId) ?? [];
    return metrics.filter((m) => m.date >= startDate && m.date <= endDate);
  }

  async updateCampaignBudget(
    campaignId: string,
    newAmountMicros: bigint
  ): Promise<BudgetUpdateResult> {
    const campaign = this.mockCampaigns.get(campaignId);
    if (!campaign) {
      return {
        success: false,
        previous_amount_micros: BigInt(0),
        new_amount_micros: BigInt(0),
        error: 'Campaign not found',
      };
    }

    const previousAmount = campaign.budget_amount_micros;
    campaign.budget_amount_micros = newAmountMicros;

    return {
      success: true,
      operation_id: `op_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      previous_amount_micros: previousAmount,
      new_amount_micros: newAmountMicros,
    };
  }
}

// ============================================================================
// REAL GOOGLE ADS IMPLEMENTATION
// ============================================================================

class GoogleAdsClient {
  isStub = false;
  private client: GoogleAdsApi;
  private customer: Customer;
  private accessVerified = false;
  private accessError: string | null = null;

  constructor() {
    if (!config.googleAds.customerId || !config.googleAds.developerToken) {
      throw new Error('Google Ads API not configured');
    }

    this.client = new GoogleAdsApi({
      client_id: config.googleAds.clientId!,
      client_secret: config.googleAds.clientSecret!,
      developer_token: config.googleAds.developerToken,
    });

    this.customer = this.client.Customer({
      customer_id: config.googleAds.customerId.replace(/-/g, ''),
      login_customer_id: config.googleAds.loginCustomerId?.replace(/-/g, ''),
      refresh_token: config.googleAds.refreshToken!,
    });
  }

  /**
   * Map campaign status from API (may be number or string) to string
   */
  private mapCampaignStatus(status: unknown): 'ENABLED' | 'PAUSED' | 'REMOVED' {
    // Handle numeric status codes
    if (typeof status === 'number') {
      switch (status) {
        case 2: return 'ENABLED';
        case 3: return 'PAUSED';
        case 4: return 'REMOVED';
        default: return 'PAUSED';
      }
    }
    // Handle string status
    if (typeof status === 'string') {
      const upper = status.toUpperCase();
      if (upper === 'ENABLED' || upper === 'PAUSED' || upper === 'REMOVED') {
        return upper as 'ENABLED' | 'PAUSED' | 'REMOVED';
      }
    }
    return 'PAUSED';
  }

  /**
   * Checks if the API has proper access to the customer account
   * Test Account access level can only access test accounts, not real ones
   */
  private parseApiError(error: unknown): string {
    const errorStr = String(error);

    // Check for 404 error which indicates test account access trying to reach real accounts
    if (errorStr.includes('404') || errorStr.includes('was not found')) {
      return 'ACCESS_DENIED: Your Google Ads API developer token has "Test Account" access level, ' +
        'which can only access test accounts, not real advertising accounts. ' +
        'To access real accounts, you must apply for "Standard Access" at: ' +
        'https://developers.google.com/google-ads/api/docs/access-levels#standard_access';
    }

    // Check for authentication errors
    if (errorStr.includes('UNAUTHENTICATED') || errorStr.includes('401')) {
      return 'AUTHENTICATION_FAILED: Invalid OAuth credentials. Please regenerate your refresh token.';
    }

    // Check for permission errors
    if (errorStr.includes('PERMISSION_DENIED') || errorStr.includes('403')) {
      return 'PERMISSION_DENIED: The authenticated user does not have access to this Google Ads account. ' +
        'Ensure the OAuth account has admin access to the customer account.';
    }

    return error instanceof Error ? error.message : 'Unknown error';
  }

  async listCampaigns(): Promise<CampaignInfo[]> {
    try {
      const campaigns = await this.customer.query(`
        SELECT
          campaign.id,
          campaign.name,
          campaign.status,
          campaign.campaign_budget,
          campaign.advertising_channel_type,
          campaign_budget.amount_micros
        FROM campaign
        WHERE campaign.status != 'REMOVED'
      `);

      this.accessVerified = true;
      this.accessError = null;

      return campaigns.map((row) => ({
        id: String(row.campaign?.id ?? ''),
        name: row.campaign?.name ?? '',
        status: this.mapCampaignStatus(row.campaign?.status),
        budget_id: row.campaign?.campaign_budget ?? '',
        budget_amount_micros: BigInt(row.campaign_budget?.amount_micros ?? 0),
        campaign_type: String(row.campaign?.advertising_channel_type ?? 'UNKNOWN'),
      }));
    } catch (error) {
      this.accessError = this.parseApiError(error);
      console.error('[GoogleAds] Error listing campaigns:', this.accessError);
      console.error('[GoogleAds] Original error:', error);
      throw new Error(this.accessError);
    }
  }

  async getCampaign(campaignId: string): Promise<CampaignInfo | null> {
    try {
      const campaigns = await this.customer.query(`
        SELECT
          campaign.id,
          campaign.name,
          campaign.status,
          campaign.campaign_budget,
          campaign.advertising_channel_type,
          campaign_budget.amount_micros
        FROM campaign
        WHERE campaign.id = ${campaignId}
      `);

      if (campaigns.length === 0) {
        return null;
      }

      const row = campaigns[0]!;
      return {
        id: String(row.campaign?.id ?? ''),
        name: row.campaign?.name ?? '',
        status: (row.campaign?.status as 'ENABLED' | 'PAUSED' | 'REMOVED') ?? 'PAUSED',
        budget_id: row.campaign?.campaign_budget ?? '',
        budget_amount_micros: BigInt(row.campaign_budget?.amount_micros ?? 0),
        campaign_type: String(row.campaign?.advertising_channel_type ?? 'UNKNOWN'),
      };
    } catch (error) {
      console.error('[GoogleAds] Error getting campaign:', error);
      throw error;
    }
  }

  async getCampaignMetrics(
    campaignId: string,
    startDate: string,
    endDate: string
  ): Promise<CampaignMetrics[]> {
    try {
      const metrics = await this.customer.query(`
        SELECT
          campaign.id,
          segments.date,
          metrics.cost_micros,
          metrics.conversions,
          metrics.conversions_value,
          metrics.impressions,
          metrics.clicks,
          metrics.search_impression_share,
          metrics.search_budget_lost_impression_share
        FROM campaign
        WHERE campaign.id = ${campaignId}
          AND segments.date BETWEEN '${startDate}' AND '${endDate}'
        ORDER BY segments.date DESC
      `);

      return metrics.map((row) => ({
        campaign_id: String(row.campaign?.id ?? ''),
        date: row.segments?.date ?? '',
        cost_micros: BigInt(row.metrics?.cost_micros ?? 0),
        conversions: row.metrics?.conversions ?? 0,
        conversion_value_micros: BigInt(Math.round((row.metrics?.conversions_value ?? 0) * 1_000_000)),
        impressions: row.metrics?.impressions ?? 0,
        clicks: row.metrics?.clicks ?? 0,
        search_impression_share: row.metrics?.search_impression_share ?? undefined,
        search_lost_impression_share_budget: row.metrics?.search_budget_lost_impression_share ?? undefined,
      }));
    } catch (error) {
      console.error('[GoogleAds] Error getting metrics:', error);
      throw error;
    }
  }

  async updateCampaignBudget(
    campaignId: string,
    newAmountMicros: bigint
  ): Promise<BudgetUpdateResult> {
    try {
      // First get the current campaign to get budget resource name
      const campaign = await this.getCampaign(campaignId);
      if (!campaign) {
        return {
          success: false,
          previous_amount_micros: BigInt(0),
          new_amount_micros: BigInt(0),
          error: 'Campaign not found',
        };
      }

      const previousAmount = campaign.budget_amount_micros;

      // Update the budget using the mutate API
      const budgetResourceName = campaign.budget_id;

      await this.customer.campaignBudgets.update([{
        resource_name: budgetResourceName,
        amount_micros: Number(newAmountMicros),
      }]);

      return {
        success: true,
        operation_id: `op_${Date.now()}`,
        previous_amount_micros: previousAmount,
        new_amount_micros: newAmountMicros,
      };
    } catch (error) {
      console.error('[GoogleAds] Error updating budget:', error);
      return {
        success: false,
        previous_amount_micros: BigInt(0),
        new_amount_micros: newAmountMicros,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

// ============================================================================
// ADAPTER FACTORY
// ============================================================================

interface GoogleAdsAdapter {
  isStub: boolean;
  listCampaigns(): Promise<CampaignInfo[]>;
  getCampaign(campaignId: string): Promise<CampaignInfo | null>;
  getCampaignMetrics(campaignId: string, startDate: string, endDate: string): Promise<CampaignMetrics[]>;
  updateCampaignBudget(campaignId: string, newAmountMicros: bigint): Promise<BudgetUpdateResult>;
}

/**
 * Validates Google Ads API access and returns detailed diagnostic info
 */
export async function validateGoogleAdsAccess(): Promise<{
  success: boolean;
  mode: 'stub' | 'live';
  error?: string;
  help?: string;
}> {
  const adapter = getGoogleAdsAdapter();

  if (adapter.isStub) {
    return {
      success: true,
      mode: 'stub',
      help: 'Running in stub mode. Set GOOGLE_ADS_STUB_MODE=false to use real API.',
    };
  }

  try {
    await adapter.listCampaigns();
    return {
      success: true,
      mode: 'live',
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      mode: 'live',
      error: errorMsg,
      help: errorMsg.includes('Test Account')
        ? 'Apply for Standard Access at: https://developers.google.com/google-ads/api/docs/access-levels'
        : 'Check your API credentials and account permissions.',
    };
  }
}

let adapterInstance: GoogleAdsAdapter | null = null;

export function getGoogleAdsAdapter(): GoogleAdsAdapter {
  if (!adapterInstance) {
    if (config.googleAds.stubMode) {
      console.log('[GoogleAds] Using stub mode (no real API calls)');
      adapterInstance = new GoogleAdsStub();
    } else {
      console.log('[GoogleAds] Using real Google Ads API');
      adapterInstance = new GoogleAdsClient();
    }
  }
  return adapterInstance;
}

// Reset adapter (for testing)
export function resetGoogleAdsAdapter(): void {
  adapterInstance = null;
}
