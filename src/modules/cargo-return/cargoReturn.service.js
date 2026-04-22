import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import db from '../../../db.js';

const require = createRequire(import.meta.url);
const inventoryService = require('../inventory/inventory.service.cjs');
import {
    getCargoReturnHeaderById,
    getCargoReturnLinesByHeaderId,
    getCargoReturnAttachmentsByCargoReturnId,
    getCargoReturnAttachmentById,
    insertCargoReturnAttachments,
    deleteCargoReturnAttachmentById,
    updateCargoReturnStatusId,
    getCargoReturnAudit,
    insertHistory
} from './cargoReturn.repo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** `server/` — for resolving `uploads/...` paths stored in DB */
const SERVER_ROOT = path.resolve(__dirname, '../../..');

/** @param {Array<{ dispatch_id: number, dispatch_item_id: number, sales_order_item_id?: number, product_name?: string, dispatched_qty: number, return_qty: number }>} lines */
async function insertCargoReturnLines(conn, crId, lines) {
    let lineNo = 1;
    for (const row of lines) {
        const dispatchId = row.dispatch_id != null ? Number(row.dispatch_id) : null;
        const dispatchItemId = row.dispatch_item_id != null ? Number(row.dispatch_item_id) : null;
        const soItemId = row.sales_order_item_id != null ? Number(row.sales_order_item_id) : null;
        const productName = row.product_name != null ? String(row.product_name).slice(0, 512) : null;
        const dispQty = Number(row.dispatched_qty ?? 0);
        const retQty = Number(row.return_qty ?? 0);
        if (!Number.isFinite(retQty) || retQty <= 0) continue;
        if (!Number.isFinite(dispatchItemId)) {
            throw new Error('Each line needs a valid dispatch_item_id');
        }

        await conn.query(
            `INSERT INTO cargo_return_lines
              (cargo_return_id, dispatch_id, dispatch_item_id, sales_order_item_id, product_name, dispatched_qty, return_qty, line_no)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [crId, dispatchId, dispatchItemId, soItemId, productName, dispQty, retQty, lineNo++]
        );
    }

    const [cntRows] = await conn.query(
        `SELECT COUNT(*) AS c FROM cargo_return_lines WHERE cargo_return_id = ?`,
        [crId]
    );
    if (!cntRows[0]?.c) {
        throw new Error('No valid return lines to save');
    }
}

/** Align with sales order / master `status` table */
export const CARGO_RETURN_STATUS_DRAFT = 3;
export const CARGO_RETURN_STATUS_SUBMITTED_FOR_APPROVAL = 8;
// NOTE: status_id=2 should be editable per requirement.
export const CARGO_RETURN_STATUS_EDITABLE_ALT = 2;
/** After submit-for-approval: QC has not decided yet. */
export const QC_STATUS_PENDING_QC = 4;
/**
 * QC saved a decision; awaiting manager approval to post inventory (no stock movement until finalize).
 * Uses same `status` row id as document "submitted" where applicable — label from DB.
 */
export const QC_STATUS_SUBMITTED_FOR_MANAGER_APPROVAL = 8;
/** After manager approves finalize (inventory posted). */
export const QC_STATUS_QC_COMPLETED_APPROVED = 1;

function isEditableCargoReturnHeader(header) {
    const st = Number(header?.status_id);
    if (st === CARGO_RETURN_STATUS_DRAFT || st === CARGO_RETURN_STATUS_EDITABLE_ALT) return true;
    const name = String(header?.status_name || '')
        .trim()
        .toLowerCase();
    // Safety: if DB uses a different id but status label indicates editable
    if (name.includes('rejected')) return true;
    return false;
}

/**
 * Log the same cargo return event on the linked sales order timeline (history.module = sales_order).
 * @param {import('mysql2/promise').PoolConnection} conn
 */
async function mirrorCargoReturnToSalesOrderHistory(conn, { salesOrderId, cargoReturnId, returnNo, userId, action, details = {} }) {
    const soId = salesOrderId != null ? Number(salesOrderId) : null;
    if (!soId || !Number.isFinite(soId)) return;
    const merged = {
        cargo_return_id: cargoReturnId,
        ...(returnNo != null && String(returnNo).trim() !== '' ? { return_no: String(returnNo) } : {}),
        ...details
    };
    await insertHistory(conn, {
        module: 'sales_order',
        moduleId: soId,
        userId,
        action,
        details: merged
    });
}

const CARGO_RETURN_QC_EPS = 1e-9;

/**
 * Reduce dispatched qty on the linked sales_order_dispatch_items row and mirror on sales_order_items.
 * Runs at QC / approval time when accepted+rejected delta is applied (same transaction as inventory).
 * @param {import('mysql2/promise').PoolConnection} conn
 * @param {{ deltaQty: number, dispatchItemId: number, dispatchIdFromLine: number|null, salesOrderItemId: number|null }} p
 */
async function applyCargoReturnDispatchTableReduction(conn, p) {
    const { deltaQty, dispatchItemId, dispatchIdFromLine, salesOrderItemId } = p;
    if (!(Math.abs(deltaQty) > CARGO_RETURN_QC_EPS)) return;
    if (dispatchItemId == null || !Number.isFinite(dispatchItemId)) return;

    if (deltaQty > 0) {
        let sql = `UPDATE sales_order_dispatch_items SET quantity = GREATEST(0, quantity - ?) WHERE id = ?`;
        const args = [deltaQty, dispatchItemId];
        if (dispatchIdFromLine != null && Number.isFinite(dispatchIdFromLine)) {
            sql += ` AND dispatch_id = ?`;
            args.push(dispatchIdFromLine);
        }
        const [ur] = await conn.query(sql, args);
        if (Number(ur?.affectedRows || 0) < 1) {
            throw new Error(
                `Could not update dispatch line ${dispatchItemId} (check dispatch_id matches cargo return line).`
            );
        }
        if (salesOrderItemId != null && Number.isFinite(salesOrderItemId)) {
            await conn.query(
                `UPDATE sales_order_items SET dispatched_quantity = GREATEST(0, dispatched_quantity - ?) WHERE id = ?`,
                [deltaQty, salesOrderItemId]
            );
        }
    } else {
        const addBack = -deltaQty;
        let sql = `UPDATE sales_order_dispatch_items SET quantity = quantity + ? WHERE id = ?`;
        const args = [addBack, dispatchItemId];
        if (dispatchIdFromLine != null && Number.isFinite(dispatchIdFromLine)) {
            sql += ` AND dispatch_id = ?`;
            args.push(dispatchIdFromLine);
        }
        const [ur] = await conn.query(sql, args);
        if (Number(ur?.affectedRows || 0) < 1) {
            throw new Error(
                `Could not update dispatch line ${dispatchItemId} (check dispatch_id matches cargo return line).`
            );
        }
        if (salesOrderItemId != null && Number.isFinite(salesOrderItemId)) {
            await conn.query(
                `UPDATE sales_order_items SET dispatched_quantity = dispatched_quantity + ? WHERE id = ?`,
                [addBack, salesOrderItemId]
            );
        }
    }
}

/** Matches `salesOrder.service.js` dispatch posting — informational IN TRANSIT row per dispatch + SO line. */
const INV_SOURCE_SALES_DISPATCH = 'SALES_DISPATCH';
const INV_TXN_SALES_DISPATCH_IN_TRANSIT = 'SALES_DISPATCH_IN_TRANSIT';

/**
 * Reduce `inventory_transactions.qty` on SALES_DISPATCH IN TRANSIT rows for this return line.
 * Dispatches insert with `source_id` = dispatch id, `source_line_id` = SO item id (see dispatchOrder).
 * There may be multiple rows (re-posts, duplicates); the full `reductionQty` is applied across all matching rows.
 */
async function reduceSalesDispatchInTransitInventoryTxn(conn, { dispatchId, salesOrderItemId, reductionQty, salesOrderId = null }) {
    const r = Number(reductionQty || 0);
    if (!(Math.abs(r) > CARGO_RETURN_QC_EPS) || r <= 0) return;
    const dId = dispatchId != null && Number.isFinite(Number(dispatchId)) ? Number(dispatchId) : null;
    const soiId = salesOrderItemId != null && Number.isFinite(Number(salesOrderItemId)) ? Number(salesOrderItemId) : null;
    if (!dId || !soiId) return;

    const soId =
        salesOrderId != null && Number.isFinite(Number(salesOrderId)) ? Number(salesOrderId) : null;

    const baseTerms = [
        `source_type = ?`,
        `txn_type = ?`,
        `(is_deleted = 0 OR is_deleted IS NULL)`
    ];
    const baseArgs = [INV_SOURCE_SALES_DISPATCH, INV_TXN_SALES_DISPATCH_IN_TRANSIT];

    /** Prefer: source_id = dispatch + source_line_id = SO item (+ sales_order_id when known). */
    let sql = `SELECT id, qty, warehouse_id FROM inventory_transactions
         WHERE ${baseTerms.join(' AND ')}
           AND source_id = ?
           AND source_line_id = ?`;
    const args = [...baseArgs, dId, soiId];
    if (soId != null) {
        sql += ` AND sales_order_id = ?`;
        args.push(soId);
    }
    sql += ` ORDER BY id ASC`;

    let [rows] = await conn.query(sql, args);

    /** Same keys but legacy rows may have NULL `sales_order_id`. */
    if (!rows?.length && soId != null) {
        sql = `SELECT id, qty, warehouse_id FROM inventory_transactions
         WHERE ${baseTerms.join(' AND ')}
           AND source_id = ?
           AND source_line_id = ?
         ORDER BY id ASC`;
        [rows] = await conn.query(sql, [...baseArgs, dId, soiId]);
    }

    /** Fallback: `dispatch_id` column populated but `source_id` differs in legacy rows. */
    if (!rows?.length) {
        sql = `SELECT id, qty, warehouse_id FROM inventory_transactions
         WHERE ${baseTerms.join(' AND ')}
           AND dispatch_id = ?
           AND source_line_id = ?`;
        const args2 = [...baseArgs, dId, soiId];
        if (soId != null) {
            sql += ` AND (sales_order_id = ? OR sales_order_id IS NULL)`;
            args2.push(soId);
        }
        sql += ` ORDER BY id ASC`;
        [rows] = await conn.query(sql, args2);
    }

    /** Last resort: same dispatch + same product on SO line (handles source_line_id mismatch). */
    if (!rows?.length) {
        const [soiRows] = await conn.query(`SELECT product_id FROM sales_order_items WHERE id = ? LIMIT 1`, [soiId]);
        const pid = soiRows?.[0]?.product_id != null ? Number(soiRows[0].product_id) : null;
        if (pid != null && Number.isFinite(pid) && soId != null) {
            [rows] = await conn.query(
                `SELECT id, qty, warehouse_id FROM inventory_transactions
                 WHERE ${baseTerms.join(' AND ')}
                   AND source_id = ?
                   AND product_id = ?
                   AND sales_order_id = ?
                 ORDER BY id ASC`,
                [...baseArgs, dId, pid, soId]
            );
        }
    }

    if (!rows?.length) return;

    let remaining = r;
    for (const row of rows) {
        if (remaining <= CARGO_RETURN_QC_EPS) break;
        const cur = Number(row.qty || 0);
        const take = Math.min(cur, remaining);
        const newQty = Math.max(0, cur - take);
        remaining -= take;
        await conn.query(
            `UPDATE inventory_transactions
             SET qty = ?, dispatch_id = COALESCE(dispatch_id, ?)
             WHERE id = ?`,
            [newQty, dId, row.id]
        );
    }
}

async function loadCargoReturnLineInventoryContext(conn, cargoReturnLineId, cargoReturnId) {
    const [rows] = await conn.query(
        `SELECT
            so.id AS sales_order_id,
            COALESCE(crl.dispatch_id, di.dispatch_id) AS dispatch_id,
            COALESCE(di.ap_bill_line_id, abl2.id) AS ap_bill_line_id,
            COALESCE(abl.bill_id, sod.ap_bill_id) AS ap_bill_id,
            COALESCE(abb.batch_id, it.batch_id) AS batch_id,
            COALESCE(abb.unit_cost, it.unit_cost, 0) AS unit_cost,
            so.warehouse_id,
            soi.product_id,
            so.currency_id,
            soi.uom_id,
            NULL AS exchange_rate
         FROM cargo_return_lines crl
         JOIN sales_order_dispatch_items di ON di.id = crl.dispatch_item_id
         LEFT JOIN sales_order_dispatches sod ON sod.id = di.dispatch_id
         JOIN sales_order_items soi ON soi.id = crl.sales_order_item_id
         JOIN sales_orders so ON so.id = soi.sales_order_id
         LEFT JOIN ap_bill_lines abl ON abl.id = di.ap_bill_line_id
         LEFT JOIN ap_bill_lines abl2 ON abl2.bill_id = sod.ap_bill_id AND abl2.product_id = soi.product_id
         LEFT JOIN inventory_transactions it ON it.source_type = 'AP_BILL'
            AND it.source_line_id = COALESCE(di.ap_bill_line_id, abl2.id)
            AND it.batch_id IS NOT NULL
            AND it.txn_type = 'PURCHASE_BILL_RECEIPT'
            AND (it.is_deleted = 0 OR it.is_deleted IS NULL)
         LEFT JOIN ap_bill_line_batches abb ON abb.id = (
             SELECT blb.id FROM ap_bill_line_batches blb
             WHERE blb.bill_line_id = COALESCE(di.ap_bill_line_id, abl2.id)
             ORDER BY blb.id ASC
             LIMIT 1
         )
         WHERE crl.id = ? AND crl.cargo_return_id = ?`,
        [cargoReturnLineId, cargoReturnId]
    );
    return rows[0] || null;
}

/**
 * QC accept → no stock IN / no CARGO_RETURN_ACCEPT row: reduce dispatch tables, SO dispatched qty,
 *   and the SALES_DISPATCH IN TRANSIT inventory_transactions row for this dispatch_id + line.
 * QC reject → DISCARD inventory transaction only (ties to SO + dispatch on txn row).
 * (accepted + rejected) delta reduces sales_order_dispatch_items.quantity and sales_order_items.dispatched_quantity.
 */
async function postCargoReturnQcInventory(conn, { cargoReturnId, lineId, newAcceptedQty, newRejectedQty }) {
    const acc = Number(newAcceptedQty || 0);
    const rej = Number(newRejectedQty || 0);

    const [lineRows] = await conn.query(
        `SELECT accepted_qty, rejected_qty, dispatch_id, dispatch_item_id, sales_order_item_id
         FROM cargo_return_lines
         WHERE id = ? AND cargo_return_id = ? FOR UPDATE`,
        [lineId, cargoReturnId]
    );
    const lineRow = lineRows?.[0];
    if (!lineRow) {
        throw new Error(`Cargo return line ${lineId} not found`);
    }

    const prevAcc = Number(lineRow.accepted_qty || 0);
    const prevRej = Number(lineRow.rejected_qty || 0);
    const dAcc = acc - prevAcc;
    const dRej = rej - prevRej;
    const deltaDispatch = dAcc + dRej;

    const dispatchItemId =
        lineRow.dispatch_item_id != null && lineRow.dispatch_item_id !== ''
            ? Number(lineRow.dispatch_item_id)
            : null;
    const salesOrderItemId =
        lineRow.sales_order_item_id != null && lineRow.sales_order_item_id !== ''
            ? Number(lineRow.sales_order_item_id)
            : null;
    const dispatchIdFromLine =
        lineRow.dispatch_id != null && lineRow.dispatch_id !== '' ? Number(lineRow.dispatch_id) : null;

    if (Math.abs(dAcc) <= CARGO_RETURN_QC_EPS && Math.abs(dRej) <= CARGO_RETURN_QC_EPS) {
        return;
    }

    const [crRowsForSo] = await conn.query(
        `SELECT sales_order_id, return_source, return_to_store
         FROM cargo_returns
         WHERE id = ?
         LIMIT 1`,
        [cargoReturnId]
    );
    const crHead = crRowsForSo?.[0];
    const crSalesOrderId =
        crHead?.sales_order_id != null && crHead.sales_order_id !== ''
            ? Number(crHead.sales_order_id)
            : null;
    const crSource = String(crHead?.return_source || '').trim().toUpperCase();
    const crReturnToStore = Number(crHead?.return_to_store) === 1;
    const shouldStockInAccepted = crReturnToStore && crSource === 'AFTER_INVOICE';

    /** Dispatch / SO dispatched qty — return removes from shipped/dispatch figures (accepted + rejected). */
    await applyCargoReturnDispatchTableReduction(conn, {
        deltaQty: deltaDispatch,
        dispatchItemId,
        dispatchIdFromLine,
        salesOrderItemId
    });

    /** Same total reduces SALES_DISPATCH IN TRANSIT qty in inventory_transactions (all matching rows). */
    await reduceSalesDispatchInTransitInventoryTxn(conn, {
        dispatchId: dispatchIdFromLine,
        salesOrderItemId,
        reductionQty: deltaDispatch,
        salesOrderId: crSalesOrderId
    });

    const ctx = await loadCargoReturnLineInventoryContext(conn, lineId, cargoReturnId);
    if (!ctx) {
        throw new Error(`Cargo return line ${lineId} not found`);
    }

    // If we don't need any inventory posting (no reject; and accept stock-in disabled), we are done.
    if (Math.abs(dRej) <= CARGO_RETURN_QC_EPS && !(shouldStockInAccepted && dAcc > CARGO_RETURN_QC_EPS)) {
        return;
    }

    const salesOrderId =
        ctx.sales_order_id != null && ctx.sales_order_id !== '' ? Number(ctx.sales_order_id) : null;
    const dispatchId =
        ctx.dispatch_id != null && ctx.dispatch_id !== '' ? Number(ctx.dispatch_id) : null;

    const productId = Number(ctx.product_id);
    const warehouseId = Number(ctx.warehouse_id);
    let batchId = ctx.batch_id != null ? Number(ctx.batch_id) : null;
    let unitCost = Number(ctx.unit_cost || 0);

    if (!batchId || !Number.isFinite(batchId)) {
        const [fallbackRows] = await conn.query(
            `SELECT it.batch_id, it.unit_cost
             FROM inventory_transactions it
             WHERE it.product_id = ?
               AND it.warehouse_id = ?
               AND it.source_type = 'AP_BILL'
               AND it.txn_type = 'PURCHASE_BILL_RECEIPT'
               AND it.batch_id IS NOT NULL
               AND (it.is_deleted = 0 OR it.is_deleted IS NULL)
             ORDER BY it.id DESC
             LIMIT 1`,
            [productId, warehouseId]
        );
        const fb = fallbackRows?.[0];
        batchId = fb?.batch_id != null ? Number(fb.batch_id) : null;
        if (unitCost <= CARGO_RETURN_QC_EPS && fb?.unit_cost != null) {
            unitCost = Number(fb.unit_cost || 0);
        }
    }

    if (!batchId || !Number.isFinite(batchId)) {
        throw new Error(
            'Return line is missing a linked purchase batch (dispatch → AP bill line batch). Cannot post discard for rejected qty.'
        );
    }

    const uomId = ctx.uom_id != null && ctx.uom_id !== '' ? Number(ctx.uom_id) : null;
    const currencyId = ctx.currency_id != null && ctx.currency_id !== '' ? Number(ctx.currency_id) : null;
    const exchangeRate =
        ctx.exchange_rate != null && ctx.exchange_rate !== '' ? Number(ctx.exchange_rate) : null;

    const apBillId = ctx.ap_bill_id != null && ctx.ap_bill_id !== '' ? Number(ctx.ap_bill_id) : null;
    const apBillLineId = ctx.ap_bill_line_id != null && ctx.ap_bill_line_id !== '' ? Number(ctx.ap_bill_line_id) : null;

    const txnDate = new Date();
    const useApBill =
        apBillId != null && Number.isFinite(apBillId) && apBillLineId != null && Number.isFinite(apBillLineId);

    const invBase = {
        txn_date: txnDate,
        source_type: useApBill ? 'AP_BILL' : 'CARGO_RETURN',
        source_id: useApBill ? apBillId : cargoReturnId,
        source_line_id: useApBill ? apBillLineId : lineId,
        product_id: productId,
        warehouse_id: warehouseId,
        batch_id: batchId,
        unit_cost: unitCost,
        currency_id: currencyId,
        exchange_rate: exchangeRate,
        uom_id: uomId,
        sales_order_id: salesOrderId,
        dispatch_id: dispatchId
    };

    // AFTER_INVOICE + return_to_store=1: accepted qty should be stocked back IN (on approval/finalize).
    if (shouldStockInAccepted && dAcc > CARGO_RETURN_QC_EPS) {
        await inventoryService.updateInventoryStock(
            conn,
            productId,
            warehouseId,
            batchId,
            dAcc,
            unitCost,
            true,
            currencyId,
            uomId
        );
        await inventoryService.insertInventoryTransaction(conn, {
            ...invBase,
            movement: 'IN',
            txn_type: 'CARGO_RETURN_ACCEPT',
            qty: dAcc,
            movement_type_id: 1
        });
    }

    if (dRej > CARGO_RETURN_QC_EPS) {
        await inventoryService.insertInventoryTransaction(conn, {
            ...invBase,
            movement: 'DISCARD',
            txn_type: 'CARGO_RETURN_REJECT',
            qty: dRej,
            movement_type_id: 5
        });
    }
}

/**
 * @param {object} payload
 * @param {number} payload.clientId
 * @param {number|null} payload.userId
 * @param {number} payload.sales_order_id
 * @param {string|null} [payload.notes]
 * @param {string|null} [payload.return_source] - BEFORE_INVOICE | AFTER_INVOICE
 * @param {number|null} [payload.ar_invoice_id]
 * @param {number|null} [payload.return_reason_id]
 * @param {boolean} [payload.return_to_store]
 * @param {string|null} [payload.return_to_store_date] - YYYY-MM-DD
 * @param {string|null} [payload.refund_type] - FULL | PARTIAL
 * @param {Array<{ dispatch_id: number, dispatch_item_id: number, sales_order_item_id?: number, product_name?: string, dispatched_qty: number, return_qty: number }>} payload.lines
 */
export async function createCargoReturn({
    clientId,
    userId,
    sales_order_id,
    notes,
    return_source = null,
    ar_invoice_id = null,
    return_reason_id = null,
    return_to_store = false,
    return_to_store_date = null,
    refund_type = null,
    lines
}) {
    if (!sales_order_id || !Array.isArray(lines) || lines.length === 0) {
        throw new Error('sales_order_id and at least one line are required');
    }
    const notesTrim = notes != null ? String(notes).trim() : '';
    if (!notesTrim) {
        throw new Error('notes (return reason) is required');
    }

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        const [soRows] = await conn.query(
            `SELECT id FROM sales_orders WHERE id = ? AND COALESCE(is_deleted, 0) = 0`,
            [sales_order_id]
        );
        if (!soRows.length) {
            throw new Error('Sales order not found');
        }

        const normalizedSource = return_source != null ? String(return_source).trim().toUpperCase() : null;
        const normalizedRefund = refund_type != null ? String(refund_type).trim().toUpperCase() : null;
        const [ins] = await conn.query(
            `INSERT INTO cargo_returns (
                client_id,
                sales_order_id,
                document_date,
                status_id,
                notes,
                return_source,
                ar_invoice_id,
                return_reason_id,
                return_to_store,
                return_to_store_date,
                refund_type,
                created_by
            )
             VALUES (?, ?, CURDATE(), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                clientId,
                sales_order_id,
                CARGO_RETURN_STATUS_DRAFT,
                notesTrim,
                normalizedSource,
                ar_invoice_id != null && Number.isFinite(Number(ar_invoice_id)) ? Number(ar_invoice_id) : null,
                return_reason_id != null && Number.isFinite(Number(return_reason_id)) ? Number(return_reason_id) : null,
                return_to_store ? 1 : 0,
                return_to_store ? (return_to_store_date || null) : null,
                normalizedRefund,
                userId || null
            ]
        );
        const crId = ins.insertId;
        const y = new Date().getFullYear();
        const returnNo = `CR-${y}-${String(crId).padStart(6, '0')}`;
        await conn.query(`UPDATE cargo_returns SET return_no = ? WHERE id = ?`, [returnNo, crId]);

        await insertCargoReturnLines(conn, crId, lines);

        await insertHistory(conn, {
            module: 'cargo_return',
            moduleId: crId,
            userId,
            action: 'CREATED',
            details: {
                sales_order_id,
                return_source: normalizedSource,
                ar_invoice_id: ar_invoice_id != null ? Number(ar_invoice_id) : null,
                return_reason_id: return_reason_id != null ? Number(return_reason_id) : null,
                return_to_store: !!return_to_store,
                return_to_store_date: return_to_store ? (return_to_store_date || null) : null,
                refund_type: normalizedRefund
            }
        });
        await mirrorCargoReturnToSalesOrderHistory(conn, {
            salesOrderId: sales_order_id,
            cargoReturnId: crId,
            returnNo,
            userId,
            action: 'CARGO_RETURN_CREATED',
            details: {}
        });

        await conn.commit();
        return { id: crId, return_no: returnNo };
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }
}

