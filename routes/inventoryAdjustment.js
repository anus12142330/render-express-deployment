/**
 * Inventory adjustments — list, detail, draft, post
 */
import { Router } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import db from '../db.js';
import { requireAuth } from '../middleware/authz.js';
import { inventoryAdjustmentUpload, buildIaStoredPath } from './inventoryAdjustment.upload.js';

const require = createRequire(import.meta.url);
const glService = require('../src/modules/gl/gl.service.cjs');
const inventoryService = require('../src/modules/inventory/inventory.service.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');

const router = Router();

/** Global `status.id` — same as AR invoices / cargo returns / credit notes */
const IA_STATUS_DRAFT = 3;
const IA_STATUS_SUBMITTED = 8;
const IA_STATUS_APPROVED = 1;
const IA_STATUS_REJECTED = 2;

/** SQL fragment: stable `status` string for API + UI */
const STATUS_CASE_SQL = `
  CASE ia.status_id
    WHEN 3 THEN 'draft'
    WHEN 8 THEN 'submitted'
    WHEN 1 THEN 'approved'
    WHEN 2 THEN 'rejected'
    ELSE LOWER(REPLACE(TRIM(COALESCE(st.name,'')), ' ', '_'))
  END`;

async function loadAttachmentsForAdjustment(adjId) {
  try {
    const [rows] = await db.promise().query(
      `SELECT id, file_original_name, file_name, file_type, file_size, file_path, uploaded_by, created_at
       FROM inventory_adjustment_attachments
       WHERE inventory_adjustment_id = ?
       ORDER BY id ASC`,
      [adjId]
    );
    return rows || [];
  } catch (e) {
    if (String(e?.code) === 'ER_NO_SUCH_TABLE') return [];
    throw e;
  }
}

function mapInventoryAdjustmentLineRow(r, enriched = false) {
  const base = {
    line_id: r.line_id != null ? Number(r.line_id) : null,
    product_id: r.product_id,
    product_name: r.product_name,
    batch_id: r.batch_id,
    batch_no: r.batch_no,
    qty_available: r.qty_available != null ? Number(r.qty_available) : null,
    qty_adjusted: r.qty_adjusted != null ? Number(r.qty_adjusted) : null,
    new_qty_on_hand: r.new_qty_on_hand != null ? Number(r.new_qty_on_hand) : null,
    value_available: r.value_available != null ? Number(r.value_available) : null,
    value_adjusted: r.value_adjusted != null ? Number(r.value_adjusted) : null,
    new_value_on_hand: r.new_value_on_hand != null ? Number(r.new_value_on_hand) : null
  };
  if (!enriched) return base;
  return {
    ...base,
    hscode: r.product_hscode != null && String(r.product_hscode).trim() !== '' ? String(r.product_hscode) : null,
    packing_text: r.pd_packing_text != null ? String(r.pd_packing_text) : null,
    packing_alias: r.pd_packing_alias != null ? String(r.pd_packing_alias) : null,
    variety: r.pd_variety != null ? String(r.pd_variety) : null,
    grade_and_size_code: r.pd_grade != null ? String(r.pd_grade) : null,
    origin: r.origin_name != null && String(r.origin_name).trim() !== '' ? String(r.origin_name) : null
  };
}

async function insertIaAllocation(conn, {
  adjustmentId,
  lineId,
  productId,
  warehouseId,
  batchId,
  qtyAllocated,
  unitCost,
  allocationMethod,
  createdBy
}) {
  const q = Number(qtyAllocated);
  const u = Number(unitCost);
  const value = (Number.isFinite(q) ? q : 0) * (Number.isFinite(u) ? u : 0);
  await conn.query(
    `INSERT INTO inventory_adjustment_line_allocations
      (inventory_adjustment_id, line_id, product_id, warehouse_id, batch_id, qty_allocated, unit_cost, value_allocated, allocation_method, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      adjustmentId,
      lineId != null ? Number(lineId) : null,
      Number(productId),
      Number(warehouseId),
      batchId != null ? Number(batchId) : null,
      Number.isFinite(q) ? q : 0,
      Number.isFinite(u) ? u : 0,
      value,
      String(allocationMethod || 'FIFO').slice(0, 20),
      createdBy != null ? Number(createdBy) : null
    ]
  );
}

async function fetchLinesForAdjustment(adjId, conn = null) {
  const executor = conn || db.promise();
  const simpleSql = `SELECT id AS line_id, product_id, product_name, batch_id, batch_no,
            qty_available, qty_adjusted, new_qty_on_hand,
            value_available, value_adjusted, new_value_on_hand
     FROM inventory_adjustment_lines
     WHERE inventory_adjustment_id = ?
     ORDER BY line_no ASC, id ASC`;
  const enrichSql = `SELECT
        ial.id AS line_id,
        ial.product_id,
        ial.product_name,
        ial.batch_id,
        ial.batch_no,
        ial.qty_available,
        ial.qty_adjusted,
        ial.new_qty_on_hand,
        ial.value_available,
        ial.value_adjusted,
        ial.new_value_on_hand,
        p.hscode AS product_hscode,
        pd.packing_text AS pd_packing_text,
        pd.packing_alias AS pd_packing_alias,
        pd.variety AS pd_variety,
        pd.grade_and_size_code AS pd_grade,
        co.name AS origin_name
     FROM inventory_adjustment_lines ial
     LEFT JOIN products p ON p.id = ial.product_id
     LEFT JOIN product_details pd ON pd.id = (
       SELECT id FROM product_details pd2 WHERE pd2.product_id = ial.product_id ORDER BY pd2.id ASC LIMIT 1
     )
     LEFT JOIN country co ON co.id = pd.origin_id
     WHERE ial.inventory_adjustment_id = ?
     ORDER BY ial.line_no ASC, ial.id ASC`;
  try {
    const [rows] = await executor.query(enrichSql, [adjId]);
    return (rows || []).map((r) => mapInventoryAdjustmentLineRow(r, true));
  } catch (err) {
    console.warn('[inventory-adjustment] fetchLines enrich failed, using base lines', err?.message || err);
    const [rows] = await executor.query(simpleSql, [adjId]);
    return (rows || []).map((r) => mapInventoryAdjustmentLineRow(r, false));
  }
}

/**
 * Approve inventory adjustment: optional stock + GL + history (transactional; conn must be open).
 */
function netValueCalculated(mode, lines) {
  const modeQty = String(mode) !== 'value';
  let net = 0;
  for (const ln of lines) {
    let lineVal = 0;
    const vAdj = Number(ln.value_adjusted);
    if (Number.isFinite(vAdj) && Math.abs(vAdj) > 1e-9) {
      lineVal = vAdj;
    } else if (modeQty) {
      const qAdj = Number(ln.qty_adjusted);
      if (Number.isFinite(qAdj) && Math.abs(qAdj) > 1e-9) {
        const qAv = Number(ln.qty_available) || 0;
        const vAv = Number(ln.value_available) || 0;
        const unitCost = qAv > 0 ? vAv / qAv : 0;
        lineVal = qAdj * unitCost;
      }
    }
    net += lineVal;
    console.log(`[IA-Calc] Line #${ln.line_id || '?'}: QtyAdj=${ln.qty_adjusted}, UnitCost=${(lineVal / (Number(ln.qty_adjusted) || 1)).toFixed(4)}, LineVal=${lineVal.toFixed(4)}`);
  }
  return net;
}

