import db from '../../../db.js';
import crypto from 'crypto';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { generateARInvoiceNumber, generateAPBillNumber } = require('../../utils/docNo.cjs');
const inventoryService = require('../inventory/inventory.service.cjs');

/** Must match `inventory_transactions.source_type` for rows tied to a sales order (approval IN TRANSIT, etc.). */
const INV_SOURCE_TYPE_SALES_ORDER = 'SALES_ORDER';
const INV_TXN_TYPE_SALES_ORDER_IN_TRANSIT = 'SALES_ORDER_IN_TRANSIT';

/**
 * Soft-delete all inventory rows for this sales order as `source_id` (SO-linked only).
 * `source_id` on inventory_transactions is the sales order id for approval IN TRANSIT rows.
 * Does not touch rows with other source_type (e.g. SALES_DISPATCH uses dispatch id as source_id).
 */
async function softDeleteSalesOrderInTransitInventory(conn, salesOrderId) {
    await conn.query(
        `UPDATE inventory_transactions SET is_deleted = 1
         WHERE source_id = ?
           AND (is_deleted = 0 OR is_deleted IS NULL)
           AND (
                source_type = ?
             OR source_type IS NULL
             OR TRIM(source_type) = ''
           )`,
        [salesOrderId, INV_SOURCE_TYPE_SALES_ORDER]
    );
}

/**
 * On dispatch: reduce SALES_ORDER IN TRANSIT informational qty for the line.
 * On dispatch revert/delete: add it back (reactivate row if it was zeroed).
 */
async function adjustSalesOrderInTransitForLine(conn, { salesOrderId, salesOrderItemId, qty, mode, soItem }) {
    const delta = Number(qty);
    if (!Number.isFinite(delta) || delta <= 0) return;

    const [rows] = await conn.query(
        `SELECT id, qty, unit_cost, currency_id, exchange_rate, is_deleted
         FROM inventory_transactions
         WHERE source_type = ?
           AND source_id = ?
           AND source_line_id = ?
           AND txn_type = ?
         ORDER BY id DESC
         LIMIT 1`,
        [INV_SOURCE_TYPE_SALES_ORDER, salesOrderId, salesOrderItemId, INV_TXN_TYPE_SALES_ORDER_IN_TRANSIT]
    );
    const row = rows[0];
    if (!row) return;

    const orderedCap = soItem != null ? Number(soItem.ordered_quantity ?? soItem.quantity ?? 0) : null;
    const curActive = Number(row.is_deleted) === 1 ? 0 : Number(row.qty || 0);

    if (mode === 'consume' && Number(row.is_deleted) === 1) return;

    let newQty;
    if (mode === 'consume') {
        newQty = Math.max(0, curActive - delta);
    } else {
        const cap = orderedCap != null && Number.isFinite(orderedCap) && orderedCap > 0 ? orderedCap : curActive + delta;
        newQty = Math.min(cap, curActive + delta);
    }

    const ucost = Number(row.unit_cost || 0);
    const amount = newQty * ucost;
    const ex = row.exchange_rate != null ? Number(row.exchange_rate) : null;
    const finalForeign = amount;
    const finalTotal = ex != null && Number.isFinite(ex) && ex > 0 ? amount * ex : amount;

    if (newQty <= 1e-9) {
        await conn.query(
            `UPDATE inventory_transactions
             SET is_deleted = 1, qty = 0, amount = 0, foreign_amount = 0, total_amount = 0
             WHERE id = ?`,
            [row.id]
        );
    } else {
        await conn.query(
            `UPDATE inventory_transactions
             SET is_deleted = 0,
                 qty = ?,
                 amount = ?,
                 foreign_amount = ?,
                 total_amount = ?
             WHERE id = ?`,
            [newQty, amount, finalForeign, finalTotal, row.id]
        );
    }
}

/** Default supplier (vendor master id) for draft AP bills created from dispatch when user confirms — Bynur Agro Trading Llc */
const NURAGRO_DISPATCH_SUPPLIER_ID = 121;

/**
 * Warehouse for dispatch inventory rows: prefer SO header, else AP bill from the dispatch line, else first warehouse.
 * Prevents NULL warehouse_id when the order header has no warehouse (common on mobile) but batches carry warehouse on the bill.
 */
async function resolveWarehouseIdForDispatchLine(conn, headerWarehouseId, apBillLineId) {
    const hw = headerWarehouseId != null && headerWarehouseId !== '' ? Number(headerWarehouseId) : null;
    if (Number.isFinite(hw) && hw > 0) return hw;

    if (apBillLineId != null && apBillLineId !== '') {
        const [rows] = await conn.query(
            `SELECT ab.warehouse_id AS wid
             FROM ap_bill_lines abl
             JOIN ap_bills ab ON abl.bill_id = ab.id
             WHERE abl.id = ?
             LIMIT 1`,
            [apBillLineId]
        );
        const wid = rows[0]?.wid;
        if (wid != null && Number(wid) > 0) return Number(wid);
    }

    const [fall] = await conn.query('SELECT id FROM warehouses ORDER BY id ASC LIMIT 1');
    const fallback = fall[0]?.id;
    if (fallback != null && Number(fallback) > 0) return Number(fallback);

    return null;
}

