import db from '../../../db.js';
import { hasPermission } from '../../../middleware/authz.js';
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
    deleteDispatch,
    listDispatchVehicles,
    listDispatchDriversByVehicle,
    getOrderDispatchBatchInfo
} from './salesOrder.service.js';
import { requireFields, validateItems, normalizeTaxMode } from './salesOrder.validators.js';
import { buildStoredPath, getFilesFromRequest, saveBase64FilesFromBody } from './salesOrder.upload.js';

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

/** Resolve authenticated user (web session or mobile token). Same pattern as Customer list. */
const getAuthUser = (req) => req.session?.user || req.mobileUser || req.user;

/** Check if the current user is Super Admin (show all records). Uses DB so it works even when session only has id/email. */
const isSuperAdmin = async (req) => {
    const userId = getAuthUser(req)?.id;
    if (!userId) return false;
    const user = getAuthUser(req);
    if (user && (Number(user.role_id) === 1)) return true;
    if (user?.roles && Array.isArray(user.roles) && user.roles.some(r => String(r).trim() === 'Super Admin')) return true;
    if (user?.role && String(user.role).trim() === 'Super Admin') return true;
    const [rows] = await db.promise().query(
        `SELECT 1 FROM user_role ur JOIN role r ON r.id = ur.role_id
         WHERE ur.user_id = ? AND r.name = 'Super Admin' LIMIT 1`,
        [userId]
    );
    return rows.length > 0;
};

