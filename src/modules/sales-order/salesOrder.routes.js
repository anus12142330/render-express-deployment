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
  removeSalesOrderDispatch,
  getDispatchVehicles,
  getDispatchDrivers,
  getDispatchBatchInfo
} from './salesOrder.controller.js';

import { headerUpload, dispatchUpload, completionUpload, deliveryUpload } from './salesOrder.upload.js';

const router = express.Router();

// Next Sequence
router.get('/next-sequence', requireAuth, requirePerm('SalesOrders', 'create'), getNextSequence);

// List (allow SalesOrders, Dispatch, or DispatchDelivery view - for dispatch staff)
router.get('/', requireAuth, requirePerm(['SalesOrders', 'Dispatch', 'DispatchDelivery'], 'view'), listSalesOrders);

// Approvals (Must be before :id route to not clash)
router.get('/approvals', requireAuth, requirePerm('SalesOrders', 'approve'), listSalesOrderApprovals);

// Dispatch vehicle/driver dropdowns (saved history, not fleet/driver masters)
const dispatchPermsList = [
  { moduleKey: 'SalesOrders', actionKey: 'dispatch' },
  { moduleKey: 'Dispatch', actionKey: 'dispatch' },
  { moduleKey: 'DispatchDelivery', actionKey: 'dispatch' },
  { moduleKey: 'SalesOrders', actionKey: 'create' },
  { moduleKey: 'Dispatch', actionKey: 'create' },
  { moduleKey: 'DispatchDelivery', actionKey: 'create' },
  { moduleKey: 'Dispatch', actionKey: 'add' },
  { moduleKey: 'DispatchDelivery', actionKey: 'add' }
];
router.get('/dispatch-vehicles', requireAuth, requireAnyPerm(dispatchPermsList), getDispatchVehicles);
router.get('/dispatch-drivers', requireAuth, requireAnyPerm(dispatchPermsList), getDispatchDrivers);

// Dispatch batch/bill info (warehouse, per-item purchase bill date + batch + allocated qty; only qty > 0)
router.get('/:id/dispatch-batch-info', requireAuth, requireAnyPerm(dispatchPermsList), getDispatchBatchInfo);

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

// Dispatch (allow dispatch, create, or add - for Record Shipment)
router.post('/:id/dispatch', requireAuth, dispatchUpload, dispatchSalesOrder);
router.put('/:id/dispatch/:dispatchId', requireAuth, dispatchUpload, dispatchSalesOrder);
router.delete('/:id/dispatch/:dispatchId', requireAuth, requireAnyPerm(dispatchPermsList), removeSalesOrderDispatch);

// Complete
router.post('/:id/complete', requireAuth, completionUpload, completeSalesOrder);

// Approve (allow SalesOrders, Dispatch, or DispatchDelivery approve - for dispatch staff Accept action)
router.post('/:id/approve', requireAuth, requirePerm(['SalesOrders', 'Dispatch', 'DispatchDelivery'], 'approve'), approveSalesOrder);

// Reject
router.post('/:id/reject', requireAuth, requirePerm('SalesOrders', 'approve'), rejectSalesOrder);

// Edit Request
router.post('/:id/request-edit', requireAuth, requirePerm('SalesOrders', 'edit'), requestSalesOrderEdit);

// Mark as Delivered (same permission set as dispatch)
router.post('/:id/delivered', requireAuth, deliveryUpload, deliveredSalesOrder);

router.post('/:id/decide-edit-request', requireAuth, requirePerm('SalesOrders', 'approve'), decideSalesOrderEditRequest);

export default router;