/**
 * Approve inventory adjustment: optional stock + GL + history (transactional; conn must be open).
 */
async function runInventoryAdjustmentApprovalPosting(conn, {
  adjustmentId,
  userId,
  comment,
  offsetAccountId // Optional override from finalize dialog
}) {
  const [adjRows] = await conn.query(
    `SELECT id, adjustment_no, mode, adjustment_date, warehouse_id, account_id, status_id
     FROM inventory_adjustments WHERE id = ? FOR UPDATE`,
    [adjustmentId]
  );
  const adj = adjRows[0];
  if (!adj) throw new Error('Adjustment not found');
  if (Number(adj.status_id) !== IA_STATUS_SUBMITTED) {
    throw new Error('Only an adjustment submitted for approval can be approved');
  }

  const lines = await fetchLinesForAdjustment(adjustmentId, conn);
  const whNum = adj.warehouse_id != null ? Number(adj.warehouse_id) : null;
  if (!whNum) throw new Error('Warehouse is required to post');

  // Logic: 
  // 1. One side is the account chosen during creation (adj.account_id)
  // 2. The other side is either passed in offsetAccountId OR fallback to Inventory Asset (ID 5 per screenshot)
  let invAssetId = offsetAccountId != null ? Number(offsetAccountId) : 5;
  const adjAccountId = adj.account_id != null ? Number(adj.account_id) : null;

  // Verify accounts exist
  if (Math.abs(netValueCalculated(adj.mode, lines)) > 0.0001) {
    if (!adjAccountId) throw new Error('Adjustment account is missing on the header');

    // Check if ID 5 exists, if not try to find by name "Inventory Asset"
    const [[chk]] = await conn.query(`SELECT id FROM acc_chart_accounts WHERE id = ? LIMIT 1`, [invAssetId]);
    if (!chk) {
      const [[fnd]] = await conn.query(`SELECT id FROM acc_chart_accounts WHERE name LIKE '%Inventory Asset%' LIMIT 1`);
      if (fnd) invAssetId = fnd.id;
      else if (invAssetId === 5) throw new Error('Inventory Asset account (ID 5) not found in COA');
    }
  }

  const modeQty = String(adj.mode) !== 'value';
  const txnDate = adj.adjustment_date
    ? new Date(adj.adjustment_date).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  // Currency: use company base currency; fallback to AED; final fallback to NULL.
  let baseCurrencyId = null;
  try {
    const [[cs]] = await conn.query(
      `SELECT base_currency FROM company_settings ORDER BY id DESC LIMIT 1`
    );
    if (cs?.base_currency != null && cs.base_currency !== '') {
      const n = Number(cs.base_currency);
      baseCurrencyId = Number.isFinite(n) ? n : null;
    }
  } catch (_) {
    // ignore
  }
  if (!baseCurrencyId) {
    try {
      const [rows] = await conn.query(`SELECT id FROM currency WHERE name = 'AED' LIMIT 1`);
      baseCurrencyId = rows.length ? Number(rows[0].id) : null;
    } catch (_) {
      // ignore
    }
  }
  const exchangeRate = 1.0;

  const netValue = netValueCalculated(adj.mode, lines);

  await conn.query(
    `UPDATE gl_journals SET is_deleted = 1
     WHERE source_type = 'INVENTORY_ADJUSTMENT' AND source_id = ?
      AND (is_deleted = 0 OR is_deleted IS NULL)`,
    [adjustmentId]
  );

  let txCount = 0;
  if (modeQty) {
    for (const ln of lines) {
      const pid = ln.product_id != null ? Number(ln.product_id) : null;
      if (!pid) continue;
      const qAdj = Number(ln.qty_adjusted);
      if (!Number.isFinite(qAdj) || Math.abs(qAdj) < 1e-9) continue;

      const qAv = Number(ln.qty_available) || 0;
      const vAv = Number(ln.value_available) || 0;
      const unitCost = qAv > 0 ? vAv / qAv : 0;

      const bid = ln.batch_id != null ? Number(ln.batch_id) : null;

      // Batch rules:
      // - OUT: allow explicit batch OR All-batches (FIFO allocation)
      // - IN: MUST choose explicit batch (no All-batches)
      if ((bid == null || !Number.isFinite(bid)) && qAdj > 0) {
        throw new Error('For stock increases (IN), please select a specific batch (All batches is not allowed).');
      }

      if (bid != null && Number.isFinite(bid)) {
        // Explicit batch path (IN or OUT)
        if (qAdj < 0) {
          const [stockRows] = await conn.query(
            `SELECT qty_on_hand
             FROM inventory_stock_batches
             WHERE product_id = ? AND warehouse_id = ? AND batch_id = ?
             LIMIT 1`,
            [pid, whNum, bid]
          );
          if (!stockRows.length) {
            throw new Error(
              `Stock record not found for batch ${bid} in warehouse ${whNum}. Please select a batch that has stock, or choose All batches.`
            );
          }
          const qoh = Number(stockRows[0]?.qty_on_hand || 0);
          if (qoh + 1e-9 < Math.abs(qAdj)) {
            throw new Error(`Insufficient stock in batch ${bid}. Available: ${qoh}, Required: ${Math.abs(qAdj)}`);
          }
        }

        await inventoryService.updateInventoryStock(
          conn,
          pid,
          whNum,
          bid,
          Math.abs(qAdj),
          unitCost,
          qAdj > 0,
          null,
          null
        );

        // Persist allocation record (explicit batch)
        try {
          await insertIaAllocation(conn, {
            adjustmentId,
            lineId: ln.line_id,
            productId: pid,
            warehouseId: whNum,
            batchId: bid,
            qtyAllocated: Math.abs(qAdj),
            unitCost,
            allocationMethod: 'EXPLICIT',
            createdBy: userId
          });
        } catch (e) {
          // Allocation persistence should never block posting.
          console.warn('[IA-Approval] allocation insert failed (explicit)', e?.message || e);
        }

        const isDiscardReason = adj.reason_id != null && [1, 2, 3].includes(Number(adj.reason_id));
        const movement = qAdj >= 0 ? 'IN' : (isDiscardReason ? 'DISCARD' : 'OUT');
        const movementTypeId = qAdj >= 0 ? 1 : (isDiscardReason ? 5 : 2);

        await inventoryService.insertInventoryTransaction(conn, {
          txn_date: txnDate,
          movement,
          txn_type: 'ADJUSTMENT',
          source_type: 'INVENTORY_ADJUSTMENT',
          source_id: adjustmentId,
          source_line_id: ln.line_id,
          product_id: pid,
          warehouse_id: whNum,
          batch_id: bid,
          qty: Math.abs(qAdj),
          unit_cost: unitCost,
          currency_id: baseCurrencyId,
          exchange_rate: exchangeRate,
          total_amount: Math.abs(qAdj * unitCost),
          movement_type_id: movementTypeId,
          created_by: userId
        });
        txCount += 1;
      } else {
        // All batches OUT via FIFO allocation
        const reqQty = Math.abs(qAdj);
        const allocations = await inventoryService.allocateFIFO(conn, pid, whNum, reqQty);
        const allocatedTotal = (allocations || []).reduce((s, a) => s + (Number(a.quantity) || 0), 0);
        if (allocatedTotal + 1e-9 < reqQty) {
          throw new Error(`Insufficient available stock. Requested: ${reqQty}, Allocated: ${allocatedTotal}`);
        }

        for (const a of allocations) {
          await inventoryService.updateInventoryStock(
            conn,
            pid,
            whNum,
            a.batch_id,
            a.quantity,
            a.unit_cost,
            false,
            null,
            null
          );

          try {
            await insertIaAllocation(conn, {
              adjustmentId,
              lineId: ln.line_id,
              productId: pid,
              warehouseId: whNum,
              batchId: a.batch_id,
              qtyAllocated: a.quantity,
              unitCost: a.unit_cost,
              allocationMethod: 'FIFO',
              createdBy: userId
            });
          } catch (e) {
            console.warn('[IA-Approval] allocation insert failed (fifo)', e?.message || e);
          }

          const isDiscardReason = adj.reason_id != null && [1, 2, 3].includes(Number(adj.reason_id));
          const movement = 'OUT'; // FIFO in IA is currently always OUT (stock decrease)
          // Wait, IA FIFO is only triggered for qAdj < 0.
          const finalMovement = isDiscardReason ? 'DISCARD' : 'OUT';
          const movementTypeId = isDiscardReason ? 5 : 2;

          await inventoryService.insertInventoryTransaction(conn, {
            txn_date: txnDate,
            movement: finalMovement,
            txn_type: 'ADJUSTMENT',
            source_type: 'INVENTORY_ADJUSTMENT',
            source_id: adjustmentId,
            source_line_id: ln.line_id,
            product_id: pid,
            warehouse_id: whNum,
            batch_id: a.batch_id,
            qty: Number(a.quantity) || 0,
            unit_cost: Number(a.unit_cost) || 0,
            currency_id: baseCurrencyId,
            exchange_rate: exchangeRate,
            total_amount: (Number(a.quantity) || 0) * (Number(a.unit_cost) || 0),
            movement_type_id: movementTypeId,
            created_by: userId
          });
          txCount += 1;
        }
      }
      
      console.log(`[IA-Approval] Stock & Txn updated for Product #${ln.product_id}, Qty=${qAdj}`);
    }
  }

  let journalId = null;
  console.log(`[IA-Approval] #${adjustmentId} NetValue: ${netValue}, AccountID: ${adjAccountId}`);
  
  if (Math.abs(netValue) > 0.0001 && adjAccountId) {
    const invId = invAssetId;
    const adjId = adjAccountId;
    
    const linesGl = [];
    for (const ln of lines) {
      let lineNet = 0;
      const vAdj = Number(ln.value_adjusted);
      if (Number.isFinite(vAdj) && Math.abs(vAdj) > 1e-9) {
        lineNet = vAdj;
      } else {
        const qAdj = Number(ln.qty_adjusted);
        if (Number.isFinite(qAdj) && Math.abs(qAdj) > 1e-9) {
          const qAv = Number(ln.qty_available) || 0;
          const vAv = Number(ln.value_available) || 0;
          const unitCost = qAv > 0 ? vAv / qAv : 0;
          lineNet = qAdj * unitCost;
        }
      }

      if (Math.abs(lineNet) > 0.0001) {
        const absAmt = Math.abs(lineNet);
        const pId = ln.product_id != null ? Number(ln.product_id) : null;
        
        // GAIN (+): Debit Inventory Asset, Credit Adjustment Account
        // LOSS (-): Debit Adjustment Account, Credit Inventory Asset
        if (lineNet > 0) {
          linesGl.push({
            account_id: invId, debit: absAmt, credit: 0, product_id: pId, invoice_id: adjustmentId,
            description: `Inv Adj Gain: ${adj.adjustment_no} - ${ln.product_name || 'Item'}`
          });
          linesGl.push({
            account_id: adjId, debit: 0, credit: absAmt, product_id: pId, invoice_id: adjustmentId,
            description: `Adj Source: ${adj.adjustment_no}`
          });
        } else {
          linesGl.push({
            account_id: adjId, debit: absAmt, credit: 0, product_id: pId, invoice_id: adjustmentId,
            description: `Inv Adj Loss: ${adj.adjustment_no} - ${ln.product_name || 'Item'}`
          });
          linesGl.push({
            account_id: invId, debit: 0, credit: absAmt, product_id: pId, invoice_id: adjustmentId,
            description: `Adj Source: ${adj.adjustment_no}`
          });
        }
      }
    }

    if (linesGl.length > 0) {
      console.log(`[IA-Approval] Posting GL lines: ${linesGl.length}`);
      try {
        journalId = await glService.createJournal(conn, {
          source_type: 'INVENTORY_ADJUSTMENT',
          source_id: adjustmentId,
          source_name: adj.adjustment_no,
          source_date: adj.adjustment_date ? new Date(adj.adjustment_date).toISOString().slice(0, 10) : txnDate,
          journal_date: txnDate,
          memo: `Inventory adjustment ${adj.adjustment_no}${comment ? ` — ${comment}` : ''}`,
          created_by: userId,
          currency_id: baseCurrencyId,
          exchange_rate: exchangeRate,
          lines: linesGl
        });
        console.log(`[IA-Approval] Journal Created: ID=${journalId}`);
      } catch (glErr) {
        console.error(`[IA-Approval] GL Posting failed:`, glErr.message);
        throw new Error(`GL Posting failed: ${glErr.message}`);
      }
    }
  } else {
    console.log(`[IA-Approval] Skipping GL Posting (Value too small or Account missing)`);
  }

  // Update adjustment header
  console.log(`[IA-Approval] Finalizing header: ID=${adjustmentId}, User=${userId}, Journal=${journalId}`);
  const [updRes] = await conn.query(
    `UPDATE inventory_adjustments SET
          status_id = ?,
          approval_comment = ?,
          approved_by = ?,
          approved_at = CURRENT_TIMESTAMP,
          gl_journal_id = COALESCE(?, gl_journal_id),
          updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status_id = ?`,
    [
      IA_STATUS_APPROVED,
      String(comment || '').slice(0, 500),
      userId,
      journalId,
      adjustmentId,
      IA_STATUS_SUBMITTED
    ]
  );
  if (!updRes.affectedRows) {
    throw new Error('Could not update adjustment status to Approved (already changed?)');
  }

  try {
    await conn.query(
      `INSERT INTO history (module, module_id, user_id, action, details)
       VALUES (?, ?, ?, ?, ?)`,
      [
        'inventory_adjustment',
        adjustmentId,
        userId,
        'APPROVED',
        JSON.stringify({
          comment: String(comment || '').slice(0, 500),
          adjustment_no: adj.adjustment_no,
          journal_id: journalId
        })
      ]
    );
  } catch (e) {
    console.warn('[inventory-adjustment] history insert failed', e?.message || e);
  }

  return { journalId, txCount, netValue };
}