export const listSalesOrders = async (req, res) => {
    try {
        const superAdmin = await isSuperAdmin(req);
        const userId = getAuthUser(req)?.id;

        // Handle both offset/limit (mobile) and page/pageSize (web)
        let page = parsePage(req.query.page);
        let pageSize = parsePageSize(req.query.pageSize ?? req.query.page_size ?? req.query.limit, 25);

        if (req.query.offset !== undefined && req.query.page === undefined) {
            page = Math.floor(Number(req.query.offset) / pageSize) + 1;
        }

        // Super Admin sees all. Otherwise: "Record All" = view_all sees all; else only own (created_by OR sales_person_id = userId).
        const canViewAll = superAdmin
            || await hasPermission(userId, 'SalesOrders', 'view_all')
            || await hasPermission(userId, 'Dispatch', 'view_all')
            || await hasPermission(userId, 'DispatchDelivery', 'view_all');
        const canViewDispatch = await hasPermission(userId, 'Dispatch', 'view') || await hasPermission(userId, 'DispatchDelivery', 'view');

        const statusParam = req.query.status_id || req.query.status_ids || null;
        const dispatchStatusIds = [8, 1, 11, 9, 12];
        const isDispatchPipelineRequest = statusParam && (() => {
            const ids = String(statusParam).split(',').map(s => Number(s.trim())).filter(Number.isFinite);
            return ids.length > 0 && ids.every(id => dispatchStatusIds.includes(id));
        })();

        // Skip filter (show all) when Super Admin, Record All / view_all, or dispatch view, or dispatch pipeline request
        const skipCreatedByFilter = canViewAll || canViewDispatch || isDispatchPipelineRequest;

        // If we skip filter, we can still respect a specific user_id/created_by from the query if provided.
        // If wbe DON'T skip: restrict to own records (created_by OR sales_person_id = logged-in user).
        // No filter by company_id or client_id for list - for both Super Admin and others (own orders when !canViewAll).
        const query = {
            clientId: null,
            page,
            pageSize,
            search: req.query.search || '',
            status_id: statusParam,
            company_id: null,
            customer_id: null,
            date_from: req.query.date_from || null,
            date_to: req.query.date_to || null,
            edit_request_status: req.query.edit_request_status || null,
            exclude_with_ar_invoice: req.query.exclude_with_ar_invoice === '1' || req.query.exclude_with_ar_invoice === true,
        };
        if (skipCreatedByFilter) {
            const optionalUserId = req.query.user_id || req.query.created_by || null;
            if (optionalUserId != null && optionalUserId !== '') query.created_by = optionalUserId;
        } else if (userId != null) {
            query.filter_own_user_id = userId;
        }

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

        const userId = getAuthUser(req)?.id;
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
        const clientId = (await getClientContext(req)) || null;
        const userId = getAuthUser(req)?.id;
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

        const userId = getAuthUser(req)?.id;
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
        const clientId = (await getClientContext(req)) || null;
        const userId = getAuthUser(req)?.id;
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
        const clientId = (await getClientContext(req)) || null;
        const userId = getAuthUser(req)?.id;
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
        const clientId = await getClientContext(req) || null;
        const userId = getAuthUser(req)?.id;
        const id = Number(req.params.id);

        const result = await submitForApproval({ clientId, userId, id });
        return res.json({ success: true, message: 'Submitted for approval', order_no: result?.order_no });
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
        // Needed for dispatch vehicle/driver history dropdown persistence.
        // Falls back to default tenant (1) via getClientContext when missing.
        const clientId = await getClientContext(req);
        const userId = getAuthUser(req)?.id;
        const id = Number(req.params.id);

        let payload = req.body || {};
        try {
            if (typeof req.body.payload === 'string') {
                payload = { ...payload, ...JSON.parse(req.body.payload) };
            }
        } catch (e) {
            // keep payload as req.body
        }

        let { dispatch_id, vehicle_no, driver_name, comments, items, force_delivery, force_delivery_reason } = payload;
        console.log('[Dispatch Controller] Incoming Body Keys:', Object.keys(req.body || {}));
        console.log('[Dispatch Controller] Payload:', { 
            id, 
            vehicle_no, 
            driver_name, 
            force_delivery, 
            force_delivery_type: typeof force_delivery,
            is_force: force_delivery === '1' || force_delivery === true || force_delivery === 1
        });
        if (!dispatch_id && req.params.dispatchId) {
            dispatch_id = Number(req.params.dispatchId);
        }
        // FormData sends items as JSON string; ensure we pass an array to the service
        if (typeof items === 'string') {
            try {
                items = JSON.parse(items);
            } catch (e) {
                items = [];
            }
        }
        if (!Array.isArray(items)) items = [];
        let rawFiles = getFilesFromRequest(req);
        if (rawFiles.length === 0) {
            try {
                const base64Files = await saveBase64FilesFromBody(req, 'dispatch');
                if (base64Files.length) {
                    rawFiles = base64Files;
                    console.log('[Dispatch] Using', base64Files.length, 'image(s) from body base64');
                }
            } catch (e) {
                console.warn('[Dispatch] base64 fallback', e?.message);
            }
        }
        console.log('[Dispatch] Content-Type:', req.headers['content-type'], '| files_count:', rawFiles.length, rawFiles[0] ? `| first file keys: ${Object.keys(rawFiles[0]).join(',')}` : '');

        // Normalize force delivery flag
        const isForceDelivery = force_delivery === '1' || force_delivery === true || force_delivery === 1;

        if (!isForceDelivery && (!vehicle_no || !driver_name)) {
            return fail(res, 'vehicle_no and driver_name are required');
        }

        if (isForceDelivery) {
            if (!String(force_delivery_reason || '').trim()) {
                return fail(res, 'A reason is required when Force Delivery is enabled');
            }
            // Defaults for force delivery if not provided
            vehicle_no = vehicle_no || 'FORCE_DELIVERY';
            driver_name = driver_name || 'FORCE_DELIVERY';
        }

        const files = rawFiles
            .filter((file) => file != null)
            .map((file, idx) => {
                const name = file.filename || file.originalname || file.originalName || `dispatch_${Date.now()}_${idx}.jpg`;
                const relPath = file.file_path || buildStoredPath('dispatch', name);
                return {
                    ...file,
                    filename: name,
                    originalname: file.originalname || file.originalName || name,
                    file_path: relPath,
                    path: file.path || relPath,
                    mimetype: file.mimetype || file.mimeType || 'image/jpeg',
                    size: file.size != null ? file.size : 0
                };
            });

        if (files.length) console.log('[Dispatch] Saving', files.length, 'file(s) to DB and folder');
        await dispatchOrder({ clientId, userId, id, dispatch_id, vehicle_no, driver_name, comments, files, items, force_delivery: isForceDelivery, force_delivery_reason: String(force_delivery_reason || '').trim() || null });
        return res.json({ success: true, message: 'Dispatched' });
    } catch (err) {
        return fail(res, err.message || 'Failed to dispatch', 500);
    }
};

