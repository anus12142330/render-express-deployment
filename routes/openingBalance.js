// server/routes/openingBalance.js
// Opening Balance routes

import express from 'express';
import db from '../db.js';
import { requireAuth, requirePerm } from '../middleware/authz.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const openingBalanceService = require('../src/modules/openingBalance/openingBalance.service.cjs');
const { generateOpeningBalanceBatchNumber } = require('../src/utils/docNo.cjs');
const { tx } = require('../src/db/tx.cjs');

const router = express.Router();
const errPayload = (message, type = 'APP_ERROR', hint) => ({ error: { message, type, hint } });

/**
 * Helper: Get exchange rate for currency on a specific date
 * Looks up from tbl_bank_exchange_rate or currency table
 */
async function getExchangeRateForCurrency(conn, currencyCode, date) {
    if (!currencyCode || currencyCode === 'AED') {
        return 1.0;
    }

    // Try to get from currency table first (conversion_rate)
    const [currencyRows] = await conn.query(`
        SELECT id, conversion_rate, name FROM currency WHERE name = ? LIMIT 1
    `, [currencyCode]);

    if (currencyRows.length > 0 && currencyRows[0].conversion_rate) {
        return parseFloat(currencyRows[0].conversion_rate) || 1.0;
    }

    // Try to get from bank exchange rate table (latest rate <= date)
    const [rateRows] = await conn.query(`
        SELECT rate_to_aed 
        FROM tbl_bank_exchange_rate 
        WHERE effective_from <= ?
        AND bank_account_id IN (
            SELECT id FROM acc_bank_details WHERE currency_code = ?
        )
        ORDER BY effective_from DESC 
        LIMIT 1
    `, [date, currencyCode]);

    if (rateRows.length > 0) {
        return parseFloat(rateRows[0].rate_to_aed) || 1.0;
    }

    // Default to null if not found (will show warning in UI)
    return null;
}

// Helper function to add history
const addHistory = async (conn, { module, moduleId, userId, action, details }) => {
    if (!module || !moduleId || !userId || !action) return;
    await conn.query(
        'INSERT INTO history (module, module_id, user_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
        [module, moduleId, userId, action, JSON.stringify(details || {})]
    );
};

