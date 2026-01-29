import {
    listOrders,
    listApprovals,
    getOrderDetail,
    createDraft,
    updateDraftHeader,
    replaceItems,
    addAttachments,
    submitForApproval,
    dispatchOrder,
    completeOrder,
    getClientContext,
    previewNextSequence,
    removeAttachment,
    rejectOrder,
    requestEditOrder,
    decideEditRequest,
    approveOrder,
    markAsDelivered,
    deleteDispatch
} from './salesOrder.service.js';
import { requireFields, validateItems, normalizeTaxMode } from './salesOrder.validators.js';
import { buildStoredPath } from './salesOrder.upload.js';

const parsePage = (value, fallback = 1) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};

const parsePageSize = (value, fallback = 20) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};

const ok = (res, data, pagination) => res.json({ success: true, data, pagination });
const fail = (res, message, status = 400) => res.status(status).json({ success: false, message });

export const listSalesOrders = async (req, res) => {
    try {
        const clientId = await getClientContext(req);
        // User asked to ignore missing context but I put a default 1 fallback in service
        // However, for strict tenant isolation, we should respect what service returns
        if (!clientId) return fail(res, 'Missing tenant context', 400);

        const page = parsePage(req.query.page);
        const pageSize = parsePageSize(req.query.pageSize ?? req.query.page_size, 20);

        // Filters
        const query = {
            clientId,
            page,
            pageSize,
            search: req.query.search || '',
            status_id: req.query.status_id || null,
            company_id: req.query.company_id || null,
            customer_id: req.query.customer_id || null,
            date_from: req.query.date_from || null,
            date_to: req.query.date_to || null,
            edit_request_status: req.query.edit_request_status || null,
        };

        const { rows, total } = await listOrders(query);
        const pagination = { page, pageSize, total, hasMore: (page * pageSize) < total };

        return ok(res, rows, pagination);
    } catch (err) {
        return fail(res, err.message || 'Failed to load sales orders', 500);
    }
};

export const createSalesOrderDraft = async (req, res) => {
    try {
        const clientId = await getClientContext(req);
        if (!clientId) return fail(res, 'Missing tenant context', 400);

        const userId = req.user?.id;
        const payload = req.body || {};

        const missing = requireFields(payload, ['customer_id', 'company_id', 'currency_id', 'tax_mode', 'order_date']);
        if (missing.length) {
            return fail(res, `Missing fields: ${missing.join(', ')}`);
        }

        const result = await createDraft({ clientId, userId, payload });
        return res.status(201).json({ success: true, data: result, message: 'Draft created' });
    } catch (err) {
        return fail(res, err.message || 'Failed to create draft', 500);
    }
};

export const updateSalesOrderDraft = async (req, res) => {
    try {
        const clientId = await getClientContext(req);
        if (!clientId) return fail(res, 'Missing tenant context', 400);

        const userId = req.user?.id;
        const id = Number(req.params.id);
        const payload = req.body || {};

        const missing = requireFields(payload, ['customer_id', 'company_id', 'currency_id', 'tax_mode', 'order_date', 'order_no']);
        if (missing.length) {
            return fail(res, `Missing fields: ${missing.join(', ')}`);
        }

        await updateDraftHeader({ clientId, userId, id, payload });
        return res.json({ success: true, message: 'Draft updated' });
    } catch (err) {
        return fail(res, err.message || 'Failed to update draft', 500);
    }
};

export const upsertSalesOrderItems = async (req, res) => {
    try {
        const clientId = await getClientContext(req);
        if (!clientId) return fail(res, 'Missing tenant context', 400);

        const userId = req.user?.id;
        const id = Number(req.params.id);
        const items = req.body?.items || [];
        const taxMode = normalizeTaxMode(req.body?.tax_mode);

        const errors = validateItems(items);
        if (errors.length) return fail(res, errors.join(' '));

        const totals = await replaceItems({ clientId, userId, id, taxMode, items });
        return res.json({ success: true, data: totals, message: 'Items saved' });
    } catch (err) {
        return fail(res, err.message || 'Failed to update items', 500);
    }
};