/** Comma-separated company ids on vendor.customer_of */
function parseVendorCustomerOfIds(raw) {
    return String(raw ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((id) => Number(id))
        .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * Bill company_id: prefer sales order company when valid; if SO has no company, use vendor customer_of;
 * if SO company is not in vendor list, use first vendor company so the bill still ties to an entity the vendor serves.
 */
function resolveApBillCompanyIdFromVendorAndOrder(vendorCustomerOfRaw, salesOrderCompanyId) {
    const vendorIds = parseVendorCustomerOfIds(vendorCustomerOfRaw);
    const soCo =
        salesOrderCompanyId != null && salesOrderCompanyId !== '' && Number.isFinite(Number(salesOrderCompanyId))
            ? Number(salesOrderCompanyId)
            : null;

    if (soCo != null) {
        if (vendorIds.length === 0 || vendorIds.includes(soCo)) {
            return soCo;
        }
        return vendorIds[0] ?? soCo;
    }
    return vendorIds[0] ?? null;
}

/**
 * Create one draft ap_bills + ap_bill_lines (+ batches) for dispatch lines that need a purchase bill but none was selected.
 * Mutates nothing; returns new line ids keyed by payload row index.
 */
async function createDraftNuragroPurchaseBillForDispatch(conn, {
    header,
    normalizedPayload,
    existingItems,
    batchInfoForOrder,
    userId,
    supplierId = NURAGRO_DISPATCH_SUPPLIER_ID
}) {
    const lineRows = [];
    const batchItems = batchInfoForOrder?.items || [];

    for (let idx = 0; idx < normalizedPayload.length; idx++) {
        const p = normalizedPayload[idx];
        const qty = Number(p.dispatch_qty || 0);
        if (qty <= 0) continue;
        if (p.ap_bill_line_id) continue;
        const soItem = existingItems.find((it) => Number(it.id) === Number(p.id));
        if (!soItem) continue;
        const prodInfo = batchItems.find((x) => Number(x.product_id) === Number(soItem.product_id));
        const batches = prodInfo?.batches || [];
        if (batches.length === 0) continue;

        const rate = Number(soItem.unit_price || 0);
        const taxRate = Number(soItem.tax_rate || 0);
        const lineSub = qty * rate;
        const lineTax = lineSub * (taxRate / 100);
        const lineTotal = lineSub + lineTax;
        lineRows.push({ idx, soItem, qty, rate, taxRate, lineSub, lineTax, lineTotal });
    }

    if (lineRows.length === 0) {
        return { billId: null, lineIdByPayloadIndex: new Map() };
    }

    const [[vendorRow]] = await conn.query(`SELECT id, customer_of FROM vendor WHERE id = ? LIMIT 1`, [supplierId]);
    if (!vendorRow) {
        throw new Error(`Vendor ${supplierId} not found`);
    }

    const billNumber = await generateAPBillNumber(conn);
    const bill_uniqid = `pb_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const billDate = new Date().toISOString().slice(0, 10);
    const warehouseId = header.warehouse_id || null;
    const currencyId = header.currency_id || null;
    const companyId = resolveApBillCompanyIdFromVendorAndOrder(vendorRow.customer_of, header.company_id);
    const salesOrderId = Number(header.id);
    const orderNo =
        header.order_no != null && String(header.order_no).trim() !== ''
            ? String(header.order_no).trim()
            : String(salesOrderId);

    let subtotal = 0;
    let taxTotal = 0;
    lineRows.forEach((r) => {
        subtotal += r.lineSub;
        taxTotal += r.lineTax;
    });
    const total = subtotal + taxTotal;

    const billNotes = [
        'Draft: Bynur Agro Trading Llc (Nuragro) — dispatch linkage',
        `Sales order no: ${orderNo}`,
        `Purchase bill no: ${billNumber}`
    ].join('\n');

    const [insBill] = await conn.query(
        `INSERT INTO ap_bills (is_service, bill_uniqid, bill_number, bill_date, company_id, supplier_id, warehouse_id, currency_id, sales_order_id, subtotal, tax_total, total, open_balance, status_id, user_id, notes)
         VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 3, ?, ?)`,
        [
            bill_uniqid,
            billNumber,
            billDate,
            companyId,
            supplierId,
            warehouseId,
            currencyId,
            Number.isFinite(salesOrderId) ? salesOrderId : null,
            subtotal,
            taxTotal,
            total,
            total,
            userId,
            billNotes
        ]
    );
    const billId = insBill.insertId;

    const lineIdByPayloadIndex = new Map();
    let lineNo = 1;

    for (const row of lineRows) {
        const { soItem, qty, rate, taxRate, lineTotal, idx } = row;
        const [[prod]] = await conn.query(`SELECT product_name FROM products WHERE id = ? LIMIT 1`, [soItem.product_id]);
        const itemName = prod?.product_name || soItem.product_name || 'Product';

        const lineLinkage = `Sales order ${orderNo} · ${itemName}`;
        const lineDescription =
            soItem.description != null && String(soItem.description).trim() !== ''
                ? `${lineLinkage} | ${String(soItem.description).trim()}`
                : lineLinkage;

        const [insLine] = await conn.query(
            `INSERT INTO ap_bill_lines (bill_id, line_no, product_id, item_name, description, quantity, uom_id, rate, tax_id, tax_rate, line_total)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                billId,
                lineNo,
                soItem.product_id,
                itemName,
                lineDescription,
                qty,
                soItem.uom_id || null,
                rate,
                soItem.tax_id || null,
                taxRate,
                lineTotal
            ]
        );
        const billLineId = insLine.insertId;
        lineIdByPayloadIndex.set(idx, billLineId);
        lineNo += 1;

        const batchNo = `DN-${billId}-${billLineId}`;
        await conn.query(
            `INSERT INTO ap_bill_line_batches (bill_line_id, batch_no, quantity, unit_cost) VALUES (?, ?, ?, ?)`,
            [billLineId, batchNo, qty, rate]
        );
    }

    return { billId, lineIdByPayloadIndex };
}

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
    getDispatchBatchInfo,
    getSalesOrderInventoryTransactions,
    getSalesOrderReturns
} from './salesOrder.repo.js';
import fs from 'fs';
import { normalizeTaxMode } from './salesOrder.validators.js';
import { buildDeliveryOrderHtml, htmlToA5PdfBuffer, escapeHtml } from './deliveryOrderPdf.util.js';

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