// GET /api/opening-balances/batches - List opening balance batches
router.get('/batches', requireAuth, async (req, res) => {
    try {
        const { status, edit_request_status, dateFrom, dateTo, search, page = 1, per_page = 20 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(per_page);

        let whereClause = 'WHERE 1=1';
        const params = [];

        if (search) {
            whereClause += ' AND (ob.batch_no LIKE ? OR ob.notes LIKE ?)';
            const searchPattern = `%${search}%`;
            params.push(searchPattern, searchPattern);
        }
        if (status) {
            whereClause += ' AND ob.status_id = ?';
            params.push(parseInt(status));
        }
        if (edit_request_status !== undefined && edit_request_status !== null && edit_request_status !== '') {
            whereClause += ' AND ob.edit_request_status = ?';
            params.push(parseInt(edit_request_status));
        }
        if (dateFrom) {
            whereClause += ' AND ob.opening_date >= ?';
            params.push(dateFrom);
        }
        if (dateTo) {
            whereClause += ' AND ob.opening_date <= ?';
            params.push(dateTo);
        }

        const [rows] = await db.promise().query(`
            SELECT 
                ob.id,
                ob.company_id,
                ob.batch_no,
                ob.opening_date,
                ob.notes,
                ob.status_id,
                ob.gl_journal_id,
                ob.created_by,
                ob.created_at,
                ob.updated_at,
                ob.approved_by,
                ob.approved_at,
                ob.edit_request_status,
                ob.edit_requested_by,
                ob.edit_requested_at,
                ob.edit_request_reason,
                ob.edit_approved_by,
                ob.edit_approved_at,
                s.name as status_name,
                s.bg_colour as status_bg_colour,
                s.colour as status_colour,
                u1.name as created_by_name,
                u2.name as approved_by_name,
                u3.name as edit_requested_by_name,
                u4.name as edit_approved_by_name,
                COUNT(DISTINCT obl.id) as total_lines,
                COALESCE(SUM(CASE WHEN obl.party_type = 'CUSTOMER' THEN obl.debit_aed - obl.credit_aed ELSE 0 END), 0) as customer_total,
                COALESCE(SUM(CASE WHEN obl.party_type = 'SUPPLIER' THEN obl.debit_aed - obl.credit_aed ELSE 0 END), 0) as supplier_total
            FROM opening_balance_batch ob
            LEFT JOIN status s ON s.id = ob.status_id
            LEFT JOIN \`user\` u1 ON u1.id = ob.created_by
            LEFT JOIN \`user\` u2 ON u2.id = ob.approved_by
            LEFT JOIN \`user\` u3 ON u3.id = ob.edit_requested_by
            LEFT JOIN \`user\` u4 ON u4.id = ob.edit_approved_by
            LEFT JOIN opening_balance_lines obl ON obl.batch_id = ob.id
            ${whereClause}
            GROUP BY ob.id
            ORDER BY ob.opening_date DESC, ob.created_at DESC
            LIMIT ? OFFSET ?
        `, [...params, parseInt(per_page), offset]);

        const [countResult] = await db.promise().query(`
            SELECT COUNT(DISTINCT ob.id) as total 
            FROM opening_balance_batch ob
            ${whereClause}
        `, params);

        const total = countResult[0]?.total || 0;

        res.json({
            data: rows || [],
            total,
            page: parseInt(page),
            per_page: parseInt(per_page)
        });
    } catch (e) {
        console.error('Error fetching opening balance batches:', e);
        res.status(500).json(errPayload('Failed to fetch opening balance batches', 'DB_ERROR', e.message));
    }
});

// GET /api/opening-balances/batches/:id - Get single batch with lines
router.get('/batches/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;

        const [batches] = await db.promise().query(`
            SELECT 
                ob.*,
                s.name as status_name,
                s.bg_colour as status_bg_colour,
                s.colour as status_colour,
                u1.name as created_by_name,
                u2.name as approved_by_name,
                u3.name as edit_requested_by_name,
                u4.name as edit_approved_by_name,
                gj.journal_number as gl_journal_number
            FROM opening_balance_batch ob
            LEFT JOIN status s ON s.id = ob.status_id
            LEFT JOIN \`user\` u1 ON u1.id = ob.created_by
            LEFT JOIN \`user\` u2 ON u2.id = ob.approved_by
            LEFT JOIN \`user\` u3 ON u3.id = ob.edit_requested_by
            LEFT JOIN \`user\` u4 ON u4.id = ob.edit_approved_by
            LEFT JOIN gl_journals gj ON gj.id = ob.gl_journal_id
            WHERE ob.id = ?
        `, [id]);

        if (batches.length === 0) {
            return res.status(404).json(errPayload('Opening balance batch not found', 'NOT_FOUND'));
        }

        const batch = batches[0];

        // Get lines with party names (customers & suppliers are both in vendor table)
        const [lines] = await db.promise().query(`
            SELECT 
                obl.*,
                CASE 
                    WHEN obl.party_type = 'CUSTOMER' THEN vc.display_name
                    WHEN obl.party_type = 'SUPPLIER' THEN vs.display_name
                END AS party_name,
                obl.currency_code AS party_currency_code
            FROM opening_balance_lines obl
            LEFT JOIN vendor vc 
                ON vc.id = obl.party_id 
                AND obl.party_type = 'CUSTOMER'
            LEFT JOIN vendor vs 
                ON vs.id = obl.party_id 
                AND obl.party_type = 'SUPPLIER'
            WHERE obl.batch_id = ?
            ORDER BY obl.party_type, obl.party_id
        `, [id]);

        res.json({
            ...batch,
            lines: lines || []
        });
    } catch (e) {
        console.error('Error fetching opening balance batch:', e);
        res.status(500).json(errPayload('Failed to fetch opening balance batch', 'DB_ERROR', e.message));
    }
});