export const uploadHeaderAttachments = async (req, res) => {
    try {
        const clientId = await getClientContext(req);
        if (!clientId) return fail(res, 'Missing tenant context', 400);

        const userId = req.user?.id;
        const id = Number(req.params.id);
        const files = (req.files || []).map(file => ({
            ...file,
            file_path: buildStoredPath('header', file.filename)
        }));

        if (!files.length) return fail(res, 'No files uploaded');

        await addAttachments({ clientId, userId, id, scope: 'HEADER', files });
        return res.json({ success: true, message: 'Attachments uploaded' });
    } catch (err) {
        return fail(res, err.message || 'Failed to upload attachments', 500);
    }
};

export const deleteHeaderAttachment = async (req, res) => {
    try {
        const clientId = await getClientContext(req);
        if (!clientId) return fail(res, 'Missing tenant context', 400);

        const userId = req.user?.id;
        const id = Number(req.params.id);
        const attachmentId = Number(req.params.attachmentId);

        await removeAttachment({ clientId, userId, id, attachmentId });
        return res.json({ success: true, message: 'Attachment deleted' });
    } catch (err) {
        return fail(res, err.message || 'Failed to delete attachment', 500);
    }


};

export const submitSalesOrder = async (req, res) => {
    try {
        const clientId = await getClientContext(req);
        if (!clientId) return fail(res, 'Missing tenant context', 400);

        const userId = req.user?.id;
        const id = Number(req.params.id);

        await submitForApproval({ clientId, userId, id });
        return res.json({ success: true, message: 'Submitted for approval' });
    } catch (err) {
        return fail(res, err.message || 'Failed to submit', 500);
    }
};

export const listSalesOrderApprovals = async (req, res) => {
    try {
        const clientId = await getClientContext(req);
        if (!clientId) return fail(res, 'Missing tenant context', 400);

        const page = parsePage(req.query.page);
        const pageSize = parsePageSize(req.query.pageSize ?? req.query.page_size, 20);

        const { rows, total } = await listApprovals({
            clientId,
            page,
            pageSize,
            search: req.query.search || ''
        });

        const pagination = { page, pageSize, total, hasMore: (page * pageSize) < total };
        return ok(res, rows, pagination);
    } catch (err) {
        return fail(res, err.message || 'Failed to load approvals', 500);
    }
};

export const dispatchSalesOrder = async (req, res) => {
    try {
        const clientId = await getClientContext(req);
        if (!clientId) return fail(res, 'Missing tenant context', 400);

        const userId = req.user?.id;
        const id = Number(req.params.id);

        let payload = {};
        try {
            payload = typeof req.body.payload === 'string' ? JSON.parse(req.body.payload) : req.body;
        } catch (e) {
            payload = req.body || {};
        }

        const { dispatch_id, vehicle_no, driver_name, items } = payload;
        console.log('[Dispatch] Payload received:', { dispatch_id, vehicle_no, driver_name, items_count: Array.isArray(items) ? items.length : 'N/A' });

        if (!vehicle_no || !driver_name) return fail(res, 'vehicle_no and driver_name are required');

        const files = (req.files || []).map(file => ({
            ...file,
            file_path: buildStoredPath('dispatch', file.filename)
        }));

        await dispatchOrder({ clientId, userId, id, dispatch_id, vehicle_no, driver_name, files, items });
        return res.json({ success: true, message: 'Dispatched' });
    } catch (err) {
        return fail(res, err.message || 'Failed to dispatch', 500);
    }
};

export const removeSalesOrderDispatch = async (req, res) => {
    try {
        const clientId = await getClientContext(req);
        if (!clientId) return fail(res, 'Missing tenant context', 400);

        const userId = req.user?.id;
        const id = Number(req.params.id);
        const dispatchId = Number(req.params.dispatchId);

        // Security check: only role 1 (Super Admin) can delete dispatches
        if (Number(req.user?.role_id) !== 1) {
            return fail(res, 'Only Super Admin can delete dispatches', 403);
        }

        await deleteDispatch({ clientId, userId, id, dispatchId });
        return res.json({ success: true, message: 'Dispatch deleted' });
    } catch (err) {
        return fail(res, err.message || 'Failed to delete dispatch', 500);
    }
};

