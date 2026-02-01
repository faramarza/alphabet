/**
 * Immutable Audit Logger
 * Append-only audit events with hash chaining for integrity verification
 */

import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { query, transaction } from '../db/client.js';
import type { AuditEvent, AuditEventType } from '../types/index.js';

// ============================================================================
// TYPES
// ============================================================================

export interface AuditLogEntry {
  event_type: AuditEventType;
  entity_type: AuditEvent['entity_type'];
  entity_id?: string;
  actor: string;
  action: string;
  details: Record<string, unknown>;
  before_state?: Record<string, unknown>;
  after_state?: Record<string, unknown>;
  api_request_id?: string;
  api_response_id?: string;
}

interface AuditEventRow {
  id: string;
  event_type: string;
  entity_type: string;
  entity_id: string | null;
  actor: string;
  action: string;
  details: Record<string, unknown>;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  api_request_id: string | null;
  api_response_id: string | null;
  timestamp: Date;
  hash: string;
  prev_hash: string;
}

// ============================================================================
// HASH COMPUTATION
// ============================================================================

function computeHash(
  eventType: string,
  entityType: string,
  entityId: string | undefined,
  actor: string,
  action: string,
  details: Record<string, unknown>,
  timestamp: Date,
  prevHash: string
): string {
  const hashInput = [
    eventType,
    entityType,
    entityId ?? '',
    actor,
    action,
    JSON.stringify(details),
    timestamp.toISOString(),
    prevHash,
  ].join('|');

  return createHash('sha256').update(hashInput).digest('hex');
}

// ============================================================================
// AUDIT LOGGER CLASS
// ============================================================================

export class AuditLogger {
  private static instance: AuditLogger | null = null;

  private constructor() {}

  static getInstance(): AuditLogger {
    if (!AuditLogger.instance) {
      AuditLogger.instance = new AuditLogger();
    }
    return AuditLogger.instance;
  }