// POST /api/opening-balances/batches - Create new batch
router.post('/batches', requireAuth, requirePerm('OpeningBalance', 'create'), async (req, res) => {
    const conn = await db.promise().getConnection();
    const userId = req.session?.user?.id;

    try {
        await conn.beginTransaction();

        const { opening_date, notes, lines } = req.body;

        // Validation
        if (!opening_date) {
            await conn.rollback();
            return res.status(400).json(errPayload('Opening date is required', 'VALIDATION_ERROR'));
        }

        if (!lines || !Array.isArray(lines) || lines.length === 0) {
            await conn.rollback();
            return res.status(400).json(errPayload('At least one opening balance line is required', 'VALIDATION_ERROR'));
        }

        // Generate batch number
        const batchNo = await generateOpeningBalanceBatchNumber(conn, new Date(opening_date).getFullYear());

        // Get company_id (default to 1 or first company)
        const [companyRows] = await conn.query(`
            SELECT id FROM company_settings ORDER BY id ASC LIMIT 1
        `);
        const companyId = companyRows.length > 0 ? companyRows[0].id : null;

        // Insert batch
        const [batchResult] = await conn.query(`
            INSERT INTO opening_balance_batch 
            (company_id, batch_no, opening_date, notes, status_id, created_by)
            VALUES (?, ?, ?, ?, 3, ?)
        `, [companyId, batchNo, opening_date, notes || null, userId]);

        const batchId = batchResult.insertId;

        // Load currencies once to resolve currency_id
        const [currencyRows] = await conn.query(`
            SELECT id, name 
            FROM currency
        `);
        const currencyMap = {};
        for (const c of currencyRows) {
            if (c.name) {
                currencyMap[c.name] = c.id;
            }
        }

        // Process and insert lines
        const lineValues = [];
        for (const line of lines) {
            const { party_type, party_id, currency_code, fx_rate_to_aed, debit_foreign, credit_foreign, notes: lineNotes } = line;

            // Validation
            if (!party_type || !party_id) {
                await conn.rollback();
                return res.status(400).json(errPayload('Each line must have party_type and party_id', 'VALIDATION_ERROR'));
            }

            if (party_type !== 'CUSTOMER' && party_type !== 'SUPPLIER') {
                await conn.rollback();
                return res.status(400).json(errPayload('party_type must be CUSTOMER or SUPPLIER', 'VALIDATION_ERROR'));
            }

            const debitForeign = parseFloat(debit_foreign || 0);
            const creditForeign = parseFloat(credit_foreign || 0);

            if (debitForeign < 0 || creditForeign < 0) {
                await conn.rollback();
                return res.status(400).json(errPayload('Debit and credit amounts cannot be negative', 'VALIDATION_ERROR'));
            }

            if (debitForeign === 0 && creditForeign === 0) {
                await conn.rollback();
                return res.status(400).json(errPayload('At least one of debit or credit must be greater than 0', 'VALIDATION_ERROR'));
            }

            const currency = currency_code || 'AED';
            const fxRate = currency === 'AED' ? 1.0 : parseFloat(fx_rate_to_aed || 1.0);

            if (currency !== 'AED' && (!fxRate || fxRate <= 0)) {
                await conn.rollback();
                return res.status(400).json(errPayload(`Exchange rate is required for currency ${currency}`, 'VALIDATION_ERROR'));
            }

            // Calculate AED amounts
            const debitAed = debitForeign * fxRate;
            const creditAed = creditForeign * fxRate;

            const currencyId = currencyMap[currency] || null;

            lineValues.push([
                batchId,
                party_type,
                party_id,
                currencyId,
                currency,
                fxRate,
                debitForeign,
                creditForeign,
                debitAed,
                creditAed,
                lineNotes || null
            ]);
        }

        // Check for duplicate parties in same batch
        const partyKeys = lines.map(l => `${l.party_type}-${l.party_id}`);
        const uniqueParties = new Set(partyKeys);
        if (partyKeys.length !== uniqueParties.size) {
            await conn.rollback();
            return res.status(400).json(errPayload('Duplicate party entries are not allowed in the same batch', 'VALIDATION_ERROR'));
        }

        // Insert lines
        if (lineValues.length > 0) {
            await conn.query(`
                INSERT INTO opening_balance_lines 
                (batch_id, party_type, party_id, currency_id, currency_code, fx_rate_to_aed, 
                 debit_foreign, credit_foreign, debit_aed, credit_aed, notes)
                VALUES ?
            `, [lineValues]);
        }

        // Log history
        await addHistory(conn, {
            module: 'opening_balance',
            moduleId: batchId,
            userId,
            action: 'CREATED',
            details: { batch_no: batchNo, opening_date: opening_date }
        });

        await conn.commit();

        // Fetch created batch with lines
        const [createdBatch] = await db.promise().query(`
            SELECT * FROM opening_balance_batch WHERE id = ?
        `, [batchId]);

        res.status(201).json({
            id: batchId,
            message: 'Opening balance batch created successfully',
            data: createdBatch[0]
        });
    } catch (e) {
        await conn.rollback();
        console.error('Error creating opening balance batch:', e);
        res.status(500).json(errPayload('Failed to create opening balance batch', 'DB_ERROR', e.message));
    } finally {
        conn.release();
    }
});

