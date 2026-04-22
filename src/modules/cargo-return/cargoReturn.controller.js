import db from '../../../db.js';
import { hasPermission } from '../../../middleware/authz.js';
import { getClientContext } from '../sales-order/salesOrder.service.js';
import { countCargoReturns, listCargoReturns, parseCargoReturnStatusIds } from './cargoReturn.repo.js';
import {
    removeCargoReturnAttachment,
    submitCargoReturnForApproval,
    updateCargoReturn,
    processQcDecision,
    finalizeCargoReturnQcInventoryApproval,
    rejectCargoReturn,
    addCargoReturnAttachments,
    createCargoReturn,
    getCargoReturnDetail,
    managerApproveCargoReturnForQc
} from './cargoReturn.service.js';

import { buildCargoReturnStoredPath } from './cargoReturn.upload.js';

const parsePage = (value, fallback = 1) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};

const parsePageSize = (value, fallback = 25) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};

const ok = (res, data, pagination) => res.json({ success: true, data, pagination });
const fail = (res, message, status = 400) => res.status(status).json({ success: false, message });

const getAuthUser = (req) => req.session?.user || req.mobileUser || req.user;

const isSuperAdmin = async (req) => {
    const userId = getAuthUser(req)?.id;
    if (!userId) return false;
    const user = getAuthUser(req);
    if (user && Number(user.role_id) === 1) return true;
    if (user?.roles && Array.isArray(user.roles) && user.roles.some((r) => String(r).trim() === 'Super Admin')) return true;
    if (user?.role && String(user.role).trim() === 'Super Admin') return true;
    const [rows] = await db.promise().query(
        `SELECT 1 FROM user_role ur JOIN role r ON r.id = ur.role_id
         WHERE ur.user_id = ? AND r.name = 'Super Admin' LIMIT 1`,
        [userId]
    );
    return rows.length > 0;
};

export const listCargoReturnsHandler = async (req, res) => {
    try {
        const superAdmin = await isSuperAdmin(req);
        const userId = getAuthUser(req)?.id;
        let page = parsePage(req.query.page);
        let pageSize = parsePageSize(req.query.pageSize ?? req.query.page_size ?? req.query.limit, 25);
        if (req.query.offset !== undefined && req.query.page === undefined) {
            page = Math.floor(Number(req.query.offset) / pageSize) + 1;
        }

        const canViewAll =
            superAdmin ||
            (await hasPermission(userId, 'SalesOrders', 'view_all')) ||
            (await hasPermission(userId, 'Dispatch', 'view_all')) ||
            (await hasPermission(userId, 'DispatchDelivery', 'view_all'));

        const clientId = await getClientContext(req);
        const search = req.query.search || '';
        const dateFrom = req.query.date_from || '';
        const dateTo = req.query.date_to || '';
        const statusIds = parseCargoReturnStatusIds(req.query.status_id);
        const qcStatusIds = parseCargoReturnStatusIds(req.query.qc_status_id);
        const salesQcRaw = String(req.query.sales_qc || '').trim().toLowerCase();
        const salesQc = salesQcRaw === 'only' || salesQcRaw === 'none' ? salesQcRaw : undefined;

        const filterOwnUserId = canViewAll ? null : userId;

        const total = await countCargoReturns({ clientId, search, filterOwnUserId, statusIds, qcStatusIds, salesQc, dateFrom, dateTo });
        const rows = await listCargoReturns({
            clientId,
            page,
            pageSize,
            search,
            filterOwnUserId,
            statusIds,
            qcStatusIds,
            salesQc,
            dateFrom,
            dateTo
        });
        const pagination = { page, pageSize, total, hasMore: page * pageSize < total };
        return ok(res, rows, pagination);
    } catch (err) {
        return fail(res, err.message || 'Failed to load cargo returns', 500);
    }
};

export const getCargoReturnByIdHandler = async (req, res) => {
    try {
        const clientId = await getClientContext(req);
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return fail(res, 'Invalid id', 400);
        const detail = await getCargoReturnDetail({ id, clientId });
        if (!detail) return fail(res, 'Cargo return not found', 404);
        return res.json({ success: true, data: detail });
    } catch (err) {
        return fail(res, err.message || 'Failed to load cargo return', 500);
    }
};