export async function getCargoReturnDetail({ id, clientId }) {
    const header = await getCargoReturnHeaderById({ id, clientId });
    if (!header) return null;
    const [lines, attachments, history] = await Promise.all([
        getCargoReturnLinesByHeaderId(id),
        getCargoReturnAttachmentsByCargoReturnId(id),
        getCargoReturnAudit({ cargoReturnId: id })
    ]);
    return { header, lines, attachments, history };
}

async function upsertSalesQc(conn, cargoReturnId, patch) {
    const crId = Number(cargoReturnId);
    if (!Number.isFinite(crId)) return;
    const entries = Object.entries(patch || {});
    if (!entries.length) return;
    const fields = entries.map(([k]) => `${k} = ?`).join(', ');
    const args = entries.map(([, v]) => v);
    // One row per cargo return; client_id kept as 1 for now (matches existing cargo_returns default).
    await conn.query(
        `INSERT INTO sales_qc (cargo_return_id, client_id)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE ${fields}`,
        [crId, 1, ...args]
    );
}

/** Draft (3) → Submitted for approval (8) */
export async function submitCargoReturnForApproval({ id, clientId, userId = null }) {
    const headerSnap = await getCargoReturnHeaderById({ id, clientId });
    if (!headerSnap) throw new Error('Cargo return not found');

    await updateCargoReturnStatusId({
        id,
        clientId,
        fromStatusIds: [CARGO_RETURN_STATUS_DRAFT],
        toStatusId: CARGO_RETURN_STATUS_SUBMITTED_FOR_APPROVAL,
        // First stop: manager approval queue (Approvals → Sales QC).
        toQcStatusId: QC_STATUS_SUBMITTED_FOR_MANAGER_APPROVAL
    });

    const conn = await db.promise().getConnection();
    try {
        // Do NOT create a Sales QC row on submit.
        // Sales QC entry should be created only at manager approval time (when return_to_store = 1).
        await insertHistory(conn, {
            module: 'cargo_return',

            moduleId: id,
            userId,
            action: 'SUBMITTED',
            details: {}
        });
        await mirrorCargoReturnToSalesOrderHistory(conn, {
            salesOrderId: headerSnap.sales_order_id,
            cargoReturnId: id,
            returnNo: headerSnap.return_no,
            userId,
            action: 'CARGO_RETURN_SUBMITTED',
            details: {}
        });
    } finally {
        conn.release();
    }
    return getCargoReturnDetail({ id, clientId });
}

