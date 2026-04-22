import express from 'express';
import { requireAuth } from '../../../middleware/authz.js';
import { createErrorLogHandler, getErrorLogByIdHandler, listErrorLogsHandler } from './errorLog.controller.js';

const router = express.Router();

// Client ingest (any authenticated user)
router.post('/', requireAuth, createErrorLogHandler);

// Admin views (Super Admin enforced in controller)
router.get('/', requireAuth, listErrorLogsHandler);
router.get('/:id', requireAuth, getErrorLogByIdHandler);

export default router;

