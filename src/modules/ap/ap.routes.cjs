// server/src/modules/ap/ap.routes.js
const express = require('express');
const router = express.Router();
const apBillsController = require('./apBills.controller.cjs');
const apPaymentsController = require('./apPayments.controller.cjs');

router.get('/bills', apBillsController.listBills);
router.get('/bills/source-pos', apBillsController.getSourcePOs); // Must be before /bills/:id
router.get('/bills/:id/payment-allocations', apBillsController.getBillPaymentAllocations); // Must be before /bills/:id
router.get('/bills/:id/journal-entries', apBillsController.getBillJournalEntries); // Must be before /bills/:id
router.get('/bills/:id', apBillsController.getBill);
router.post('/bills', apBillsController.billUpload, apBillsController.createBill);
router.put('/bills/:id', apBillsController.billUpload, apBillsController.updateBill);
router.post('/bills/:id/post', apBillsController.postBill);
router.post('/bills/:id/cancel', apBillsController.cancelBill);
router.put('/bills/:id/status', apBillsController.updateStatus);
router.post('/bills/:id/approve', apBillsController.approveBill);
router.post('/bills/:id/reject', apBillsController.rejectBill);
router.post('/bills/:id/request-edit', apBillsController.requestEdit);
router.post('/bills/:id/decide-edit-request', apBillsController.decideEditRequest);
router.post('/bills/:id/attachments', apBillsController.billUpload, apBillsController.addAttachment);
router.delete('/bills/:id/attachments/:attachmentId', apBillsController.deleteAttachment);

router.get('/payments', apPaymentsController.listPayments);
router.get('/payments/:id', apPaymentsController.getPayment);
router.post('/payments', apPaymentsController.createPayment);
router.put('/payments/:id', apPaymentsController.updatePayment);
router.post('/payments/:id/post', apPaymentsController.postPayment);
router.post('/payments/:id/cancel', apPaymentsController.cancelPayment);

router.get('/suppliers/:supplierId/open-bills', apPaymentsController.getOpenBills);

module.exports = router;

