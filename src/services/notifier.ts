/**
 * Notifier Service
 * Sends notifications via email (required) and optionally Slack/SMS
 * MUST notify on ANY budget change and ANY policy change
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { config } from '../config/index.js';
import type { Notification, ProposalType } from '../types/index.js';

// ============================================================================
// NOTIFICATION TYPES
// ============================================================================

export interface BudgetChangeNotification {
  campaign_id: string;
  campaign_name: string;
  proposal_id: string;
  proposal_type: ProposalType;
  previous_budget: string;
  new_budget: string;
  change_pct: number;
  approved_by: string;
  reason_codes: string[];
}

export interface PolicyChangeNotification {
  policy_version: number;
  changed_by: string;
  reason: string;
  key_changes: string[];
}

export interface SafetyStopNotification {
  reason: string;
  triggered_at: Date;
  affected_campaigns?: string[];
}

export interface ProposalPendingNotification {
  proposal_id: string;
  campaign_name: string;
  proposal_type: ProposalType;
  proposed_change: string;
  confidence_score: number;
  expires_at: Date;
}

export interface DailySummary {
  date: string;
  proposals_generated: number;
  proposals_executed: number;
  proposals_rejected: number;
  total_spend_change_usd: number;
  campaigns_modified: string[];
  safety_events: string[];
}

// ============================================================================
// NOTIFIER SERVICE
// ============================================================================

export class NotifierService {
  private static instance: NotifierService | null = null;
  private emailTransporter: Transporter | null = null;
  private notificationQueue: Notification[] = [];

  private constructor() {
    if (config.notifications.email.isConfigured) {
      this.emailTransporter = nodemailer.createTransport({
        host: config.notifications.email.host,
        port: config.notifications.email.port,
        secure: config.notifications.email.secure,
        auth: {
          user: config.notifications.email.user,
          pass: config.notifications.email.pass,
        },
      });
    }
  }

  static getInstance(): NotifierService {
    if (!NotifierService.instance) {
      NotifierService.instance = new NotifierService();
    }
    return NotifierService.instance;
  }

  /**
   * Send a budget change notification (REQUIRED for any budget change)
   */
  async sendBudgetChangeNotification(data: BudgetChangeNotification): Promise<void> {
    const direction = data.proposal_type === 'budget_increase' ? 'increased' : 'decreased';
    const subject = `[Alphabet Trains] Budget ${direction}: ${data.campaign_name}`;

    const body = `
Budget Change Notification
==========================

Campaign: ${data.campaign_name}
Campaign ID: ${data.campaign_id}
Proposal ID: ${data.proposal_id}

Change Details:
- Previous Budget: $${data.previous_budget}
- New Budget: $${data.new_budget}
- Change: ${data.change_pct > 0 ? '+' : ''}${data.change_pct.toFixed(1)}%

Approved By: ${data.approved_by}
Reason Codes: ${data.reason_codes.join(', ')}

---
This is an automated notification from the Alphabet Trains Google Ads Co-Pilot.
All budget changes are logged in the audit trail.
    `.trim();

    await this.send({
      type: 'budget_change',
      subject,
      body,
      priority: 'high',
      channels: ['email', 'slack'],
      metadata: data as unknown as Record<string, unknown>,
    });
  }

  /**
   * Send a policy change notification (REQUIRED for any policy change)
   */
  async sendPolicyChangeNotification(data: PolicyChangeNotification): Promise<void> {
    const subject = `[Alphabet Trains] Policy Updated: Version ${data.policy_version}`;

    const body = `
Policy Change Notification
==========================

New Version: ${data.policy_version}
Changed By: ${data.changed_by}
Reason: ${data.reason}

Key Changes:
${data.key_changes.map((c) => `- ${c}`).join('\n')}

---
This is an automated notification from the Alphabet Trains Google Ads Co-Pilot.
Policy changes are versioned and immutable once created.
    `.trim();

    await this.send({
      type: 'policy_change',
      subject,
      body,
      priority: 'urgent',
      channels: ['email', 'slack'],
      metadata: data as unknown as Record<string, unknown>,
    });
  }

  /**
   * Send a safety stop notification (URGENT)
   */
  async sendSafetyStopNotification(data: SafetyStopNotification): Promise<void> {
    const subject = `[URGENT] Alphabet Trains - Safety Stop Triggered`;

    const body = `
SAFETY STOP TRIGGERED
=====================

Reason: ${data.reason}
Triggered At: ${data.triggered_at.toISOString()}

All write operations have been suspended until this is manually resolved.

${data.affected_campaigns ? `Affected Campaigns:\n${data.affected_campaigns.map((c) => `- ${c}`).join('\n')}` : ''}

ACTION REQUIRED:
1. Investigate the cause of this safety stop
2. Verify conversion tracking is working
3. Check campaign performance metrics
4. Clear the safety stop via the API when resolved

---
This is an automated notification from the Alphabet Trains Google Ads Co-Pilot.
    `.trim();

    await this.send({
      type: 'safety_stop',
      subject,
      body,
      priority: 'urgent',
      channels: ['email', 'slack'],
      metadata: data as unknown as Record<string, unknown>,
    });
  }

  /**
   * Send a notification about a pending proposal
   */
  async sendProposalPendingNotification(data: ProposalPendingNotification): Promise<void> {
    const subject = `[Alphabet Trains] Proposal Pending Approval: ${data.campaign_name}`;

    const body = `
Proposal Pending Approval
=========================

Proposal ID: ${data.proposal_id}
Campaign: ${data.campaign_name}
Type: ${data.proposal_type}
Proposed Change: ${data.proposed_change}
Confidence Score: ${data.confidence_score}/100
Expires: ${data.expires_at.toISOString()}

Please review and approve/reject this proposal in the dashboard.

---
This is an automated notification from the Alphabet Trains Google Ads Co-Pilot.
    `.trim();

    await this.send({
      type: 'proposal_pending',
      subject,
      body,
      priority: 'normal',
      channels: ['email'],
      metadata: data as unknown as Record<string, unknown>,
    });
  }

  /**
   * Send daily summary
   */
  async sendDailySummary(data: DailySummary): Promise<void> {
    const subject = `[Alphabet Trains] Daily Summary: ${data.date}`;

    const body = `
Daily Summary for ${data.date}
==============================

Proposals:
- Generated: ${data.proposals_generated}
- Executed: ${data.proposals_executed}
- Rejected: ${data.proposals_rejected}

Total Spend Change: ${data.total_spend_change_usd >= 0 ? '+' : ''}$${data.total_spend_change_usd.toFixed(2)}

Campaigns Modified:
${data.campaigns_modified.length > 0 ? data.campaigns_modified.map((c) => `- ${c}`).join('\n') : '(None)'}

Safety Events:
${data.safety_events.length > 0 ? data.safety_events.map((e) => `- ${e}`).join('\n') : '(None)'}

---
This is an automated notification from the Alphabet Trains Google Ads Co-Pilot.
    `.trim();

    await this.send({
      type: 'daily_summary',
      subject,
      body,
      priority: 'low',
      channels: ['email'],
      metadata: data as unknown as Record<string, unknown>,
    });
  }

  /**
   * Send notification through configured channels
   */
  private async send(notification: Notification): Promise<void> {
    const { channels, subject, body, priority } = notification;

    // Email (required)
    if (channels.includes('email')) {
      await this.sendEmail(subject, body, priority);
    }

    // Slack (optional)
    if (channels.includes('slack') && config.notifications.slack.isConfigured) {
      await this.sendSlack(subject, body, priority);
    }

    // Log the notification
    console.log(`[Notifier] Sent ${notification.type} notification: ${subject}`);
  }

  /**
   * Send email notification
   */
  private async sendEmail(
    subject: string,
    body: string,
    priority: Notification['priority']
  ): Promise<void> {
    if (!this.emailTransporter || !config.notifications.email.isConfigured) {
      console.warn('[Notifier] Email not configured. Required: SMTP_HOST, SMTP_USER, SMTP_PASS, NOTIFICATION_FROM, NOTIFICATION_TO');
      console.log(`[Notifier] Would send email: ${subject}`);
      return;
    }

    const from = config.notifications.email.from;
    const to = config.notifications.email.to;

    if (!from || !to) {
      console.error('[Notifier] Missing from or to address, cannot send email');
      return;
    }

    if (!body || body.trim().length === 0) {
      console.error('[Notifier] Empty email body, skipping');
      return;
    }

    try {
      console.log(`[Notifier] Sending email to ${to}: ${subject}`);
      await this.emailTransporter.sendMail({
        from,
        to,
        subject,
        text: body,
        priority: priority === 'urgent' ? 'high' : priority === 'high' ? 'high' : 'normal',
      });
      console.log(`[Notifier] Email sent successfully: ${subject}`);
    } catch (error) {
      console.error('[Notifier] Failed to send email:', error);
      // Don't throw - notifications should not block operations
    }
  }

  /**
   * Send Slack notification
   */
  private async sendSlack(
    subject: string,
    body: string,
    priority: Notification['priority']
  ): Promise<void> {
    if (!config.notifications.slack.webhookUrl) {
      return;
    }

    const emoji =
      priority === 'urgent' ? ':rotating_light:' :
      priority === 'high' ? ':warning:' :
      ':information_source:';

    try {
      await fetch(config.notifications.slack.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `${emoji} *${subject}*\n\`\`\`${body}\`\`\``,
        }),
      });
    } catch (error) {
      console.error('[Notifier] Failed to send Slack notification:', error);
      // Don't throw - notifications should not block operations
    }
  }

  /**
   * Send a kill switch notification
   */
  async sendKillSwitchNotification(
    enabled: boolean,
    actor: string,
    reason?: string
  ): Promise<void> {
    const action = enabled ? 'ENABLED' : 'DISABLED';
    const subject = `[${enabled ? 'URGENT' : 'INFO'}] Alphabet Trains - Kill Switch ${action}`;

    const body = `
Kill Switch ${action}
${'='.repeat(20 + action.length)}

Action: ${action}
By: ${actor}
${reason ? `Reason: ${reason}` : ''}
Time: ${new Date().toISOString()}

${enabled ?
  'All write operations are now SUSPENDED. No budget changes or campaign modifications will be executed until the kill switch is disabled.' :
  'Write operations have been RESUMED. The system will now execute approved proposals.'}

---
This is an automated notification from the Alphabet Trains Google Ads Co-Pilot.
    `.trim();

    await this.send({
      type: enabled ? 'safety_stop' : 'execution_result',
      subject,
      body,
      priority: enabled ? 'urgent' : 'normal',
      channels: ['email', 'slack'],
      metadata: { enabled, actor, reason },
    });
  }
}

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

export function getNotifier(): NotifierService {
  return NotifierService.getInstance();
}