// PUT /api/opening-balances/batches/:id - Update batch
// - Allowed when current status is Draft (3), Submitted for Approval (8), or Rejected (2)
// - On save, status is always reset to Draft (3)
router.put('/batches/:id', requireAuth, requirePerm('OpeningBalance', 'edit'), async (req, res) => {
    const conn = await db.promise().getConnection();
    const userId = req.session?.user?.id;

    try {
        await conn.beginTransaction();

        const { id } = req.params;
        const { opening_date, notes, lines } = req.body;

        // Check if batch exists and is in an editable status
        const [batches] = await conn.query(`
            SELECT * 
            FROM opening_balance_batch 
            WHERE id = ? 
              AND status_id IN (3, 8, 2)
        `, [id]);

        if (batches.length === 0) {
            await conn.rollback();
            return res.status(404).json(errPayload('Opening balance batch not found or not in Draft status', 'NOT_FOUND'));
        }

        // Validation
        if (!opening_date) {
            await conn.rollback();
            return res.status(400).json(errPayload('Opening date is required', 'VALIDATION_ERROR'));
        }

        if (!lines || !Array.isArray(lines) || lines.length === 0) {
            await conn.rollback();
            return res.status(400).json(errPayload('At least one opening balance line is required', 'VALIDATION_ERROR'));
        }

        // Update batch header
        // Always reset status back to Draft (3) when editing
        await conn.query(`
            UPDATE opening_balance_batch 
            SET opening_date = ?, notes = ?, status_id = 3, updated_at = NOW(), updated_by = ?
            WHERE id = ?
        `, [opening_date, notes || null, userId, id]);

        // Delete existing lines
        await conn.query(`
            DELETE FROM opening_balance_lines WHERE batch_id = ?
        `, [id]);

        // Load currencies once to resolve currency_id
        const [currencyRows] = await conn.query(`
            SELECT id, name 
            FROM currency
        `);
        const currencyMap = {};
        for (const c of currencyRows) {
            if (c.name) {
                currencyMap[c.name] = c.id;
            }
        }

        // Insert new lines (same logic as create)
        const lineValues = [];
        for (const line of lines) {
            const { party_type, party_id, currency_code, fx_rate_to_aed, debit_foreign, credit_foreign, notes: lineNotes } = line;

            if (!party_type || !party_id) {
                await conn.rollback();
                return res.status(400).json(errPayload('Each line must have party_type and party_id', 'VALIDATION_ERROR'));
            }

            const debitForeign = parseFloat(debit_foreign || 0);
            const creditForeign = parseFloat(credit_foreign || 0);

            if (debitForeign < 0 || creditForeign < 0) {
                await conn.rollback();
                return res.status(400).json(errPayload('Debit and credit amounts cannot be negative', 'VALIDATION_ERROR'));
            }

            if (debitForeign === 0 && creditForeign === 0) {
                await conn.rollback();
                return res.status(400).json(errPayload('At least one of debit or credit must be greater than 0', 'VALIDATION_ERROR'));
            }

            const currency = currency_code || 'AED';
            const fxRate = currency === 'AED' ? 1.0 : parseFloat(fx_rate_to_aed || 1.0);

            if (currency !== 'AED' && (!fxRate || fxRate <= 0)) {
                await conn.rollback();
                return res.status(400).json(errPayload(`Exchange rate is required for currency ${currency}`, 'VALIDATION_ERROR'));
            }

            const debitAed = debitForeign * fxRate;
            const creditAed = creditForeign * fxRate;

            const currencyId = currencyMap[currency] || null;

            lineValues.push([
                id,
                party_type,
                party_id,
                currencyId,
                currency,
                fxRate,
                debitForeign,
                creditForeign,
                debitAed,
                creditAed,
                lineNotes || null
            ]);
        }

        // Check for duplicate parties
        const partyKeys = lines.map(l => `${l.party_type}-${l.party_id}`);
        const uniqueParties = new Set(partyKeys);
        if (partyKeys.length !== uniqueParties.size) {
            await conn.rollback();
            return res.status(400).json(errPayload('Duplicate party entries are not allowed in the same batch', 'VALIDATION_ERROR'));
        }

        // Insert new lines
        if (lineValues.length > 0) {
            await conn.query(`
                INSERT INTO opening_balance_lines 
                (batch_id, party_type, party_id, currency_id, currency_code, fx_rate_to_aed, 
                 debit_foreign, credit_foreign, debit_aed, credit_aed, notes)
                VALUES ?
            `, [lineValues]);
        }

        // Log history
        await addHistory(conn, {
            module: 'opening_balance',
            moduleId: parseInt(id),
            userId,
            action: 'UPDATED',
            details: { batch_no: batches[0].batch_no, opening_date: opening_date }
        });

        await conn.commit();

        res.json({
            id: parseInt(id),
            message: 'Opening balance batch updated successfully'
        });
    } catch (e) {
        await conn.rollback();
        console.error('Error updating opening balance batch:', e);
        res.status(500).json(errPayload('Failed to update opening balance batch', 'DB_ERROR', e.message));
    } finally {
        conn.release();
    }
});

