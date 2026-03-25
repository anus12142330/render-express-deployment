import db from '../../../db.js';
import crypto from 'crypto';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { generateARInvoiceNumber } = require('../../utils/docNo.cjs');

import {
    fetchCompanyPrefix,
    fetchSalesOrderFormat,
    getSalesOrderHeader,
    getSalesOrderItems,
    getSalesOrderAttachments,
    getSalesOrderApproval,
    getSalesOrderAudit,
    getSalesOrderDispatches,
    getDispatchItems,
    insertSalesOrder,
    updateSalesOrderHeader,
    replaceSalesOrderItems,
    updateItemDispatchedQuantity,
    insertDispatchHeader,
    insertDispatchItems,
    updateDispatchHeader,
    deleteDispatchItems,
    deleteDispatchHeader,
    getDispatchById,
    insertAttachments,
    insertApproval,
    insertAudit,
    listSalesOrders,
    listApprovalQueue,
    getAttachmentById,
    deleteAttachment,
    getDispatchVehicles,
    getDispatchDriversByVehicle,
    upsertDispatchVehicleDriver,
    getDispatchBatchInfo
} from './salesOrder.repo.js';
import fs from 'fs';
import { normalizeTaxMode } from './salesOrder.validators.js';

const withTx = async (fn) => {
    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();
        const result = await fn(conn);
        await conn.commit();
        return result;
    } catch (error) {
        try {
            await conn.rollback();
        } catch { }
        throw error;
    } finally {
        conn.release();
    }
};

const pad = (num, size = 3) => String(num).padStart(size, '0');

const getSeqWidthFromFormat = (format, fallback = 3) => {
    const match = String(format || '').match(/\{seq(?::(\d+)|(\d+))?\}/i);
    const width = Number(match?.[1] || match?.[2] || fallback);
    return Number.isFinite(width) && width > 0 ? width : fallback;
};

/** Build order number from master format template or legacy. Placeholders: {prefix}, {YY}, {YYYY}, {MM}, {seq}/{seq5}/{seq:5} */
const buildOrderNoFromFormat = (prefix, format, yy, yyyy, mm, nextSeq) => {
    const MM = String(mm).padStart(2, '0');
    const YY = String(yy).padStart(2, '0');
    const seq = pad(nextSeq, getSeqWidthFromFormat(format, 3));
    if (format && format.length > 0) {
        return format
            .replace(/\{prefix\}/gi, prefix || 'SO')
            .replace(/\{YYYY\}/g, String(yyyy))
            .replace(/\{YY\}/g, YY)
            .replace(/\{MM\}/g, MM)
            .replace(/\{seq(?::\d+|\d+)?\}/gi, seq);
    }
    return `${prefix || 'SO'}SO-${YY}-${MM}-${seq}`;
};

const generateOrderNo = async (conn, { clientId, companyId, orderDate }) => {
    const date = orderDate ? new Date(orderDate) : new Date();
    const yyyy = date.getFullYear();
    const mm = date.getMonth() + 1;
    const yy = Number(String(yyyy).slice(-2));

    // Previous month (so sequence continues from last month's last 3 digits, not 001)
    const prevMm = mm === 1 ? 12 : mm - 1;
    const prevYy = mm === 1 ? (yy === 0 ? 99 : yy - 1) : yy;

    const [[prevRow]] = await conn.query(
        `SELECT COALESCE(MAX(last_seq), 0) AS last_seq FROM sales_order_sequences
         WHERE client_id = ? AND company_id = ? AND yy = ? AND mm = ?`,
        [clientId, companyId, prevYy, prevMm]
    );
    const initialSeq = prevRow && prevRow.last_seq != null ? Number(prevRow.last_seq) : 0;

    // Ensure a row exists for this client, company, year, month (continue from last month's seq)
    await conn.query(
        `INSERT IGNORE INTO sales_order_sequences (client_id, company_id, yy, mm, last_seq)
         VALUES (?, ?, ?, ?, ?)`,
        [clientId, companyId, yy, mm, initialSeq]
    );

    // Increment and get the new sequence for this month/year
    await conn.query(
        `UPDATE sales_order_sequences
            SET last_seq = last_seq + 1
          WHERE client_id = ? AND company_id = ? AND yy = ? AND mm = ?`,
        [clientId, companyId, yy, mm]
    );

    const [rows] = await conn.query(
        `SELECT last_seq FROM sales_order_sequences
          WHERE client_id = ? AND company_id = ? AND yy = ? AND mm = ?`,
        [clientId, companyId, yy, mm]
    );

    const nextSeq = rows.length && rows[0].last_seq != null ? Number(rows[0].last_seq) : 1;
    const { prefix, format } = await fetchSalesOrderFormat(conn, companyId);
    return buildOrderNoFromFormat(prefix, format, yy, yyyy, mm, nextSeq);
};