/** Replace all lines for an adjustment (caller should run inside a transaction). */
async function replaceAdjustmentLines(conn, adjustmentId, lines) {
  await conn.query(`DELETE FROM inventory_adjustment_lines WHERE inventory_adjustment_id = ?`, [adjustmentId]);
  const arr = Array.isArray(lines) ? lines : [];
  if (!arr.length) return;
  const values = [];
  let lineNo = 0;
  for (const ln of arr) {
    lineNo += 1;
    values.push([
      adjustmentId,
      lineNo,
      ln.product_id != null ? Number(ln.product_id) : null,
      ln.product_name != null ? String(ln.product_name).slice(0, 512) : null,
      ln.batch_id != null ? Number(ln.batch_id) : null,
      ln.batch_no != null ? String(ln.batch_no).slice(0, 128) : null,
      ln.qty_available != null && ln.qty_available !== '' ? Number(ln.qty_available) : null,
      ln.qty_adjusted != null && ln.qty_adjusted !== '' ? Number(ln.qty_adjusted) : null,
      ln.new_qty_on_hand != null && ln.new_qty_on_hand !== '' ? Number(ln.new_qty_on_hand) : null,
      ln.value_available != null && ln.value_available !== '' ? Number(ln.value_available) : null,
      ln.value_adjusted != null && ln.value_adjusted !== '' ? Number(ln.value_adjusted) : null,
      ln.new_value_on_hand != null && ln.new_value_on_hand !== '' ? Number(ln.new_value_on_hand) : null
    ]);
  }
  await conn.query(
    `INSERT INTO inventory_adjustment_lines (
      inventory_adjustment_id, line_no, product_id, product_name, batch_id, batch_no,
      qty_available, qty_adjusted, new_qty_on_hand, value_available, value_adjusted, new_value_on_hand
    ) VALUES ?`,
    [values]
  );
}

