import express from 'express';
import { requireAuth, requireAnyPerm, requirePerm } from '../../../middleware/authz.js';
import {
    listCargoReturnsHandler,
    getCargoReturnByIdHandler,
    createCargoReturnHandler,
    submitCargoReturnForApprovalHandler,
    managerApproveCargoReturnForQcHandler,
    updateCargoReturnHandler,
    uploadCargoReturnAttachmentsHandler,
    deleteCargoReturnAttachmentHandler,
    processQcDecisionHandler,
    finalizeCargoReturnQcInventoryApprovalHandler,
    rejectCargoReturnHandler
} from './cargoReturn.controller.js';

import { cargoReturnUpload } from './cargoReturn.upload.js';

const router = express.Router();

const salesOrderViewModules = ['SalesOrders', 'Dispatch', 'DispatchDelivery'];

const draftEditPerms = [
    { moduleKey: 'SalesOrders', actionKey: 'edit' },
    { moduleKey: 'SalesOrders', actionKey: 'create' }
];

const qcPerms = [
    { moduleKey: 'SalesQC', actionKey: 'edit' },
    { moduleKey: 'SalesQC', actionKey: 'create' }
];

/** POST /finalize-qc-inventory — SalesOrders approve and/or SalesQC edit/create */
const finalizeQcInventoryPerms = [
    { moduleKey: 'SalesOrders', actionKey: 'approve' },
    ...qcPerms
];

/** Manager approval before QC */
const managerApprovePerms = [{ moduleKey: 'SalesOrders', actionKey: 'approve' }];

/** Reject document: same as finalize (manager / QC) or SalesOrders edit (reject before QC decision). */
const rejectCargoReturnPerms = [...finalizeQcInventoryPerms, { moduleKey: 'SalesOrders', actionKey: 'edit' }];

router.get('/', requireAuth, requirePerm(salesOrderViewModules, 'view'), listCargoReturnsHandler);
router.post('/', requireAuth, requirePerm('SalesOrders', 'create'), createCargoReturnHandler);
router.post(
    '/:id/submit-for-approval',
    requireAuth,
    requireAnyPerm(draftEditPerms),
    submitCargoReturnForApprovalHandler
);
router.post(
    '/:id/manager-approve',
    requireAuth,
    requireAnyPerm(managerApprovePerms),
    managerApproveCargoReturnForQcHandler
);
router.put('/:id', requireAuth, requireAnyPerm(draftEditPerms), updateCargoReturnHandler);
router.post(
    '/:id/attachments',
    requireAuth,
    requireAnyPerm(draftEditPerms),
    cargoReturnUpload.array('attachments', 20),
    uploadCargoReturnAttachmentsHandler
);
router.delete(
    '/:id/attachments/:attachmentId',
    requireAuth,
    requireAnyPerm(draftEditPerms),
    deleteCargoReturnAttachmentHandler
);
const qcDecisionUpload = cargoReturnUpload.array('attachments', 20);

router.post(
    '/:id/qc-decision',
    requireAuth,
    requireAnyPerm([{ moduleKey: 'SalesOrders', actionKey: 'edit' }, ...qcPerms]),
    (req, res, next) => {
        const ct = String(req.headers['content-type'] || '');
        if (ct.includes('multipart/form-data')) {
            return qcDecisionUpload(req, res, next);
        }
        return next();
    },
    processQcDecisionHandler
);

router.post(
    '/:id/finalize-qc-inventory',
    requireAuth,
    requireAnyPerm(finalizeQcInventoryPerms),
    finalizeCargoReturnQcInventoryApprovalHandler
);

router.post(
    '/:id/reject',
    requireAuth,
    requireAnyPerm(rejectCargoReturnPerms),
    rejectCargoReturnHandler
);

router.get('/:id', requireAuth, requirePerm(salesOrderViewModules, 'view'), getCargoReturnByIdHandler);


export default router;