const computeTotals = (items, taxMode) => {
    const mode = normalizeTaxMode(taxMode);
    let subtotal = 0;
    let taxTotal = 0;
    let grandTotal = 0;

    const normalizedItems = items.map((item) => {
        const qty = Number(item.quantity ?? item.qty ?? 0);
        const unitPrice = Number(item.unit_price ?? item.unitPrice ?? 0);
        const taxRate = Number(item.tax_rate ?? item.taxRate ?? 0);
        const discountType = item.discount_type || 'PERCENTAGE';
        const discountRate = Number(item.discount_rate || 0);
        const discountAmountValue = Number(item.discount_amount || 0);

        let lineSubtotal = qty * unitPrice;
        let lineDiscount = 0;

        if (discountType === 'PERCENTAGE') {
            lineDiscount = lineSubtotal * (discountRate / 100);
        } else {
            lineDiscount = discountAmountValue;
        }

        const lineNet = lineSubtotal - lineDiscount;
        let lineTax = 0;
        let lineTotal = lineNet;

        if (taxRate > 0) {
            if (mode === 'INCLUSIVE') {
                const base = lineNet / (1 + taxRate / 100);
                lineTax = lineNet - base;
                lineTotal = lineNet;
            } else {
                lineTax = lineNet * (taxRate / 100);
                lineTotal = lineNet + lineTax;
            }
        }

        subtotal += lineNet;
        taxTotal += lineTax;
        grandTotal += lineTotal;

        return {
            product_id: Number(item.product_id ?? item.productId),
            description: item.description || null,
            quantity: qty,
            uom_id: Number(item.uom_id ?? item.uomId ?? item.uom),
            unit_price: unitPrice,
            discount_type: discountType,
            discount_rate: discountRate,
            discount_amount: discountAmountValue,
            line_subtotal: Number(lineNet.toFixed(2)),
            tax_rate: taxRate || null,
            tax_id: (() => {
                const raw = item.tax_id ?? item.taxId;
                if (raw == null || raw === '') return null;
                const n = Number(raw);
                return Number.isFinite(n) ? n : null;
            })(),
            line_tax: Number(lineTax.toFixed(2)),
            line_total: Number(lineTotal.toFixed(2)),
            ordered_quantity: Number(item.ordered_quantity || item.quantity || 0),
            dispatched_quantity: Number(item.dispatched_quantity || 0)
        };
    });

    return {
        items: normalizedItems,
        totals: {
            subtotal: Number(subtotal.toFixed(2)),
            tax_total: Number(taxTotal.toFixed(2)),
            grand_total: Number(grandTotal.toFixed(2))
        }
    };
};

export const listOrders = async (query) => {
    const conn = await db.promise().getConnection();
    try {
        return await listSalesOrders(conn, query);
    } finally {
        conn.release();
    }
};

export const listApprovals = async (query) => {
    const conn = await db.promise().getConnection();
    try {
        return await listApprovalQueue(conn, query);
    } finally {
        conn.release();
    }
};

/** Get warehouse + per-item purchase bill/batch info for dispatch (bill_date, batch_no, allocated_quantity; only qty > 0). */
export const getOrderDispatchBatchInfo = async ({ id }) => {
    const conn = await db.promise().getConnection();
    try {
        return await getDispatchBatchInfo(conn, { salesOrderId: id });
    } finally {
        conn.release();
    }
};

export const getOrderDetail = async ({ id, clientId }) => {
    const conn = await db.promise().getConnection();
    try {
        const header = await getSalesOrderHeader(conn, { id, clientId: null });
        if (!header) return null;
        // Load items, attachments, dispatches by order id only (no client_id filter) so they show on detail in web and mobile
        const [items, attachments, approval, audit, dispatches] = await Promise.all([
            getSalesOrderItems(conn, { salesOrderId: header.id, clientId: null }),
            getSalesOrderAttachments(conn, { salesOrderId: header.id, clientId: null }),
            getSalesOrderApproval(conn, { salesOrderId: header.id, clientId: null }),
            getSalesOrderAudit(conn, { salesOrderId: header.id, clientId: null }),
            getSalesOrderDispatches(conn, { salesOrderId: header.id, clientId: null })
        ]);

        const enrichedDispatches = await Promise.all(dispatches.map(async (d) => {
            const dItems = await getDispatchItems(conn, { dispatchId: d.id });
            return { ...d, items: dItems };
        }));

        return { header, items, attachments, approval, audit, dispatches: enrichedDispatches };
    } finally {
        conn.release();
    }
};

const computeHeaderDiff = (oldHeader, newPayload) => {
    const changes = [];
    const fields = [
        'company_id', 'customer_id', 'warehouse_id', 'billing_address', 'shipping_address', 'currency_id',
        'tax_mode', 'order_date', 'terms_conditions', 'sales_person_id'
    ];
    fields.forEach(f => {
        if (newPayload[f] !== undefined && String(oldHeader[f]) !== String(newPayload[f])) {
            changes.push({ field: f, from: oldHeader[f], to: newPayload[f] });
        }
    });
    return changes;
};

const DRAFT_ORDER_NO_PLACEHOLDER = 'XXX';

export const createDraft = async ({ clientId, userId, payload }) =>
    withTx(async (conn) => {
        const orderNo = DRAFT_ORDER_NO_PLACEHOLDER;

        const orderId = await insertSalesOrder(conn, {
            client_id: clientId,
            company_id: payload.company_id,
            customer_id: payload.customer_id,
            warehouse_id: payload.warehouse_id,
            billing_address: payload.billing_address,
            shipping_address: payload.shipping_address,
            currency_id: payload.currency_id,
            tax_mode: normalizeTaxMode(payload.tax_mode),
            order_no: orderNo,
            order_date: payload.order_date,
            status_id: 3,
            subtotal: 0,
            tax_total: 0,
            grand_total: 0,
            created_by: userId,
            terms_conditions: payload.terms_conditions ?? payload.notes ?? null,
            sales_person_id: payload.sales_person_id || userId
        });

        await insertAudit(conn, {
            client_id: clientId,
            sales_order_id: orderId,
            action: 'CREATED',
            old_status_id: null,
            new_status_id: 3,
            payload_json: { order_no: orderNo },
            action_by: userId
        });

        return { id: orderId, order_no: orderNo };
    });

