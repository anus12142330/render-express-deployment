import express from 'express';
import { requireAuth, requirePerm, requireAnyPerm } from '../../../middleware/authz.js';
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

import { headerUpload, dispatchUpload, completionUpload, deliveryUpload } from './salesOrder.upload.js';

const router = express.Router();

// Next Sequence
router.get('/next-sequence', requireAuth, requirePerm('SalesOrders', 'create'), getNextSequence);

// List (allow SalesOrders, Dispatch, or DispatchDelivery view - for dispatch staff)
router.get('/', requireAuth, requirePerm(['SalesOrders', 'Dispatch', 'DispatchDelivery'], 'view'), listSalesOrders);

// Approvals (Must be before :id route to not clash)
router.get('/approvals', requireAuth, requirePerm('SalesOrders', 'approve'), listSalesOrderApprovals);

// Retrieve (allow view or dispatch - dispatch staff need to load order for Record Shipment)
router.get('/:id', requireAuth, requireAnyPerm([
  { moduleKey: 'SalesOrders', actionKey: 'view' },
  { moduleKey: 'Dispatch', actionKey: 'view' },
  { moduleKey: 'DispatchDelivery', actionKey: 'view' },
  { moduleKey: 'SalesOrders', actionKey: 'dispatch' },
  { moduleKey: 'Dispatch', actionKey: 'dispatch' },
  { moduleKey: 'DispatchDelivery', actionKey: 'dispatch' }
]), getSalesOrderDetail);

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
router.post('/:id/submit', requireAuth, requirePerm('SalesOrders', 'view'), submitSalesOrder);

// Dispatch
router.post('/:id/dispatch', requireAuth, requirePerm(['SalesOrders', 'Dispatch', 'DispatchDelivery'], 'dispatch'), dispatchUpload.array('attachments', 20), dispatchSalesOrder);
router.delete('/:id/dispatch/:dispatchId', requireAuth, requirePerm(['SalesOrders', 'Dispatch', 'DispatchDelivery'], 'dispatch'), removeSalesOrderDispatch);

// Complete
router.post('/:id/complete', requireAuth, requirePerm(['SalesOrders', 'Dispatch', 'DispatchDelivery'], 'complete'), completionUpload.array('attachments', 20), completeSalesOrder);

// Approve (allow SalesOrders, Dispatch, or DispatchDelivery approve - for dispatch staff Accept action)
router.post('/:id/approve', requireAuth, requirePerm(['SalesOrders', 'Dispatch', 'DispatchDelivery'], 'approve'), approveSalesOrder);

// Reject
router.post('/:id/reject', requireAuth, requirePerm('SalesOrders', 'approve'), rejectSalesOrder);

// Edit Request
router.post('/:id/request-edit', requireAuth, requirePerm('SalesOrders', 'edit'), requestSalesOrderEdit);

// Mark as Delivered
router.post('/:id/delivered', requireAuth, requirePerm(['SalesOrders', 'Dispatch', 'DispatchDelivery'], 'dispatch'), deliveryUpload.array('attachments', 20), deliveredSalesOrder);

router.post('/:id/decide-edit-request', requireAuth, requirePerm('SalesOrders', 'approve'), decideSalesOrderEditRequest);

export default router;
