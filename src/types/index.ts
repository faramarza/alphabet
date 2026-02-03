/**
 * Core type definitions for Alphabet Trains Google Ads Co-Pilot
 * All types are designed for safety, auditability, and transparency
 */

// ============================================================================
// ENUMS
// ============================================================================

export enum CampaignMode {
  EXPLOIT = 'EXPLOIT', // Conservative: small increments, no big changes
  EXPLORE = 'EXPLORE', // Limited experiments with explicit hypothesis & cap
}

export enum ProposalStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  EXECUTED = 'executed',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

export enum ProposalType {
  BUDGET_INCREASE = 'budget_increase',
  BUDGET_DECREASE = 'budget_decrease',
  PRODUCT_EXCLUSION = 'product_exclusion',
  ASSET_REPLACEMENT = 'asset_replacement',
}

export enum RiskLevel {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
}

export enum AuditEventType {
  SNAPSHOT_PULLED = 'snapshot_pulled',
  PROPOSAL_CREATED = 'proposal_created',
  PROPOSAL_APPROVED = 'proposal_approved',
  PROPOSAL_REJECTED = 'proposal_rejected',
  PROPOSAL_MODIFIED = 'proposal_modified',
  PROPOSAL_EXECUTED = 'proposal_executed',
  PROPOSAL_EXPIRED = 'proposal_expired',
  POLICY_CREATED = 'policy_created',
  POLICY_OVERRIDE_CREATED = 'policy_override_created',
  POLICY_OVERRIDE_EXPIRED = 'policy_override_expired',
  KILL_SWITCH_ENABLED = 'kill_switch_enabled',
  KILL_SWITCH_DISABLED = 'kill_switch_disabled',
  SAFETY_STOP_TRIGGERED = 'safety_stop_triggered',
  OPS_SIGNAL_UPDATED = 'ops_signal_updated',
  CAMPAIGN_MODE_CHANGED = 'campaign_mode_changed',
  EXECUTION_FAILED = 'execution_failed',
  API_ERROR = 'api_error',
}

// ============================================================================
// POLICY TYPES
// ============================================================================

export interface PolicyConfig {
  // Profit rails (non-negotiable)
  break_even_roas: number; // e.g., 4.0
  target_roas: number; // e.g., 5.0

  // Budget guardrails
  max_daily_spend_cap: number; // e.g., 100 USD
  hard_limit: number; // e.g., 300 USD - absolute maximum
  max_step_budget_increase_pct: number; // e.g., 10%
  max_step_budget_decrease_pct: number; // e.g., 20%
  cooldown_days_budget_changes: number; // e.g., 7 days
  max_weekly_loss_usd: number; // guardrail

  // Safety thresholds
  roas_drop_safety_threshold_pct: number; // e.g., 30% - triggers safety stop
  min_conversions_for_confidence: number; // e.g., 10 conversions
  min_data_days_for_proposal: number; // e.g., 7 days

  // Fulfillment risk thresholds
  max_lead_time_days_for_scaling: number; // e.g., 5 days
  block_scaling_on_high_fulfillment_risk: boolean;

  // Autopilot settings (which actions can run without approval)
  autopilot_enabled: boolean;
  autopilot_actions: ProposalType[]; // Empty = all require approval
  autopilot_max_budget_change_usd: number; // e.g., 10 USD
}

export interface Policy {
  id: string;
  version: number;
  config: PolicyConfig;
  created_at: Date;
  created_by: string;
  reason: string;
  is_current: boolean;
}

export interface PolicyOverride {
  id: string;
  policy_id: string;
  override_type: 'raise_cap' | 'lock_campaign' | 'disable_autopilot' | 'custom';
  target_campaign_id?: string;
  override_config: Record<string, unknown>;
  reason: string;
  created_by: string;
  created_at: Date;
  expires_at?: Date;
  is_active: boolean;
}

// ============================================================================
// CAMPAIGN & METRICS TYPES
// ============================================================================