function errPayload(message, type = 'APP_ERROR') {
  return { error: { message, type } };
}

/** In-memory defaults when `inventory_adjustment_reasons` table is missing or query fails */
const DEFAULT_ADJUSTMENT_REASONS = [
  { id: 1, name: 'Damaged goods', sort_order: 10 },
  { id: 2, name: 'Expired stock', sort_order: 20 },
  { id: 3, name: 'Lost / missing', sort_order: 30 },
  { id: 4, name: 'Found stock', sort_order: 40 },
  { id: 5, name: 'Stock count correction', sort_order: 50 },
  { id: 6, name: 'Revaluation', sort_order: 60 },
  { id: 7, name: 'Other', sort_order: 70 }
];

async function generateAdjustmentNo(conn) {
  const year = new Date().getFullYear();
  const prefix = `IA-${year}-`;
  const [[row]] = await conn.query(
    `SELECT adjustment_no FROM inventory_adjustments WHERE adjustment_no LIKE ? ORDER BY id DESC LIMIT 1`,
    [`${prefix}%`]
  );
  let next = 1;
  if (row?.adjustment_no) {
    const m = String(row.adjustment_no).match(/IA-\d+-(\d+)/i);
    if (m) next = Number(m[1]) + 1;
  }
  return `${prefix}${String(next).padStart(5, '0')}`;
}