  /**
   * Log an audit event with hash chaining
   */
  async log(entry: AuditLogEntry): Promise<AuditEvent> {
    return transaction(async (client) => {
      // Get the latest hash for chain continuation
      const latestResult = await client.query<{ hash: string }>(
        `SELECT hash FROM audit_events ORDER BY timestamp DESC, id DESC LIMIT 1`
      );
      const prevHash =
        latestResult.rows[0]?.hash ??
        '0000000000000000000000000000000000000000000000000000000000000000';

      const id = uuidv4();
      const timestamp = new Date();

      // Compute hash for this event
      const hash = computeHash(
        entry.event_type,
        entry.entity_type,
        entry.entity_id,
        entry.actor,
        entry.action,
        entry.details,
        timestamp,
        prevHash
      );

      // Insert the audit event
      await client.query(
        `INSERT INTO audit_events (
          id, event_type, entity_type, entity_id, actor, action, details,
          before_state, after_state, api_request_id, api_response_id,
          timestamp, hash, prev_hash
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          id,
          entry.event_type,
          entry.entity_type,
          entry.entity_id ?? null,
          entry.actor,
          entry.action,
          JSON.stringify(entry.details),
          entry.before_state ? JSON.stringify(entry.before_state) : null,
          entry.after_state ? JSON.stringify(entry.after_state) : null,
          entry.api_request_id ?? null,
          entry.api_response_id ?? null,
          timestamp,
          hash,
          prevHash,
        ]
      );

      return {
        id,
        event_type: entry.event_type,
        entity_type: entry.entity_type,
        entity_id: entry.entity_id,
        actor: entry.actor,
        action: entry.action,
        details: entry.details,
        before_state: entry.before_state,
        after_state: entry.after_state,
        api_request_id: entry.api_request_id,
        api_response_id: entry.api_response_id,
        timestamp,
        hash,
        prev_hash: prevHash,
      };
    });
  }

  /**
   * Query audit events with filtering
   */
  async query(options: {
    entity_type?: string;
    entity_id?: string;
    event_type?: AuditEventType;
    actor?: string;
    start_date?: Date;
    end_date?: Date;
    limit?: number;
    offset?: number;
  }): Promise<AuditEvent[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (options.entity_type) {
      conditions.push(`entity_type = $${paramIndex++}`);
      params.push(options.entity_type);
    }

    if (options.entity_id) {
      conditions.push(`entity_id = $${paramIndex++}`);
      params.push(options.entity_id);
    }

    if (options.event_type) {
      conditions.push(`event_type = $${paramIndex++}`);
      params.push(options.event_type);
    }

    if (options.actor) {
      conditions.push(`actor = $${paramIndex++}`);
      params.push(options.actor);
    }

    if (options.start_date) {
      conditions.push(`timestamp >= $${paramIndex++}`);
      params.push(options.start_date);
    }

    if (options.end_date) {
      conditions.push(`timestamp <= $${paramIndex++}`);
      params.push(options.end_date);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const sql = `
      SELECT * FROM audit_events
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex}
    `;
    params.push(limit, offset);

    const result = await query<AuditEventRow>(sql, params);

    return result.rows.map((row) => ({
      id: row.id,
      event_type: row.event_type as AuditEventType,
      entity_type: row.entity_type as AuditEvent['entity_type'],
      entity_id: row.entity_id ?? undefined,
      actor: row.actor,
      action: row.action,
      details: row.details,
      before_state: row.before_state ?? undefined,
      after_state: row.after_state ?? undefined,
      api_request_id: row.api_request_id ?? undefined,
      api_response_id: row.api_response_id ?? undefined,
      timestamp: row.timestamp,
      hash: row.hash,
      prev_hash: row.prev_hash,
    }));
  }

  /**
   * Verify the integrity of the audit chain
   */
  async verifyChain(limit = 1000): Promise<{
    valid: boolean;
    total_events: number;
    verified_events: number;
    first_invalid?: string;
    error?: string;
  }> {
    const result = await query<AuditEventRow>(
      `SELECT * FROM audit_events ORDER BY timestamp ASC, id ASC LIMIT $1`,
      [limit]
    );

    const events = result.rows;
    let expectedPrevHash =
      '0000000000000000000000000000000000000000000000000000000000000000';

    for (let i = 0; i < events.length; i++) {
      const event = events[i]!;

      // Verify prev_hash matches expected
      if (event.prev_hash !== expectedPrevHash) {
        return {
          valid: false,
          total_events: events.length,
          verified_events: i,
          first_invalid: event.id,
          error: `Hash chain broken at event ${event.id}: expected prev_hash ${expectedPrevHash}, got ${event.prev_hash}`,
        };
      }

      // Recompute hash and verify
      const computedHash = computeHash(
        event.event_type,
        event.entity_type,
        event.entity_id ?? undefined,
        event.actor,
        event.action,
        event.details,
        event.timestamp,
        event.prev_hash
      );

      if (computedHash !== event.hash) {
        return {
          valid: false,
          total_events: events.length,
          verified_events: i,
          first_invalid: event.id,
          error: `Hash mismatch at event ${event.id}: stored ${event.hash}, computed ${computedHash}`,
        };
      }

      expectedPrevHash = event.hash;
    }

    return {
      valid: true,
      total_events: events.length,
      verified_events: events.length,
    };
  }

  /**
   * Get count of audit events
   */
  async count(options?: {
    entity_type?: string;
    event_type?: AuditEventType;
  }): Promise<number> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (options?.entity_type) {
      conditions.push(`entity_type = $${paramIndex++}`);
      params.push(options.entity_type);
    }

    if (options?.event_type) {
      conditions.push(`event_type = $${paramIndex++}`);
      params.push(options.event_type);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM audit_events ${whereClause}`,
      params
    );

    return parseInt(result.rows[0]?.count ?? '0', 10);
  }
}

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

export function getAuditLogger(): AuditLogger {
  return AuditLogger.getInstance();
}

export async function logAuditEvent(entry: AuditLogEntry): Promise<AuditEvent> {
  return getAuditLogger().log(entry);
}