export interface CampaignSettings {
  id: string;
  campaign_id: string;
  campaign_name: string;
  mode: CampaignMode;
  is_locked: boolean;
  lock_reason?: string;
  locked_by?: string;
  locked_at?: Date;
  last_budget_change_at?: Date;
  created_at: Date;
  updated_at: Date;
}

export interface MetricsSnapshot {
  id: string;
  campaign_id: string;
  asset_group_id?: string;
  snapshot_date: string; // YYYY-MM-DD
  snapshot_hour?: number; // 0-23 for hourly snapshots

  // Core metrics
  cost_micros: bigint; // Cost in micros (divide by 1,000,000 for USD)
  conversions: number;
  conversion_value_micros: bigint;
  impressions: number;
  clicks: number;

  // Computed metrics (stored for convenience)
  roas?: number; // conversion_value / cost
  cpa_micros?: bigint; // cost / conversions
  ctr?: number; // clicks / impressions

  // Budget info at time of snapshot
  budget_amount_micros?: bigint;
  budget_utilization_pct?: number;

  // Coverage and quality
  data_freshness_hours: number;
  is_complete: boolean; // Was all data available?

  created_at: Date;
}

export interface AggregatedMetrics {
  campaign_id: string;
  window_days: number; // 7, 14, or 30
  start_date: string;
  end_date: string;

  total_cost_micros: bigint;
  total_conversions: number;
  total_conversion_value_micros: bigint;
  total_impressions: number;
  total_clicks: number;

  avg_daily_cost_micros: bigint;
  avg_daily_conversions: number;

  roas: number;
  cpa_micros: bigint;
  ctr: number;

  // Trend indicators
  roas_trend: 'increasing' | 'stable' | 'decreasing';
  spend_trend: 'increasing' | 'stable' | 'decreasing';

  // Confidence
  data_coverage_pct: number; // % of days with complete data
  has_sufficient_conversions: boolean;
}

// ============================================================================
// OPS SIGNALS
// ============================================================================

export interface OpsSignal {
  id: string;
  campaign_id?: string; // null = global
  product_id?: string;

  fulfillment_risk: RiskLevel;
  lead_time_days: number;
  inventory_risk: RiskLevel;

  // Promo calendar
  is_promo_period: boolean;
  promo_start_date?: string;
  promo_end_date?: string;

  // Creative
  creative_fatigue_flag: boolean;

  // Custom notes
  notes?: string;

  updated_by: string;
  updated_at: Date;
}

// ============================================================================
// PROPOSAL TYPES
// ============================================================================

export interface ImpactRange {
  min: number;
  expected: number;
  max: number;
  unit: 'percent' | 'usd' | 'impressions' | 'conversions';
  assumptions: string[];
}

export interface EvidencePack {
  // Reason codes for why this proposal was generated
  reason_codes: string[]; // e.g., ['A1', 'B2', 'C3']
  reason_descriptions: string[];

  // Metrics windows
  metrics_7d: AggregatedMetrics;
  metrics_14d: AggregatedMetrics;
  metrics_30d: AggregatedMetrics;

  // Staleness indicators
  data_freshness_hours: number;
  oldest_data_date: string;
  newest_data_date: string;

  // Coverage and confidence
  coverage_score: number; // 0-100: how complete is the data
  confidence_score: number; // 0-100: how confident are we in this proposal
  confidence_factors: string[];

  // Budget-specific evidence (for budget proposals)
  budget_limited_signals?: {
    lost_impression_share_budget_pct?: number;
    spend_hitting_cap_days: number;
    avg_budget_utilization_pct: number;
  };

  // Counterfactual impact as RANGES (never single numbers)
  projected_impressions?: ImpactRange;
  projected_revenue?: ImpactRange;
  projected_profit?: ImpactRange;

  // Downside scenario
  downside_scenario: {
    description: string;
    probability: 'low' | 'medium' | 'high';
    max_loss_usd: number;
  };

  // Stop-loss condition
  stop_loss_condition: {
    metric: string;
    threshold: number;
    action: string;
  };