export const updateDraftHeader = async ({ clientId, userId, id, payload }) =>
    withTx(async (conn) => {
        const header = await getSalesOrderHeader(conn, { id, clientId: null });
        if (!header) throw new Error('Sales order not found');
        const scopeClientId = clientId ?? header.client_id;
        // If order is not a draft, change it to draft to allow editing
        if (Number(header.status_id) !== 3) {
            const oldStatus = header.status_id;
            await conn.query(`UPDATE sales_orders SET status_id = ?, updated_by = ?, updated_at = NOW() WHERE id = ?`, [
                3,
                userId,
                id
            ]);
            await insertAudit(conn, {
                client_id: scopeClientId,
                sales_order_id: id,
                action: 'SET_TO_DRAFT_FOR_EDIT',
                old_status_id: oldStatus,
                new_status_id: 3,
                payload_json: { order_no: header.order_no },
                action_by: userId
            });
            // Refresh header for subsequent operations
            const refreshed = await getSalesOrderHeader(conn, { id, clientId: null });
            if (refreshed) Object.assign(header, refreshed);
        }

        const changes = computeHeaderDiff(header, payload);

        await updateSalesOrderHeader(conn, {
            id,
            client_id: scopeClientId,
            company_id: payload.company_id,
            customer_id: payload.customer_id,
            warehouse_id: payload.warehouse_id,
            billing_address: payload.billing_address,
            shipping_address: payload.shipping_address,
            currency_id: payload.currency_id,
            tax_mode: normalizeTaxMode(payload.tax_mode),
            order_date: payload.order_date,
            subtotal: header.subtotal,
            tax_total: header.tax_total,
            grand_total: header.grand_total,
            updated_by: userId,
            terms_conditions: (payload.terms_conditions !== undefined ? payload.terms_conditions : payload.notes !== undefined ? payload.notes : header.terms_conditions),
            sales_person_id: payload.sales_person_id || (payload.sales_person_id !== undefined ? userId : header.sales_person_id)
        });

        if (changes.length > 0) {
            await insertAudit(conn, {
                client_id: scopeClientId,
                sales_order_id: id,
                action: 'UPDATED_HEADER',
                old_status_id: header.status_id,
                new_status_id: header.status_id,
                payload_json: { order_no: header.order_no, changes },
                action_by: userId
            });
        }
    });

export const replaceItems = async ({ clientId, userId, id, taxMode, items }) =>
    withTx(async (conn) => {
        const header = await getSalesOrderHeader(conn, { id, clientId: null });
        if (!header) throw new Error('Sales order not found');
        // If order is not a draft, change it to draft to allow editing
        if (Number(header.status_id) !== 3) {
            const oldStatus = header.status_id;
            await conn.query(`UPDATE sales_orders SET status_id = ?, updated_by = ?, updated_at = NOW() WHERE id = ?`, [
                3,
                userId,
                id
            ]);
            await insertAudit(conn, {
                client_id: clientId,
                sales_order_id: id,
                action: 'SET_TO_DRAFT_FOR_EDIT',
                old_status_id: oldStatus,
                new_status_id: 3,
                payload_json: { order_no: header.order_no },
                action_by: userId
            });
            const refreshed = await getSalesOrderHeader(conn, { id, clientId: null });
            if (refreshed) Object.assign(header, refreshed);
        }

        const computed = computeTotals(items, taxMode || header.tax_mode);
        await replaceSalesOrderItems(conn, {
            salesOrderId: id,
            clientId,
            items: computed.items
        });

        await updateSalesOrderHeader(conn, {
            id,
            client_id: clientId,
            company_id: header.company_id,
            customer_id: header.customer_id,
            warehouse_id: header.warehouse_id,
            billing_address: header.billing_address,
            shipping_address: header.shipping_address,
            currency_id: header.currency_id,
            tax_mode: normalizeTaxMode(taxMode || header.tax_mode),
            order_date: header.order_date,
            subtotal: computed.totals.subtotal,
            tax_total: computed.totals.tax_total,
            grand_total: computed.totals.grand_total,
            updated_by: userId,
            terms_conditions: header.terms_conditions,
            sales_person_id: header.sales_person_id
        });

        if (Number(header.grand_total) !== Number(computed.totals.grand_total) || Number(header.subtotal) !== Number(computed.totals.subtotal)) {
            await insertAudit(conn, {
                client_id: clientId,
                sales_order_id: id,
                action: 'UPDATED_ITEMS',
                old_status_id: 3,
                new_status_id: 3,
                payload_json: { item_count: computed.items.length },
                action_by: userId
            });
        }

        return computed.totals;
    });

export const addAttachments = async ({ clientId, userId, id, scope, files }) =>
    withTx(async (conn) => {
        const header = await getSalesOrderHeader(conn, { id, clientId: null });
        if (!header) throw new Error('Sales order not found');
        const scopeClientId = clientId ?? header.client_id;
        // Allow attachments in drafts, submitted, maybe even dispatched?
        // Requirement says "available in Draft and Submitted for Approval".
        // Also Completion creates new attachments.

        const rows = files.map((file) => [
            id,
            null, // dispatch_id (header attachments have no dispatch)
            scope,
            file.originalname,
            file.filename,
            file.mimetype,
            file.size,
            file.file_path,
            userId,
            new Date()
        ]);
        await insertAttachments(conn, rows);

        await insertAudit(conn, {
            client_id: scopeClientId ?? null,
            sales_order_id: id,
            action: 'ATTACHMENTS_ADDED',
            old_status_id: header.status_id,
            new_status_id: header.status_id,
            payload_json: { count: files.length, scope },
            action_by: userId
        });
    });

export const removeAttachment = async ({ clientId, userId, id, attachmentId }) =>
    withTx(async (conn) => {
        const header = await getSalesOrderHeader(conn, { id, clientId: null });
        if (!header) throw new Error('Sales order not found');

        const att = await getAttachmentById(conn, { attachmentId, clientId });
        if (!att) throw new Error('Attachment not found');

        if (Number(att.sales_order_id) !== Number(id)) throw new Error('Attachment mismatch');

        // Delete from DB
        await deleteAttachment(conn, { attachmentId, clientId });

        // Unlink file
        if (att.file_path && fs.existsSync(att.file_path)) {
            try {
                fs.unlinkSync(att.file_path);
            } catch (e) {
                console.error('Failed to unlink file:', att.file_path, e);
            }
        }

        await insertAudit(conn, {
            client_id: clientId,
            sales_order_id: id,
            action: 'ATTACHMENT_DELETED',
            old_status_id: header.status_id,
            new_status_id: header.status_id,
            payload_json: { file_name: att.file_original_name },
            action_by: userId
        });
    });