// POST /api/opening-balances/batches/:id/approve - Approve and post batch
router.post('/batches/:id/approve', requireAuth, requirePerm('OpeningBalance', 'approve'), async (req, res) => {
    const userId = req.session?.user?.id;
    const { comment } = req.body;

    try {
        await tx(async (conn) => {
            const batchId = parseInt(req.params.id);
            
            // Check if batch exists and is in Submitted status
            const [batches] = await conn.query(`
                SELECT * FROM opening_balance_batch WHERE id = ? AND status_id = 8
            `, [batchId]);

            if (batches.length === 0) {
                throw new Error('Opening balance batch not found or not in Submitted for Approval status');
            }

            const journalId = await openingBalanceService.postOpeningBalance(conn, batchId, userId);
            
            // Log history
            await addHistory(conn, {
                module: 'opening_balance',
                moduleId: batchId,
                userId,
                action: 'APPROVED',
                details: { gl_journal_id: journalId, comment: comment || null }
            });
        });

        res.json({
            message: 'Opening balance batch approved and posted successfully'
        });
    } catch (e) {
        console.error('Error approving opening balance batch:', e);
        res.status(500).json(errPayload(e.message || 'Failed to approve opening balance batch', 'DB_ERROR', e.message));
    }
});

// POST /api/opening-balances/batches/:id/reject - Reject batch
router.post('/batches/:id/reject', requireAuth, requirePerm('OpeningBalance', 'approve'), async (req, res) => {
    const conn = await db.promise().getConnection();
    const userId = req.session?.user?.id;
    const { reason } = req.body;

    try {
        await conn.beginTransaction();

        const { id } = req.params;

        // Check if batch exists and is in Submitted status
        const [batches] = await conn.query(`
            SELECT * FROM opening_balance_batch WHERE id = ? AND status_id = 8
        `, [id]);

        if (batches.length === 0) {
            await conn.rollback();
            return res.status(404).json(errPayload('Opening balance batch not found or not in Submitted for Approval status', 'NOT_FOUND'));
        }

        if (!reason || !reason.trim()) {
            await conn.rollback();
            return res.status(400).json(errPayload('Rejection reason is required', 'VALIDATION_ERROR'));
        }

        // Update status to Rejected (status_id = 2)
        await conn.query(`
            UPDATE opening_balance_batch
            SET status_id = 2, updated_at = NOW(), updated_by = ?
            WHERE id = ?
        `, [userId, id]);

        // Log history
        await addHistory(conn, {
            module: 'opening_balance',
            moduleId: parseInt(id),
            userId,
            action: 'REJECTED',
            details: { reason: reason.trim() }
        });

        await conn.commit();

        res.json({
            message: 'Opening balance batch rejected successfully'
        });
    } catch (e) {
        await conn.rollback();
        console.error('Error rejecting opening balance batch:', e);
        res.status(500).json(errPayload('Failed to reject opening balance batch', 'DB_ERROR', e.message));
    } finally {
        conn.release();
    }
});

