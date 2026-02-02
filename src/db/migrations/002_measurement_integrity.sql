-- Migration: 002_measurement_integrity
-- Adds tables for measurement integrity, proposal quality, and audit checkpoints

-- ============================================================================
-- AUDIT CHECKPOINTS (for signed verification)
-- ============================================================================
CREATE TABLE audit_checkpoints (
    id UUID PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL,
    event_count INTEGER NOT NULL,
    first_event_id UUID NOT NULL REFERENCES audit_events(id),
    last_event_id UUID NOT NULL REFERENCES audit_events(id),
    last_event_hash VARCHAR(64) NOT NULL,
    checkpoint_hash VARCHAR(64) NOT NULL,
    signature VARCHAR(64)
);

CREATE INDEX idx_audit_checkpoints_created ON audit_checkpoints(created_at DESC);

-- ============================================================================
-- MEASUREMENT HEALTH LOG
-- ============================================================================
CREATE TABLE measurement_health_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    campaign_id VARCHAR(255),
    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    healthy BOOLEAN NOT NULL,
    confidence NUMERIC(5, 4) NOT NULL,
    can_propose BOOLEAN NOT NULL,
    issues JSONB NOT NULL DEFAULT '[]',
    recommendations JSONB NOT NULL DEFAULT '[]',
    lag_adjusted_window JSONB NOT NULL
);

CREATE INDEX idx_measurement_health_campaign ON measurement_health_log(campaign_id, checked_at DESC);
CREATE INDEX idx_measurement_health_issues ON measurement_health_log(checked_at DESC) WHERE NOT healthy;

-- ============================================================================
-- FEED CHANGE TRACKING
-- ============================================================================
CREATE TABLE feed_changes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    change_type VARCHAR(50) NOT NULL,
    affected_products INTEGER,
    details JSONB NOT NULL DEFAULT '{}',
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    freeze_until TIMESTAMPTZ NOT NULL,

    CONSTRAINT valid_change_type CHECK (
        change_type IN ('product_added', 'product_removed', 'price_change', 'availability_change', 'bulk_update')
    )
);

CREATE INDEX idx_feed_changes_freeze ON feed_changes(freeze_until DESC);

-- ============================================================================
-- PROPOSAL COOLDOWNS
-- ============================================================================
CREATE TABLE proposal_cooldowns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    campaign_id VARCHAR(255),
    cooldown_type VARCHAR(50) NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ends_at TIMESTAMPTZ NOT NULL,
    reason TEXT,

    CONSTRAINT valid_cooldown_type CHECK (
        cooldown_type IN ('campaign_proposal', 'budget_change', 'global')
    )
);

CREATE INDEX idx_proposal_cooldowns_active ON proposal_cooldowns(ends_at DESC);
CREATE INDEX idx_proposal_cooldowns_campaign ON proposal_cooldowns(campaign_id, ends_at DESC);

-- ============================================================================
-- UPDATE PROPOSALS TABLE
-- ============================================================================
-- Add columns for proposal quality tracking
ALTER TABLE proposals
    ADD COLUMN IF NOT EXISTS evidence_score NUMERIC(5, 4),
    ADD COLUMN IF NOT EXISTS lag_adjusted_roas NUMERIC(10, 4),
    ADD COLUMN IF NOT EXISTS measurement_confidence NUMERIC(5, 4),
    ADD COLUMN IF NOT EXISTS proposal_type VARCHAR(50);

-- ============================================================================
-- UPDATE ENTITY TYPE CONSTRAINT
-- ============================================================================
-- Drop and recreate constraint to add new entity types
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS valid_entity_type;
ALTER TABLE audit_events ADD CONSTRAINT valid_entity_type CHECK (
    entity_type IN ('proposal', 'policy', 'campaign', 'system', 'ops_signal', 'measurement', 'feed', 'checkpoint')
);

-- ============================================================================
-- VIEW FOR ACTIVE COOLDOWNS
-- ============================================================================
CREATE VIEW active_cooldowns AS
SELECT
    campaign_id,
    cooldown_type,
    ends_at,
    reason,
    EXTRACT(EPOCH FROM (ends_at - NOW())) / 3600 as hours_remaining
FROM proposal_cooldowns
WHERE ends_at > NOW()
ORDER BY ends_at;

-- Comment on new tables
COMMENT ON TABLE audit_checkpoints IS 'Periodic signed checkpoints for audit chain verification';
COMMENT ON TABLE measurement_health_log IS 'History of measurement integrity checks';
COMMENT ON TABLE feed_changes IS 'Tracking of product feed changes that freeze inference';
COMMENT ON TABLE proposal_cooldowns IS 'Cooldown periods between proposals';