export const submitCargoReturnForApprovalHandler = async (req, res) => {
    try {
        const clientId = await getClientContext(req);
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return fail(res, 'Invalid id', 400);
        const userId = getAuthUser(req)?.id ?? null;
        const detail = await submitCargoReturnForApproval({ id, clientId, userId });
        return res.json({ success: true, data: detail, message: 'Submitted for approval' });
    } catch (err) {
        return fail(res, err.message || 'Failed to submit', 400);
    }
};

export const managerApproveCargoReturnForQcHandler = async (req, res) => {
    try {
        const clientId = await getClientContext(req);
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return fail(res, 'Invalid id', 400);
        const userId = getAuthUser(req)?.id ?? null;
        const comment = req.body?.comment != null ? String(req.body.comment).trim() : '';
        if (!comment) return fail(res, 'comment is required', 400);
        const detail = await managerApproveCargoReturnForQc({ id, clientId, userId, comment });
        return res.json({ success: true, data: detail, message: 'Approved and sent to Sales QC' });
    } catch (err) {
        return fail(res, err.message || 'Failed to approve', 400);
    }
};

export const updateCargoReturnHandler = async (req, res) => {
    try {
        const clientId = await getClientContext(req);
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return fail(res, 'Invalid id', 400);
        const body = req.body || {};
        const lines = Array.isArray(body.lines) ? body.lines : [];
        const notes = body.notes !== undefined ? body.notes : undefined;
        const return_source = body.return_source !== undefined ? body.return_source : undefined;
        const ar_invoice_id = body.ar_invoice_id !== undefined ? body.ar_invoice_id : undefined;
        const return_reason_id = body.return_reason_id !== undefined ? body.return_reason_id : undefined;
        const return_to_store = body.return_to_store !== undefined ? body.return_to_store : undefined;
        const return_to_store_date = body.return_to_store_date !== undefined ? body.return_to_store_date : undefined;
        const refund_type = body.refund_type !== undefined ? body.refund_type : undefined;
        const userId = getAuthUser(req)?.id ?? null;

        const detail = await updateCargoReturn({
            id,
            clientId,
            userId,
            notes,
            return_source,
            ar_invoice_id,
            return_reason_id,
            return_to_store,
            return_to_store_date,
            refund_type,
            lines
        });
        return res.json({ success: true, data: detail, message: 'Cargo return updated' });
    } catch (err) {
        return fail(res, err.message || 'Failed to update cargo return', 400);
    }
};

export const uploadCargoReturnAttachmentsHandler = async (req, res) => {
    try {
        const clientId = await getClientContext(req);
        const userId = getAuthUser(req)?.id ?? null;
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return fail(res, 'Invalid id', 400);
        const scopeRaw = req.query?.scope ?? req.body?.scope ?? null;
        const scope = scopeRaw != null ? String(scopeRaw).trim().toUpperCase() : 'RETURN';
        if (scope && !['RETURN', 'QC'].includes(scope)) return fail(res, 'Invalid scope', 400);
        const files = (req.files || []).map((file) => ({
            ...file,
            file_path: buildCargoReturnStoredPath(file.filename)
        }));
        if (!files.length) return fail(res, 'No files uploaded', 400);
        const detail = await addCargoReturnAttachments({ id, clientId, userId, files, scope });
        return res.json({ success: true, data: detail, message: 'Attachments uploaded' });
    } catch (err) {
        return fail(res, err.message || 'Failed to upload attachments', 500);
    }
};

export const deleteCargoReturnAttachmentHandler = async (req, res) => {
    try {
        const clientId = await getClientContext(req);
        const id = Number(req.params.id);
        const attachmentId = Number(req.params.attachmentId);
        if (!Number.isFinite(id) || !Number.isFinite(attachmentId)) return fail(res, 'Invalid id', 400);
        const userId = getAuthUser(req)?.id ?? null;
        const detail = await removeCargoReturnAttachment({ id, clientId, attachmentId, userId });
        return res.json({ success: true, data: detail, message: 'Attachment removed' });
    } catch (err) {
        return fail(res, err.message || 'Failed to delete attachment', 500);
    }
};