// POST /api/opening-balances/batches/:id/cancel - Cancel batch (only if Draft)
router.post('/batches/:id/cancel', requireAuth, requirePerm('OpeningBalance', 'delete'), async (req, res) => {
    const conn = await db.promise().getConnection();

    try {
        await conn.beginTransaction();

        const { id } = req.params;

        // Check if batch exists and is in Draft status
        const [batches] = await conn.query(`
            SELECT * FROM opening_balance_batch WHERE id = ? AND status_id = 3
        `, [id]);

        if (batches.length === 0) {
            await conn.rollback();
            return res.status(404).json(errPayload('Opening balance batch not found or not in Draft status', 'NOT_FOUND'));
        }

        // Delete lines (cascade will handle this, but explicit for clarity)
        await conn.query(`
            DELETE FROM opening_balance_lines WHERE batch_id = ?
        `, [id]);

        // Delete batch
        await conn.query(`
            DELETE FROM opening_balance_batch WHERE id = ?
        `, [id]);

        await conn.commit();

        res.json({
            message: 'Opening balance batch cancelled successfully'
        });
    } catch (e) {
        await conn.rollback();
        console.error('Error cancelling opening balance batch:', e);
        res.status(500).json(errPayload('Failed to cancel opening balance batch', 'DB_ERROR', e.message));
    } finally {
        conn.release();
    }
});

// POST /api/opening-balances/batches/:id/submit - Submit batch for approval (status_id 8)
router.post('/batches/:id/submit', requireAuth, requirePerm('OpeningBalance', 'approve'), async (req, res) => {
    const conn = await db.promise().getConnection();

    try {
        await conn.beginTransaction();

        const { id } = req.params;

        // Only Draft batches can be submitted
        const [batches] = await conn.query(`
            SELECT * FROM opening_balance_batch WHERE id = ? AND status_id = 3
        `, [id]);

        if (batches.length === 0) {
            await conn.rollback();
            return res.status(404).json(errPayload('Opening balance batch not found or not in Draft status', 'NOT_FOUND'));
        }

        await conn.query(`
            UPDATE opening_balance_batch
            SET status_id = 8, updated_at = NOW(), updated_by = ?
            WHERE id = ?
        `, [req.session?.user?.id || null, id]);

        await addHistory(conn, {
            module: 'opening_balance',
            moduleId: parseInt(id),
            userId: req.session?.user?.id,
            action: 'SUBMITTED',
            details: { previous_status: 3, new_status: 8 }
        });

        await conn.commit();

        res.json({ message: 'Opening balance batch submitted for approval successfully' });
    } catch (e) {
        await conn.rollback();
        console.error('Error submitting opening balance batch:', e);
        res.status(500).json(errPayload('Failed to submit opening balance batch', 'DB_ERROR', e.message));
    } finally {
        conn.release();
    }
});

// POST /api/opening-balances/batches/:id/request-edit - Request edit for approved batch
router.post('/batches/:id/request-edit', requireAuth, async (req, res) => {
    const conn = await db.promise().getConnection();
    const userId = req.session?.user?.id;

    try {
        await conn.beginTransaction();

        const { id } = req.params;
        const { reason } = req.body;

        if (!userId) {
            await conn.rollback();
            return res.status(401).json(errPayload('Authentication required', 'AUTH_ERROR'));
        }

        if (!reason || !reason.trim()) {
            await conn.rollback();
            return res.status(400).json(errPayload('A reason for the edit request is required', 'VALIDATION_ERROR'));
        }

        // Get batch
        const [batches] = await conn.query(`
            SELECT id, status_id, edit_request_status 
            FROM opening_balance_batch 
            WHERE id = ?
        `, [id]);

        if (batches.length === 0) {
            await conn.rollback();
            return res.status(404).json(errPayload('Opening balance batch not found', 'NOT_FOUND'));
        }

        const batch = batches[0];

        // Only allow edit requests for APPROVED batches (status_id = 1)
        if (batch.status_id !== 1) {
            await conn.rollback();
            return res.status(400).json(errPayload('Only approved opening balance batches can have edit requests', 'VALIDATION_ERROR'));
        }

        // Prevent new requests if one is already pending (3)
        if (batch.edit_request_status === 3) {
            await conn.rollback();
            return res.status(400).json(errPayload('An edit request is already pending for this batch', 'VALIDATION_ERROR'));
        }

        // Update batch with edit request
        await conn.query(`
            UPDATE opening_balance_batch SET 
                edit_request_status = 3,
                edit_requested_by = ?,
                edit_requested_at = NOW(),
                edit_request_reason = ?,
                edit_approved_by = NULL,
                edit_approved_at = NULL,
                edit_rejection_reason = NULL
            WHERE id = ?
        `, [userId, reason.trim(), batch.id]);

        // Add history entry
        await addHistory(conn, {
            module: 'opening_balance',
            moduleId: batch.id,
            userId,
            action: 'EDIT_REQUESTED',
            details: { reason: reason.trim() }
        });

        await conn.commit();
        res.json({ message: 'Edit request submitted successfully' });
    } catch (e) {
        await conn.rollback();
        console.error('Error requesting edit for opening balance batch:', e);
        res.status(500).json(errPayload('Failed to submit edit request', 'DB_ERROR', e.message));
    } finally {
        conn.release();
    }
});

