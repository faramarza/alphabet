# Google Ads API - Application Design Document

## Application Name
Alphabet Trains - Google Ads Co-Pilot

## Company/Organization
Alphabet Trains (Internal Tool)

## Application Type
Internal business tool for managing Google Ads campaigns

---

## 1. Application Overview

### Purpose
An internal safety-constrained management tool for monitoring and optimizing Google Ads Performance Max (PMax) campaigns for our e-commerce retail business.

### Users
- Internal marketing team members only
- Password-protected access
- Not available to external users or third parties

### Deployment
- Self-hosted on company infrastructure
- Single-tenant deployment for internal use only

---

## 2. Google Ads API Usage

### Features Used

| API Feature | Purpose |
|-------------|---------|
| `GoogleAdsService.Search` | Retrieve campaign data and performance metrics |
| `GoogleAdsService.SearchStream` | Stream campaign reports for dashboard display |
| `CampaignBudgetService` | View and adjust campaign budgets |
| `CampaignService` | Read campaign settings and status |

### Operations Performed

1. **Read Operations (Primary)**
   - List active campaigns
   - Fetch campaign performance metrics (impressions, clicks, conversions, cost, ROAS)
   - Retrieve budget information
   - Monitor campaign status

2. **Write Operations (Limited)**
   - Adjust campaign daily budgets within predefined safety limits
   - All changes require human approval before execution
   - Hard spending caps enforced at application level

### API Call Volume (Estimated)
- Dashboard refresh: ~10 API calls per page load
- Automated monitoring: ~100 calls per day
- Total estimated: < 500 calls per day (well under Basic Access limit of 15,000/day)

---

## 3. Safety Controls

### Spending Safeguards
The application enforces strict financial controls:

| Control | Value | Description |
|---------|-------|-------------|
| Break-even ROAS | 4.0x | Minimum acceptable return |
| Target ROAS | 5.0x | Optimal target return |
| Max Daily Spend | $100 | Per-campaign daily limit |
| Hard Spending Cap | $300 | Absolute maximum daily spend |
| Kill Switch | Available | Instantly pause all automated actions |

### Human-in-the-Loop
- All budget changes generate proposals
- Proposals require explicit human approval
- Full audit log of all actions
- No fully autonomous spending decisions

---

## 4. Data Handling

### Data Accessed
- Campaign names and IDs
- Performance metrics (aggregated, non-PII)
- Budget amounts
- Campaign status

### Data Storage
- Metrics cached locally for dashboard display
- Audit logs retained for compliance
- No personal user data from Google Ads is stored
- No customer lists or audience data accessed

### Data Security
- HTTPS encryption in transit
- Database encryption at rest
- Access restricted to authenticated internal users
- No data shared with third parties

---

## 5. Technical Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Web Browser   │────▶│  Node.js API    │────▶│  Google Ads     │
│   (Internal)    │◀────│  Server         │◀────│  API            │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌─────────────────┐
                        │  PostgreSQL     │
                        │  (Audit Logs)   │
                        └─────────────────┘
```

### Technology Stack
- Backend: Node.js with TypeScript
- Database: PostgreSQL
- API Client: google-ads-api npm library (v23)
- Authentication: OAuth 2.0 with refresh tokens

---

## 6. Compliance

### Terms of Service
- Application complies with Google Ads API Terms of Service
- No automated bidding without human oversight
- No scraping or data harvesting
- Single Google Ads account access (our own)

### Access Scope
- Accessing only our own Google Ads account
- Not a multi-tenant or agency tool
- Not reselling or redistributing data

---

## 7. Screenshots

### Dashboard View
The application displays campaign performance metrics in a table format showing:
- Campaign name and status
- Spend, clicks, impressions
- ROAS and conversion metrics
- Budget utilization

### Safety Controls Panel
Administrators can configure:
- ROAS thresholds
- Spending limits
- Enable/disable automation
- Emergency kill switch

---

## 8. Contact Information

**Developer Contact:** [Your Email]
**Company:** Alphabet Trains
**Website:** https://copilot.alphabet-trains.com (internal access only)

---

## Summary

This is an internal tool for a single business to manage their own Google Ads campaigns with strict safety controls. We are not building a tool for external customers or agencies. The primary use case is monitoring campaign performance and making controlled budget adjustments with human approval.