/** GET /api/inventory-adjustments */
router.get('/', requireAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || req.query.per_page || '25', 10), 1), 200);
    const offset = (page - 1) * pageSize;
    const search = String(req.query.search || '').trim();
    const statusIdFilter = req.query.status_id;
    const params = [];
    let where = 'WHERE 1=1';
    if (search) {
      where += ` AND (
        ia.adjustment_no LIKE ? OR
        COALESCE(ia.reference_no,'') LIKE ? OR
        COALESCE(ia.description,'') LIKE ? OR
        COALESCE(w.warehouse_name,'') LIKE ?
      )`;
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }
    if (statusIdFilter !== undefined && statusIdFilter !== '' && statusIdFilter !== 'all') {
      const sid = Number(statusIdFilter);
      if (Number.isFinite(sid)) {
        where += ` AND ia.status_id = ?`;
        params.push(sid);
      }
    }
    const countSql = `
      SELECT COUNT(*) AS c FROM inventory_adjustments ia
      LEFT JOIN warehouses w ON w.id = ia.warehouse_id
      ${where}
    `;
    const [[countRow]] = await db.promise().query(countSql, params);
    const total = Number(countRow?.c || 0);

    const listSql = `
      SELECT
        ia.id,
        ia.adjustment_uniqid,
        ia.adjustment_no,
        ia.mode,
        ia.reference_no,
        ia.adjustment_date,
        ia.account_id,
        ia.reason_id,
        ia.warehouse_id,
        ia.description,
        ia.status_id,
        (${STATUS_CASE_SQL.trim()}) AS status,
        st.name AS status_name,
        st.bg_colour AS status_bg_colour,
        st.colour AS status_text_colour,
        ia.created_at,
        ia.updated_at,
        w.warehouse_name,
        a.name AS account_name
      FROM inventory_adjustments ia
      LEFT JOIN warehouses w ON w.id = ia.warehouse_id
      LEFT JOIN acc_chart_accounts a ON a.id = ia.account_id
      LEFT JOIN status st ON st.id = ia.status_id
      ${where}
      ORDER BY ia.id DESC
      LIMIT ? OFFSET ?
    `;
    const [rows] = await db.promise().query(listSql, [...params, pageSize, offset]);

    res.json({
      data: rows,
      pagination: { total, page, pageSize }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json(errPayload(err.message || 'Failed to list adjustments'));
  }
});

/** GET /api/inventory-adjustments/reasons — active reasons for dropdown (must be before /:id) */
router.get('/reasons', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      `SELECT id, name, sort_order
       FROM inventory_adjustment_reasons
       WHERE is_active = 1
       ORDER BY sort_order ASC, id ASC`
    );
    res.json({ data: rows });
  } catch (err) {
    console.warn('[inventory-adjustments/reasons]', err?.code || err?.message, '— using default reasons');
    res.json({ data: DEFAULT_ADJUSTMENT_REASONS, _fallback: true });
  }
});

/** Avoid confusing Express "Cannot GET" when someone opens /draft or /post in the browser */
router.get('/draft', requireAuth, (req, res) => {
  res.status(405).set('Allow', 'POST').json(errPayload('Use POST to save a draft.', 'METHOD_NOT_ALLOWED'));
});
router.get('/post', requireAuth, (req, res) => {
  res.status(405).set('Allow', 'POST').json(errPayload('Use POST to post an adjustment.', 'METHOD_NOT_ALLOWED'));
});

/**
 * POST /api/inventory-adjustments/:id/finalize — submitted (8) → approved (1), stock + GL + history
 * Body: { comment: string (required), offset_account_id?: number } — offset GL account required when net value ≠ 0
 */
