# Alphabet Trains - Google Ads Co-Pilot

A production-grade, **safety-constrained agentic system** for managing Google Ads PMax campaigns. This is a governed co-pilot, NOT an autonomous trader.

**By default: Suggest + require approval. Autopilot is allowed only for low-risk actions explicitly enabled in policy.**

## Table of Contents

- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Running the System](#running-the-system)
- [API Endpoints](#api-endpoints)
- [Approving Proposals](#approving-proposals)
- [Guardrails & Safety](#guardrails--safety)
- [Evidence Packs](#evidence-packs)
- [Policy Management](#policy-management)
- [Audit Trail](#audit-trail)
- [Notifications](#notifications)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Control Plane API                           │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │ Policies │ │Proposals │ │  Audit   │ │ System   │ │Snapshots │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                  │
┌─────────────────────────────────────────────────────────────────────┐
│                            Worker Jobs                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐               │
│  │ Observer │ │ Policy   │ │ Executor │ │  Safety  │               │
│  │ (hourly) │ │Evaluator │ │(15 min)  │ │  Check   │               │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘               │
└─────────────────────────────────────────────────────────────────────┘
                                  │
┌─────────────────────────────────────────────────────────────────────┐
│                            Services                                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │  Policy  │ │ Proposal │ │ Executor │ │ Notifier │ │  Audit   │  │
│  │  Engine  │ │Generator │ │          │ │          │ │  Logger  │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                  │
┌─────────────────────────────────────────────────────────────────────┐
│                           Adapters                                  │
│  ┌──────────────────────┐ ┌──────────────────────┐                 │
│  │    Google Ads API    │ │  Merchant Center     │                 │
│  │   (or stub mode)     │ │   (stub available)   │                 │
│  └──────────────────────┘ └──────────────────────┘                 │
└─────────────────────────────────────────────────────────────────────┘
                                  │
┌─────────────────────────────────────────────────────────────────────┐
│                         PostgreSQL Database                         │
│  policies │ proposals │ snapshots │ audit_events │ system_state    │
└─────────────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Prerequisites

- Node.js 18+
- PostgreSQL 14+
- Google Ads API credentials (optional - stub mode available)

### 2. Installation

```bash
# Clone and install dependencies
cd alphabet
npm install

# Copy environment template
cp .env.example .env
# Edit .env with your configuration
```

### 3. Database Setup

```bash
# Run migrations
npm run migrate

# Seed initial data (creates default policy)
npm run seed
```

### 4. Start the System

```bash
# Terminal 1: Start API server
npm run api

# Terminal 2: Start worker (jobs)
npm run worker
```

### 5. Access the UI

Open http://localhost:3000/ui in your browser.

## Configuration

### Environment Variables

```bash
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/alphabet_trains

# Google Ads API (leave empty for stub mode)
GOOGLE_ADS_DEVELOPER_TOKEN=your_developer_token
GOOGLE_ADS_CLIENT_ID=your_client_id
GOOGLE_ADS_CLIENT_SECRET=your_client_secret
GOOGLE_ADS_REFRESH_TOKEN=your_refresh_token
GOOGLE_ADS_CUSTOMER_ID=your_customer_id

# Authentication
JWT_SECRET=your_jwt_secret_minimum_32_characters
ADMIN_TOKEN=your_admin_token_for_api_access

# Email Notifications (required for production)
SMTP_HOST=smtp.example.com
SMTP_USER=notifications@example.com
SMTP_PASS=your_smtp_password
NOTIFICATION_FROM=noreply@alphabettrains.com
NOTIFICATION_TO=admin@alphabettrains.com

# Slack (optional)
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx/yyy/zzz
```

### Stub Mode

If Google Ads API credentials are not provided, the system runs in **stub mode** with mock campaign data. This is useful for development and testing.

## Running the System

### Development Mode

```bash
# API with hot reload
npm run dev

# Or run API and worker separately
npm run api    # API server only
npm run worker # Worker jobs only
```

### Production Mode

```bash
# Build TypeScript
npm run build

# Start
npm start  # Starts API server
# In separate process:
node dist/worker.js
```

## API Endpoints

### Health Check (No Auth)

```bash
GET /health
```

### Policies

```bash
# Get current policy
GET /api/policies/current

# List all policy versions
GET /api/policies

# Create new policy version
POST /api/policies
Content-Type: application/json
Authorization: Admin YOUR_TOKEN

{
  "config": { ... },
  "reason": "Updated target ROAS"
}

# Create policy override
POST /api/policies/override
```

### Proposals

```bash
# List proposals
GET /api/proposals?status=pending

# Get proposal details
GET /api/proposals/:id

# Approve proposal
POST /api/proposals/:id/approve
{
  "modified_value": "75.00"  # Optional: approve with different value
}

# Reject proposal
POST /api/proposals/:id/reject
{
  "reason": "ROAS too low for scaling"
}
```

### System Operations

```bash
# Enable kill switch (freezes all writes)
POST /api/system/killswitch/enable
{
  "reason": "Investigating conversion tracking issue"
}

# Disable kill switch
POST /api/system/killswitch/disable

# Clear safety stop
POST /api/system/safety-stop/clear
```

### Audit Log

```bash
# Query audit events
GET /api/audit?entity_type=proposal&limit=50

# Verify audit chain integrity
GET /api/audit/verify
```

### Snapshots

```bash
# Get campaign metrics
GET /api/snapshots/metrics?campaign_id=123

# List campaigns
GET /api/snapshots/campaigns
```

## Approving Proposals

### Via Web UI

1. Open http://localhost:3000/ui
2. Enter your admin token
3. Review pending proposals in the "Proposals" tab
4. Click "Approve", "Modify & Approve", or "Reject"

### Via CLI (curl)

```bash
# List pending proposals
curl -H "Authorization: Admin YOUR_TOKEN" \
  http://localhost:3000/api/proposals?status=pending

# Approve a proposal
curl -X POST \
  -H "Authorization: Admin YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  http://localhost:3000/api/proposals/PROPOSAL_ID/approve

# Approve with modification
curl -X POST \
  -H "Authorization: Admin YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"modified_value": "75.00"}' \
  http://localhost:3000/api/proposals/PROPOSAL_ID/approve

# Reject with reason
curl -X POST \
  -H "Authorization: Admin YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "ROAS trending down"}' \
  http://localhost:3000/api/proposals/PROPOSAL_ID/reject
```

## Guardrails & Safety

### Hard Profit Rails (Non-Negotiable)

| Guardrail | Default | Description |
|-----------|---------|-------------|
| `break_even_roas` | 4.0 | Minimum acceptable ROAS |
| `target_roas` | 5.0 | Target ROAS for scaling |
| `hard_limit` | $300 | Absolute maximum daily budget |
| `max_step_budget_increase_pct` | 10% | Max single budget increase |
| `max_step_budget_decrease_pct` | 20% | Max single budget decrease |
| `cooldown_days_budget_changes` | 7 days | Time between budget changes |
| `max_weekly_loss_usd` | $500 | Weekly loss limit |

### Safety Stops

The system automatically triggers a safety stop (freezes all writes) when:

- **ROAS drops** > 30% below break-even
- **Conversion tracking suspected broken** (spending with zero conversions)
- **Repeated API errors**
- **Budget would exceed hard_limit**

### Kill Switch

Emergency manual freeze available via:
- UI button
- API: `POST /api/system/killswitch/enable`

When enabled, **all write operations are blocked** until manually disabled.

### Ops Signals

The system respects operational signals:

- `fulfillment_risk: high` → Blocks scaling
- `lead_time_days > 5` → Blocks scaling
- `inventory_risk: high` → Blocks scaling

## Evidence Packs

Every proposal includes a detailed evidence pack with:

### Reason Codes

| Code | Description |
|------|-------------|
| A1 | ROAS consistently above target across all windows |
| A2 | Budget utilization at cap |
| A3 | Significant impression share lost to budget |
| B1 | ROAS below break-even |
| B2 | ROAS declining trend |
| C1 | Cooldown period not passed |

### Metrics Windows

- 7-day aggregated metrics
- 14-day aggregated metrics
- 30-day aggregated metrics

### Impact Projections (RANGES, NOT GUARANTEES)

```json
{
  "projected_profit": {
    "min": 50,
    "expected": 120,
    "max": 200,
    "unit": "usd",
    "assumptions": [
      "Assumes similar market conditions",
      "Based on historical 7-day performance",
      "Actual results may vary significantly"
    ]
  }
}
```

### Downside Scenario

```json
{
  "downside_scenario": {
    "description": "If ROAS drops to break-even...",
    "probability": "low",
    "max_loss_usd": 75.50
  },
  "stop_loss_condition": {
    "metric": "roas_7d",
    "threshold": 4.0,
    "action": "Automatic budget decrease"
  }
}
```

## Policy Management

### Creating a New Policy Version

```bash
curl -X POST \
  -H "Authorization: Admin YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "config": {
      "break_even_roas": 4.0,
      "target_roas": 5.5,
      "max_daily_spend_cap": 150,
      "hard_limit": 400,
      "max_step_budget_increase_pct": 10,
      "max_step_budget_decrease_pct": 20,
      "cooldown_days_budget_changes": 7,
      "max_weekly_loss_usd": 600,
      "roas_drop_safety_threshold_pct": 30,
      "min_conversions_for_confidence": 10,
      "min_data_days_for_proposal": 7,
      "max_lead_time_days_for_scaling": 5,
      "block_scaling_on_high_fulfillment_risk": true,
      "autopilot_enabled": false,
      "autopilot_actions": [],
      "autopilot_max_budget_change_usd": 10
    },
    "reason": "Increased target ROAS and hard limit for Q4"
  }' \
  http://localhost:3000/api/policies
```

### Policy Overrides

Temporary overrides without creating a new policy version:

```bash
# Temporarily raise cap for a specific campaign
curl -X POST \
  -H "Authorization: Admin YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "override_type": "raise_cap",
    "target_campaign_id": "campaign_123",
    "override_config": {"max_daily_spend_cap": 200},
    "reason": "Holiday promotion",
    "expires_at": "2024-12-31T23:59:59Z"
  }' \
  http://localhost:3000/api/policies/override
```

## Audit Trail

All actions are logged to an **append-only, hash-chained audit table**:

- Snapshot pulls
- Proposal creation/approval/rejection
- Executions (with before/after diffs)
- Policy changes
- Kill switch toggles
- Safety stops

### Verify Audit Integrity

```bash
curl -H "Authorization: Admin YOUR_TOKEN" \
  http://localhost:3000/api/audit/verify
```

Response:
```json
{
  "success": true,
  "data": {
    "valid": true,
    "total_events": 1523,
    "verified_events": 1523
  }
}
```

## Notifications

The system sends notifications for:

| Event | Channels | Priority |
|-------|----------|----------|
| Budget change executed | Email + Slack | High |
| Policy changed | Email + Slack | Urgent |
| Kill switch toggled | Email + Slack | Urgent |
| Safety stop triggered | Email + Slack | Urgent |
| Proposal pending | Email | Normal |
| Daily summary | Email | Low |

## Modes of Operation

### EXPLOIT Mode (Default)

- Conservative approach
- Small budget increments only
- No structural changes
- Suitable for proven campaigns

### EXPLORE Mode

- Limited spend experiments
- Requires explicit hypothesis
- Has dedicated experiment budget cap
- Tracks outcomes for post-mortem

Set mode via API:
```bash
# Future implementation
POST /api/campaigns/:id/mode
{"mode": "EXPLORE", "experiment_budget": 50}
```

## Development

### Project Structure

```
src/
├── adapters/           # External API adapters
│   ├── google-ads.ts
│   └── merchant-center.ts
├── api/
│   ├── middleware/     # Auth, logging
│   ├── routes/         # API endpoints
│   └── server.ts
├── config/             # Configuration
├── db/
│   ├── client.ts       # Database connection
│   ├── migrations/     # SQL migrations
│   └── seed.ts
├── jobs/               # Scheduled jobs
│   ├── observer.ts
│   └── policy-evaluator.ts
├── services/           # Business logic
│   ├── audit.ts
│   ├── executor.ts
│   ├── notifier.ts
│   ├── policy.ts
│   ├── proposals.ts
│   ├── snapshots.ts
│   └── system-state.ts
├── types/              # TypeScript types
├── index.ts            # Main entry
└── worker.ts           # Worker process
```

### Running Tests

```bash
npm test
```

### Type Checking

```bash
npm run typecheck
```

## Security Considerations

1. **Authentication**: All API endpoints (except /health) require authentication
2. **Secrets**: Never commit secrets - use environment variables
3. **Audit Trail**: All actions are logged immutably
4. **Kill Switch**: Can freeze all writes instantly
5. **Hard Limits**: Cannot be bypassed by proposals

## License

Proprietary - Alphabet Trains
