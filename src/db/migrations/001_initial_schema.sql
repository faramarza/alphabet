-- Migration: 001_initial_schema
-- Alphabet Trains Google Ads Co-Pilot Database Schema
-- All tables support the safety-constrained agentic architecture

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- POLICIES (Versioned)
-- ============================================================================
CREATE TABLE policies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    version INTEGER NOT NULL,
    config JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by VARCHAR(255) NOT NULL,
    reason TEXT NOT NULL,
    is_current BOOLEAN NOT NULL DEFAULT FALSE,

    CONSTRAINT policies_version_unique UNIQUE (version)
);

CREATE INDEX idx_policies_is_current ON policies(is_current) WHERE is_current = TRUE;
CREATE INDEX idx_policies_created_at ON policies(created_at DESC);

-- ============================================================================
-- POLICY OVERRIDES
-- ============================================================================
CREATE TABLE policy_overrides (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    policy_id UUID REFERENCES policies(id),
    override_type VARCHAR(50) NOT NULL,
    target_campaign_id VARCHAR(255),
    override_config JSONB NOT NULL DEFAULT '{}',
    reason TEXT NOT NULL,
    created_by VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    CONSTRAINT valid_override_type CHECK (
        override_type IN ('raise_cap', 'lock_campaign', 'disable_autopilot', 'custom')
    )
);

CREATE INDEX idx_policy_overrides_active ON policy_overrides(is_active, expires_at);
CREATE INDEX idx_policy_overrides_campaign ON policy_overrides(target_campaign_id) WHERE target_campaign_id IS NOT NULL;

-- ============================================================================
-- CAMPAIGN SETTINGS
-- ============================================================================
CREATE TABLE campaign_settings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    campaign_id VARCHAR(255) NOT NULL UNIQUE,
    campaign_name VARCHAR(500) NOT NULL,
    mode VARCHAR(20) NOT NULL DEFAULT 'EXPLOIT',
    is_locked BOOLEAN NOT NULL DEFAULT FALSE,
    lock_reason TEXT,
    locked_by VARCHAR(255),
    locked_at TIMESTAMPTZ,
    last_budget_change_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_campaign_mode CHECK (mode IN ('EXPLOIT', 'EXPLORE'))
);

CREATE INDEX idx_campaign_settings_campaign_id ON campaign_settings(campaign_id);
CREATE INDEX idx_campaign_settings_mode ON campaign_settings(mode);

-- ============================================================================
-- OPS SIGNALS (Merchandising/Operations inputs)
-- ============================================================================
CREATE TABLE ops_signals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    campaign_id VARCHAR(255),
    product_id VARCHAR(255),

    fulfillment_risk VARCHAR(20) NOT NULL DEFAULT 'low',
    lead_time_days INTEGER NOT NULL DEFAULT 3,
    inventory_risk VARCHAR(20) NOT NULL DEFAULT 'low',

    is_promo_period BOOLEAN NOT NULL DEFAULT FALSE,
    promo_start_date DATE,
    promo_end_date DATE,

    creative_fatigue_flag BOOLEAN NOT NULL DEFAULT FALSE,

    notes TEXT,

    updated_by VARCHAR(255) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_fulfillment_risk CHECK (fulfillment_risk IN ('low', 'medium', 'high')),
    CONSTRAINT valid_inventory_risk CHECK (inventory_risk IN ('low', 'medium', 'high'))
);

CREATE INDEX idx_ops_signals_campaign ON ops_signals(campaign_id);
CREATE INDEX idx_ops_signals_product ON ops_signals(product_id) WHERE product_id IS NOT NULL;
CREATE INDEX idx_ops_signals_fulfillment_risk ON ops_signals(fulfillment_risk) WHERE fulfillment_risk != 'low';

-- ============================================================================
-- METRICS SNAPSHOTS
-- ============================================================================
CREATE TABLE snapshots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    campaign_id VARCHAR(255) NOT NULL,
    asset_group_id VARCHAR(255),
    snapshot_date DATE NOT NULL,
    snapshot_hour INTEGER,

    -- Core metrics
    cost_micros BIGINT NOT NULL DEFAULT 0,
    conversions NUMERIC(12, 4) NOT NULL DEFAULT 0,
    conversion_value_micros BIGINT NOT NULL DEFAULT 0,
    impressions BIGINT NOT NULL DEFAULT 0,
    clicks BIGINT NOT NULL DEFAULT 0,

    -- Computed metrics
    roas NUMERIC(10, 4),
    cpa_micros BIGINT,
    ctr NUMERIC(10, 6),

    -- Budget info
    budget_amount_micros BIGINT,
    budget_utilization_pct NUMERIC(5, 2),

    -- Data quality
    data_freshness_hours INTEGER NOT NULL DEFAULT 0,
    is_complete BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT snapshots_unique_daily UNIQUE (campaign_id, snapshot_date, asset_group_id)
        WHERE snapshot_hour IS NULL,
    CONSTRAINT snapshots_unique_hourly UNIQUE (campaign_id, snapshot_date, snapshot_hour, asset_group_id)
        WHERE snapshot_hour IS NOT NULL,
    CONSTRAINT valid_snapshot_hour CHECK (snapshot_hour IS NULL OR (snapshot_hour >= 0 AND snapshot_hour <= 23))
);