export const submitForApproval = async ({ clientId, userId, id }) =>
    withTx(async (conn) => {
        const header = await getSalesOrderHeader(conn, { id, clientId: null });
        if (!header) throw new Error('Sales order not found');
        const scopeClientId = clientId ?? header.client_id;
        if (Number(header.status_id) !== 3) throw new Error('Only drafts can be submitted');

        const items = await getSalesOrderItems(conn, { salesOrderId: id, clientId: null });
        if (!items.length) throw new Error('At least 1 item is required before submit');

        let finalOrderNo = header.order_no;
        const needsOrderNo = !header.order_no || String(header.order_no).toUpperCase() === 'XXX';
        if (needsOrderNo) {
            finalOrderNo = await generateOrderNo(conn, {
                clientId: scopeClientId,
                companyId: header.company_id,
                orderDate: header.order_date
            });
            await conn.query(
                `UPDATE sales_orders SET order_no = ?, status_id = 8, updated_by = ?, updated_at = NOW() WHERE id = ?`,
                [finalOrderNo, userId, id]
            );
        } else {
            await conn.query(
                `UPDATE sales_orders SET status_id = 8, updated_by = ?, updated_at = NOW() WHERE id = ?`,
                [userId, id]
            );
        }

        await insertAudit(conn, {
            client_id: scopeClientId ?? null,
            sales_order_id: id,
            action: 'SUBMITTED',
            old_status_id: 3,
            new_status_id: 8,
            payload_json: { order_no: finalOrderNo },
            action_by: userId
        });

        return { order_no: finalOrderNo };
    });

export const approveOrder = async ({ clientId, userId, id, comment }) =>
    withTx(async (conn) => {
        const header = await getSalesOrderHeader(conn, { id, clientId: null });
        if (!header) throw new Error('Sales order not found');
        const scopeClientId = clientId ?? header.client_id;
        if (Number(header.status_id) !== 8) throw new Error('Only submitted orders can be approved');

        await conn.query(`UPDATE sales_orders SET status_id = 1, updated_by = ?, updated_at = NOW() WHERE id = ?`, [
            userId,
            id
        ]);

        await insertAudit(conn, {
            client_id: scopeClientId,
            sales_order_id: id,
            action: 'APPROVED',
            old_status_id: 8,
            new_status_id: 1,
            payload_json: { comment, order_no: header.order_no },
            action_by: userId
        });
    });

export const dispatchOrder = async ({ clientId, userId, id, dispatch_id, vehicle_no, driver_name, comments, files, items: dispatchPayload, force_delivery = false, force_delivery_reason = null }) =>
    withTx(async (conn) => {
        const header = await getSalesOrderHeader(conn, { id, clientId: null });
        if (!header) throw new Error('Sales order not found');
        const scopeClientId = clientId ?? header.client_id;
        // Ignore client_id check for attachments: use 0 when null so INSERT never fails
        const attachmentClientId = scopeClientId ?? header.client_id ?? 0;

        if (![1, 11, 9].includes(Number(header.status_id))) {
            throw new Error(`Dispatch allowed only for approved, partial or dispatched orders. Current status: ${header.status_id}`);
        }

        let normalizedPayload = dispatchPayload;
        if (typeof dispatchPayload === 'string') {
            try { normalizedPayload = JSON.parse(dispatchPayload); } catch (e) { normalizedPayload = []; }
        }
        if (!Array.isArray(normalizedPayload)) normalizedPayload = [];

        let activeDispatchId = dispatch_id;
        if (activeDispatchId) {
            await updateDispatchHeader(conn, { id: activeDispatchId, vehicle_no, driver_name, client_id: scopeClientId, comments });

            const oldItems = await getDispatchItems(conn, { dispatchId: activeDispatchId, clientId: scopeClientId });
            for (const oi of oldItems) {
                await conn.query(
                    `UPDATE sales_order_items SET dispatched_quantity = dispatched_quantity - ? WHERE id = ?`,
                    [Number(oi.quantity), oi.sales_order_item_id]
                );
            }
            await deleteDispatchItems(conn, { dispatchId: activeDispatchId });
        } else {
            activeDispatchId = await insertDispatchHeader(conn, {
                client_id: scopeClientId,
                sales_order_id: id,
                vehicle_no,
                driver_name,
                dispatched_by: userId,
                comments
            });
        }

        const dispatchHistory = [];
        const aggregateQtyByItemId = {};

        for (const p of normalizedPayload) {
            const qty = Number(p.dispatch_qty || 0);
            if (qty <= 0) continue;

            dispatchHistory.push([activeDispatchId, p.id, p.ap_bill_line_id || null, qty]);
            aggregateQtyByItemId[p.id] = (aggregateQtyByItemId[p.id] || 0) + qty;
        }

        if (dispatchHistory.length > 0) {
            await insertDispatchItems(conn, dispatchHistory);
        }

        const existingItems = await getSalesOrderItems(conn, { salesOrderId: id, clientId: scopeClientId });

        for (const item of existingItems) {
            const addedInThisUpdate = Number(aggregateQtyByItemId[item.id] || 0);
            await updateItemDispatchedQuantity(conn, {
                id: item.id,
                dispatched_quantity: Number(item.dispatched_quantity || 0) + addedInThisUpdate
            });
        }

        // Decide status from actual DB state after updates (so partial = 11, full = 9)
        const itemsAfterUpdate = await getSalesOrderItems(conn, { salesOrderId: id, clientId: scopeClientId });
        let allFullyDispatched = true;
        for (const item of itemsAfterUpdate) {
            const dispatched = Number(item.dispatched_quantity || 0);
            const ordered = Number(item.ordered_quantity || item.quantity || 0);
            if (ordered > 0 && dispatched < ordered) {
                allFullyDispatched = false;
                break;
            }
        }

        const filesList = Array.isArray(files) ? files : [];
        if (filesList.length) {
            const rows = filesList.map((file) => {
                const originalName = file.originalname || file.originalName || file.filename || 'dispatch_photo';
                const fileName = file.filename || file.originalname || file.originalName || `dispatch_${Date.now()}.jpg`;
                const filePath = file.file_path || file.path || `uploads/sales_orders/dispatch/${fileName}`;
                return [
                    id,
                    activeDispatchId,
                    'DISPATCH',
                    originalName,
                    fileName,
                    file.mimetype || file.mimeType || 'image/jpeg',
                    file.size != null ? Number(file.size) : 0,
                    filePath,
                    userId,
                    new Date()
                ];
            });
            await insertAttachments(conn, rows);
        }

        // Force delivery overrides the partial check — close the order as fully dispatched
        const effectivelyFullyDispatched = force_delivery ? true : allFullyDispatched;

        const newStatus = effectivelyFullyDispatched ? 9 : 11;
        await conn.query(
            `UPDATE sales_orders SET status_id = ?, updated_by = ?, updated_at = NOW() WHERE id = ?`,
            [newStatus, userId, id]
        );

        const auditAction = dispatch_id
            ? 'DISPATCH_UPDATED'
            : (force_delivery ? 'FORCE_DELIVERED' : (effectivelyFullyDispatched ? 'DISPATCHED' : 'PARTIALLY_DISPATCHED'));

        await insertAudit(conn, {
            client_id: scopeClientId,
            sales_order_id: id,
            action: auditAction,
            old_status_id: header.status_id,
            new_status_id: newStatus,
            payload_json: {
                dispatch_id: activeDispatchId,
                vehicle_no,
                driver_name,
                is_edit: !!dispatch_id,
                ...(force_delivery ? { force_delivery: true, force_delivery_reason } : {})
            },
            action_by: userId
        });

        // Save vehicle+driver pair for next time (dropdown history, separate from fleet/driver masters)
        try {
            await upsertDispatchVehicleDriver(conn, {
                clientId: scopeClientId,
                vehicleName: vehicle_no,
                driverName: driver_name
            });
        } catch (err) {
            console.warn('[dispatchOrder] upsertDispatchVehicleDriver', err?.message || err);
        }
    });