/** Cargo return submitted (8) or QC pending (4) blocks completing the sales order until resolved. */
function blockCompleteDueToCargoReturnQc(returns) {
    if (!Array.isArray(returns) || !returns.length) return false;
    return returns.some((r) => {
        const st = Number(r.status_id);
        const qc = Number(r.qc_status_id);
        return st === 8 || qc === 4;
    });
}

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

/** When sales_orders.shipping_address is empty, resolve from vendor shipping (same pattern as sales order completion → invoice). */
async function enrichShippingAddressFromVendor(conn, header) {
    if (!header?.customer_id) return;
    const raw = header.shipping_address;
    if (raw != null && String(raw).trim()) return;
    try {
        const [shipRows] = await conn.query(
            `SELECT
                vsa.ship_address_1, vsa.ship_address_2, vsa.ship_city, vsa.ship_zip_code,
                ss.name AS ship_state_name, sc.name AS ship_country_name
             FROM vendor_shipping_addresses vsa
             LEFT JOIN state ss ON vsa.ship_state_id = ss.id
             LEFT JOIN country sc ON vsa.ship_country_id = sc.id
             WHERE vsa.vendor_id = ?
             ORDER BY vsa.id DESC
             LIMIT 1`,
            [header.customer_id]
        );
        const ship = shipRows?.[0];
        if (!ship) return;
        const shipParts = [
            ship.ship_address_1,
            ship.ship_address_2,
            [ship.ship_city, ship.ship_state_name, ship.ship_zip_code].filter(Boolean).join(', '),
            ship.ship_country_name
        ].filter(Boolean);
        if (shipParts.length) {
            header.shipping_address = shipParts.join('\n');
        }
    } catch {
        /* keep empty */
    }
}

export const getOrderDetail = async ({ id, clientId }) => {
    const conn = await db.promise().getConnection();
    try {
        const header = await getSalesOrderHeader(conn, { id, clientId: null });
        if (!header) return null;
        await enrichShippingAddressFromVendor(conn, header);
        // Load items, attachments, dispatches, and returns by order id only (no client_id filter) so they show on detail in web and mobile
        const [items, attachments, approval, audit, dispatches, returns, inventoryTransactions] = await Promise.all([
            getSalesOrderItems(conn, { salesOrderId: header.id, clientId: null }),
            getSalesOrderAttachments(conn, { salesOrderId: header.id, clientId: null }),
            getSalesOrderApproval(conn, { salesOrderId: header.id, clientId: null }),
            getSalesOrderAudit(conn, { salesOrderId: header.id, clientId: null }),
            getSalesOrderDispatches(conn, { salesOrderId: header.id, clientId: null }),
            getSalesOrderReturns(conn, { salesOrderId: header.id }),
            getSalesOrderInventoryTransactions(conn, { salesOrderId: header.id })
        ]);

        const blockCompleteDueToCargoReturnQcFlag = blockCompleteDueToCargoReturnQc(returns);

        const [enrichedDispatches, enrichedReturns] = await Promise.all([
            Promise.all(dispatches.map(async (d) => {
                const dItems = await getDispatchItems(conn, { dispatchId: d.id });
                return { ...d, items: dItems };
            })),
            Promise.all((returns || []).map(async (r) => {
                const rLines = await (await import('./salesOrder.repo.js')).getReturnLines(conn, { cargoReturnId: r.id });
                return { ...r, items: rLines };
            }))
        ]);

        return {
            header,
            items,
            attachments,
            approval,
            audit,
            dispatches: enrichedDispatches,
            returns: enrichedReturns,
            blockCompleteDueToCargoReturnQc: blockCompleteDueToCargoReturnQcFlag,
            inventoryTransactions
        };

    } finally {
        conn.release();
    }
};

