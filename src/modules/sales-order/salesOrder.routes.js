import express from 'express';
import { requireAuth, requirePerm } from '../../../middleware/authz.js';
import {
    listSalesOrders,
    createSalesOrderDraft,
    getSalesOrderDetail,
    updateSalesOrderDraft,
    upsertSalesOrderItems,
    uploadHeaderAttachments,
    submitSalesOrder,
    listSalesOrderApprovals,
    dispatchSalesOrder,
    completeSalesOrder,
    getNextSequence,
    deleteHeaderAttachment,
    rejectSalesOrder,
    requestSalesOrderEdit,
    decideSalesOrderEditRequest,
    approveSalesOrder,
    deliveredSalesOrder,
    removeSalesOrderDispatch
} from './salesOrder.controller.js';

import { headerUpload, dispatchUpload, completionUpload } from './salesOrder.upload.js';

const router = express.Router();

// Next Sequence
router.get('/next-sequence', requireAuth, requirePerm('SalesOrders', 'create'), getNextSequence);

// List
router.get('/', requireAuth, requirePerm('SalesOrders', 'view'), listSalesOrders);

// Approvals (Must be before :id route to not clash)
router.get('/approvals', requireAuth, requirePerm('SalesOrders', 'approve'), listSalesOrderApprovals);

// Retrieve
router.get('/:id', requireAuth, requirePerm('SalesOrders', 'view'), getSalesOrderDetail);

// Create Draft
router.post('/', requireAuth, requirePerm('SalesOrders', 'create'), createSalesOrderDraft);

// Update Draft Header
router.put('/:id', requireAuth, requirePerm('SalesOrders', 'edit'), updateSalesOrderDraft);

// Update Items (calculate totals)
router.post('/:id/items', requireAuth, requirePerm('SalesOrders', 'edit'), upsertSalesOrderItems);

// Attachments (Header)
router.post('/:id/attachments', requireAuth, requirePerm('SalesOrders', 'edit'), headerUpload.array('attachments', 20), uploadHeaderAttachments);
router.delete('/:id/attachments/:attachmentId', requireAuth, requirePerm('SalesOrders', 'edit'), deleteHeaderAttachment);

// Submit
router.post('/:id/submit', requireAuth, requirePerm('SalesOrders', 'submit'), submitSalesOrder);

// Dispatch
router.post('/:id/dispatch', requireAuth, requirePerm('SalesOrders', 'dispatch'), dispatchUpload.array('attachments', 20), dispatchSalesOrder);
router.delete('/:id/dispatch/:dispatchId', requireAuth, requirePerm('SalesOrders', 'dispatch'), removeSalesOrderDispatch);

// Complete
router.post('/:id/complete', requireAuth, requirePerm('SalesOrders', 'complete'), completionUpload.array('attachments', 20), completeSalesOrder);

// Approve
router.post('/:id/approve', requireAuth, requirePerm('SalesOrders', 'approve'), approveSalesOrder);

// Reject
router.post('/:id/reject', requireAuth, requirePerm('SalesOrders', 'approve'), rejectSalesOrder);

// Edit Request
router.post('/:id/request-edit', requireAuth, requirePerm('SalesOrders', 'edit'), requestSalesOrderEdit);

// Mark as Delivered
router.post('/:id/delivered', requireAuth, requirePerm('SalesOrders', 'approve'), deliveredSalesOrder);

router.post('/:id/decide-edit-request', requireAuth, requirePerm('SalesOrders', 'approve'), decideSalesOrderEditRequest);

export default router;
