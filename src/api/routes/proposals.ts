/**
 * Proposal Routes
 * List, approve, reject, and view proposals
 */

import { Router } from 'express';
import { z } from 'zod';
import { getProposalGeneratorService } from '../../services/proposals.js';
import { getExecutorService } from '../../services/executor.js';
import { requireAdmin } from '../middleware/auth.js';
import { ProposalStatus } from '../../types/index.js';

const router = Router();

// Validation schemas
const approveSchema = z.object({
  modified_value: z.string().optional(),
});

const rejectSchema = z.object({
  reason: z.string().min(1),
});

/**
 * GET /proposals
 * List proposals with optional status filter
 */
router.get('/', async (req, res) => {
  try {
    const status = req.query['status'] as string | undefined;
    const limit = parseInt(req.query['limit'] as string) || 50;

    let proposalStatus: ProposalStatus | undefined;
    if (status) {
      if (Object.values(ProposalStatus).includes(status as ProposalStatus)) {
        proposalStatus = status as ProposalStatus;
      } else {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_STATUS',
            message: `Invalid status. Valid values: ${Object.values(ProposalStatus).join(', ')}`,
          },
        });
        return;
      }
    }

    const proposalService = getProposalGeneratorService();
    const proposals = await proposalService.getProposals(proposalStatus, limit);

    res.json({
      success: true,
      data: proposals,
      meta: {
        count: proposals.length,
        status_filter: status ?? 'all',
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

/**
 * GET /proposals/pending
 * List pending proposals (shortcut)
 */
router.get('/pending', async (req, res) => {
  try {
    const limit = parseInt(req.query['limit'] as string) || 50;
    const proposalService = getProposalGeneratorService();
    const proposals = await proposalService.getProposals(ProposalStatus.PENDING, limit);

    res.json({
      success: true,
      data: proposals,
      meta: {
        count: proposals.length,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

/**
 * GET /proposals/:id
 * Get a specific proposal with full evidence pack
 */
router.get('/:id', async (req, res) => {
  try {
    const proposalId = req.params['id'];
    if (!proposalId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Proposal ID required',
        },
      });
      return;
    }

    const proposalService = getProposalGeneratorService();
    const proposal = await proposalService.getProposal(proposalId);

    if (!proposal) {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Proposal not found',
        },
      });
      return;
    }

    res.json({
      success: true,
      data: proposal,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

/**
 * POST /proposals/:id/approve
 * Approve a proposal (with optional value modification)
 */
router.post('/:id/approve', requireAdmin, async (req, res) => {
  try {
    const proposalId = req.params['id'];
    if (!proposalId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Proposal ID required',
        },
      });
      return;
    }

    const validation = approveSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request body',
          details: validation.error.format(),
        },
      });
      return;
    }

    const { modified_value } = validation.data;
    const actor = req.user?.id ?? 'unknown';

    const proposalService = getProposalGeneratorService();
    const proposal = await proposalService.approveProposal(proposalId, actor, modified_value);

    res.json({
      success: true,
      data: proposal,
      meta: {
        message: modified_value
          ? `Approved with modified value: ${modified_value}`
          : 'Approved as proposed',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const statusCode = message.includes('not found') ? 404 : message.includes('Cannot') ? 400 : 500;

    res.status(statusCode).json({
      success: false,
      error: {
        code: statusCode === 404 ? 'NOT_FOUND' : statusCode === 400 ? 'INVALID_STATE' : 'INTERNAL_ERROR',
        message,
      },
    });
  }
});

/**
 * POST /proposals/:id/reject
 * Reject a proposal with reason
 */
router.post('/:id/reject', requireAdmin, async (req, res) => {
  try {
    const proposalId = req.params['id'];
    if (!proposalId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Proposal ID required',
        },
      });
      return;
    }

    const validation = rejectSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Rejection reason is required',
          details: validation.error.format(),
        },
      });
      return;
    }

    const { reason } = validation.data;
    const actor = req.user?.id ?? 'unknown';

    const proposalService = getProposalGeneratorService();
    const proposal = await proposalService.rejectProposal(proposalId, actor, reason);

    res.json({
      success: true,
      data: proposal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const statusCode = message.includes('not found') ? 404 : message.includes('Cannot') ? 400 : 500;

    res.status(statusCode).json({
      success: false,
      error: {
        code: statusCode === 404 ? 'NOT_FOUND' : statusCode === 400 ? 'INVALID_STATE' : 'INTERNAL_ERROR',
        message,
      },
    });
  }
});

/**
 * POST /proposals/:id/execute
 * Manually trigger execution of an approved proposal
 */
router.post('/:id/execute', requireAdmin, async (req, res) => {
  try {
    const proposalId = req.params['id'];
    if (!proposalId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Proposal ID required',
        },
      });
      return;
    }

    const executor = getExecutorService();
    const result = await executor.executeById(proposalId);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const statusCode = message.includes('not found') ? 404 : message.includes('Cannot') ? 400 : 500;

    res.status(statusCode).json({
      success: false,
      error: {
        code: statusCode === 404 ? 'NOT_FOUND' : statusCode === 400 ? 'INVALID_STATE' : 'INTERNAL_ERROR',
        message,
      },
    });
  }
});

export default router;
