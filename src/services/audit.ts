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

// ============================================================================
// SIGNED CHECKPOINTS & EXPORT
// ============================================================================

export interface AuditCheckpoint {
  id: string;
  created_at: Date;
  event_count: number;
  first_event_id: string;
  last_event_id: string;
  last_event_hash: string;
  checkpoint_hash: string;
  signature?: string; // Optional HMAC signature if secret is configured
}

export interface AuditExportBundle {
  export_id: string;
  exported_at: string;
  checkpoint?: AuditCheckpoint;
  events: AuditEvent[];
  chain_valid: boolean;
  summary: {
    total_events: number;
    date_range: { start: string; end: string };
    event_types: Record<string, number>;
    actors: string[];
  };
}

/**
 * Create a signed checkpoint at the current point in the audit log
 */
export async function createAuditCheckpoint(signingSecret?: string): Promise<AuditCheckpoint> {
  const logger = getAuditLogger();

  // Get current state
  const latestEvents = await logger.query({ limit: 1 });
  const totalCount = await logger.count();

  if (latestEvents.length === 0) {
    throw new Error('No audit events to checkpoint');
  }

  const lastEvent = latestEvents[0]!;

  // Get first event
  const firstEventResult = await query<AuditEventRow>(
    `SELECT * FROM audit_events ORDER BY timestamp ASC, id ASC LIMIT 1`
  );
  const firstEvent = firstEventResult.rows[0];

  if (!firstEvent) {
    throw new Error('No audit events found');
  }

  const checkpointId = uuidv4();
  const createdAt = new Date();

  // Create checkpoint hash
  const checkpointData = [
    checkpointId,
    createdAt.toISOString(),
    totalCount.toString(),
    firstEvent.id,
    lastEvent.id,
    lastEvent.hash,
  ].join('|');

  const checkpointHash = createHash('sha256').update(checkpointData).digest('hex');

  // Optional: sign with HMAC if secret provided
  let signature: string | undefined;
  if (signingSecret) {
    const hmac = createHash('sha256');
    hmac.update(signingSecret);
    hmac.update(checkpointHash);
    signature = hmac.digest('hex');
  }

  const checkpoint: AuditCheckpoint = {
    id: checkpointId,
    created_at: createdAt,
    event_count: totalCount,
    first_event_id: firstEvent.id,
    last_event_id: lastEvent.id,
    last_event_hash: lastEvent.hash,
    checkpoint_hash: checkpointHash,
    signature,
  };

  // Store checkpoint
  await query(
    `INSERT INTO audit_checkpoints (id, created_at, event_count, first_event_id, last_event_id, last_event_hash, checkpoint_hash, signature)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      checkpoint.id,
      checkpoint.created_at,
      checkpoint.event_count,
      checkpoint.first_event_id,
      checkpoint.last_event_id,
      checkpoint.last_event_hash,
      checkpoint.checkpoint_hash,
      checkpoint.signature ?? null,
    ]
  );

  return checkpoint;
}

/**
 * Export audit log as a verifiable bundle for external review
 */
export async function exportAuditBundle(options?: {
  start_date?: Date;
  end_date?: Date;
  limit?: number;
  include_checkpoint?: boolean;
}): Promise<AuditExportBundle> {
  const logger = getAuditLogger();

  // Query events
  const events = await logger.query({
    start_date: options?.start_date,
    end_date: options?.end_date,
    limit: options?.limit ?? 10000,
  });

  // Verify chain integrity
  const verification = await logger.verifyChain(events.length);

  // Get or create checkpoint if requested
  let checkpoint: AuditCheckpoint | undefined;
  if (options?.include_checkpoint) {
    try {
      checkpoint = await createAuditCheckpoint();
    } catch {
      // No events or checkpoint creation failed
    }
  }

  // Build summary
  const eventTypes: Record<string, number> = {};
  const actorSet = new Set<string>();
  let minDate: Date | null = null;
  let maxDate: Date | null = null;

  for (const event of events) {
    eventTypes[event.event_type] = (eventTypes[event.event_type] || 0) + 1;
    actorSet.add(event.actor);

    if (!minDate || event.timestamp < minDate) minDate = event.timestamp;
    if (!maxDate || event.timestamp > maxDate) maxDate = event.timestamp;
  }

  return {
    export_id: uuidv4(),
    exported_at: new Date().toISOString(),
    checkpoint,
    events,
    chain_valid: verification.valid,
    summary: {
      total_events: events.length,
      date_range: {
        start: minDate?.toISOString() ?? '',
        end: maxDate?.toISOString() ?? '',
      },
      event_types: eventTypes,
      actors: Array.from(actorSet),
    },
  };
}

/**
 * Verify an exported audit bundle
 */
export function verifyAuditBundle(bundle: AuditExportBundle, signingSecret?: string): {
  valid: boolean;
  issues: string[];
} {
  const issues: string[] = [];

  // Check chain validity flag
  if (!bundle.chain_valid) {
    issues.push('Bundle reports chain is invalid');
  }

  // Re-verify the hash chain
  let expectedPrevHash = '0000000000000000000000000000000000000000000000000000000000000000';

  // Sort events by timestamp for verification
  const sortedEvents = [...bundle.events].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
  );

  for (const event of sortedEvents) {
    // For first event or if we're starting mid-chain, accept the prev_hash
    if (event.prev_hash !== expectedPrevHash && expectedPrevHash !== '0000000000000000000000000000000000000000000000000000000000000000') {
      // Check if this might be the first event in the export (not first in chain)
      if (sortedEvents.indexOf(event) === 0) {
        expectedPrevHash = event.prev_hash;
      } else {
        issues.push(`Hash chain broken at event ${event.id}`);
      }
    }

    // Recompute hash
    const computedHash = computeHash(
      event.event_type,
      event.entity_type,
      event.entity_id,
      event.actor,
      event.action,
      event.details,
      event.timestamp,
      event.prev_hash
    );

    if (computedHash !== event.hash) {
      issues.push(`Hash mismatch at event ${event.id}`);
    }

    expectedPrevHash = event.hash;
  }

  // Verify checkpoint signature if present
  if (bundle.checkpoint?.signature && signingSecret) {
    const hmac = createHash('sha256');
    hmac.update(signingSecret);
    hmac.update(bundle.checkpoint.checkpoint_hash);
    const expectedSignature = hmac.digest('hex');

    if (expectedSignature !== bundle.checkpoint.signature) {
      issues.push('Checkpoint signature verification failed');
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
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