router.post('/:id/finalize', requireAuth, async (req, res) => {
  const { id: idString } = req.params;
  if (!idString || !/^\d+$/.test(idString)) {
    return res.status(400).json(errPayload(`Invalid numeric id: ${idString}`));
  }
  const id = Number(idString);
  const comment = String(req.body?.comment ?? '').trim();
  const offsetRaw = req.body?.offset_account_id;
  const offsetAccountId =
    offsetRaw !== undefined && offsetRaw !== null && offsetRaw !== '' ? Number(offsetRaw) : null;

  if (!comment) {
    return res.status(400).json(errPayload('Approval comment is required'));
  }

  const userId = req.session?.user?.id ?? req.user?.id ?? null;
  if (!userId) {
    return res.status(401).json(errPayload('Not authenticated'));
  }

  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();
    const result = await runInventoryAdjustmentApprovalPosting(conn, {
      adjustmentId: id,
      userId,
      comment,
      offsetAccountId: Number.isFinite(offsetAccountId) ? offsetAccountId : null
    });
    await conn.commit();
    const [approvedRows] = await db
      .promise()
      .query(
        `SELECT adjustment_no, status_id, approval_comment, approved_by, approved_at, gl_journal_id
         FROM inventory_adjustments WHERE id = ? LIMIT 1`,
        [id]
      );
    res.json({
      success: true,
      id,
      adjustment_no: approvedRows[0]?.adjustment_no,
      status: 'approved',
      posting: {
        journal_id: result?.journalId ?? null,
        tx_count: result?.txCount ?? 0,
        net_value: result?.netValue ?? 0
      },
      header: approvedRows[0] || null,
      message: 'Adjustment approved and posted.'
    });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json(errPayload(err.message || 'Failed to approve'));
  } finally {
    conn.release();
  }
});

/**
 * POST /api/inventory-adjustments/:id/reject — submitted (8) → rejected (4)
 * Body: { reason: string (required) }
 */
router.post('/:id/reject', requireAuth, async (req, res) => {
  const { id: idString } = req.params;
  if (!idString || !/^\d+$/.test(idString)) {
    return res.status(400).json(errPayload(`Invalid numeric id: ${idString}`));
  }
  const id = Number(idString);
  const reason = String(req.body?.reason ?? '').trim();
  if (!reason) {
    return res.status(400).json(errPayload('Rejection reason is required'));
  }
  const userId = req.session?.user?.id ?? req.user?.id ?? null;
  if (!userId) {
    return res.status(401).json(errPayload('Not authenticated'));
  }

  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();
    const [adjRows] = await conn.query(
      `SELECT id, status_id, adjustment_no FROM inventory_adjustments WHERE id = ? FOR UPDATE`,
      [id]
    );
    if (!adjRows.length) {
      await conn.rollback();
      return res.status(404).json(errPayload('Not found'));
    }
    if (Number(adjRows[0].status_id) !== IA_STATUS_SUBMITTED) {
      await conn.rollback();
      return res.status(400).json(errPayload('Only an adjustment submitted for approval can be rejected'));
    }
    const [updRes] = await conn.query(
      `UPDATE inventory_adjustments SET
          status_id = ?,
          rejection_reason = ?,
          rejected_by = ?,
          rejected_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status_id = ?`,
      [IA_STATUS_REJECTED, reason.slice(0, 500), userId, id, IA_STATUS_SUBMITTED]
    );
    if (!updRes.affectedRows) {
      await conn.rollback();
      return res.status(400).json(errPayload('Could not reject (status may have changed)'));
    }
    try {
      await conn.query(
        `INSERT INTO history (module, module_id, user_id, action, details)
         VALUES (?, ?, ?, ?, ?)`,
        [
          'inventory_adjustment',
          id,
          userId,
          'REJECTED',
          JSON.stringify({ reason: reason.slice(0, 500), adjustment_no: adjRows[0].adjustment_no })
        ]
      );
    } catch (e) {
      console.warn('[inventory-adjustment] history insert (reject)', e?.message || e);
    }
    await conn.commit();
    res.json({
      success: true,
      id,
      adjustment_no: adjRows[0].adjustment_no,
      status: 'rejected',
      message: 'Adjustment rejected.'
    });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json(errPayload(err.message || 'Failed to reject'));
  } finally {
    conn.release();
  }
});

/**
 * POST /api/inventory-adjustments/:id/attachments — multipart field `attachments`
 */
router.post(
  ('/:id/attachments'),
  requireAuth,
  inventoryAdjustmentUpload.array('attachments', 20),
  async (req, res) => {
    const { id: idString } = req.params;
    if (!idString || !/^\d+$/.test(idString)) {
      return res.status(400).json(errPayload(`Invalid numeric id: ${idString}`));
    }
    const id = Number(idString);
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json(errPayload('No files uploaded'));
    }
    const userId = req.session?.user?.id ?? null;
    const conn = await db.promise().getConnection();
    try {
      const [exists] = await conn.query(`SELECT id, status_id FROM inventory_adjustments WHERE id = ? LIMIT 1`, [id]);
      if (!exists.length) {
        return res.status(404).json(errPayload('Not found'));
      }
      if (Number(exists[0].status_id) !== IA_STATUS_DRAFT) {
        return res.status(400).json(errPayload('Attachments can only be added while the adjustment is a draft'));
      }
      const values = files.map((f) => [
        id,
        String(f.originalname || ''),
        f.filename,
        f.mimetype || null,
        f.size != null ? Number(f.size) : null,
        buildIaStoredPath(f.filename),
        userId
      ]);
      await conn.query(
        `INSERT INTO inventory_adjustment_attachments
          (inventory_adjustment_id, file_original_name, file_name, file_type, file_size, file_path, uploaded_by)
         VALUES ?`,
        [values]
      );
      res.json({ success: true, message: 'Attachments uploaded' });
    } catch (err) {
      console.error(err);
      if (String(err?.code) === 'ER_NO_SUCH_TABLE') {
        return res.status(503).json(
          errPayload('Attachments storage is not configured on this server.', 'CONFIG_REQUIRED')
        );
      }
      res.status(500).json(errPayload(err.message || 'Failed to upload'));
    } finally {
      conn.release();
    }
  }
);