async function getNextArCreditNoteNumber(conn) {
    const [rows] = await conn.query(`SELECT id FROM ar_credit_notes ORDER BY id DESC LIMIT 1`);
    const next = (rows[0]?.id || 0) + 1;
    return `CN-${String(next).padStart(5, '0')}`;
}

async function loadArInvoiceLinesForCreditNote(conn, invoiceId) {
    const invId = Number(invoiceId);
    if (!Number.isFinite(invId)) return [];
    // ar_invoice_lines schema differs across DBs; progressively fall back on missing columns.
    const attempts = [
        // richest shape
        `SELECT
            il.id,
            il.line_no,
            il.sales_order_item_id,
            il.product_id,
            il.item_name,
            il.description,
            il.quantity,
            il.uom_id,
            il.rate,
            il.tax_id,
            il.tax_rate,
            il.line_total,
            il.account_id
         FROM ar_invoice_lines il
         WHERE il.invoice_id = ?
         ORDER BY il.line_no ASC, il.id ASC`,
        // no account_id
        `SELECT
            il.id,
            il.line_no,
            il.sales_order_item_id,
            il.product_id,
            il.item_name,
            il.description,
            il.quantity,
            il.uom_id,
            il.rate,
            il.tax_id,
            il.tax_rate,
            il.line_total
         FROM ar_invoice_lines il
         WHERE il.invoice_id = ?
         ORDER BY il.line_no ASC, il.id ASC`,
        // no sales_order_item_id
        `SELECT
            il.id,
            il.line_no,
            il.product_id,
            il.item_name,
            il.description,
            il.quantity,
            il.uom_id,
            il.rate,
            il.tax_id,
            il.tax_rate,
            il.line_total
         FROM ar_invoice_lines il
         WHERE il.invoice_id = ?
         ORDER BY il.line_no ASC, il.id ASC`,
        // minimal
        `SELECT
            il.id,
            il.product_id,
            il.item_name,
            il.quantity,
            il.uom_id,
            il.rate
         FROM ar_invoice_lines il
         WHERE il.invoice_id = ?
         ORDER BY il.id ASC`
    ];

    let lastErr = null;
    for (const sql of attempts) {
        try {
            const [rows] = await conn.query(sql, [invId]);
            return rows || [];
        } catch (e) {
            lastErr = e;
        }
    }
    if (lastErr) throw lastErr;
    return [];
}

