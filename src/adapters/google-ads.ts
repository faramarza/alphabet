/**
 * Google Ads API Adapter
 * Thin wrapper for Google Ads API operations
 *
 * This adapter handles:
 * - Fetching campaign performance metrics
 * - Fetching budget settings
 * - Updating campaign budgets
 *
 * For PMax campaigns, we fetch the best available metrics and record coverage_score
 */

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
      const aov = 80 + Math.random() * 40; // $80-120 AOV
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
  private customerId: string;
  private loginCustomerId: string | undefined;
  private developerToken: string;

  constructor() {
    if (!config.googleAds.customerId || !config.googleAds.developerToken) {
      throw new Error('Google Ads API not configured');
    }

    this.customerId = config.googleAds.customerId.replace(/-/g, '');
    this.loginCustomerId = config.googleAds.loginCustomerId?.replace(/-/g, '');
    this.developerToken = config.googleAds.developerToken;
  }

  private async getAccessToken(): Promise<string> {
    // OAuth token refresh implementation
    // In production, use google-auth-library or similar
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.googleAds.clientId!,
        client_secret: config.googleAds.clientSecret!,
        refresh_token: config.googleAds.refreshToken!,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      throw new Error(`Token refresh failed: ${response.status}`);
    }

    const data = (await response.json()) as { access_token: string };
    return data.access_token;
  }

  private async makeRequest(query: string): Promise<unknown[]> {
    const accessToken = await this.getAccessToken();

    const url = `https://googleads.googleapis.com/v15/customers/${this.customerId}/googleAds:searchStream`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'developer-token': this.developerToken,
      'Content-Type': 'application/json',
    };

    if (this.loginCustomerId) {
      headers['login-customer-id'] = this.loginCustomerId;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Google Ads API error: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as { results?: unknown[] }[];
    return data.flatMap((batch) => batch.results ?? []);
  }

  private async mutateCampaignBudget(
    budgetResourceName: string,
    newAmountMicros: bigint
  ): Promise<{ operationId: string }> {
    const accessToken = await this.getAccessToken();

    const url = `https://googleads.googleapis.com/v15/customers/${this.customerId}/campaignBudgets:mutate`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'developer-token': this.developerToken,
      'Content-Type': 'application/json',
    };

    if (this.loginCustomerId) {
      headers['login-customer-id'] = this.loginCustomerId;
    }

    const body = {
      operations: [
        {
          updateMask: 'amountMicros',
          update: {
            resourceName: budgetResourceName,
            amountMicros: newAmountMicros.toString(),
          },
        },
      ],
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Budget update failed: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as { results?: { resourceName: string }[] };
    const operationId = data.results?.[0]?.resourceName ?? `op_${Date.now()}`;

    return { operationId };
  }

  async listCampaigns(): Promise<CampaignInfo[]> {
    const query = `
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        campaign.advertising_channel_type,
        campaign_budget.id,
        campaign_budget.amount_micros
      FROM campaign
      WHERE campaign.status != 'REMOVED'
    `;

    const results = (await this.makeRequest(query)) as {
      campaign: { id: string; name: string; status: string; advertisingChannelType: string };
      campaignBudget: { id: string; amountMicros: string };
    }[];

    return results.map((row) => ({
      id: row.campaign.id,
      name: row.campaign.name,
      status: row.campaign.status as CampaignInfo['status'],
      budget_id: row.campaignBudget.id,
      budget_amount_micros: BigInt(row.campaignBudget.amountMicros),
      campaign_type: row.campaign.advertisingChannelType,
    }));
  }

  async getCampaign(campaignId: string): Promise<CampaignInfo | null> {
    const campaigns = await this.listCampaigns();
    return campaigns.find((c) => c.id === campaignId) ?? null;
  }

  async getCampaignMetrics(
    campaignId: string,
    startDate: string,
    endDate: string
  ): Promise<CampaignMetrics[]> {
    const query = `
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
    `;

    const results = (await this.makeRequest(query)) as {
      campaign: { id: string };
      segments: { date: string };
      metrics: {
        costMicros: string;
        conversions: number;
        conversionsValue: number;
        impressions: string;
        clicks: string;
        searchImpressionShare?: number;
        searchBudgetLostImpressionShare?: number;
      };
    }[];

    return results.map((row) => ({
      campaign_id: row.campaign.id,
      date: row.segments.date,
      cost_micros: BigInt(row.metrics.costMicros),
      conversions: row.metrics.conversions,
      conversion_value_micros: BigInt(Math.round(row.metrics.conversionsValue * 1_000_000)),
      impressions: parseInt(row.metrics.impressions, 10),
      clicks: parseInt(row.metrics.clicks, 10),
      search_impression_share: row.metrics.searchImpressionShare,
      search_lost_impression_share_budget: row.metrics.searchBudgetLostImpressionShare,
    }));
  }

  async updateCampaignBudget(
    campaignId: string,
    newAmountMicros: bigint
  ): Promise<BudgetUpdateResult> {
    const campaign = await this.getCampaign(campaignId);
    if (!campaign) {
      return {
        success: false,
        previous_amount_micros: BigInt(0),
        new_amount_micros: BigInt(0),
        error: 'Campaign not found',
      };
    }

    const budgetResourceName = `customers/${this.customerId}/campaignBudgets/${campaign.budget_id}`;

    try {
      const { operationId } = await this.mutateCampaignBudget(
        budgetResourceName,
        newAmountMicros
      );

      return {
        success: true,
        operation_id: operationId,
        previous_amount_micros: campaign.budget_amount_micros,
        new_amount_micros: newAmountMicros,
      };
    } catch (error) {
      return {
        success: false,
        previous_amount_micros: campaign.budget_amount_micros,
        new_amount_micros: newAmountMicros,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

// ============================================================================
// ADAPTER INTERFACE
// ============================================================================

export interface IGoogleAdsAdapter {
  listCampaigns(): Promise<CampaignInfo[]>;
  getCampaign(campaignId: string): Promise<CampaignInfo | null>;
  getCampaignMetrics(
    campaignId: string,
    startDate: string,
    endDate: string
  ): Promise<CampaignMetrics[]>;
  updateCampaignBudget(
    campaignId: string,
    newAmountMicros: bigint
  ): Promise<BudgetUpdateResult>;
  isStub(): boolean;
}

// ============================================================================
// FACTORY
// ============================================================================

export function createGoogleAdsAdapter(): IGoogleAdsAdapter {
  if (config.googleAds.isConfigured) {
    console.log('Using real Google Ads API');
    const client = new GoogleAdsClient();
    return {
      ...client,
      listCampaigns: () => client.listCampaigns(),
      getCampaign: (id) => client.getCampaign(id),
      getCampaignMetrics: (id, start, end) => client.getCampaignMetrics(id, start, end),
      updateCampaignBudget: (id, amount) => client.updateCampaignBudget(id, amount),
      isStub: () => false,
    };
  } else {
    console.log('Google Ads API not configured, using stub');
    const stub = new GoogleAdsStub();
    return {
      listCampaigns: () => stub.listCampaigns(),
      getCampaign: (id) => stub.getCampaign(id),
      getCampaignMetrics: (id, start, end) => stub.getCampaignMetrics(id, start, end),
      updateCampaignBudget: (id, amount) => stub.updateCampaignBudget(id, amount),
      isStub: () => true,
    };
  }
}

// Singleton instance
let adapterInstance: IGoogleAdsAdapter | null = null;

export function getGoogleAdsAdapter(): IGoogleAdsAdapter {
  if (!adapterInstance) {
    adapterInstance = createGoogleAdsAdapter();
  }
  return adapterInstance;
}