export const completeSalesOrder = async (req, res) => {
    try {
        const clientId = await getClientContext(req);
        if (!clientId) return fail(res, 'Missing tenant context', 400);

        const userId = req.user?.id;
        const id = Number(req.params.id);
        const { client_received_by, client_notes } = req.body || {};

        const files = (req.files || []).map(file => ({
            ...file,
            file_path: buildStoredPath('completion', file.filename)
        }));

        await completeOrder({ clientId, userId, id, client_received_by, client_notes, files });
        return res.json({ success: true, message: 'Completed' });
    } catch (err) {
        return fail(res, err.message || 'Failed to complete', 500);
    }
};

export const getSalesOrderDetail = async (req, res) => {
    try {
        const clientId = await getClientContext(req);
        if (!clientId) return fail(res, 'Missing tenant context', 400);

        const id = Number(req.params.id);
        const detail = await getOrderDetail({ id, clientId });
        if (!detail) return fail(res, 'Sales order not found', 404);

        return res.json({ success: true, data: detail });
    } catch (err) {
        return fail(res, err.message || 'Failed to load sales order', 500);
    }
};

export const rejectSalesOrder = async (req, res) => {
    try {
        const clientId = await getClientContext(req);
        if (!clientId) return fail(res, 'Missing tenant context', 400);

        const userId = req.user?.id;
        const id = Number(req.params.id);
        const { reason } = req.body || {};

        if (!reason) return fail(res, 'Reason is required for rejection');

        await rejectOrder({ clientId, userId, id, reason });
        return res.json({ success: true, message: 'Sales order rejected' });
    } catch (err) {
        return fail(res, err.message || 'Failed to reject', 500);
    }
};

export const requestSalesOrderEdit = async (req, res) => {
    try {
        const clientId = await getClientContext(req);
        if (!clientId) return fail(res, 'Missing tenant context', 400);

        const userId = req.user?.id;
        const id = Number(req.params.id);
        const { reason } = req.body || {};

        if (!reason) return fail(res, 'Reason is required for edit request');

        await requestEditOrder({ clientId, userId, id, reason });
        return res.json({ success: true, message: 'Edit request submitted' });
    } catch (err) {
        return fail(res, err.message || 'Failed to submit edit request', 500);
    }
};

export const decideSalesOrderEditRequest = async (req, res) => {
    try {
        const clientId = await getClientContext(req);
        if (!clientId) return fail(res, 'Missing tenant context', 400);

        const userId = req.user?.id;
        const id = Number(req.params.id);
        const { decision, reason } = req.body || {};

        if (!decision) return fail(res, 'Decision is required');

        await decideEditRequest({ clientId, userId, id, decision, reason });
        return res.json({ success: true, message: `Edit request ${decision}ed` });
    } catch (err) {
        return fail(res, err.message || 'Failed to process edit request', 500);
    }
};

export const approveSalesOrder = async (req, res) => {
    try {
        const clientId = await getClientContext(req);
        if (!clientId) return fail(res, 'Missing tenant context', 400);

        const userId = req.user?.id;
        const id = Number(req.params.id);
        const { comment } = req.body || {};

        await approveOrder({ clientId, userId, id, comment });
        return res.json({ success: true, message: 'Sales order approved' });
    } catch (err) {
        return fail(res, err.message || 'Failed to approve', 500);
    }
};

export const deliveredSalesOrder = async (req, res) => {
    try {
        const clientId = await getClientContext(req);
        if (!clientId) return fail(res, 'Missing tenant context', 400);

        const userId = req.user?.id;
        const id = Number(req.params.id);
        const { comment } = req.body || {};

        await markAsDelivered({ clientId, userId, id, comment });
        return res.json({ success: true, message: 'Sales order marked as delivered' });
    } catch (err) {
        return fail(res, err.message || 'Failed to mark delivered', 500);
    }
};

export const getNextSequence = async (req, res) => {
    try {
        const clientId = await getClientContext(req);
        if (!clientId) return fail(res, 'Missing tenant context', 400);

        const company_id = req.query.company_id || req.body.company_id;
        const order_date = req.query.order_date || req.body.order_date;

        if (!company_id) return fail(res, 'company_id is required');

        const orderNo = await previewNextSequence({ clientId, companyId: company_id, orderDate: order_date });
        return res.json({ success: true, order_no: orderNo });
    } catch (err) {
        console.error('Sequence gen error:', err);
        return fail(res, err.message || 'Failed to generate sequence', 500);
    }
};