// POST /api/opening-balances/batches/:id/decide-edit-request - Approve or reject edit request
router.post('/batches/:id/decide-edit-request', requireAuth, requirePerm('OpeningBalance', 'approve'), async (req, res) => {
    const conn = await db.promise().getConnection();
    const userId = req.session?.user?.id;

    try {
        await conn.beginTransaction();

        const { id } = req.params;
        const { decision, reason } = req.body;

        if (!userId) {
            await conn.rollback();
            return res.status(401).json(errPayload('Authentication required', 'AUTH_ERROR'));
        }

        if (!decision || !['approve', 'reject'].includes(decision)) {
            await conn.rollback();
            return res.status(400).json(errPayload('Decision must be "approve" or "reject"', 'VALIDATION_ERROR'));
        }

        // Get batch with pending edit request
        const [batches] = await conn.query(`
            SELECT id, status_id, edit_request_status 
            FROM opening_balance_batch 
            WHERE id = ? AND edit_request_status = 3
        `, [id]);

        if (batches.length === 0) {
            await conn.rollback();
            return res.status(404).json(errPayload('No pending edit request found for this batch', 'NOT_FOUND'));
        }

        const batch = batches[0];

        if (decision === 'approve') {
            // Approve edit request - set status to DRAFT (3) to allow editing
            await conn.query(`
                UPDATE opening_balance_batch SET 
                    status_id = 3,
                    edit_request_status = 1,
                    edit_approved_by = ?,
                    edit_approved_at = NOW()
                WHERE id = ?
            `, [userId, batch.id]);

            // Add history entry
            await addHistory(conn, {
                module: 'opening_balance',
                moduleId: batch.id,
                userId,
                action: 'EDIT_REQUEST_APPROVED',
                details: { comment: reason || 'Edit request approved' }
            });
        } else {
            // Reject edit request
            if (!reason || !reason.trim()) {
                await conn.rollback();
                return res.status(400).json(errPayload('Rejection reason is required', 'VALIDATION_ERROR'));
            }

            await conn.query(`
                UPDATE opening_balance_batch SET 
                    edit_request_status = 2,
                    edit_rejection_reason = ?
                WHERE id = ?
            `, [reason.trim(), batch.id]);

            // Add history entry
            await addHistory(conn, {
                module: 'opening_balance',
                moduleId: batch.id,
                userId,
                action: 'EDIT_REQUEST_REJECTED',
                details: { reason: reason.trim() }
            });
        }

        await conn.commit();
        res.json({ message: `Edit request ${decision}d successfully` });
    } catch (e) {
        await conn.rollback();
        console.error('Error deciding opening balance edit request:', e);
        res.status(500).json(errPayload('Failed to process edit request', 'DB_ERROR', e.message));
    } finally {
        conn.release();
    }
});

// GET /api/opening-balances/customers/search - Search customers
router.get('/customers/search', requireAuth, async (req, res) => {
    try {
        const { q = '' } = req.query;
        const searchTerm = `%${q}%`;

        const [rows] = await db.promise().query(`
            SELECT 
                v.id,
                v.display_name AS name,
                cur.name AS currency_code,
                v.email_address AS email,
                v.phone_work AS phone
            FROM vendor v
            LEFT JOIN vendor_other vo ON vo.vendor_id = v.id
            LEFT JOIN currency cur ON cur.id = vo.currency_id
            WHERE v.company_type_id = 2
              AND v.is_deleted = 0
              AND (v.display_name LIKE ? OR v.email_address LIKE ?)
            ORDER BY v.display_name
            LIMIT 50
        `, [searchTerm, searchTerm]);

        res.json(rows || []);
    } catch (e) {
        console.error('Error searching customers:', e);
        res.status(500).json(errPayload('Failed to search customers', 'DB_ERROR', e.message));
    }
});