  // Measurement integrity fields (optional, added by measurement-integrity service)
  lag_adjusted_roas?: number;
  measurement_confidence?: number;
  evidence_score?: number;
  measurement_warnings?: string[];

  // Governance doctrine fields (required for all proposals)
  reversibility?: {
    level: 'full' | 'slow' | 'irreversible';
    description: string;
    max_autopilot_allowed: boolean;
    required_approval_level: 'none' | 'standard' | 'elevated';
  };
  rollback_plan?: {
    can_rollback: boolean;
    rollback_steps: string[];
    estimated_rollback_time: string;
    potential_rollback_cost: string;
    rollback_triggers: string[];
  };
  inaction_justification?: {
    why_action_safer_than_inaction: string;
    evidence_for_safety: string[];
    downside_of_inaction: string;
    confidence_in_safety: number;
  };
}

export interface Proposal {
  id: string;
  type: ProposalType;
  status: ProposalStatus;

  campaign_id: string;
  campaign_name: string;

  // What is being proposed
  current_value: number | string;
  proposed_value: number | string;
  change_pct?: number;

  // Evidence and reasoning
  evidence: EvidencePack;

  // Execution details
  requires_approval: boolean;
  auto_execute_after?: Date; // For autopilot actions

  // Experiment tracking (for EXPLORE mode)
  experiment_id?: string;
  experiment_max_spend?: number;
  experiment_start_date?: string;
  experiment_end_date?: string;

  // Timestamps
  created_at: Date;
  expires_at: Date;

  // Approval tracking
  approved_by?: string;
  approved_at?: Date;
  approved_value?: number | string; // May differ from proposed_value
  rejection_reason?: string;
  rejected_by?: string;
  rejected_at?: Date;

  // Execution tracking
  executed_at?: Date;
  execution_result?: ExecutionResult;
}

export interface ExecutionResult {
  success: boolean;
  api_operation_id?: string;
  before_value: number | string;
  after_value: number | string;
  error_message?: string;
  error_code?: string;
  conditions_at_execution: {
    kill_switch_off: boolean;
    policy_still_allows: boolean;
    cooldown_respected: boolean;
    roas_acceptable: boolean;
  };
}

// ============================================================================
// AUDIT TYPES
// ============================================================================

export interface AuditEvent {
  id: string;
  event_type: AuditEventType;

  // What was affected
  entity_type: 'proposal' | 'policy' | 'campaign' | 'system' | 'ops_signal';
  entity_id?: string;

  // Who did it
  actor: string; // 'system', 'scheduler', or user ID

  // What happened
  action: string;
  details: Record<string, unknown>;

  // Before/after for changes
  before_state?: Record<string, unknown>;
  after_state?: Record<string, unknown>;

  // API tracking
  api_request_id?: string;
  api_response_id?: string;

  // Timestamp
  timestamp: Date;

  // Hash chain for immutability verification
  hash: string;
  prev_hash: string;
}

// ============================================================================
// SYSTEM STATE
// ============================================================================

export interface SystemState {
  kill_switch_enabled: boolean;
  kill_switch_enabled_at?: Date;
  kill_switch_enabled_by?: string;
  kill_switch_reason?: string;

  safety_stop_active: boolean;
  safety_stop_reason?: string;
  safety_stop_triggered_at?: Date;

  last_observer_run?: Date;
  last_policy_evaluation?: Date;
  last_executor_run?: Date;

  current_policy_version: number;
}

// ============================================================================
// API TYPES
// ============================================================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  meta?: {
    timestamp: string;
    request_id: string;
  };
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  pagination?: {
    total: number;
    page: number;
    per_page: number;
    has_more: boolean;
  };
}

// ============================================================================
// NOTIFICATION TYPES
// ============================================================================

export interface Notification {
  type: 'budget_change' | 'policy_change' | 'safety_stop' | 'proposal_pending' | 'execution_result' | 'daily_summary';
  subject: string;
  body: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  channels: ('email' | 'slack' | 'sms')[];
  metadata?: Record<string, unknown>;
}
