import db from '../../../db.js';
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
    deleteAttachment
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

/** Build order number from master format template or legacy. Placeholders: {prefix}, {YY}, {YYYY}, {MM}, {seq} */
const buildOrderNoFromFormat = (prefix, format, yy, yyyy, mm, nextSeq) => {
    const MM = String(mm).padStart(2, '0');
    const YY = String(yy).padStart(2, '0');
    const seq = pad(nextSeq, 3);
    if (format && format.length > 0) {
        return format
            .replace(/\{prefix\}/gi, prefix || 'SO')
            .replace(/\{YYYY\}/g, String(yyyy))
            .replace(/\{YY\}/g, YY)
            .replace(/\{MM\}/g, MM)
            .replace(/\{seq\}/gi, seq);
    }
    return `${prefix || 'SO'}SO-${YY}-${MM}-${seq}`;
};

const generateOrderNo = async (conn, { clientId, companyId, orderDate }) => {
    const date = orderDate ? new Date(orderDate) : new Date();
    const yyyy = date.getFullYear();
    const mm = date.getMonth() + 1;
    const yy = Number(String(yyyy).slice(-2));

    // Ensure a row exists for this client, company, year, month (last_seq 0)
    await conn.query(
        `INSERT IGNORE INTO sales_order_sequences (client_id, company_id, yy, mm, last_seq)
         VALUES (?, ?, ?, ?, 0)`,
        [clientId, companyId, yy, mm]
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

export const getOrderDetail = async ({ id, clientId }) => {
    const conn = await db.promise().getConnection();
    try {
        const header = await getSalesOrderHeader(conn, { id, clientId });
        if (!header) return null;
        const [items, attachments, approval, audit, dispatches] = await Promise.all([
            getSalesOrderItems(conn, { salesOrderId: header.id, clientId }),
            getSalesOrderAttachments(conn, { salesOrderId: header.id, clientId }),
            getSalesOrderApproval(conn, { salesOrderId: header.id, clientId }),
            getSalesOrderAudit(conn, { salesOrderId: header.id, clientId }),
            getSalesOrderDispatches(conn, { salesOrderId: header.id, clientId })
        ]);

        const enrichedDispatches = await Promise.all(dispatches.map(async (d) => {
            const dItems = await getDispatchItems(conn, { dispatchId: d.id, clientId });
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
            sales_person_id: payload.sales_person_id || null
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
        const header = await getSalesOrderHeader(conn, { id, clientId });
        if (!header) throw new Error('Sales order not found');
        // If order is not a draft, change it to draft to allow editing
        if (Number(header.status_id) !== 3) {
            const oldStatus = header.status_id;
            await conn.query(`UPDATE sales_orders SET status_id = ?, updated_by = ?, updated_at = NOW() WHERE id = ? AND client_id = ?`, [
                3,
                userId,
                id,
                clientId
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
            // Refresh header for subsequent operations
            // (we don't strictly need all refreshed fields, but keep consistent)
            // Note: getSalesOrderHeader reads from DB, so re-fetch
            // to keep `header` values used later in audit/payload accurate.
            // eslint-disable-next-line no-param-reassign
            // (reassigning header variable is acceptable here)
            // eslint-disable-next-line prefer-const
            // fetch new header
            const refreshed = await getSalesOrderHeader(conn, { id, clientId });
            if (refreshed) Object.assign(header, refreshed);
        }

        const changes = computeHeaderDiff(header, payload);

        await updateSalesOrderHeader(conn, {
            id,
            client_id: clientId,
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
            sales_person_id: payload.sales_person_id !== undefined ? payload.sales_person_id : header.sales_person_id
        });

        if (changes.length > 0) {
            await insertAudit(conn, {
                client_id: clientId,
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
        const header = await getSalesOrderHeader(conn, { id, clientId });
        if (!header) throw new Error('Sales order not found');
        // If order is not a draft, change it to draft to allow editing
        if (Number(header.status_id) !== 3) {
            const oldStatus = header.status_id;
            await conn.query(`UPDATE sales_orders SET status_id = ?, updated_by = ?, updated_at = NOW() WHERE id = ? AND client_id = ?`, [
                3,
                userId,
                id,
                clientId
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
            const refreshed = await getSalesOrderHeader(conn, { id, clientId });
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
        const header = await getSalesOrderHeader(conn, { id, clientId });
        if (!header) throw new Error('Sales order not found');
        // Allow attachments in drafts, submitted, maybe even dispatched?
        // Requirement says "available in Draft and Submitted for Approval".
        // Also Completion creates new attachments.

        const rows = files.map((file) => [
            clientId,
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
            client_id: clientId,
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
        const header = await getSalesOrderHeader(conn, { id, clientId });
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
        const header = await getSalesOrderHeader(conn, { id, clientId });
        if (!header) throw new Error('Sales order not found');
        if (Number(header.status_id) !== 3) throw new Error('Only drafts can be submitted');

        const items = await getSalesOrderItems(conn, { salesOrderId: id, clientId });
        if (!items.length) throw new Error('At least 1 item is required before submit');

        let finalOrderNo = header.order_no;
        const needsOrderNo = !header.order_no || String(header.order_no).toUpperCase() === 'XXX';
        if (needsOrderNo) {
            finalOrderNo = await generateOrderNo(conn, {
                clientId,
                companyId: header.company_id,
                orderDate: header.order_date
            });
            await conn.query(
                `UPDATE sales_orders SET order_no = ?, status_id = 8, updated_by = ?, updated_at = NOW() WHERE id = ? AND client_id = ?`,
                [finalOrderNo, userId, id, clientId]
            );
        } else {
            await conn.query(
                `UPDATE sales_orders SET status_id = 8, updated_by = ?, updated_at = NOW() WHERE id = ? AND client_id = ?`,
                [userId, id, clientId]
            );
        }

        await insertAudit(conn, {
            client_id: clientId,
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
        const header = await getSalesOrderHeader(conn, { id, clientId });
        if (!header) throw new Error('Sales order not found');
        if (Number(header.status_id) !== 8) throw new Error('Only submitted orders can be approved');

        await conn.query(`UPDATE sales_orders SET status_id = 1, updated_by = ?, updated_at = NOW() WHERE id = ? AND client_id = ?`, [
            userId,
            id,
            clientId
        ]);

        await insertAudit(conn, {
            client_id: clientId,
            sales_order_id: id,
            action: 'APPROVED',
            old_status_id: 8,
            new_status_id: 1,
            payload_json: { comment, order_no: header.order_no },
            action_by: userId
        });
    });

export const dispatchOrder = async ({ clientId, userId, id, dispatch_id, vehicle_no, driver_name, files, items: dispatchPayload }) =>
    withTx(async (conn) => {
        const header = await getSalesOrderHeader(conn, { id, clientId });
        if (!header) throw new Error('Sales order not found');

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
            // EDIT MODE: Update existing header and reverse old quantities
            await updateDispatchHeader(conn, { id: activeDispatchId, vehicle_no, driver_name, client_id: clientId });

            const oldItems = await getDispatchItems(conn, { dispatchId: activeDispatchId, clientId });
            for (const oi of oldItems) {
                await conn.query(
                    `UPDATE sales_order_items SET dispatched_quantity = dispatched_quantity - ? WHERE id = ? AND client_id = ?`,
                    [Number(oi.quantity), oi.sales_order_item_id, clientId]
                );
            }
            await deleteDispatchItems(conn, { dispatchId: activeDispatchId, clientId });
        } else {
            // NEW DISPATCH mode
            activeDispatchId = await insertDispatchHeader(conn, {
                client_id: clientId,
                sales_order_id: id,
                vehicle_no,
                driver_name,
                dispatched_by: userId
            });
        }

        const dispatchHistory = [];
        const aggregateQtyByItemId = {};

        for (const p of normalizedPayload) {
            const qty = Number(p.dispatch_qty || 0);
            if (qty <= 0) continue;

            dispatchHistory.push([clientId, activeDispatchId, p.id, qty]);
            aggregateQtyByItemId[p.id] = (aggregateQtyByItemId[p.id] || 0) + qty;
        }

        if (dispatchHistory.length > 0) {
            await insertDispatchItems(conn, dispatchHistory);
        }

        // Apply new quantities and determine status
        const existingItems = await getSalesOrderItems(conn, { salesOrderId: id, clientId });
        let allFullyDispatched = true;

        for (const item of existingItems) {
            const addedInThisUpdate = Number(aggregateQtyByItemId[item.id] || 0);
            const currentTotal = Number(item.dispatched_quantity || 0) + (activeDispatchId ? 0 : 0);
            // NOTE: item.dispatched_quantity from getSalesOrderItems MIGHT NOT be updated yet because we ran update queries individually.
            // Let's fetch fresh item data or just update and then decide.

            await updateItemDispatchedQuantity(conn, {
                id: item.id,
                dispatched_quantity: Number(item.dispatched_quantity || 0) + addedInThisUpdate,
                clientId
            });

            const ordered = Number(item.ordered_quantity || item.quantity || 0);
            if (Number(item.dispatched_quantity || 0) + addedInThisUpdate < ordered) {
                allFullyDispatched = false;
            }
        }

        if (files.length) {
            const rows = files.map((file) => [
                clientId,
                id,
                activeDispatchId,
                'DISPATCH',
                file.originalname,
                file.filename,
                file.mimetype,
                file.size,
                file.file_path,
                userId,
                new Date()
            ]);
            await insertAttachments(conn, rows);
        }

        const newStatus = allFullyDispatched ? 9 : 11;
        await conn.query(
            `UPDATE sales_orders SET status_id = ?, updated_by = ?, updated_at = NOW() WHERE id = ? AND client_id = ?`,
            [newStatus, userId, id, clientId]
        );

        await insertAudit(conn, {
            client_id: clientId,
            sales_order_id: id,
            action: dispatch_id ? 'DISPATCH_UPDATED' : (allFullyDispatched ? 'DISPATCHED' : 'PARTIALLY_DISPATCHED'),
            old_status_id: header.status_id,
            new_status_id: newStatus,
            payload_json: {
                dispatch_id: activeDispatchId,
                vehicle_no,
                driver_name,
                is_edit: !!dispatch_id
            },
            action_by: userId
        });
    });

export const markAsDelivered = async ({ clientId, userId, id, comment }) =>
    withTx(async (conn) => {
        const header = await getSalesOrderHeader(conn, { id, clientId });
        if (!header) throw new Error('Sales order not found');
        if (Number(header.status_id) !== 9) throw new Error('Only fully dispatched orders can be marked delivered');

        await conn.query(`UPDATE sales_orders SET status_id = 12, updated_by = ?, updated_at = NOW() WHERE id = ? AND client_id = ?`, [
            userId,
            id,
            clientId
        ]);

        await insertAudit(conn, {
            client_id: clientId,
            sales_order_id: id,
            action: 'MARKED_DELIVERED',
            old_status_id: 9,
            new_status_id: 12,
            payload_json: { comment },
            action_by: userId
        });
    });

export const deleteDispatch = async ({ clientId, userId, id, dispatchId }) =>
    withTx(async (conn) => {
        const header = await getSalesOrderHeader(conn, { id, clientId });
        if (!header) throw new Error('Sales order not found');

        const dispatch = await getDispatchById(conn, { id: dispatchId, clientId });
        if (!dispatch) throw new Error('Dispatch record not found');
        if (Number(dispatch.sales_order_id) !== Number(id)) throw new Error('Dispatch record mismatch');

        // 1. Reverse quantities
        const items = await getDispatchItems(conn, { dispatchId, clientId });
        for (const it of items) {
            await conn.query(
                `UPDATE sales_order_items SET dispatched_quantity = dispatched_quantity - ? WHERE id = ? AND client_id = ?`,
                [Number(it.quantity), it.sales_order_item_id, clientId]
            );
        }

        // 2. Delete dispatch (cascades to items)
        await deleteDispatchHeader(conn, { id: dispatchId, clientId });

        // 3. Re-calculate order status
        const allItems = await getSalesOrderItems(conn, { salesOrderId: id, clientId });
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
            await conn.query(`UPDATE sales_orders SET status_id = ?, updated_by = ?, updated_at = NOW() WHERE id = ? AND client_id = ?`, [
                newStatus,
                userId,
                id,
                clientId
            ]);
        }

        await insertAudit(conn, {
            client_id: clientId,
            sales_order_id: id,
            action: 'DISPATCH_DELETED',
            old_status_id: header.status_id,
            new_status_id: newStatus,
            payload_json: { dispatch_id: dispatchId, vehicle_no: dispatch.vehicle_no },
            action_by: userId
        });
    });

export const completeOrder = async ({ clientId, userId, id, client_received_by, client_notes, files }) =>
    withTx(async (conn) => {
        const header = await getSalesOrderHeader(conn, { id, clientId });
        if (!header) throw new Error('Sales order not found');
        if (Number(header.status_id) !== 9) throw new Error('Completion allowed only for dispatched orders');

        if (files.length) {
            const rows = files.map((file) => [
                clientId,
                id,
                null, // dispatch_id (completion attachments have no dispatch)
                'COMPLETION',
                file.originalname,
                file.filename,
                file.mimetype,
                file.size,
                file.file_path,
                userId,
                new Date()
            ]);
            await insertAttachments(conn, rows);
        }

        // Updated status AND completion info in header
        await conn.query(
            `UPDATE sales_orders 
             SET status_id = 10, 
                 client_received_by = NULL, 
                 client_notes = ?, 
                 completed_by = ?, 
                 completed_at = NOW(),
                 updated_by = ?, 
                 updated_at = NOW() 
             WHERE id = ? AND client_id = ?`,
            [client_notes, userId, userId, id, clientId]
        );

        await insertAudit(conn, {
            client_id: clientId,
            sales_order_id: id,
            action: 'COMPLETED',
            old_status_id: 9,
            new_status_id: 10,
            payload_json: { client_notes, attachments: files.length },
            action_by: userId
        });
    });

export const requestEditOrder = async ({ clientId, userId, id, reason }) =>
    withTx(async (conn) => {
        const header = await getSalesOrderHeader(conn, { id, clientId });
        if (!header) throw new Error('Sales order not found');

        // Allow request edit if status is 8 (Submitted) or 9 (Dispatched) or 15 (Completed) 
        // User asked for "once id 9 then instead of edit reedit request option"
        // But usually it's allowed for any confirmed status.
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
                WHERE id = ? AND client_id = ?`,
            [reason, userId, userId, id, clientId]
        );

        await insertAudit(conn, {
            client_id: clientId,
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
        const header = await getSalesOrderHeader(conn, { id, clientId });
        if (!header) throw new Error('Sales order not found');
        if (header.edit_request_status !== 'pending') throw new Error('No pending edit request found');

        const isApproved = decision === 'approve';
        const newStatus = isApproved ? 3 : header.status_id; // approved -> Draft (3), rejected -> keep current
        // When approved, reset edit_request_status to null so it clears from the list
        // When rejected, set to 'rejected' to keep history
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
                WHERE id = ? AND client_id = ?`,
            [newEditRequestStatus, reason || null, isApproved ? null : header.edit_request_reason, isApproved ? null : header.edit_requested_by, isApproved ? null : header.edit_requested_at, newStatus, userId, id, clientId]
        );

        await insertAudit(conn, {
            client_id: clientId,
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
        const header = await getSalesOrderHeader(conn, { id, clientId });
        if (!header) throw new Error('Sales order not found');
        if (Number(header.status_id) !== 8) throw new Error('Only submitted orders can be rejected');

        await conn.query(`UPDATE sales_orders SET status_id = 2, updated_by = ?, updated_at = NOW() WHERE id = ? AND client_id = ?`, [
            userId,
            id,
            clientId
        ]);

        await insertAudit(conn, {
            client_id: clientId,
            sales_order_id: id,
            action: 'REJECTED',
            old_status_id: 8,
            new_status_id: 2,
            payload_json: { reason, order_no: header.order_no },
            action_by: userId
        });
    });

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
