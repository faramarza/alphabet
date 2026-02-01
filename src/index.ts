/**
 * Alphabet Trains Google Ads Co-Pilot
 * Main entry point - starts both API server and worker
 *
 * This is a safety-constrained agentic system that:
 * - Monitors Google Ads + Merchant Center
 * - Generates evidence-backed proposals
 * - Executes ONLY within strict guardrails
 * - Requires approval for changes (unless autopilot is enabled for low-risk actions)
 *
 * CRITICAL: This is a governed co-pilot, NOT an autonomous trader.
 * By default: Suggest + require approval.
 */

import './api/server.js';

console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                                                                  ║
║   Alphabet Trains - Google Ads Co-Pilot                          ║
║   Safety-Constrained Agentic System                              ║
║                                                                  ║
║   This system operates under strict guardrails:                  ║
║   • Hard profit rails (break-even ROAS, target ROAS)             ║
║   • Budget limits and cooldown periods                           ║
║   • Evidence-backed proposals with ranges (no guarantees)        ║
║   • Required approvals for most actions                          ║
║   • Kill switch for emergency stops                              ║
║   • Immutable audit trail                                        ║
║                                                                  ║
║   Start the worker separately: npm run worker                    ║
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝
`);