/** Build A5 Delivery Order PDF buffer for a single dispatch (Puppeteer HTML → PDF). */
export const getDeliveryOrderPdfBuffer = async ({ orderId, dispatchId }) => {
    const conn = await db.promise().getConnection();
    try {
        const header = await getSalesOrderHeader(conn, { id: orderId, clientId: null });
        if (!header) throw new Error('Sales order not found');
        await enrichShippingAddressFromVendor(conn, header);

        const dispatch = await getDispatchById(conn, { id: dispatchId });
        if (!dispatch || Number(dispatch.sales_order_id) !== Number(orderId)) {
            throw new Error('Dispatch not found for this order');
        }

        const [compRows] = await conn.query(
            `SELECT name, full_address, logo, base64logo, trn_no FROM company_settings WHERE id = ? LIMIT 1`,
            [header.company_id]
        );
        const company = compRows[0] || {};

        const dispatchItems = await getDispatchItems(conn, { dispatchId });
        const orderItems = await getSalesOrderItems(conn, { salesOrderId: orderId, clientId: null });
        const bySoiId = new Map(orderItems.map((o) => [Number(o.id), o]));

        const dispatches = await getSalesOrderDispatches(conn, { salesOrderId: orderId, clientId: null });
        const idx = dispatches.findIndex((d) => Number(d.id) === Number(dispatchId));
        const dispatchLabel = idx >= 0 ? String(dispatches.length - idx) : String(dispatchId);

        const lines = [];

        for (const di of dispatchItems) {
            const soi = bySoiId.get(Number(di.sales_order_item_id));
            if (!soi) continue;
            const qty = Number(di.quantity || 0);
            const packing = String(soi.product_packing_alias || '').trim();
            const pname = di.product_name || soi.product_name || '';
            lines.push({
                titleHtml: escapeHtml(pname).replace(/\n/g, '<br/>'),
                packingHtml: packing ? escapeHtml(packing).replace(/\n/g, '<br/>') : '',
                qty,
                uom: di.uom_name || soi.uom_name || ''
            });
        }

        const html = buildDeliveryOrderHtml({
            company,
            header,
            dispatch,
            lines,
            dispatchLabel
        });
        return await htmlToA5PdfBuffer(html);
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
                header.id
            ]);

            // If this order was previously approved/accepted, remove any existing "IN TRANSIT" inventory rows.
            // They will be re-created on the next approval based on the updated items.
            await softDeleteSalesOrderInTransitInventory(conn, header.id);

            await insertAudit(conn, {
                client_id: scopeClientId,
                sales_order_id: header.id,
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
                header.id
            ]);

            // Remove old "IN TRANSIT" inventory rows if they exist from a previous approval.
            await softDeleteSalesOrderInTransitInventory(conn, header.id);

            await insertAudit(conn, {
                client_id: clientId,
                sales_order_id: header.id,
                action: 'SET_TO_DRAFT_FOR_EDIT',
                old_status_id: oldStatus,
                new_status_id: 3,
                payload_json: { order_no: header.order_no },
                action_by: userId
            });
            const refreshed = await getSalesOrderHeader(conn, { id: header.id, clientId: null });
            if (refreshed) Object.assign(header, refreshed);
        }

        const computed = computeTotals(items, taxMode || header.tax_mode);
        await replaceSalesOrderItems(conn, {
            salesOrderId: header.id,
            clientId,
            items: computed.items
        });

        await updateSalesOrderHeader(conn, {
            id: header.id,
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
            header.id,
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
            sales_order_id: header.id,
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

        if (Number(att.sales_order_id) !== Number(header.id)) throw new Error('Attachment mismatch');

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
            sales_order_id: header.id,
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

        const items = await getSalesOrderItems(conn, { salesOrderId: header.id, clientId: null });
        if (!items.length) throw new Error('At least 1 item is required before submit');

        // Defensive: if this SO was previously approved/accepted and then edited+re-submitted,
        // remove stale IN TRANSIT rows (scoped by SO line ids so we always match).
        await softDeleteSalesOrderInTransitInventory(conn, header.id);

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
                [finalOrderNo, userId, header.id]
            );
        } else {
            await conn.query(
                `UPDATE sales_orders SET status_id = 8, updated_by = ?, updated_at = NOW() WHERE id = ?`,
                [userId, header.id]
            );
        }

        await insertAudit(conn, {
            client_id: scopeClientId ?? null,
            sales_order_id: header.id,
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
        const currentStatus = Number(header.status_id);
        let nextStatus = null;
        let auditAction = 'APPROVED';
        if (currentStatus === 8) {
            nextStatus = 1;
            auditAction = 'APPROVED';
        } else if (currentStatus === 1) {
            nextStatus = 13;
            auditAction = 'ACCEPTED';
        } else {
            throw new Error('Only submitted or to-do orders can be accepted');
        }

        await conn.query(`UPDATE sales_orders SET status_id = ?, updated_by = ?, updated_at = NOW() WHERE id = ?`, [
            nextStatus,
            userId,
            header.id
        ]);

        // Create IN TRANSIT inventory rows on approval/accept (informational; does NOT affect stock on hand).
        // These rows are linked to SALES_ORDER so we can trace approved quantities.
        const [soItems] = await conn.query(
            `SELECT id, product_id, uom_id, quantity, ordered_quantity, unit_price
             FROM sales_order_items
             WHERE sales_order_id = ?`,
            [header.id]
        );
        if (soItems?.length) {
            // Remove previous SO in-transit rows to avoid duplicates on re-approval.
            await softDeleteSalesOrderInTransitInventory(conn, header.id);

            // Exchange rate (optional) — align with AP bill logic (currency.conversion_rate).
            let exchangeRate = null;
            if (header.currency_id) {
                const [curRows] = await conn.query(`SELECT conversion_rate FROM currency WHERE id = ?`, [
                    header.currency_id
                ]);
                if (curRows?.length) exchangeRate = Number(curRows[0].conversion_rate || 0) || 1;
            }

            for (const it of soItems) {
                const qty = Number(it.ordered_quantity ?? it.quantity ?? 0);
                if (!Number.isFinite(qty) || qty <= 0) continue;
                if (!it.product_id || !header.warehouse_id) continue;
                const unitCost = Number(it.unit_price ?? 0);
                await inventoryService.insertInventoryTransaction(conn, {
                    txn_date: new Date(),
                    movement: 'IN TRANSIT',
                    txn_type: INV_TXN_TYPE_SALES_ORDER_IN_TRANSIT,
                    source_type: INV_SOURCE_TYPE_SALES_ORDER,
                    source_id: id,
                    source_line_id: it.id,
                    sales_order_id: id,
                    product_id: it.product_id,
                    warehouse_id: header.warehouse_id,
                    batch_id: null,
                    qty,
                    // Use SO unit price so amount/foreign/total are meaningful in inventory_transactions.
                    // This is still informational (IN TRANSIT); it does not touch inventory_stock_batches.
                    unit_cost: Number.isFinite(unitCost) ? unitCost : 0,
                    currency_id: header.currency_id || null,
                    exchange_rate: exchangeRate,
                    // Let inventoryService compute foreign_amount/total_amount from qty*unit_cost (+ exchange rate).
                    foreign_amount: null,
                    total_amount: null,
                    uom_id: it.uom_id || null,
                    movement_type_id: 3
                });
            }

            // Backfill safety: if any rows were inserted with missing types (e.g. ENUM mismatch), set them.
            const lineIds = soItems.map((row) => row.id);
            const ph = lineIds.map(() => '?').join(',');
            await conn.query(
                `UPDATE inventory_transactions
                 SET source_type = ?, txn_type = ?
                 WHERE source_id = ?
                   AND source_line_id IN (${ph})
                   AND (source_type IS NULL OR source_type = '')
                   AND (txn_type IS NULL OR txn_type = '')
                   AND (is_deleted = 0 OR is_deleted IS NULL)`,
                [INV_SOURCE_TYPE_SALES_ORDER, INV_TXN_TYPE_SALES_ORDER_IN_TRANSIT, header.id, ...lineIds]
            );
        }

        await insertAudit(conn, {
            client_id: scopeClientId,
            sales_order_id: header.id,
            action: auditAction,
            old_status_id: currentStatus,
            new_status_id: nextStatus,
            payload_json: { comment, order_no: header.order_no },
            action_by: userId
        });
    });