CREATE INDEX idx_snapshots_campaign_date ON snapshots(campaign_id, snapshot_date DESC);
CREATE INDEX idx_snapshots_date ON snapshots(snapshot_date DESC);
CREATE INDEX idx_snapshots_campaign_range ON snapshots(campaign_id, snapshot_date)
    WHERE snapshot_hour IS NULL;

-- ============================================================================
-- PROPOSALS
-- ============================================================================
CREATE TABLE proposals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',

    campaign_id VARCHAR(255) NOT NULL,
    campaign_name VARCHAR(500) NOT NULL,

    -- What is being proposed
    current_value TEXT NOT NULL,
    proposed_value TEXT NOT NULL,
    change_pct NUMERIC(10, 4),

    -- Evidence (JSONB for flexibility, but key fields also indexed)
    evidence JSONB NOT NULL,

    -- Execution control
    requires_approval BOOLEAN NOT NULL DEFAULT TRUE,
    auto_execute_after TIMESTAMPTZ,

    -- Experiment tracking
    experiment_id UUID,
    experiment_max_spend NUMERIC(10, 2),
    experiment_start_date DATE,
    experiment_end_date DATE,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,

    -- Approval tracking
    approved_by VARCHAR(255),
    approved_at TIMESTAMPTZ,
    approved_value TEXT,
    rejection_reason TEXT,
    rejected_by VARCHAR(255),
    rejected_at TIMESTAMPTZ,

    -- Execution tracking
    executed_at TIMESTAMPTZ,
    execution_result JSONB,

    CONSTRAINT valid_proposal_type CHECK (
        type IN ('budget_increase', 'budget_decrease', 'product_exclusion', 'asset_replacement')
    ),
    CONSTRAINT valid_proposal_status CHECK (
        status IN ('pending', 'approved', 'rejected', 'executed', 'expired', 'cancelled')
    )
);

CREATE INDEX idx_proposals_status ON proposals(status);
CREATE INDEX idx_proposals_campaign ON proposals(campaign_id);
CREATE INDEX idx_proposals_created_at ON proposals(created_at DESC);
CREATE INDEX idx_proposals_pending ON proposals(created_at DESC) WHERE status = 'pending';
CREATE INDEX idx_proposals_approved ON proposals(approved_at DESC) WHERE status = 'approved';

-- Partial index for evidence confidence score
CREATE INDEX idx_proposals_confidence ON proposals(((evidence->>'confidence_score')::numeric) DESC)
    WHERE status = 'pending';

-- ============================================================================
-- AUDIT EVENTS (Append-only with hash chain)
-- ============================================================================
CREATE TABLE audit_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_type VARCHAR(50) NOT NULL,

    -- What was affected
    entity_type VARCHAR(50) NOT NULL,
    entity_id VARCHAR(255),

    -- Who did it
    actor VARCHAR(255) NOT NULL,

    -- What happened
    action TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}',

    -- Before/after states
    before_state JSONB,
    after_state JSONB,

    -- API tracking
    api_request_id VARCHAR(255),
    api_response_id VARCHAR(255),

    -- Timestamp
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Hash chain for immutability verification
    hash VARCHAR(64) NOT NULL,
    prev_hash VARCHAR(64) NOT NULL,

    CONSTRAINT valid_entity_type CHECK (
        entity_type IN ('proposal', 'policy', 'campaign', 'system', 'ops_signal')
    )
);

-- Audit events are append-only, so primarily index for reads
CREATE INDEX idx_audit_events_timestamp ON audit_events(timestamp DESC);
CREATE INDEX idx_audit_events_entity ON audit_events(entity_type, entity_id);
CREATE INDEX idx_audit_events_actor ON audit_events(actor);
CREATE INDEX idx_audit_events_type ON audit_events(event_type);

-- Prevent updates/deletes on audit_events (immutability)
CREATE OR REPLACE FUNCTION prevent_audit_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Audit events are immutable and cannot be modified or deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_immutable_update
    BEFORE UPDATE ON audit_events
    FOR EACH ROW
    EXECUTE FUNCTION prevent_audit_modification();

CREATE TRIGGER audit_events_immutable_delete
    BEFORE DELETE ON audit_events
    FOR EACH ROW
    EXECUTE FUNCTION prevent_audit_modification();