export const createCargoReturnHandler = async (req, res) => {
    try {
        const clientId = await getClientContext(req);
        const userId = getAuthUser(req)?.id ?? null;
        const body = req.body || {};
        const salesOrderId = Number(body.sales_order_id ?? body.orderId);
        const lines = Array.isArray(body.lines) ? body.lines : [];
        const notes = body.notes != null ? String(body.notes) : null;
        const return_source = body.return_source != null ? String(body.return_source) : null;
        const ar_invoice_id = body.ar_invoice_id != null && body.ar_invoice_id !== '' ? Number(body.ar_invoice_id) : null;
        const return_reason_id = body.return_reason_id != null && body.return_reason_id !== '' ? Number(body.return_reason_id) : null;
        const return_to_store = body.return_to_store != null ? Boolean(body.return_to_store) : false;
        const return_to_store_date = body.return_to_store_date != null && body.return_to_store_date !== '' ? String(body.return_to_store_date) : null;
        const refund_type = body.refund_type != null ? String(body.refund_type) : null;

        if (!Number.isFinite(salesOrderId)) {
            return fail(res, 'sales_order_id is required');
        }

        const result = await createCargoReturn({
            clientId,
            userId,
            sales_order_id: salesOrderId,
            notes,
            return_source,
            ar_invoice_id,
            return_reason_id,
            return_to_store,
            return_to_store_date,
            refund_type,
            lines
        });
        return res.status(201).json({ success: true, data: result, message: 'Cargo return saved' });
    } catch (err) {
        return fail(res, err.message || 'Failed to save cargo return', 500);
    }
};

export const processQcDecisionHandler = async (req, res) => {
    try {
        const clientId = await getClientContext(req);
        const userId = getAuthUser(req)?.id ?? null;
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return fail(res, 'Invalid id', 400);

        const multipart = String(req.headers['content-type'] || '').includes('multipart/form-data');
        let decision;
        let comment;
        let lines;
        if (multipart) {
            decision = req.body?.decision;
            comment = req.body?.comment;
            const linesRaw = req.body?.lines;
            try {
                lines = typeof linesRaw === 'string' ? JSON.parse(linesRaw || '[]') : linesRaw;
            } catch {
                return fail(res, 'Invalid lines JSON', 400);
            }
        } else {
            ({ decision, comment, lines } = req.body || {});
        }

        if (!decision) return fail(res, 'decision is required', 400);
        if (!comment || !String(comment).trim()) return fail(res, 'comment is required', 400);
        if (!Array.isArray(lines)) return fail(res, 'lines array is required', 400);

        const files = multipart
            ? (req.files || []).map((file) => ({
                  ...file,
                  file_path: buildCargoReturnStoredPath(file.filename)
              }))
            : [];

        const detail = await processQcDecision({
            id,
            clientId,
            userId,
            decision,
            comment,
            lines,
            files
        });

        return res.json({
            success: true,
            data: detail,
            message: `QC decision saved: ${decision}. Approve to post inventory.`
        });
    } catch (err) {
        return fail(res, err.message || 'Failed to process QC decision', 400);
    }
};

export const finalizeCargoReturnQcInventoryApprovalHandler = async (req, res) => {
    try {
        const clientId = await getClientContext(req);
        const userId = getAuthUser(req)?.id ?? null;
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return fail(res, 'Invalid id', 400);

        const { comment } = req.body || {};
        const detail = await finalizeCargoReturnQcInventoryApproval({
            id,
            clientId,
            userId,
            approvalComment: comment
        });
        return res.json({ success: true, data: detail, message: 'Inventory posted' });
    } catch (err) {
        return fail(res, err.message || 'Failed to post inventory', 400);
    }
};

export const rejectCargoReturnHandler = async (req, res) => {
    try {
        const clientId = await getClientContext(req);
        const userId = getAuthUser(req)?.id ?? null;
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return fail(res, 'Invalid id', 400);

        const { comment } = req.body || {};

        const detail = await rejectCargoReturn({
            id,
            clientId,
            userId,
            comment
        });

        return res.json({ success: true, data: detail, message: `Cargo return rejected successfully` });
    } catch (err) {
        return fail(res, err.message || 'Failed to reject cargo return', 400);
    }
};