export const markAsDelivered = async ({ clientId, userId, id, comment, files }) =>
    withTx(async (conn) => {
        const header = await getSalesOrderHeader(conn, { id, clientId: null });
        if (!header) throw new Error('Sales order not found');
        const scopeClientId = clientId ?? header.client_id;
        if (![9, 11].includes(Number(header.status_id))) {
            throw new Error('Only dispatched orders can be marked delivered');
        }

        const filesList = Array.isArray(files) ? files : [];
        if (filesList.length) {
            const rows = filesList.map((file) => {
                const originalName = file.originalname || file.originalName || file.filename || 'delivery_photo';
                const fileName = file.filename || file.originalname || file.originalName || `delivery_${Date.now()}.jpg`;
                const filePath = file.file_path || file.path || `uploads/sales_orders/delivery/${fileName}`;
                return [
                    id,
                    null, // dispatch_id
                    'DELIVERY',
                    originalName,
                    fileName,
                    file.mimetype || file.mimeType || 'image/jpeg',
                    file.size != null ? Number(file.size) : 0,
                    filePath,
                    userId,
                    new Date()
                ];
            });
            await insertAttachments(conn, rows);
        }

        await conn.query(
            `UPDATE sales_orders 
             SET status_id = 12, 
                 delivery_notes = ?, 
                 delivered_by = ?, 
                 delivered_at = NOW(), 
                 updated_by = ?, 
                 updated_at = NOW() 
             WHERE id = ?`,
            [comment || null, userId, userId, id]
        );

        await insertAudit(conn, {
            client_id: scopeClientId,
            sales_order_id: id,
            action: 'MARKED_DELIVERED',
            old_status_id: header.status_id,
            new_status_id: 12,
            payload_json: { comment, attachments: filesList.length },
            action_by: userId
        });
    });

export const deleteDispatch = async ({ clientId, userId, id, dispatchId }) =>
    withTx(async (conn) => {
        const header = await getSalesOrderHeader(conn, { id, clientId: null });
        if (!header) throw new Error('Sales order not found');
        const scopeClientId = clientId ?? header.client_id;

        const dispatch = await getDispatchById(conn, { id: dispatchId });
        if (!dispatch) throw new Error('Dispatch record not found');
        if (Number(dispatch.sales_order_id) !== Number(id)) throw new Error('Dispatch record mismatch');

        const items = await getDispatchItems(conn, { dispatchId, clientId: scopeClientId });
        for (const it of items) {
            await conn.query(
                `UPDATE sales_order_items SET dispatched_quantity = dispatched_quantity - ? WHERE id = ?`,
                [Number(it.quantity), it.sales_order_item_id]
            );
        }

        await deleteDispatchHeader(conn, { id: dispatchId });

        const allItems = await getSalesOrderItems(conn, { salesOrderId: id, clientId: scopeClientId });
        let hasAnyDispatch = false;
        let allFullyDispatched = true;

        for (const item of allItems) {
            const disp = Number(item.dispatched_quantity || 0);
            const ordered = Number(item.ordered_quantity || item.quantity || 0);
            if (disp > 0) hasAnyDispatch = true;
            if (disp < ordered) allFullyDispatched = false;
        }

        let newStatus = 1; // Approved
        if (allFullyDispatched) newStatus = 9;
        else if (hasAnyDispatch) newStatus = 11;

        if (header.status_id !== newStatus) {
            await conn.query(`UPDATE sales_orders SET status_id = ?, updated_by = ?, updated_at = NOW() WHERE id = ?`, [
                newStatus,
                userId,
                id
            ]);
        }

        await insertAudit(conn, {
            client_id: scopeClientId,
            sales_order_id: id,
            action: 'DISPATCH_DELETED',
            old_status_id: header.status_id,
            new_status_id: newStatus,
            payload_json: { dispatch_id: dispatchId, vehicle_no: dispatch.vehicle_no },
            action_by: userId
        });
    });

