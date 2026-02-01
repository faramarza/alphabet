-- Down migration: 001_initial_schema
-- WARNING: This will drop all tables and data!

-- Drop views
DROP VIEW IF EXISTS recent_audit;
DROP VIEW IF EXISTS pending_proposals;
DROP MATERIALIZED VIEW IF EXISTS campaign_metrics_7d;

-- Drop triggers
DROP TRIGGER IF EXISTS audit_events_immutable_delete ON audit_events;
DROP TRIGGER IF EXISTS audit_events_immutable_update ON audit_events;
DROP TRIGGER IF EXISTS campaign_settings_updated_at ON campaign_settings;

-- Drop functions
DROP FUNCTION IF EXISTS prevent_audit_modification();
DROP FUNCTION IF EXISTS get_latest_audit_hash();
DROP FUNCTION IF EXISTS compute_audit_hash(VARCHAR, VARCHAR, VARCHAR, VARCHAR, TEXT, JSONB, TIMESTAMPTZ, VARCHAR);
DROP FUNCTION IF EXISTS update_campaign_settings_timestamp();

-- Drop tables (in dependency order)
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS proposals;
DROP TABLE IF EXISTS snapshots;
DROP TABLE IF EXISTS ops_signals;
DROP TABLE IF EXISTS campaign_settings;
DROP TABLE IF EXISTS policy_overrides;
DROP TABLE IF EXISTS policies;
DROP TABLE IF EXISTS system_state;