/**
 * DELETE /api/inventory-adjustments/:id/attachments/:attachmentId
 */
router.delete('/:id/attachments/:attachmentId', requireAuth, async (req, res) => {
  const { id: idString, attachmentId: attachmentIdString } = req.params;

  if (!idString || !/^\d+$/.test(idString)) {
    return res.status(400).json(errPayload(`Invalid numeric id: ${idString}`));
  }
  if (!attachmentIdString || !/^\d+$/.test(attachmentIdString)) {
    return res.status(400).json(errPayload(`Invalid numeric attachmentId: ${attachmentIdString}`));
  }

  const id = Number(idString);
  const attachmentId = Number(attachmentIdString);
  const conn = await db.promise().getConnection();
  try {
    const [hdr] = await conn.query(`SELECT id, status_id FROM inventory_adjustments WHERE id = ? LIMIT 1`, [id]);
    if (!hdr.length) {
      return res.status(404).json(errPayload('Not found'));
    }
    if (Number(hdr[0].status_id) !== IA_STATUS_DRAFT) {
      return res.status(400).json(errPayload('Attachments can only be removed while the adjustment is a draft'));
    }
    const [rows] = await conn.query(
      `SELECT * FROM inventory_adjustment_attachments WHERE id = ? AND inventory_adjustment_id = ? LIMIT 1`,
      [attachmentId, id]
    );
    if (!rows.length) {
      return res.status(404).json(errPayload('Attachment not found'));
    }
    const att = rows[0];
    await conn.query(`DELETE FROM inventory_adjustment_attachments WHERE id = ?`, [attachmentId]);
    const abs = path.isAbsolute(att.file_path)
      ? att.file_path
      : path.join(SERVER_ROOT, String(att.file_path).replace(/^\//, ''));
    if (att.file_path && fs.existsSync(abs)) {
      try {
        fs.unlinkSync(abs);
      } catch (e) {
        console.warn('[inventory-adjustment] unlink attachment file', e?.message || e);
      }
    }
    res.json({ success: true, message: 'Attachment removed' });
  } catch (err) {
    console.error(err);
    if (String(err?.code) === 'ER_NO_SUCH_TABLE') {
      return res.status(503).json(
        errPayload('Attachments storage is not configured on this server.', 'CONFIG_REQUIRED')
      );
    }
    res.status(500).json(errPayload(err.message || 'Failed to delete'));
  } finally {
    conn.release();
  }
});

/**
 * GET /api/inventory-adjustments/:id (numeric id only)
 */
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const idString = req.params.id;
    if (!/^\d+$/.test(idString)) {
      // If it's not a digit, it might be another named route we didn't catch earlier,
      // or just invalid. Since we check /draft and /post before this, it's likely invalid.
      return res.status(400).json(errPayload(`Invalid numeric id: ${idString}`));
    }
    const id = Number(idString);

    const [rows] = await db.promise().query(
      `
      SELECT
        ia.id,
        ia.adjustment_uniqid,
        ia.adjustment_no,
        ia.mode,
        ia.reference_no,
        ia.adjustment_date,
        ia.account_id,
        ia.reason_id,
        ia.warehouse_id,
        ia.description,
        ia.status_id,
        ia.approval_comment,
        ia.approved_by,
        ia.approved_at,
        ia.rejection_reason,
        ia.rejected_by,
        ia.rejected_at,
        ia.gl_journal_id,
        ia.created_at,
        ia.updated_at,
        ia.created_by,
        w.warehouse_name,
        a.name AS account_name,
        (${STATUS_CASE_SQL.trim()}) AS status,
        st.name AS status_name,
        st.bg_colour AS status_bg_colour,
        st.colour AS status_text_colour,
        r.name AS reason
      FROM inventory_adjustments ia
      LEFT JOIN warehouses w ON w.id = ia.warehouse_id
      LEFT JOIN acc_chart_accounts a ON a.id = ia.account_id
      LEFT JOIN status st ON st.id = ia.status_id
      LEFT JOIN inventory_adjustment_reasons r ON r.id = ia.reason_id
      WHERE ia.id = ?
      `,
      [id]
    );
    if (!rows.length) return res.status(404).json(errPayload('Not found'));
    const row = rows[0];
    let lines = [];
    try {
      lines = await fetchLinesForAdjustment(id);
    } catch (e) {
      if (String(e?.code) === 'ER_NO_SUCH_TABLE') {
        return res.status(503).json(
          errPayload('Adjustment lines storage is not configured on this server.', 'CONFIG_REQUIRED')
        );
      }
      throw e;
    }
    const attachments = await loadAttachmentsForAdjustment(id);
    const attachment_count = attachments.length;
    res.json({ ...row, lines, attachment_count, attachments });
  } catch (err) {
    console.error(err);
    res.status(500).json(errPayload(err.message || 'Failed to load'));
  }
});

function buildPayload(body) {
  const rid = body.reason_id != null && body.reason_id !== '' ? Number(body.reason_id) : null;
  return {
    mode: body.mode === 'value' ? 'value' : 'quantity',
    reference_no: body.reference_no || null,
    adjustment_date: body.adjustment_date || new Date().toISOString().slice(0, 10),
    account_id: body.account_id != null ? Number(body.account_id) : null,
    reason_id: Number.isFinite(rid) ? rid : null,
    warehouse_id: body.warehouse_id != null ? Number(body.warehouse_id) : null,
    description: body.description ? String(body.description).slice(0, 500) : null,
    lines: Array.isArray(body.lines) ? body.lines : []
  };
}