export const completeOrder = async ({ clientId, userId, id, client_received_by, client_notes, files, payment_term_id, due_date, allocations }) =>
    withTx(async (conn) => {
        const header = await getSalesOrderHeader(conn, { id, clientId: null });
        if (!header) throw new Error('Sales order not found');
        const scopeClientId = clientId ?? header.client_id;
        if (![9, 12].includes(Number(header.status_id))) {
            throw new Error('Completion allowed only for dispatched or delivered orders');
        }

        if (!client_notes || !client_notes.trim()) {
            throw new Error('Remark (Notes) is mandatory for completion');
        }

        const filesList = Array.isArray(files) ? files : [];
        if (filesList.length === 0) {
            throw new Error('Proof of Delivery attachment is mandatory for completion');
        }

        // 1. Update allocations if provided (User requested: "allocated quantity can able to edit also")
        if (Array.isArray(allocations) && allocations.length > 0) {
            for (const alloc of allocations) {
                if (alloc.id && alloc.allocated_qty !== undefined) {
                    await conn.query(
                        `UPDATE sales_order_items SET dispatched_quantity = ? WHERE id = ? AND sales_order_id = ?`,
                        [Number(alloc.allocated_qty), alloc.id, id]
                    );
                }
            }
        }

        if (filesList.length) {
            const rows = filesList.map((file) => {
                const originalName = file.originalname || file.originalName || file.filename || 'completion_photo';
                const fileName = file.filename || file.originalname || file.originalName || `completion_${Date.now()}.jpg`;
                const filePath = file.file_path || file.path || `uploads/sales_orders/completion/${fileName}`;
                return [
                    id,
                    null, // dispatch_id (completion attachments have no dispatch)
                    'COMPLETION',
                    originalName,
                    fileName,
                    file.mimetype || file.mimeType || 'image/jpeg',
                    file.size != null ? Number(file.size) : 0,
                    filePath,
                    userId,
                    new Date()
                ];
            });
            await insertAttachments(conn, rows);
        }

        // 1.5 Determine warehouse_id from dispatch items (tied to AP Bill batches)
        const [dispatchWh] = await conn.query(`
            SELECT ab.warehouse_id 
            FROM sales_order_dispatch_items di
            JOIN ap_bill_lines abl ON di.ap_bill_line_id = abl.id
            JOIN ap_bills ab ON abl.bill_id = ab.id
            JOIN sales_order_dispatches d ON di.dispatch_id = d.id
            WHERE d.sales_order_id = ? LIMIT 1
        `, [id]);
        let finalWarehouseId = dispatchWh[0]?.warehouse_id || header.warehouse_id;

        if (!finalWarehouseId) {
            const [fallBackWh] = await conn.query('SELECT id FROM warehouses LIMIT 1');
            finalWarehouseId = fallBackWh[0]?.id || 1;
        }

        // 2. Updated status AND completion info in header (including payment terms, due date, warehouse)
        await conn.query(
            `UPDATE sales_orders 
             SET status_id = 10, 
                 client_received_by = ?, 
                 client_notes = ?, 
                 completed_by = ?, 
                 completed_at = NOW(),
                 payment_term_id = ?,
                 due_date = ?,
                 warehouse_id = ?,
                 updated_by = ?, 
                 updated_at = NOW() 
             WHERE id = ?`,
            [client_received_by || null, client_notes, userId, payment_term_id || null, due_date || null, finalWarehouseId, userId, id]
        );

        // 3. Auto-generate Customer Invoice (Submitted status 8)
        const [existingInvoices] = await conn.query('SELECT id FROM ar_invoices WHERE sales_order_id = ?', [id]);
        if (existingInvoices.length === 0) {
            // Re-fetch items to get latest dispatched_quantity and prices
            const items = await getSalesOrderItems(conn, { salesOrderId: id, clientId: scopeClientId });

            let invSubtotal = 0;
            let invTaxTotal = 0;
            let invGrandTotal = 0;
            const invoiceLines = [];

            for (const item of items) {
                const qty = Number(item.dispatched_quantity || 0);
                if (qty <= 0) continue;

                const rate = Number(item.unit_price || 0);
                const lineSubtotal = qty * rate;
                const taxRate = Number(item.tax_rate || 0);
                const lineTax = lineSubtotal * (taxRate / 100);
                const lineTotal = lineSubtotal + lineTax;

                invSubtotal += lineSubtotal;
                invTaxTotal += lineTax;
                invGrandTotal += lineTotal;

                invoiceLines.push({
                    ...item,
                    qty,
                    rate,
                    lineSubtotal,
                    lineTax,
                    lineTotal
                });
            }

            if (invoiceLines.length > 0) {
                const year = new Date().getFullYear();
                const invoiceNumber = await generateARInvoiceNumber(conn, {
                    year,
                    companyId: header.company_id || null,
                    date: new Date()
                });
                const invoiceUniqid = `ari_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

                // Full address from customer (vendor): address1, address2, city, state, postcode, country
                let customerAddress = header.billing_address || null;
                let deliveryAddress = header.shipping_address || null;
                try {
                    const [vendorRows] = await conn.query(
                        `SELECT 
                            va.bill_address_1, va.bill_address_2, va.bill_city, va.bill_zip_code,
                            vsa.ship_address_1, vsa.ship_address_2, vsa.ship_city, vsa.ship_zip_code,
                            bs.name AS bill_state_name, bc.name AS bill_country_name,
                            ss.name AS ship_state_name, sc.name AS ship_country_name
                         FROM vendor v
                         LEFT JOIN vendor_address va ON va.vendor_id = v.id
                         LEFT JOIN vendor_shipping_addresses vsa ON vsa.vendor_id = v.id AND vsa.is_primary = 1
                         LEFT JOIN state bs ON va.bill_state_id = bs.id
                         LEFT JOIN country bc ON va.bill_country_id = bc.id
                         LEFT JOIN state ss ON vsa.ship_state_id = ss.id
                         LEFT JOIN country sc ON vsa.ship_country_id = sc.id
                         WHERE v.id = ? LIMIT 1`,
                        [header.customer_id]
                    );
                    const v = vendorRows[0];
                    if (v) {
                        const billParts = [
                            v.bill_address_1,
                            v.bill_address_2,
                            [v.bill_city, v.bill_state_name, v.bill_zip_code].filter(Boolean).join(', '),
                            v.bill_country_name
                        ].filter(Boolean);
                        if (billParts.length) customerAddress = billParts.join('\n');
                        const shipParts = [
                            v.ship_address_1,
                            v.ship_address_2,
                            [v.ship_city, v.ship_state_name, v.ship_zip_code].filter(Boolean).join(', '),
                            v.ship_country_name
                        ].filter(Boolean);
                        if (shipParts.length) deliveryAddress = shipParts.join('\n');
                    }
                } catch (e) {
                    // keep header.billing_address / header.shipping_address if vendor fetch fails
                }

                const [invoiceResult] = await conn.query(`
                    INSERT INTO ar_invoices 
                    (invoice_uniqid, invoice_number, invoice_date, due_date, payment_terms_id, 
                     customer_id, company_id, warehouse_id, currency_id, subtotal, 
                     discount_type, discount_amount, tax_total, total, notes, 
                     customer_address, delivery_address,
                     sales_order_id, sales_order_number, user_id, status_id)
                    VALUES (?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 8)
                `, [
                    invoiceUniqid, invoiceNumber, due_date || null, payment_term_id || null,
                    header.customer_id, header.company_id, finalWarehouseId, header.currency_id,
                    invSubtotal, 'fixed', 0, invTaxTotal, invGrandTotal, client_notes || null,
                    customerAddress, deliveryAddress,
                    id, header.order_no, userId
                ]);

                const invoiceId = invoiceResult.insertId;

                for (let i = 0; i < invoiceLines.length; i++) {
                    const line = invoiceLines[i];
                    const [lineResult] = await conn.query(`
                        INSERT INTO ar_invoice_lines 
                        (invoice_id, line_no, product_id, item_name, description, quantity, uom_id, rate, tax_id, tax_rate, line_total)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `, [invoiceId, i + 1, line.product_id, line.product_name, line.description, line.qty, line.uom_id, line.rate, line.tax_id, line.tax_rate, line.lineTotal]);

                    const lineId = lineResult.insertId;

                    // Get batch allocations from dispatches (ap_bill_line_batches)
                    let [dispatchBatches] = await conn.query(`
                        SELECT di.ap_bill_line_id, di.quantity, ablb.batch_id, abl.rate as unit_cost
                        FROM sales_order_dispatch_items di
                        JOIN ap_bill_lines abl ON di.ap_bill_line_id = abl.id
                        JOIN sales_order_dispatches d ON di.dispatch_id = d.id
                        LEFT JOIN ap_bill_line_batches ablb ON ablb.bill_line_id = di.ap_bill_line_id
                        WHERE d.sales_order_id = ? AND di.sales_order_item_id = ?
                        GROUP BY di.ap_bill_line_id
                    `, [id, line.id]);

                    // Fallback: if no batches from dispatch (e.g. ap_bill_line_id was null, or product without purchase bills),
                    // allocate from current inventory stock (FIFO) so approval can proceed
                    if (!dispatchBatches || dispatchBatches.length === 0) {
                        const [stockBatches] = await conn.query(`
                            SELECT isb.batch_id, isb.qty_on_hand, isb.unit_cost
                            FROM inventory_stock_batches isb
                            WHERE isb.product_id = ? AND isb.warehouse_id = ? AND isb.qty_on_hand > 0
                            ORDER BY isb.id ASC
                        `, [line.product_id, finalWarehouseId]);
                        let remaining = Number(line.qty || 0);
                        for (const sb of stockBatches || []) {
                            if (remaining <= 0) break;
                            const take = Math.min(remaining, parseFloat(sb.qty_on_hand || 0));
                            if (take <= 0) continue;
                            await conn.query(`
                                INSERT INTO ar_invoice_line_batches 
                                (invoice_line_id, batch_id, quantity, unit_cost)
                                VALUES (?, ?, ?, ?)
                            `, [lineId, sb.batch_id, take, sb.unit_cost || line.rate || 0]);
                            remaining -= take;
                        }
                    } else {
                        for (const dbat of dispatchBatches) {
                            const bId = dbat.batch_id || dbat.ap_bill_line_id;
                            await conn.query(`
                                INSERT INTO ar_invoice_line_batches 
                                (invoice_line_id, batch_id, quantity, unit_cost)
                                VALUES (?, ?, ?, ?)
                            `, [lineId, bId, dbat.quantity, dbat.unit_cost || 0]);
                        }
                    }
                }

                // Add history for the new invoice
                await conn.query(
                    'INSERT INTO history (module, module_id, user_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
                    ['ar_invoice', invoiceId, userId, 'CREATED', JSON.stringify({
                        invoice_number: invoiceNumber,
                        sales_order_id: id,
                        reason: 'Auto-generated on Sales Order completion'
                    })]
                );
            }
        }

        await insertAudit(conn, {
            client_id: scopeClientId,
            sales_order_id: id,
            action: 'COMPLETED',
            old_status_id: 9,
            new_status_id: 10,
            payload_json: { client_notes, attachments: filesList.length },
            action_by: userId
        });
    });

export const requestEditOrder = async ({ clientId, userId, id, reason }) =>
    withTx(async (conn) => {
        const header = await getSalesOrderHeader(conn, { id, clientId: null });
        if (!header) throw new Error('Sales order not found');
        const scopeClientId = clientId ?? header.client_id;

        if (![8, 9, 12, 15].includes(Number(header.status_id))) {
            throw new Error('Edit request not allowed for this status');
        }

        await conn.query(
            `UPDATE sales_orders 
                SET edit_request_status = 'pending', 
                    edit_request_reason = ?, 
                    edit_requested_at = NOW(), 
                    edit_requested_by = ?,
                    updated_by = ?,
                    updated_at = NOW()
                WHERE id = ?`,
            [reason, userId, userId, id]
        );

        await insertAudit(conn, {
            client_id: scopeClientId,
            sales_order_id: id,
            action: 'EDIT_REQUESTED',
            old_status_id: header.status_id,
            new_status_id: header.status_id,
            payload_json: { reason, order_no: header.order_no },
            action_by: userId
        });
    });

export const decideEditRequest = async ({ clientId, userId, id, decision, reason }) =>
    withTx(async (conn) => {
        const header = await getSalesOrderHeader(conn, { id, clientId: null });
        if (!header) throw new Error('Sales order not found');
        const scopeClientId = clientId ?? header.client_id;
        if (header.edit_request_status !== 'pending') throw new Error('No pending edit request found');

        const isApproved = decision === 'approve';
        const newStatus = isApproved ? 3 : header.status_id;
        const newEditRequestStatus = isApproved ? null : 'rejected';

        await conn.query(
            `UPDATE sales_orders 
                SET edit_request_status = ?, 
                    edit_request_decision_reason = ?,
                    edit_request_reason = ?,
                    edit_requested_by = ?,
                    edit_requested_at = ?,
                    status_id = ?,
                    updated_by = ?,
                    updated_at = NOW()
                WHERE id = ?`,
            [newEditRequestStatus, reason || null, isApproved ? null : header.edit_request_reason, isApproved ? null : header.edit_requested_by, isApproved ? null : header.edit_requested_at, newStatus, userId, id]
        );

        await insertAudit(conn, {
            client_id: scopeClientId,
            sales_order_id: id,
            action: isApproved ? 'EDIT_REQUEST_APPROVED' : 'EDIT_REQUEST_REJECTED',
            old_status_id: header.status_id,
            new_status_id: newStatus,
            payload_json: { decision_reason: reason, order_no: header.order_no },
            action_by: userId
        });
    });

export const rejectOrder = async ({ clientId, userId, id, reason }) =>
    withTx(async (conn) => {
        const header = await getSalesOrderHeader(conn, { id, clientId: null });
        if (!header) throw new Error('Sales order not found');
        const scopeClientId = clientId ?? header.client_id;
        if (Number(header.status_id) !== 8) throw new Error('Only submitted orders can be rejected');

        await conn.query(`UPDATE sales_orders SET status_id = 2, updated_by = ?, updated_at = NOW() WHERE id = ?`, [
            userId,
            id
        ]);

        await insertAudit(conn, {
            client_id: scopeClientId,
            sales_order_id: id,
            action: 'REJECTED',
            old_status_id: 8,
            new_status_id: 2,
            payload_json: { reason, order_no: header.order_no },
            action_by: userId
        });
    });

/** List distinct vehicle names for dispatch dropdown (from sales_dispatch_vehicle_driver, not fleet) */
export const listDispatchVehicles = async ({ clientId }) => {
    const conn = await db.promise().getConnection();
    try {
        return await getDispatchVehicles(conn, { clientId });
    } catch (err) {
        // Table may not exist yet; return empty so UI does not 500
        console.warn('[listDispatchVehicles]', err?.message || err);
        return [];
    } finally {
        conn.release();
    }
};

/** List distinct driver names for a vehicle (from sales_dispatch_vehicle_driver, not driver master) */
export const listDispatchDriversByVehicle = async ({ clientId, vehicleName }) => {
    const conn = await db.promise().getConnection();
    try {
        return await getDispatchDriversByVehicle(conn, { clientId, vehicleName: vehicleName || '' });
    } catch (err) {
        console.warn('[listDispatchDriversByVehicle]', err?.message || err);
        return [];
    } finally {
        conn.release();
    }
};

export const getClientContext = async (req) => {
    const fallbackHeader = req.headers?.['x-client-id'] || req.headers?.['x-tenant-id'];
    const clientId =
        req.user?.client_id ??
        req.user?.company_id ??
        req.user?.entity_id ??
        req.query?.company_id ??
        req.body?.company_id ??
        fallbackHeader ??
        null;

    // Default to 1 if not found, assuming single tenant or default tenant
    if (!clientId || isNaN(Number(clientId))) {
        return 1;
    }
    return Number(clientId);
};

/** Preview next order number without consuming the sequence (for form display). */
export const previewNextSequence = async ({ clientId, companyId, orderDate }) => {
    const conn = await db.promise().getConnection();
    try {
        const date = orderDate ? new Date(orderDate) : new Date();
        const yyyy = date.getFullYear();
        const mm = date.getMonth() + 1;
        const yy = Number(String(yyyy).slice(-2));
        const cId = Number(clientId);
        const coId = Number(companyId);

        const [rows] = await conn.query(
            `SELECT last_seq FROM sales_order_sequences
              WHERE client_id = ? AND company_id = ? AND yy = ? AND mm = ?`,
            [cId, coId, yy, mm]
        );

        const nextSeq = (rows.length && rows[0].last_seq != null ? Number(rows[0].last_seq) : 0) + 1;
        const { prefix, format } = await fetchSalesOrderFormat(conn, coId);
        return buildOrderNoFromFormat(prefix, format, yy, yyyy, mm, nextSeq);
    } catch (err) {
        // Fallback if sales_order_sequences table missing or DB error (e.g. migration not run)
        const date = orderDate ? new Date(orderDate) : new Date();
        const yy = Number(String(date.getFullYear()).slice(-2));
        const mm = date.getMonth() + 1;
        return buildOrderNoFromFormat('SO', null, yy, date.getFullYear(), mm, 1);
    } finally {
        try {
            conn.release();
        } catch (_) {
            // ignore release errors
        }
    }
};