/** GET /api/sales-orders/:id/dispatch-batch-info - warehouse, dispatching time, per-item purchase bill (date, batch_no, allocated qty; only qty > 0) */
export const getDispatchBatchInfo = async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!id || !Number.isFinite(id)) return fail(res, 'Invalid order id', 400);
        const info = await getOrderDispatchBatchInfo({ id });
        if (!info) return fail(res, 'Sales order not found', 404);
        return res.json({ success: true, data: info });
    } catch (err) {
        return fail(res, err.message || 'Failed to load dispatch batch info', 500);
    }
};

/** GET /api/sales-orders/dispatch-vehicles - distinct vehicle names from dispatch history (not fleet master) */
export const getDispatchVehicles = async (req, res) => {
    try {
        const clientId = (await getClientContext(req)) || null;
        if (!clientId) return res.json([]);
        const list = await listDispatchVehicles({ clientId });
        return res.json(Array.isArray(list) ? list : []);
    } catch (err) {
        return fail(res, err.message || 'Failed to load vehicles', 500);
    }
};

/** GET /api/sales-orders/dispatch-drivers?vehicle_name= - distinct driver names for that vehicle (not driver master) */
export const getDispatchDrivers = async (req, res) => {
    try {
        const clientId = (await getClientContext(req)) || null;
        const vehicleName = req.query.vehicle_name ?? '';
        if (!clientId) return res.json([]);
        const list = await listDispatchDriversByVehicle({ clientId, vehicleName });
        return res.json(Array.isArray(list) ? list : []);
    } catch (err) {
        return fail(res, err.message || 'Failed to load drivers', 500);
    }
};