// GET /api/opening-balances/vendors/search - Search vendors
router.get('/vendors/search', requireAuth, async (req, res) => {
    try {
        const { q = '' } = req.query;
        const searchTerm = `%${q}%`;

        const [rows] = await db.promise().query(`
            SELECT 
                v.id,
                v.display_name AS name,
                cur.name AS currency_code,
                v.email_address AS email,
                v.phone_work AS phone
            FROM vendor v
            LEFT JOIN vendor_other vo ON vo.vendor_id = v.id
            LEFT JOIN currency cur ON cur.id = vo.currency_id
            WHERE v.company_type_id = 1
              AND v.is_deleted = 0
              AND (v.display_name LIKE ? OR v.email_address LIKE ?)
            ORDER BY v.display_name
            LIMIT 50
        `, [searchTerm, searchTerm]);

        res.json(rows || []);
    } catch (e) {
        console.error('Error searching vendors:', e);
        res.status(500).json(errPayload('Failed to search vendors', 'DB_ERROR', e.message));
    }
});

// GET /api/opening-balances/exchange-rate - Get exchange rate for currency and date
router.get('/exchange-rate', requireAuth, async (req, res) => {
    try {
        const { currency, date } = req.query;

        if (!currency || !date) {
            return res.status(400).json(errPayload('Currency and date parameters are required', 'VALIDATION_ERROR'));
        }

        const conn = await db.promise().getConnection();
        try {
            const rate = await getExchangeRateForCurrency(conn, currency, date);
            res.json({ 
                currency_code: currency,
                date: date,
                rate_to_aed: rate,
                found: rate !== null
            });
        } finally {
            conn.release();
        }
    } catch (e) {
        console.error('Error getting exchange rate:', e);
        res.status(500).json(errPayload('Failed to get exchange rate', 'DB_ERROR', e.message));
    }
});

// GET /api/opening-balances/batches/:id/history - Get history for a batch
router.get('/batches/:id/history', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;

        const [history] = await db.promise().query(`
            SELECT 
                h.*,
                u.name as user_name
            FROM history h
            LEFT JOIN \`user\` u ON u.id = h.user_id
            WHERE h.module = 'opening_balance' AND h.module_id = ?
            ORDER BY h.created_at DESC
        `, [id]);

        res.json(history || []);
    } catch (e) {
        console.error('Error fetching history:', e);
        res.status(500).json(errPayload('Failed to fetch history', 'DB_ERROR', e.message));
    }
});

// GET /api/opening-balances/batches/:id/journal-entries - Get GL journal entries for a batch
router.get('/batches/:id/journal-entries', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;

        // Get batch to find gl_journal_id
        const [batches] = await db.promise().query(`
            SELECT gl_journal_id FROM opening_balance_batch WHERE id = ?
        `, [id]);

        if (batches.length === 0 || !batches[0].gl_journal_id) {
            return res.json({ data: [] });
        }

        const glJournalId = batches[0].gl_journal_id;

        // Get journal lines - only show entries from non-deleted journals
        const [lines] = await db.promise().query(`
            SELECT 
                gjl.id,
                gjl.line_no,
                gjl.account_id,
                gjl.debit,
                gjl.credit,
                gjl.description,
                gjl.currency_id,
                gjl.foreign_amount,
                gjl.total_amount,
                acc.name as account_name
            FROM gl_journal_lines gjl
            LEFT JOIN acc_chart_accounts acc ON acc.id = gjl.account_id
            LEFT JOIN gl_journals gj ON gj.id = gjl.journal_id
            WHERE gjl.journal_id = ?
              AND (gj.is_deleted = 0 OR gj.is_deleted IS NULL)
            ORDER BY gjl.line_no
        `, [glJournalId]);

        res.json({ data: lines || [] });
    } catch (e) {
        console.error('Error fetching journal entries:', e);
        res.status(500).json(errPayload('Failed to fetch journal entries', 'DB_ERROR', e.message));
    }
});

export default router;