/** POST /api/inventory-adjustments/draft — create, or update existing draft when body.id is set */
router.post('/draft', requireAuth, async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    const userId = req.session?.user?.id ?? null;
    const body = req.body || {};
    const p = buildPayload(body);
    const editId = body.id != null ? Number(body.id) : 0;

    if (editId > 0) {
      const [existing] = await conn.query(
        `SELECT id, status_id, adjustment_no FROM inventory_adjustments WHERE id = ? LIMIT 1`,
        [editId]
      );
      if (!existing.length) {
        return res.status(404).json(errPayload('Adjustment not found'));
      }
      const cur = Number(existing[0].status_id);
      if (cur !== IA_STATUS_DRAFT && cur !== IA_STATUS_REJECTED) {
        return res.status(400).json(errPayload('Only drafts or rejected adjustments can be edited'));
      }
      await conn.beginTransaction();
      try {
        await conn.query(
          `
          UPDATE inventory_adjustments SET
            mode = ?, reference_no = ?, adjustment_date = ?, account_id = ?, reason_id = ?, warehouse_id = ?,
            description = ?, status_id = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status_id IN (?, ?)
          `,
          [
            p.mode,
            p.reference_no,
            p.adjustment_date,
            p.account_id,
            p.reason_id,
            p.warehouse_id,
            p.description,
            IA_STATUS_DRAFT,
            editId,
            IA_STATUS_DRAFT,
            IA_STATUS_REJECTED
          ]
        );
        await replaceAdjustmentLines(conn, editId, p.lines);
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      }
      return res.json({
        success: true,
        id: editId,
        adjustment_no: existing[0].adjustment_no,
        status: 'draft'
      });
    }

    const uniqid = crypto.randomUUID();
    const adjustmentNo = await generateAdjustmentNo(conn);

    await conn.beginTransaction();
    let newId;
    try {
      const [insertResult] = await conn.query(
        `
        INSERT INTO inventory_adjustments (
          adjustment_uniqid, adjustment_no, mode, reference_no, adjustment_date,
          account_id, reason_id, warehouse_id, description, status_id, created_by
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `,
        [
          uniqid,
          adjustmentNo,
          p.mode,
          p.reference_no,
          p.adjustment_date,
          p.account_id,
          p.reason_id,
          p.warehouse_id,
          p.description,
          IA_STATUS_DRAFT,
          userId
        ]
      );
      newId = Number(insertResult.insertId);
      await replaceAdjustmentLines(conn, newId, p.lines);
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    }
    res.json({ success: true, id: newId, adjustment_no: adjustmentNo, status: 'draft' });
  } catch (err) {
    console.error(err);
    if (String(err?.code) === 'ER_NO_SUCH_TABLE') {
      return res.status(503).json(
        errPayload('Inventory adjustments are not configured on this server.', 'CONFIG_REQUIRED')
      );
    }
    res.status(500).json(errPayload(err.message || 'Failed to save draft'));
  } finally {
    conn.release();
  }
});

/** POST /api/inventory-adjustments/post — finalize; if body.id is a draft, updates that row to adjusted */
router.post('/post', requireAuth, async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    const userId = req.session?.user?.id ?? null;
    const body = req.body || {};
    const p = buildPayload(body);
    const postId = body.id != null ? Number(body.id) : 0;

    if (postId > 0) {
      const [existing] = await conn.query(
        `SELECT id, status_id, adjustment_no FROM inventory_adjustments WHERE id = ? LIMIT 1`,
        [postId]
      );
      if (!existing.length) {
        return res.status(404).json(errPayload('Adjustment not found'));
      }
      if (Number(existing[0].status_id) !== IA_STATUS_DRAFT) {
        return res.status(400).json(errPayload('Only a draft can be posted'));
      }
      await conn.beginTransaction();
      try {
        await conn.query(
          `
          UPDATE inventory_adjustments SET
            mode = ?, reference_no = ?, adjustment_date = ?, account_id = ?, reason_id = ?, warehouse_id = ?,
            description = ?, status_id = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status_id = ?
          `,
          [
            p.mode,
            p.reference_no,
            p.adjustment_date,
            p.account_id,
            p.reason_id,
            p.warehouse_id,
            p.description,
            IA_STATUS_SUBMITTED,
            postId,
            IA_STATUS_DRAFT
          ]
        );
        await replaceAdjustmentLines(conn, postId, p.lines);
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      }
      return res.json({
        success: true,
        id: postId,
        adjustment_no: existing[0].adjustment_no,
        status: 'submitted',
        message: 'Submitted for approval. Approve from the detail page when ready.'
      });
    }

    const uniqid = crypto.randomUUID();
    const adjustmentNo = await generateAdjustmentNo(conn);

    await conn.beginTransaction();
    let newId;
    try {
      const [insertResult] = await conn.query(
        `
        INSERT INTO inventory_adjustments (
          adjustment_uniqid, adjustment_no, mode, reference_no, adjustment_date,
          account_id, reason_id, warehouse_id, description, status_id, created_by
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `,
        [
          uniqid,
          adjustmentNo,
          p.mode,
          p.reference_no,
          p.adjustment_date,
          p.account_id,
          p.reason_id,
          p.warehouse_id,
          p.description,
          IA_STATUS_SUBMITTED,
          userId
        ]
      );
      newId = Number(insertResult.insertId);
      await replaceAdjustmentLines(conn, newId, p.lines);
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    }
    res.json({
      success: true,
      id: newId,
      adjustment_no: adjustmentNo,
      status: 'submitted',
      message: 'Submitted for approval. Approve from the detail page when ready.'
    });
  } catch (err) {
    console.error(err);
    if (String(err?.code) === 'ER_NO_SUCH_TABLE') {
      return res.status(503).json(
        errPayload('Inventory adjustments are not configured on this server.', 'CONFIG_REQUIRED')
      );
    }
    res.status(500).json(errPayload(err.message || 'Failed to post'));
  } finally {
    conn.release();
  }
});

export default router;