async function maybeCreateAutoCreditNote(conn, { cargoReturnHeader, userId }) {
    const source = String(cargoReturnHeader?.return_source || '').trim().toUpperCase();
    if (source !== 'AFTER_INVOICE') return null;
    const invId = cargoReturnHeader?.ar_invoice_id != null ? Number(cargoReturnHeader.ar_invoice_id) : null;
    if (!invId || !Number.isFinite(invId)) return null;

    const [[inv]] = await conn.query(
        `SELECT id, customer_id, company_id, warehouse_id, currency_id, invoice_number
         FROM ar_invoices
         WHERE id = ?
         LIMIT 1`,
        [invId]
    );
    if (!inv?.id) {
        throw new Error('Linked customer invoice not found for auto credit note');
    }

    const credit_note_number = await getNextArCreditNoteNumber(conn);
    const credit_note_uniqid = `cn_${Date.now()}_${Math.random().toString(16).slice(2)}_${String(inv.id)}`;
    const subject = `Cargo Return ${cargoReturnHeader.return_no || `#${cargoReturnHeader.id}`}`;
    const customer_notes = cargoReturnHeader?.notes ? String(cargoReturnHeader.notes) : null;

    // Build CN lines from returned quantities + source invoice lines.
    const [crLineRows] = await conn.query(
        `SELECT
            crl.id AS cargo_return_line_id,
            crl.sales_order_item_id,
            crl.product_name,
            crl.return_qty,
            soi.product_id,
            soi.uom_id
         FROM cargo_return_lines crl
         LEFT JOIN sales_order_items soi ON soi.id = crl.sales_order_item_id
         WHERE crl.cargo_return_id = ?
         ORDER BY crl.line_no ASC, crl.id ASC`,
        [Number(cargoReturnHeader.id)]
    );
    const invoiceLines = await loadArInvoiceLinesForCreditNote(conn, inv.id);

    const retBySoi = new Map();
    const retByProduct = new Map();
    for (const r of crLineRows || []) {
        const qty = Number(r.return_qty || 0);
        if (!Number.isFinite(qty) || qty <= CARGO_RETURN_QC_EPS) continue;
        const soiId = r.sales_order_item_id != null ? Number(r.sales_order_item_id) : null;
        const pid = r.product_id != null ? Number(r.product_id) : null;
        if (soiId != null && Number.isFinite(soiId)) {
            retBySoi.set(soiId, (retBySoi.get(soiId) || 0) + qty);
        }
        if (pid != null && Number.isFinite(pid)) {
            retByProduct.set(pid, (retByProduct.get(pid) || 0) + qty);
        }
    }

    const cnLines = [];
    for (const il of invoiceLines || []) {
        const ilId = Number(il.id);
        if (!Number.isFinite(ilId)) continue;
        const ilQty = Number(il.quantity || 0);
        const rate = Number(il.rate || 0);
        const taxRate = Number(il.tax_rate || 0);

        // Prefer sales_order_item_id matching when available.
        let retQty = 0;
        const soiId = il.sales_order_item_id != null ? Number(il.sales_order_item_id) : null;
        if (soiId != null && Number.isFinite(soiId) && retBySoi.has(soiId)) {
            retQty = Number(retBySoi.get(soiId) || 0);
        } else {
            const pid = il.product_id != null ? Number(il.product_id) : null;
            if (pid != null && Number.isFinite(pid) && retByProduct.has(pid)) {
                retQty = Number(retByProduct.get(pid) || 0);
            }
        }

        if (!Number.isFinite(retQty) || retQty <= CARGO_RETURN_QC_EPS) continue;
        if (Number.isFinite(ilQty) && ilQty > CARGO_RETURN_QC_EPS) {
            retQty = Math.min(retQty, ilQty);
        }

        const lineTotal = Math.round(retQty * rate * 10000) / 10000;
        cnLines.push({
            ar_invoice_line_id: ilId,
            product_id: il.product_id != null ? Number(il.product_id) : null,
            item_name: il.item_name || null,
            description: il.description || null,
            quantity: retQty,
            uom_id: il.uom_id != null ? Number(il.uom_id) : null,
            rate,
            tax_id: il.tax_id != null ? Number(il.tax_id) : null,
            tax_rate: taxRate,
            line_total: lineTotal,
            account_id: il.account_id != null ? Number(il.account_id) : null
        });
    }

    if (!cnLines.length) {
        throw new Error('Auto credit note: no matching invoice lines found for returned quantities');
    }

    const subtotal = cnLines.reduce((s, l) => s + Number(l.line_total || 0), 0);
    const tax_total = cnLines.reduce((s, l) => s + (Number(l.line_total || 0) * (Number(l.tax_rate || 0) / 100)), 0);
    const total = subtotal + tax_total;

    const [ins] = await conn.query(
        `INSERT INTO ar_credit_notes (
            credit_note_uniqid,
            credit_note_number,
            credit_note_date,
            reference_no,
            subject,
            customer_id,
            ar_invoice_id,
            company_id,
            warehouse_id,
            currency_id,
            customer_notes,
            discount_type,
            discount_amount,
            subtotal,
            tax_total,
            total,
            status_id,
            user_id
        ) VALUES (?, ?, CURDATE(), ?, ?, ?, ?, ?, ?, ?, ?, 'fixed', 0, ?, ?, ?, 8, ?)`,
        [
            credit_note_uniqid,
            credit_note_number,
            inv.invoice_number || null,
            subject,
            inv.customer_id,
            inv.id,
            inv.company_id || null,
            inv.warehouse_id || null,
            inv.currency_id || null,
            customer_notes,
            subtotal,
            tax_total,
            total,
            userId || null
        ]
    );

    const cnId = ins.insertId;
    for (let i = 0; i < cnLines.length; i++) {
        const L = cnLines[i];
        await conn.query(
            `INSERT INTO ar_credit_note_lines
             (credit_note_id, line_no, ar_invoice_line_id, product_id, item_name, description,
              quantity, uom_id, rate, tax_id, tax_rate, line_total, account_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                cnId,
                i + 1,
                L.ar_invoice_line_id || null,
                L.product_id || null,
                L.item_name || null,
                L.description || null,
                Number(L.quantity) || 0,
                L.uom_id || null,
                Number(L.rate) || 0,
                L.tax_id || null,
                Number(L.tax_rate) || 0,
                Number(L.line_total) || 0,
                L.account_id || null
            ]
        );
    }

    return { id: cnId, credit_note_number };
}

/**
 * Manager approval step (Approvals → Sales QC):
 * - Moves qc_status_id from "Submitted for manager approval" (8) → "Pending QC" (4)
 * - If AFTER_INVOICE, auto-creates a draft AR Credit Note linked to the selected invoice.
 */
export async function managerApproveCargoReturnForQc({ id, clientId, userId = null, comment }) {
    const commentTrim = comment != null ? String(comment).trim() : '';
    if (!commentTrim) throw new Error('comment is required');
    const header = await getCargoReturnHeaderById({ id, clientId });
    if (!header) throw new Error('Cargo return not found');
    if (Number(header.status_id) !== CARGO_RETURN_STATUS_SUBMITTED_FOR_APPROVAL) {
        throw new Error('Cargo return is not in submitted status');
    }
    if (Number(header.qc_status_id) !== QC_STATUS_SUBMITTED_FOR_MANAGER_APPROVAL) {
        throw new Error('Cargo return is not pending manager approval');
    }
    if (Number(header.qc_inventory_pending) === 1) {
        throw new Error('Cargo return already has a QC decision pending inventory posting');
    }

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        const creditNote = await maybeCreateAutoCreditNote(conn, { cargoReturnHeader: header, userId });

        const returnToStore = Boolean(header.return_to_store);
        if (!returnToStore) {
            // No physical return → discard all quantities immediately (no QC queue),
            // then approve the document and only issue credit note if applicable.
            const [allLines] = await conn.query(
                `SELECT id, return_qty
                 FROM cargo_return_lines
                 WHERE cargo_return_id = ?
                 ORDER BY line_no ASC, id ASC
                 FOR UPDATE`,
                [id]
            );
            if (!allLines.length) {
                throw new Error('Cargo return has no lines');
            }
            for (const row of allLines) {
                const lineId = Number(row.id);
                const retQty = Number(row.return_qty || 0);
                if (!Number.isFinite(lineId) || !Number.isFinite(retQty) || retQty <= CARGO_RETURN_QC_EPS) continue;
                await postCargoReturnQcInventory(conn, {
                    cargoReturnId: id,
                    lineId,
                    newAcceptedQty: 0,
                    newRejectedQty: retQty
                });
            }
            await conn.query(
                `UPDATE cargo_return_lines
                 SET accepted_qty = 0,
                     rejected_qty = return_qty,
                     pending_accepted_qty = NULL,
                     pending_rejected_qty = NULL
                 WHERE cargo_return_id = ?`,
                [id]
            );

            await conn.query(
                `UPDATE cargo_returns
                 SET status_id = ?, qc_status_id = NULL, qc_inventory_pending = 0, updated_by = ?
                 WHERE id = ? AND client_id = ?`,
                [1, userId, id, clientId]
            );
            await insertHistory(conn, {
                module: 'cargo_return',
                moduleId: id,
                userId,
                action: 'MANAGER_APPROVED_NO_QC',
                details: {
                    comment: commentTrim,
                    discard: true,
                    credit_note_id: creditNote?.id ?? null,
                    credit_note_number: creditNote?.credit_note_number ?? null
                }
            });
            await mirrorCargoReturnToSalesOrderHistory(conn, {
                salesOrderId: header.sales_order_id,
                cargoReturnId: id,
                returnNo: header.return_no,
                userId,
                action: 'CARGO_RETURN_MANAGER_APPROVED_NO_QC',
                details: {
                    comment: commentTrim,
                    discard: true,
                    credit_note_id: creditNote?.id ?? null,
                    credit_note_number: creditNote?.credit_note_number ?? null
                }
            });
        } else {
            // Physical return → send to Sales QC
            await conn.query(
                `UPDATE cargo_returns
                 SET status_id = ?, qc_status_id = ?, updated_by = ?
                 WHERE id = ? AND client_id = ?`,
                [1, QC_STATUS_PENDING_QC, userId, id, clientId]
            );

            await upsertSalesQc(conn, id, {
                qc_status_id: QC_STATUS_PENDING_QC,
                manager_approval_comment: commentTrim
            });

            await insertHistory(conn, {
                module: 'cargo_return',
                moduleId: id,
                userId,
                action: 'MANAGER_APPROVED_FOR_QC',
                details: {
                    comment: commentTrim,
                    credit_note_id: creditNote?.id ?? null,
                    credit_note_number: creditNote?.credit_note_number ?? null
                }
            });
            await mirrorCargoReturnToSalesOrderHistory(conn, {
                salesOrderId: header.sales_order_id,
                cargoReturnId: id,
                returnNo: header.return_no,
                userId,
                action: 'CARGO_RETURN_MANAGER_APPROVED_FOR_QC',
                details: {
                    comment: commentTrim,
                    credit_note_id: creditNote?.id ?? null,
                    credit_note_number: creditNote?.credit_note_number ?? null
                }
            });
        }

        await conn.commit();
        return getCargoReturnDetail({ id, clientId });
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }
}


/**
 * Replace draft cargo return lines (same shape as create).
 * @param {object} p
 * @param {number} p.id
 * @param {number} p.clientId
 * @param {string|null} [p.notes] - if provided, updates notes
 * @param {Array} p.lines
 */
export async function updateCargoReturn({
    id,
    clientId,
    userId = null,
    notes,
    return_source,
    ar_invoice_id,
    return_reason_id,
    return_to_store,
    return_to_store_date,
    refund_type,
    lines
}) {
    if (!id || !Array.isArray(lines)) {
        throw new Error('Invalid payload');
    }

    const header = await getCargoReturnHeaderById({ id, clientId });
    if (!header) {
        throw new Error('Cargo return not found');
    }
    const originalStatusId = Number(header.status_id);
    const originalQcStatusId = header.qc_status_id != null ? Number(header.qc_status_id) : null;
    if (!isEditableCargoReturnHeader(header)) {
        throw new Error(`Only draft/rejected cargo returns can be edited (current: ${header?.status_id ?? '—'})`);
    }

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        await conn.query(`DELETE FROM cargo_return_lines WHERE cargo_return_id = ?`, [id]);

        const updateFields = [];
        const updateArgs = [];
        if (notes !== undefined) {
            const notesTrim = notes != null ? String(notes).trim() : '';
            if (!notesTrim) {
                throw new Error('notes (return reason) is required');
            }
            updateFields.push('notes = ?');
            updateArgs.push(notesTrim);
        }
        if (return_source !== undefined) {
            const normalizedSource = return_source != null ? String(return_source).trim().toUpperCase() : null;
            updateFields.push('return_source = ?');
            updateArgs.push(normalizedSource);
        }
        if (ar_invoice_id !== undefined) {
            updateFields.push('ar_invoice_id = ?');
            updateArgs.push(ar_invoice_id != null && ar_invoice_id !== '' ? Number(ar_invoice_id) : null);
        }
        if (return_reason_id !== undefined) {
            updateFields.push('return_reason_id = ?');
            updateArgs.push(return_reason_id != null && return_reason_id !== '' ? Number(return_reason_id) : null);
        }
        if (return_to_store !== undefined) {
            updateFields.push('return_to_store = ?');
            updateArgs.push(return_to_store ? 1 : 0);
        }
        if (return_to_store_date !== undefined) {
            updateFields.push('return_to_store_date = ?');
            const toStore = return_to_store !== undefined ? !!return_to_store : !!header.return_to_store;
            updateArgs.push(toStore ? (return_to_store_date || null) : null);
        }
        if (refund_type !== undefined) {
            const normalizedRefund = refund_type != null ? String(refund_type).trim().toUpperCase() : null;
            updateFields.push('refund_type = ?');
            updateArgs.push(normalizedRefund);
        }
        if (updateFields.length) {
            await conn.query(`UPDATE cargo_returns SET ${updateFields.join(', ')} WHERE id = ? AND client_id = ?`, [
                ...updateArgs,
                id,
                clientId
            ]);
        }

        await insertCargoReturnLines(conn, id, lines);

        // When editing a rejected return, move it back to Draft automatically.
        if (originalStatusId === CARGO_RETURN_STATUS_EDITABLE_ALT) {
            await conn.query(
                `UPDATE cargo_returns
                 SET status_id = ?,
                     qc_status_id = NULL,
                     qc_decision = NULL,
                     qc_comment = NULL,
                     qc_manager_id = NULL
                 WHERE id = ? AND client_id = ?`,
                [CARGO_RETURN_STATUS_DRAFT, id, clientId]
            );
        }

        await insertHistory(conn, {
            module: 'cargo_return',
            moduleId: id,
            userId,
            action: 'UPDATED',
            details: {
                notes_updated: notes !== undefined,
                meta_updated:
                    return_source !== undefined ||
                    ar_invoice_id !== undefined ||
                    return_reason_id !== undefined ||
                    return_to_store !== undefined ||
                    return_to_store_date !== undefined ||
                    refund_type !== undefined
            }
        });
        await mirrorCargoReturnToSalesOrderHistory(conn, {
            salesOrderId: header.sales_order_id,
            cargoReturnId: id,
            returnNo: header.return_no,
            userId,
            action: 'CARGO_RETURN_UPDATED',
            details: { notes_updated: notes !== undefined }
        });

        await conn.commit();
        return getCargoReturnDetail({ id, clientId });
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }
}

/**
 * @param {object} p
 * @param {number} p.id - cargo return id
 * @param {number} p.clientId
 * @param {number|null} p.userId
 * @param {Array} p.files - multer files with file_path set
 */
export async function addCargoReturnAttachments({ id, clientId, userId, files, scope = 'RETURN' }) {
    const header = await getCargoReturnHeaderById({ id, clientId });
    if (!header) throw new Error('Cargo return not found');
    const normalizedScope = String(scope || 'RETURN').trim().toUpperCase();
    if (!isEditableCargoReturnHeader(header)) {
        throw new Error('Attachments can only be added while the cargo return is editable');
    }
    if (!files?.length) throw new Error('No files uploaded');

    const rows = files.map((file) => ({
        cargo_return_id: id,
        scope: normalizedScope || 'RETURN',
        file_original_name: file.originalname || file.filename,
        file_name: file.filename,
        file_type: file.mimetype,
        file_size: file.size,
        file_path: file.file_path,
        uploaded_by: userId
    }));

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();
        await insertCargoReturnAttachments(conn, rows);
        await insertHistory(conn, {
            module: 'cargo_return',
            moduleId: id,
            userId,
            action: 'ATTACHMENTS_ADDED',
            details: { count: rows.length, names: rows.map((r) => r.file_original_name).slice(0, 20) }
        });
        await mirrorCargoReturnToSalesOrderHistory(conn, {
            salesOrderId: header.sales_order_id,
            cargoReturnId: id,
            returnNo: header.return_no,
            userId,
            action: 'CARGO_RETURN_ATTACHMENTS_ADDED',
            details: { count: rows.length, names: rows.map((r) => r.file_original_name).slice(0, 20) }
        });
        await conn.commit();
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }
    return getCargoReturnDetail({ id, clientId });
}

export async function removeCargoReturnAttachment({ id, clientId, attachmentId, userId = null }) {
    const header = await getCargoReturnHeaderById({ id, clientId });
    if (!header) throw new Error('Cargo return not found');
    if (!isEditableCargoReturnHeader(header)) {
        throw new Error('Attachments can only be removed while the cargo return is editable');
    }

    const att = await getCargoReturnAttachmentById(attachmentId);
    if (!att || Number(att.cargo_return_id) !== Number(id)) {
        throw new Error('Attachment not found');
    }

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();
        await deleteCargoReturnAttachmentById(conn, attachmentId);
        await insertHistory(conn, {
            module: 'cargo_return',
            moduleId: id,
            userId,
            action: 'ATTACHMENT_DELETED',
            details: { attachment_id: attachmentId, file_name: att?.file_original_name || att?.file_name }
        });
        await mirrorCargoReturnToSalesOrderHistory(conn, {
            salesOrderId: header.sales_order_id,
            cargoReturnId: id,
            returnNo: header.return_no,
            userId,
            action: 'CARGO_RETURN_ATTACHMENT_DELETED',
            details: { attachment_id: attachmentId, file_name: att?.file_original_name || att?.file_name }
        });
        await conn.commit();
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }

    const abs = path.isAbsolute(att.file_path)
        ? att.file_path
        : path.join(SERVER_ROOT, att.file_path.replace(/^\//, ''));
    if (att.file_path && fs.existsSync(abs)) {
        try {
            fs.unlinkSync(abs);
        } catch (e) {
            console.error('[cargo-return] remove attach file', abs, e?.message);
        }
    }
    return getCargoReturnDetail({ id, clientId });
}

export async function rejectCargoReturn({ id, clientId, userId, comment }) {
    const header = await getCargoReturnHeaderById({ id, clientId });
    if (!header) throw new Error('Cargo return not found');

    const statusSubmitted = 8;
    const statusApproved = 1;

    if (Number(header.status_id) !== statusSubmitted && Number(header.status_id) !== statusApproved) {
        throw new Error('Only submitted or approved cargo returns can be rejected completely');
    }
    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        await conn.query(
            `UPDATE cargo_returns 
             SET status_id = 2, qc_status_id = 2, qc_comment = ?, qc_manager_id = ?, updated_by = ?, qc_inventory_pending = 0, qc_decision = NULL
             WHERE id = ? AND client_id = ?`,
            [comment || null, userId, userId, id, clientId]
        );
        await conn.query(
            `UPDATE cargo_return_lines SET pending_accepted_qty = NULL, pending_rejected_qty = NULL WHERE cargo_return_id = ?`,
            [id]
        );

        await insertHistory(conn, {
            module: 'cargo_return',
            moduleId: id,
            userId,
            action: 'REJECTED',
            details: { comment }
        });
        await mirrorCargoReturnToSalesOrderHistory(conn, {
            salesOrderId: header.sales_order_id,
            cargoReturnId: id,
            returnNo: header.return_no,
            userId,
            action: 'CARGO_RETURN_REJECTED',
            details: { comment }
        });

        await conn.commit();
        return getCargoReturnDetail({ id, clientId });
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }
}

/**
 * Process a QC decision (Accept, Reject, Regrade) for a cargo return.
 * @param {object} p
 * @param {number} p.id
 * @param {number} p.clientId
 * @param {number} p.userId
 * @param {string} p.decision - 'ACCEPT', 'REJECT', 'REGRADE'
 * @param {string} p.comment
 * @param {Array<{id: number, accepted_qty: number, rejected_qty: number}>} p.lines
 * @param {Array<{ filename: string, originalname?: string, mimetype?: string, size?: number, file_path: string }>} [p.files] - optional QC evidence (same shape as after multer + file_path)
 */
export async function processQcDecision({ id, clientId, userId, decision, comment, lines, files = [] }) {
    if (!comment || !String(comment).trim()) {
        throw new Error('QC comment is required');
    }
    const header = await getCargoReturnHeaderById({ id, clientId });
    if (!header) throw new Error('Cargo return not found');

    const statusSubmitted = CARGO_RETURN_STATUS_SUBMITTED_FOR_APPROVAL;

    const curStatusId = Number(header.status_id);
    if (curStatusId !== statusSubmitted && curStatusId !== 1) {
        throw new Error('Only submitted/approved cargo returns can be processed by QC');
    }

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        // Decision only: pending quantities + qc fields. Inventory and final status are applied in finalizeCargoReturnQcInventoryApproval.
        await conn.query(
            `UPDATE cargo_returns 
             SET status_id = ?,
                 qc_status_id = ?,
                 qc_decision = ?,
                 qc_comment = ?,
                 qc_manager_id = ?,
                 updated_by = ?,
                 qc_inventory_pending = 1
             WHERE id = ? AND client_id = ?`,
            [
                curStatusId,
                QC_STATUS_SUBMITTED_FOR_MANAGER_APPROVAL,
                decision,
                comment || null,
                userId,
                userId,
                id,
                clientId
            ]
        );

        await upsertSalesQc(conn, id, {
            qc_status_id: QC_STATUS_SUBMITTED_FOR_MANAGER_APPROVAL,
            qc_decision: decision,
            qc_comment: comment || null,
            qc_manager_id: userId,
            qc_inventory_pending: 1
        });

        await insertHistory(conn, {
            module: 'cargo_return',
            moduleId: id,
            userId,
            action: 'QC_DECISION',
            details: { decision, comment }
        });
        await mirrorCargoReturnToSalesOrderHistory(conn, {
            salesOrderId: header.sales_order_id,
            cargoReturnId: id,
            returnNo: header.return_no,
            userId,
            action: 'CARGO_RETURN_QC_DECISION',
            details: { decision, comment }
        });

        const [allLines] = await conn.query(
            `SELECT id, return_qty FROM cargo_return_lines WHERE cargo_return_id = ? ORDER BY line_no ASC, id ASC`,
            [id]
        );
        if (!allLines.length) {
            throw new Error('Cargo return has no lines');
        }

        const payloadById = new Map((lines || []).map((L) => [Number(L.id), L]));

        for (const row of allLines) {
            const lineId = Number(row.id);
            const retQty = Number(row.return_qty || 0);
            const payload = payloadById.get(lineId);

            let acc = 0;
            let rej = 0;

            if (decision === 'ACCEPT') {
                acc = retQty;
                rej = 0;
            } else if (decision === 'REJECT') {
                acc = 0;
                rej = retQty;
            } else if (decision === 'REGRADE') {
                if (!payload) {
                    throw new Error(`Missing QC line data for regrade (line id ${lineId})`);
                }
                acc = Number(payload.accepted_qty || 0);
                rej = Number(payload.rejected_qty || 0);
                if (acc < 0 || rej < 0) {
                    throw new Error('Accepted and rejected quantities cannot be negative');
                }
                if (Math.abs(acc + rej - retQty) > 1e-6) {
                    throw new Error(
                        `Line ${lineId}: accepted (${acc}) + rejected (${rej}) must equal returned quantity (${retQty})`
                    );
                }
            } else {
                throw new Error(`Unknown QC decision: ${decision}`);
            }

            await conn.query(
                `UPDATE cargo_return_lines
                 SET pending_accepted_qty = ?, pending_rejected_qty = ?, accepted_qty = 0, rejected_qty = 0
                 WHERE id = ? AND cargo_return_id = ?`,
                [acc, rej, lineId, id]
            );
        }

        if (files?.length) {
            const rows = files.map((file) => ({
                cargo_return_id: id,
                scope: 'QC',
                file_original_name: file.originalname || file.filename,
                file_name: file.filename,
                file_type: file.mimetype,
                file_size: file.size,
                file_path: file.file_path,
                uploaded_by: userId
            }));
            await insertCargoReturnAttachments(conn, rows);
            await insertHistory(conn, {
                module: 'cargo_return',
                moduleId: id,
                userId,
                action: 'ATTACHMENTS_ADDED',
                details: {
                    count: rows.length,
                    names: rows.map((r) => r.file_original_name).slice(0, 20),
                    scope: 'QC'
                }
            });
            await mirrorCargoReturnToSalesOrderHistory(conn, {
                salesOrderId: header.sales_order_id,
                cargoReturnId: id,
                returnNo: header.return_no,
                userId,
                action: 'CARGO_RETURN_ATTACHMENTS_ADDED',
                details: {
                    count: rows.length,
                    names: rows.map((r) => r.file_original_name).slice(0, 20),
                    scope: 'QC'
                }
            });
        }

        await conn.commit();
        return getCargoReturnDetail({ id, clientId });
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }
}

/**
 * After QC decision, post inventory + dispatch reductions and set final document status.
 * Call this when approving (separate from recording the QC decision).
 */
export async function finalizeCargoReturnQcInventoryApproval({ id, clientId, userId, approvalComment = null }) {
    const commentTrim = approvalComment != null ? String(approvalComment).trim() : '';
    if (!commentTrim) {
        throw new Error('Manager approval comment is required');
    }

    const header = await getCargoReturnHeaderById({ id, clientId });
    if (!header) throw new Error('Cargo return not found');
    if (!Number(header.qc_inventory_pending)) {
        throw new Error('No pending QC inventory to post. Save a QC decision first.');
    }
    if (Number(header.status_id) !== CARGO_RETURN_STATUS_SUBMITTED_FOR_APPROVAL && Number(header.status_id) !== 1) {
        throw new Error('Cargo return must be submitted/approved to post inventory');
    }
    const decision = String(header.qc_decision || '').trim();
    if (!decision) throw new Error('QC decision is missing');

    const statusApproved = 1;
    const statusRejected = 2;

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        const [allLines] = await conn.query(
            `SELECT id, return_qty, COALESCE(pending_accepted_qty, 0) AS pa, COALESCE(pending_rejected_qty, 0) AS pr
             FROM cargo_return_lines WHERE cargo_return_id = ? ORDER BY line_no ASC, id ASC FOR UPDATE`,
            [id]
        );
        if (!allLines.length) {
            throw new Error('Cargo return has no lines');
        }

        for (const row of allLines) {
            const lineId = Number(row.id);
            const acc = Number(row.pa || 0);
            const rej = Number(row.pr || 0);
            await postCargoReturnQcInventory(conn, {
                cargoReturnId: id,
                lineId,
                newAcceptedQty: acc,
                newRejectedQty: rej
            });
            await conn.query(
                `UPDATE cargo_return_lines SET accepted_qty = ?, rejected_qty = ? WHERE id = ? AND cargo_return_id = ?`,
                [acc, rej, lineId, id]
            );
        }

        let targetStatusId = statusApproved;
        let targetQcStatusId = QC_STATUS_QC_COMPLETED_APPROVED;
        if (decision === 'REJECT') {
            // QC rejected: keep cargo return document approved, only QC status becomes rejected.
            targetStatusId = statusApproved;
            targetQcStatusId = statusRejected;
        }

        await conn.query(
            `UPDATE cargo_returns
             SET status_id = ?, qc_status_id = ?, qc_inventory_pending = 0, updated_by = ?
             WHERE id = ? AND client_id = ?`,
            [targetStatusId, targetQcStatusId, userId, id, clientId]
        );

        // Keep `sales_qc` in sync for approvals tracking.
        // Requirement: on approval, set qc_status_id=1 (or 2 if QC rejected), qc_inventory_pending=0, manager_approval_comment=comment.
        const qcFinalStatusId = decision === 'REJECT' ? 2 : 1;
        await upsertSalesQc(conn, id, {
            qc_status_id: qcFinalStatusId,
            qc_inventory_pending: 0,
            manager_approval_comment: commentTrim
        });

        await insertHistory(conn, {
            module: 'cargo_return',
            moduleId: id,
            userId,
            action: 'QC_INVENTORY_POSTED',
            details: { decision, approval_comment: commentTrim }
        });
        await mirrorCargoReturnToSalesOrderHistory(conn, {
            salesOrderId: header.sales_order_id,
            cargoReturnId: id,
            returnNo: header.return_no,
            userId,
            action: 'CARGO_RETURN_QC_INVENTORY_POSTED',
            details: { decision, approval_comment: commentTrim }
        });

        await conn.commit();
        return getCargoReturnDetail({ id, clientId });
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }
}