export const dispatchOrder = async ({
    clientId,
    userId,
    id,
    dispatch_id,
    vehicle_no,
    driver_name,
    comments,
    files,
    items: dispatchPayload,
    force_delivery = false,
    force_delivery_reason = null,
    create_draft_purchase_bill = false,
    warehouse_id_from_client = null
}) =>
    withTx(async (conn) => {
        const header = await getSalesOrderHeader(conn, { id, clientId: null });
        if (!header) throw new Error('Sales order not found');
        const scopeClientId = clientId ?? header.client_id;
        // Ignore client_id check for attachments: use 0 when null so INSERT never fails
        const attachmentClientId = scopeClientId ?? header.client_id ?? 0;

        let effectiveWarehouseId = header.warehouse_id;
        if (warehouse_id_from_client != null && warehouse_id_from_client !== '') {
            const w = Number(warehouse_id_from_client);
            if (Number.isFinite(w) && w > 0) effectiveWarehouseId = w;
        }

        if (![13, 11, 9].includes(Number(header.status_id))) {
            throw new Error(`Dispatch allowed only for accepted, partial or dispatched orders. Current status: ${header.status_id}`);
        }

        const incomingFiles = Array.isArray(files) ? files : [];
        // Normal dispatch / edit: require proof photos. Force-delivery shortcut (close order) stays attachment-optional.
        if (incomingFiles.length === 0 && !force_delivery) {
            const did = dispatch_id ? Number(dispatch_id) : null;
            if (did && Number.isFinite(did)) {
                const [cntRows] = await conn.query(
                    `SELECT COUNT(*) AS c FROM sales_order_attachments WHERE dispatch_id = ?`,
                    [did]
                );
                if (Number(cntRows[0]?.c || 0) === 0) {
                    throw new Error('At least one dispatch proof attachment is required');
                }
            } else {
                throw new Error('At least one dispatch proof attachment is required');
            }
        }

        let normalizedPayload = dispatchPayload;
        if (typeof dispatchPayload === 'string') {
            try { normalizedPayload = JSON.parse(dispatchPayload); } catch (e) { normalizedPayload = []; }
        }
        if (!Array.isArray(normalizedPayload)) normalizedPayload = [];

        const existingItems = await getSalesOrderItems(conn, { salesOrderId: id, clientId: scopeClientId });
        const batchInfoForOrder = await getDispatchBatchInfo(conn, { salesOrderId: id });

        let draftBillId = null;
        if (create_draft_purchase_bill) {
            const draft = await createDraftNuragroPurchaseBillForDispatch(conn, {
                header,
                normalizedPayload,
                existingItems,
                batchInfoForOrder,
                userId
            });
            draftBillId = draft.billId;
            draft.lineIdByPayloadIndex.forEach((lineId, idx) => {
                if (normalizedPayload[idx]) normalizedPayload[idx].ap_bill_line_id = lineId;
            });
        }

        for (let i = 0; i < normalizedPayload.length; i++) {
            const p = normalizedPayload[i];
            const qty = Number(p.dispatch_qty || 0);
            if (qty <= 0) continue;
            const soItem = existingItems.find((it) => Number(it.id) === Number(p.id));
            if (!soItem) throw new Error('Invalid order line for dispatch');
            const prodInfo = (batchInfoForOrder.items || []).find((x) => Number(x.product_id) === Number(soItem.product_id));
            const batches = prodInfo?.batches || [];
            if (batches.length > 0 && !p.ap_bill_line_id) {
                throw new Error(
                    `Purchase bill / batch is required for ${soItem.product_name || 'item'}. Select a purchase bill or confirm saving a draft Bynur Agro (Nuragro) purchase bill.`
                );
            }
        }

        let activeDispatchId = dispatch_id;
        if (activeDispatchId) {
            await updateDispatchHeader(conn, {
                id: activeDispatchId,
                vehicle_no,
                driver_name,
                comments,
                ...(draftBillId ? { ap_bill_id: draftBillId } : {})
            });

            const oldItems = await getDispatchItems(conn, { dispatchId: activeDispatchId, clientId: scopeClientId });
            for (const oi of oldItems) {
                // Restore physical stock if it was previously reduced
                if (oi.ap_bill_line_id) {
                    const [batchRows] = await conn.query(
                        `SELECT batch_id, unit_cost FROM ap_bill_line_batches WHERE bill_line_id = ? LIMIT 1`,
                        [oi.ap_bill_line_id]
                    );
                    if (batchRows.length > 0) {
                        const { batch_id, unit_cost } = batchRows[0];
                        const [stRows] = await conn.query(
                            `SELECT movement FROM inventory_transactions
                             WHERE source_type = 'SALES_DISPATCH' AND source_id = ? AND product_id = ? AND batch_id = ?
                               AND (is_deleted = 0 OR is_deleted IS NULL)
                             ORDER BY id DESC LIMIT 1`,
                            [activeDispatchId, oi.product_id, batch_id]
                        );
                        // Legacy: dispatch used OUT + stock reduction. New: IN TRANSIT only — no stock to restore.
                        if (stRows[0]?.movement === 'OUT') {
                            const whRestore = await resolveWarehouseIdForDispatchLine(conn, effectiveWarehouseId, oi.ap_bill_line_id);
                            if (!whRestore) {
                                throw new Error('Warehouse is required to adjust stock for this dispatch.');
                            }
                            await inventoryService.updateInventoryStock(
                                conn,
                                oi.product_id,
                                whRestore,
                                batch_id,
                                oi.quantity,
                                unit_cost || 0,
                                true // isIn = true (Add back stock)
                            );
                        }
                        await conn.query(
                            `UPDATE inventory_transactions SET is_deleted = 1 
                             WHERE source_type = 'SALES_DISPATCH' AND source_id = ? AND product_id = ? AND batch_id = ?`,
                            [activeDispatchId, oi.product_id, batch_id]
                        );
                    }
                }
                const oiSoItem = existingItems.find((it) => Number(it.id) === Number(oi.sales_order_item_id));
                await adjustSalesOrderInTransitForLine(conn, {
                    salesOrderId: id,
                    salesOrderItemId: oi.sales_order_item_id,
                    qty: Number(oi.quantity),
                    mode: 'restore',
                    soItem: oiSoItem
                });
                await conn.query(
                    `UPDATE sales_order_items SET dispatched_quantity = dispatched_quantity - ? WHERE id = ?`,
                    [Number(oi.quantity), oi.sales_order_item_id]
                );
            }
            await deleteDispatchItems(conn, { dispatchId: activeDispatchId });
        } else {
            activeDispatchId = await insertDispatchHeader(conn, {
                sales_order_id: id,
                vehicle_no,
                driver_name,
                dispatched_by: userId,
                comments,
                ap_bill_id: draftBillId || null
            });
        }

        if (draftBillId && activeDispatchId) {
            await conn.query(`UPDATE ap_bills SET dispatch_id = ? WHERE id = ?`, [Number(activeDispatchId), draftBillId]);
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

            // --- Physical stock reduction at dispatch stage ---
            for (const p of normalizedPayload) {
                const qty = Number(p.dispatch_qty || 0);
                if (qty <= 0) continue;

                const soItem = existingItems.find((it) => Number(it.id) === Number(p.id));

                if (p.ap_bill_line_id) {
                    const [batchRows] = await conn.query(
                        `SELECT batch_id, unit_cost FROM ap_bill_line_batches WHERE bill_line_id = ? LIMIT 1`,
                        [p.ap_bill_line_id]
                    );

                    if (batchRows.length > 0) {
                        const { batch_id, unit_cost } = batchRows[0];
                        const productId = p.product_id || soItem?.product_id;

                        // Dispatch = IN TRANSIT until customer invoice posts (physical OUT at AR invoice).
                        // Does not reduce inventory_stock_batches here.
                        let exchangeRate = null;
                        if (header.currency_id) {
                            const [curRows] = await conn.query(`SELECT conversion_rate FROM currency WHERE id = ?`, [
                                header.currency_id
                            ]);
                            if (curRows?.length) exchangeRate = Number(curRows[0].conversion_rate || 0) || 1;
                        }
                        const resolvedWh = await resolveWarehouseIdForDispatchLine(conn, effectiveWarehouseId, p.ap_bill_line_id);
                        if (!resolvedWh) {
                            throw new Error(
                                'Warehouse is required for dispatch. Set warehouse on the sales order or select a purchase bill batch.'
                            );
                        }
                        await inventoryService.insertInventoryTransaction(conn, {
                            txn_date: new Date(),
                            movement: 'IN TRANSIT',
                            txn_type: 'SALES_DISPATCH_IN_TRANSIT',
                            source_type: 'SALES_DISPATCH',
                            source_id: activeDispatchId,
                            source_line_id: p.id,
                            sales_order_id: id,
                            dispatch_id: activeDispatchId,
                            product_id: productId,
                            warehouse_id: resolvedWh,
                            batch_id: batch_id,
                            qty: qty,
                            unit_cost: unit_cost || 0,
                            currency_id: header.currency_id || null,
                            exchange_rate: exchangeRate,
                            foreign_amount: null,
                            total_amount: null,
                            uom_id: soItem?.uom_id || null,
                            movement_type_id: 3
                        });
                    }
                }

                // Reduce SO "IN TRANSIT" informational qty for every dispatched line (matches dispatched_quantity update)
                await adjustSalesOrderInTransitForLine(conn, {
                    salesOrderId: id,
                    salesOrderItemId: p.id,
                    qty,
                    mode: 'consume',
                    soItem
                });
            }
        }

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
                ...(draftBillId ? { ap_bill_id: draftBillId, draft_purchase_bill: true } : {}),
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

        return {
            dispatch_id: activeDispatchId,
            ap_bill_id: draftBillId
        };
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
        if (filesList.length === 0) {
            throw new Error('At least one delivery proof attachment is required');
        }
        const rows = filesList.map((file) => {
            const originalName = file.originalname || file.originalName || file.filename || 'delivery_photo';
            const fileName = file.filename || file.originalname || file.originalName || `delivery_${Date.now()}.jpg`;
            const filePath = file.file_path || file.path || `uploads/sales_orders/delivery/${fileName}`;
            return [
                header.id,
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

        await conn.query(
            `UPDATE sales_orders 
             SET status_id = 12, 
                 delivery_notes = ?, 
                 delivered_by = ?, 
                 delivered_at = NOW(), 
                 updated_by = ?, 
                 updated_at = NOW() 
             WHERE id = ?`,
            [comment || null, userId, userId, header.id]
        );

        await insertAudit(conn, {
            client_id: scopeClientId,
            sales_order_id: header.id,
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
        if (Number(dispatch.sales_order_id) !== Number(header.id)) throw new Error('Dispatch record mismatch');

        const items = await getDispatchItems(conn, { dispatchId, clientId: scopeClientId });
        const soItemsBeforeDelete = await getSalesOrderItems(conn, { salesOrderId: header.id, clientId: scopeClientId });
        for (const it of items) {
            // Restore physical stock
            if (it.ap_bill_line_id) {
                const [batchRows] = await conn.query(
                    `SELECT batch_id, unit_cost FROM ap_bill_line_batches WHERE bill_line_id = ? LIMIT 1`,
                    [it.ap_bill_line_id]
                );
                if (batchRows.length > 0) {
                    const { batch_id, unit_cost } = batchRows[0];
                    const [stRowsDel] = await conn.query(
                        `SELECT movement FROM inventory_transactions
                         WHERE source_type = 'SALES_DISPATCH' AND source_id = ? AND product_id = ? AND batch_id = ?
                           AND (is_deleted = 0 OR is_deleted IS NULL)
                         ORDER BY id DESC LIMIT 1`,
                        [dispatchId, it.product_id, batch_id]
                    );
                    if (stRowsDel[0]?.movement === 'OUT') {
                        const whDel = await resolveWarehouseIdForDispatchLine(conn, header.warehouse_id, it.ap_bill_line_id);
                        if (!whDel) {
                            throw new Error('Warehouse is required to adjust stock when removing this dispatch.');
                        }
                        await inventoryService.updateInventoryStock(
                            conn,
                            it.product_id,
                            whDel,
                            batch_id,
                            it.quantity,
                            unit_cost || 0,
                            true // isIn = true (Add back)
                        );
                    }
                    await conn.query(
                        `UPDATE inventory_transactions SET is_deleted = 1 
                         WHERE source_type = 'SALES_DISPATCH' AND source_id = ? AND product_id = ? AND batch_id = ?`,
                        [dispatchId, it.product_id, batch_id]
                    );
                }
            }
            const delSoItem = soItemsBeforeDelete.find((row) => Number(row.id) === Number(it.sales_order_item_id));
            await adjustSalesOrderInTransitForLine(conn, {
                salesOrderId: id,
                salesOrderItemId: it.sales_order_item_id,
                qty: Number(it.quantity),
                mode: 'restore',
                soItem: delSoItem
            });
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
            sales_order_id: header.id,
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

        const crReturns = await getSalesOrderReturns(conn, { salesOrderId: header.id });
        if (blockCompleteDueToCargoReturnQc(crReturns)) {
            throw new Error(
                'Cannot complete this order while a cargo return is submitted or awaiting QC. Approve or reject the return first.'
            );
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
                        [Number(alloc.allocated_qty), alloc.id, header.id]
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
                    header.id,
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
        `, [header.id]);

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
            [client_received_by || null, client_notes, userId, payment_term_id || null, due_date || null, finalWarehouseId, userId, header.id]
        );

        // 3. Auto-generate Customer Invoice (Submitted status 8)
        const [existingInvoices] = await conn.query('SELECT id FROM ar_invoices WHERE sales_order_id = ?', [header.id]);
        if (existingInvoices.length === 0) {
            // Re-fetch items to get latest dispatched_quantity and prices
            const items = await getSalesOrderItems(conn, { salesOrderId: header.id, clientId: scopeClientId });

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
                let deliveryAddressId = null;
                try {
                    const [vendorRows] = await conn.query(
                        `SELECT 
                            va.bill_address_1, va.bill_address_2, va.bill_city, va.bill_zip_code,
                            bs.name AS bill_state_name, bc.name AS bill_country_name
                         FROM vendor v
                         LEFT JOIN vendor_address va ON va.vendor_id = v.id
                         LEFT JOIN state bs ON va.bill_state_id = bs.id
                         LEFT JOIN country bc ON va.bill_country_id = bc.id
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
                    }

                    // Shipping address lookup is schema-safe (no dependency on is_primary column).
                    const [shipRows] = await conn.query(
                        `SELECT
                            vsa.id,
                            vsa.ship_address_1, vsa.ship_address_2, vsa.ship_city, vsa.ship_zip_code,
                            ss.name AS ship_state_name, sc.name AS ship_country_name
                         FROM vendor_shipping_addresses vsa
                         LEFT JOIN state ss ON vsa.ship_state_id = ss.id
                         LEFT JOIN country sc ON vsa.ship_country_id = sc.id
                         WHERE vsa.vendor_id = ?
                         ORDER BY vsa.id DESC
                         LIMIT 1`,
                        [header.customer_id]
                    );
                    const ship = shipRows?.[0];
                    if (ship) {
                        deliveryAddressId = ship.id || null;
                        const shipParts = [
                            ship.ship_address_1,
                            ship.ship_address_2,
                            [ship.ship_city, ship.ship_state_name, ship.ship_zip_code].filter(Boolean).join(', '),
                            ship.ship_country_name
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
                     customer_address, delivery_address, delivery_address_id,
                     sales_order_id, sales_order_number, user_id, status_id)
                    VALUES (?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 8)
                `, [
                    invoiceUniqid, invoiceNumber, due_date || null, payment_term_id || null,
                    header.customer_id, header.company_id, finalWarehouseId, header.currency_id,
                    invSubtotal, 'fixed', 0, invTaxTotal, invGrandTotal, client_notes || null,
                    customerAddress, deliveryAddress, deliveryAddressId,
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
                        SELECT
                            di.ap_bill_line_id,
                            SUM(di.quantity) AS quantity,
                            ib.id AS batch_id,
                            abl.rate as unit_cost
                        FROM sales_order_dispatch_items di
                        JOIN ap_bill_lines abl ON di.ap_bill_line_id = abl.id
                        JOIN sales_order_dispatches d ON di.dispatch_id = d.id
                        LEFT JOIN ap_bill_line_batches ablb ON ablb.bill_line_id = di.ap_bill_line_id
                        LEFT JOIN inventory_batches ib ON ib.id = ablb.batch_id
                        WHERE d.sales_order_id = ? AND di.sales_order_item_id = ?
                        GROUP BY di.ap_bill_line_id, ib.id, abl.rate
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
                        const requestedQty = Number(line.qty || 0);
                        let allocatedQty = 0;

                        for (const dbat of dispatchBatches) {
                            const bId = Number(dbat.batch_id);
                            const qty = Number(dbat.quantity || 0);
                            if (!Number.isFinite(bId) || bId <= 0 || qty <= 0) continue;

                            await conn.query(`
                                INSERT INTO ar_invoice_line_batches 
                                (invoice_line_id, batch_id, quantity, unit_cost)
                                VALUES (?, ?, ?, ?)
                            `, [lineId, bId, qty, dbat.unit_cost || line.rate || 0]);
                            allocatedQty += qty;
                        }

                        // If dispatch mapping could not provide enough valid batch allocations,
                        // top-up from live stock to avoid FK failures and keep invoice completable.
                        let remaining = requestedQty - allocatedQty;
                        if (remaining > 0) {
                            const [stockBatches] = await conn.query(`
                                SELECT isb.batch_id, isb.qty_on_hand, isb.unit_cost
                                FROM inventory_stock_batches isb
                                WHERE isb.product_id = ? AND isb.warehouse_id = ? AND isb.qty_on_hand > 0
                                ORDER BY isb.id ASC
                            `, [line.product_id, finalWarehouseId]);

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
                        }
                    }
                }

                // Add history for the new invoice
                await conn.query(
                    'INSERT INTO history (module, module_id, user_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
                    ['ar_invoice', invoiceId, userId, 'CREATED', JSON.stringify({
                        invoice_number: invoiceNumber,
                        sales_order_id: header.id,
                        reason: 'Auto-generated on Sales Order completion'
                    })]
                );
            }
        }

        await insertAudit(conn, {
            client_id: scopeClientId,
            sales_order_id: header.id,
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

        // If edit request is approved (status becomes Draft), remove any prior approval "IN TRANSIT" rows.
        if (isApproved) {
            await softDeleteSalesOrderInTransitInventory(conn, id);
        }

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
            header.id
        ]);

        await insertAudit(conn, {
            client_id: scopeClientId,
            sales_order_id: header.id,
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