export const removeSalesOrderDispatch = async (req, res) => {
    try {
        const clientId = (await getClientContext(req)) || null;
        const userId = getAuthUser(req)?.id;
        const id = Number(req.params.id);
        const dispatchId = Number(req.params.dispatchId);

        // Security check: only role 1 (Super Admin) can delete dispatches
        if (Number(getAuthUser(req)?.role_id) !== 1) {
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
        const clientId = null; // Bypassed as requested
        const userId = getAuthUser(req)?.id;
        const id = Number(req.params.id);
        const { client_received_by, client_notes, comments, payment_term_id, due_date, allocations: rawAllocations } = req.body || {};
        const finalNotes = client_notes || comments;

        let allocations = [];
        if (rawAllocations) {
            try {
                allocations = typeof rawAllocations === 'string' ? JSON.parse(rawAllocations) : rawAllocations;
            } catch (e) {
                console.warn('Failed to parse allocations in completion:', e);
            }
        }

        let rawFiles = getFilesFromRequest(req);
        if (rawFiles.length === 0) {
            try {
                const base64Files = await saveBase64FilesFromBody(req, 'complete');
                if (base64Files.length) {
                    rawFiles = base64Files;
                    console.log('[Complete] Using', base64Files.length, 'image(s) from body base64');
                }
            } catch (e) {
                console.warn('[Complete] base64 fallback', e?.message);
            }
        }
        console.log('[Complete] Content-Type:', req.headers['content-type'], '| files_count:', rawFiles.length);

        const files = rawFiles
            .filter((file) => file != null)
            .map((file, idx) => {
                const name = file.filename || file.originalname || file.originalName || `completion_${Date.now()}_${idx}.jpg`;
                const relPath = file.file_path || buildStoredPath('completion', name);
                return {
                    ...file,
                    filename: name,
                    originalname: file.originalname || file.originalName || name,
                    file_path: relPath,
                    path: file.path || relPath,
                    mimetype: file.mimetype || file.mimeType || 'image/jpeg',
                    size: file.size != null ? file.size : 0
                };
            });

        if (files.length) console.log('[Complete] Saving', files.length, 'file(s) to DB and folder');
        await completeOrder({
            clientId,
            userId,
            id,
            client_received_by,
            client_notes: finalNotes,
            files,
            payment_term_id,
            due_date,
            allocations
        });
        return res.json({ success: true, message: 'Completed' });
    } catch (err) {
        return fail(res, err.message || 'Failed to complete', 500);
    }
};

export const getSalesOrderDetail = async (req, res) => {
    try {
        const userId = getAuthUser(req)?.id;
        const id = Number(req.params.id);
        if (!id || !Number.isFinite(id)) return fail(res, 'Invalid order id', 400);

        const detail = await getOrderDetail({ id, clientId: null });
        if (!detail) return fail(res, 'Sales order not found', 404);

        const superAdmin = await isSuperAdmin(req);
        const canViewAll = superAdmin
            || await hasPermission(userId, 'SalesOrders', 'view_all')
            || await hasPermission(userId, 'Dispatch', 'view_all')
            || await hasPermission(userId, 'DispatchDelivery', 'view_all')
            || await hasPermission(userId, 'Dispatch', 'view')
            || await hasPermission(userId, 'DispatchDelivery', 'view');

        if (!canViewAll && Number(detail.header?.created_by) !== Number(userId) && Number(detail.header?.sales_person_id) !== Number(userId)) {
            return res.status(403).json({ success: false, message: 'You can only view your own sales orders.' });
        }

        return res.json({ success: true, data: detail });
    } catch (err) {
        return fail(res, err.message || 'Failed to load sales order', 500);
    }
};

export const rejectSalesOrder = async (req, res) => {
    try {
        const clientId = (await getClientContext(req)) || null;
        const userId = getAuthUser(req)?.id;
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
        const clientId = (await getClientContext(req)) || null;
        const userId = getAuthUser(req)?.id;
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
        const clientId = (await getClientContext(req)) || null;
        const userId = getAuthUser(req)?.id;
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
        const clientId = null; // Bypassed as requested
        const userId = getAuthUser(req)?.id;
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
        const clientId = null; // Bypassed as requested
        const userId = getAuthUser(req)?.id;
        const id = Number(req.params.id);
        const { comment, comments } = req.body || {};
        const finalComment = comment || comments;

        let rawFiles = getFilesFromRequest(req);
        if (rawFiles.length === 0) {
            try {
                const base64Files = await saveBase64FilesFromBody(req, 'delivery');
                if (base64Files.length) {
                    rawFiles = base64Files;
                    console.log('[Delivered] Using', base64Files.length, 'image(s) from body base64');
                }
            } catch (e) {
                console.warn('[Delivered] base64 fallback', e?.message);
            }
        }
        console.log('[Delivered] Content-Type:', req.headers['content-type'], '| files_count:', rawFiles.length);

        const files = rawFiles
            .filter((file) => file != null)
            .map((file, idx) => {
                const name = file.filename || file.originalname || file.originalName || `delivery_${Date.now()}_${idx}.jpg`;
                const relPath = file.file_path || buildStoredPath('delivery', name);
                return {
                    ...file,
                    filename: name,
                    originalname: file.originalname || file.originalName || name,
                    file_path: relPath,
                    path: file.path || relPath,
                    mimetype: file.mimetype || file.mimeType || 'image/jpeg',
                    size: file.size != null ? file.size : 0
                };
            });

        if (files.length) console.log('[Delivered] Saving', files.length, 'file(s) to DB and folder');
        await markAsDelivered({ clientId, userId, id, comment: finalComment, files });
        return res.json({ success: true, message: 'Sales order marked as delivered' });
    } catch (err) {
        return fail(res, err.message || 'Failed to mark delivered', 500);
    }
};

const fallbackOrderNo = () => {
    const d = new Date();
    const yy = String(d.getFullYear()).slice(-2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `SO-${yy}-${mm}-001`;
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
        // Always return 200 with fallback so mobile form can load; avoid 500
        return res.json({ success: true, order_no: fallbackOrderNo() });
    }
};