-- ============================================================================
-- SYSTEM STATE
-- ============================================================================
CREATE TABLE system_state (
    id INTEGER PRIMARY KEY DEFAULT 1,

    kill_switch_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    kill_switch_enabled_at TIMESTAMPTZ,
    kill_switch_enabled_by VARCHAR(255),
    kill_switch_reason TEXT,

    safety_stop_active BOOLEAN NOT NULL DEFAULT FALSE,
    safety_stop_reason TEXT,
    safety_stop_triggered_at TIMESTAMPTZ,

    last_observer_run TIMESTAMPTZ,
    last_policy_evaluation TIMESTAMPTZ,
    last_executor_run TIMESTAMPTZ,

    current_policy_version INTEGER NOT NULL DEFAULT 0,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Ensure only one row exists
    CONSTRAINT system_state_singleton CHECK (id = 1)
);

-- Insert singleton row
INSERT INTO system_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Function to compute SHA-256 hash for audit chain
CREATE OR REPLACE FUNCTION compute_audit_hash(
    p_event_type VARCHAR,
    p_entity_type VARCHAR,
    p_entity_id VARCHAR,
    p_actor VARCHAR,
    p_action TEXT,
    p_details JSONB,
    p_timestamp TIMESTAMPTZ,
    p_prev_hash VARCHAR
) RETURNS VARCHAR AS $$
DECLARE
    hash_input TEXT;
BEGIN
    hash_input := COALESCE(p_event_type, '') || '|' ||
                  COALESCE(p_entity_type, '') || '|' ||
                  COALESCE(p_entity_id, '') || '|' ||
                  COALESCE(p_actor, '') || '|' ||
                  COALESCE(p_action, '') || '|' ||
                  COALESCE(p_details::TEXT, '{}') || '|' ||
                  COALESCE(p_timestamp::TEXT, '') || '|' ||
                  COALESCE(p_prev_hash, '');
    RETURN encode(sha256(hash_input::bytea), 'hex');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Function to get the latest audit hash (for chain continuation)
CREATE OR REPLACE FUNCTION get_latest_audit_hash() RETURNS VARCHAR AS $$
DECLARE
    latest_hash VARCHAR;
BEGIN
    SELECT hash INTO latest_hash
    FROM audit_events
    ORDER BY timestamp DESC, id DESC
    LIMIT 1;

    -- Genesis hash if no events exist
    RETURN COALESCE(latest_hash, '0000000000000000000000000000000000000000000000000000000000000000');
END;
$$ LANGUAGE plpgsql;

-- Function to update campaign settings timestamp
CREATE OR REPLACE FUNCTION update_campaign_settings_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER campaign_settings_updated_at
    BEFORE UPDATE ON campaign_settings
    FOR EACH ROW
    EXECUTE FUNCTION update_campaign_settings_timestamp();

-- ============================================================================
-- VIEWS
-- ============================================================================

-- View for active proposals requiring attention
CREATE VIEW pending_proposals AS
SELECT
    p.*,
    (p.evidence->>'confidence_score')::numeric as confidence_score,
    (p.evidence->>'coverage_score')::numeric as coverage_score,
    cs.mode as campaign_mode,
    cs.is_locked as campaign_is_locked
FROM proposals p
LEFT JOIN campaign_settings cs ON p.campaign_id = cs.campaign_id
WHERE p.status = 'pending'
  AND p.expires_at > NOW()
ORDER BY p.created_at DESC;

-- View for recent audit activity
CREATE VIEW recent_audit AS
SELECT *
FROM audit_events
ORDER BY timestamp DESC
LIMIT 100;

-- Materialized view for campaign aggregated metrics (refresh periodically)
CREATE MATERIALIZED VIEW campaign_metrics_7d AS
SELECT
    campaign_id,
    SUM(cost_micros) as total_cost_micros,
    SUM(conversions) as total_conversions,
    SUM(conversion_value_micros) as total_conversion_value_micros,
    SUM(impressions) as total_impressions,
    SUM(clicks) as total_clicks,
    CASE
        WHEN SUM(cost_micros) > 0
        THEN SUM(conversion_value_micros)::numeric / SUM(cost_micros)::numeric
        ELSE 0
    END as roas,
    COUNT(*) as days_with_data,
    MIN(snapshot_date) as start_date,
    MAX(snapshot_date) as end_date
FROM snapshots
WHERE snapshot_date >= CURRENT_DATE - INTERVAL '7 days'
  AND snapshot_hour IS NULL
GROUP BY campaign_id;

CREATE UNIQUE INDEX idx_campaign_metrics_7d ON campaign_metrics_7d(campaign_id);

-- Comment on schema
COMMENT ON TABLE policies IS 'Versioned policy configurations with guardrails';
COMMENT ON TABLE policy_overrides IS 'Temporary overrides to policy settings';
COMMENT ON TABLE campaign_settings IS 'Per-campaign mode (EXPLOIT/EXPLORE) and locks';
COMMENT ON TABLE ops_signals IS 'Operational signals: fulfillment risk, inventory, promos';
COMMENT ON TABLE snapshots IS 'Daily/hourly metrics snapshots from Google Ads';
COMMENT ON TABLE proposals IS 'Change proposals with evidence packs';
COMMENT ON TABLE audit_events IS 'Immutable append-only audit log with hash chain';
COMMENT ON TABLE system_state IS 'System-wide state including kill switch';
