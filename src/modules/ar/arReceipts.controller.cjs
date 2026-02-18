// server/src/modules/ar/arReceipts.controller.js
const { tx } = require('../../db/tx.cjs');
const { pool } = require('../../db/tx.cjs');
const { generateARReceiptNumber } = require('../../utils/docNo.cjs');
const arReceiptsService = require('./arReceipts.service.cjs');
const crypto = require('crypto');

async function listReceipts(req, res, next) {
    try {
        const page = Math.max(parseInt(req.query.page || '1', 10), 1);
        const perPage = Math.min(Math.max(parseInt(req.query.per_page || '10', 10), 1), 100);
        const offset = (page - 1) * perPage;
        const search = (req.query.search || '').trim();
        const customerId = req.query.customer_id ? parseInt(req.query.customer_id, 10) : null;
        const status = req.query.status || '';

        let whereClause = 'WHERE 1=1';
        const params = [];

        if (customerId) {
            whereClause += ' AND ar.customer_id = ?';
            params.push(customerId);
        }
        if (status) {
            whereClause += ' AND ar.status = ?';
            params.push(status);
        }
        if (search) {
            whereClause += ' AND (ar.receipt_number LIKE ? OR v.display_name LIKE ?)';
            const searchPattern = `%${search}%`;
            params.push(searchPattern, searchPattern);
        }

        const [countRows] = await pool.query(`SELECT COUNT(*) as total FROM ar_receipts ar LEFT JOIN vendor v ON v.id = ar.customer_id ${whereClause}`, params);
        const total = countRows[0].total;

        const [rows] = await pool.query(`
            SELECT ar.*, v.display_name as customer_name, c.name as currency_code
            FROM ar_receipts ar
            LEFT JOIN vendor v ON v.id = ar.customer_id
            LEFT JOIN currency c ON c.id = ar.currency_id
            ${whereClause}
            ORDER BY ar.receipt_date DESC, ar.id DESC
            LIMIT ? OFFSET ?
        `, [...params, perPage, offset]);

        res.json({ data: rows, total, page, perPage });
    } catch (error) {
        next(error);
    }
}

async function getReceipt(req, res, next) {
    try {
        const { id } = req.params;
        const isNumeric = /^\d+$/.test(id);
        const whereField = isNumeric ? 'ar.id' : 'ar.receipt_uniqid';

        const [receipts] = await pool.query(`
            SELECT ar.*, v.display_name as customer_name, c.name as currency_code
            FROM ar_receipts ar
            LEFT JOIN vendor v ON v.id = ar.customer_id
            LEFT JOIN currency c ON c.id = ar.currency_id
            WHERE ${whereField} = ?
        `, [id]);

        if (receipts.length === 0) return res.status(404).json({ error: 'Receipt not found' });

        const receipt = receipts[0];
        const [allocations] = await pool.query(`
            SELECT ara.*, ai.invoice_number, ai.invoice_date, ai.total as invoice_total,
                (
                    COALESCE((SELECT SUM(CASE WHEN p.currency_id = ai.currency_id THEN pa.amount_bank ELSE pa.amount_base END) FROM tbl_payment_allocation pa INNER JOIN tbl_payment p ON p.id = pa.payment_id WHERE pa.alloc_type = 'invoice' AND pa.reference_id = ai.id AND (p.is_deleted = 0 OR p.is_deleted IS NULL) AND p.status_id = 1 AND p.direction = 'IN'), 0)
                ) as invoice_received_amount,
                (ai.total - (
                    COALESCE((SELECT SUM(CASE WHEN p.currency_id = ai.currency_id THEN pa.amount_bank ELSE pa.amount_base END) FROM tbl_payment_allocation pa INNER JOIN tbl_payment p ON p.id = pa.payment_id WHERE pa.alloc_type = 'invoice' AND pa.reference_id = ai.id AND (p.is_deleted = 0 OR p.is_deleted IS NULL) AND p.status_id = 1 AND p.direction = 'IN'), 0)
                )) as invoice_outstanding
            FROM ar_receipt_allocations ara
            JOIN ar_invoices ai ON ai.id = ara.invoice_id
            WHERE ara.receipt_id = ?
        `, [receipt.id]);

        receipt.allocations = allocations;
        res.json(receipt);
    } catch (error) {
        next(error);
    }
}

async function createReceipt(req, res, next) {
    await tx(async (conn) => {
        try {
            const userId = req.session?.user?.id;
            if (!userId) return res.status(401).json({ error: 'Unauthorized' });

            const { receipt_number, receipt_date, customer_id, bank_account_id, currency_id, total_amount, notes, allocations = [] } = req.body;

            let finalReceiptNumber = receipt_number;
            if (!finalReceiptNumber) {
                finalReceiptNumber = await generateARReceiptNumber(conn, new Date(receipt_date || new Date()).getFullYear());
            }

            const [existing] = await conn.query(`SELECT id FROM ar_receipts WHERE receipt_number = ?`, [finalReceiptNumber]);
            if (existing.length > 0) return res.status(409).json({ error: 'Receipt number already exists' });

            const totalAllocated = allocations.reduce((sum, a) => sum + parseFloat(a.allocated_amount || 0), 0);
            if (Math.abs(totalAllocated - parseFloat(total_amount)) > 0.01) {
                return res.status(400).json({ error: 'Allocation total must match receipt amount' });
            }

            const receiptUniqid = `arr_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

            const [receiptResult] = await conn.query(`
                INSERT INTO ar_receipts 
                (receipt_uniqid, receipt_number, receipt_date, customer_id, bank_account_id, currency_id, total_amount, notes, user_id, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT')
            `, [receiptUniqid, finalReceiptNumber, receipt_date, customer_id, bank_account_id, currency_id, total_amount, notes, userId]);

            const receiptId = receiptResult.insertId;

            for (const alloc of allocations) {
                await conn.query(`INSERT INTO ar_receipt_allocations (receipt_id, invoice_id, allocated_amount) VALUES (?, ?, ?)`, [receiptId, alloc.invoice_id, alloc.allocated_amount]);
            }

            const [[newReceipt]] = await conn.query(`SELECT * FROM ar_receipts WHERE id = ?`, [receiptId]);
            res.status(201).json(newReceipt);
        } catch (error) {
            throw error;
        }
    }).catch(next);
}

async function updateReceipt(req, res, next) {
    await tx(async (conn) => {
        try {
            const { id } = req.params;
            const userId = req.session?.user?.id;
            if (!userId) return res.status(401).json({ error: 'Unauthorized' });

            const [receipts] = await conn.query(`SELECT * FROM ar_receipts WHERE id = ? OR receipt_uniqid = ?`, [id, id]);
            if (receipts.length === 0) return res.status(404).json({ error: 'Receipt not found' });

            const receipt = receipts[0];
            if (receipt.status !== 'DRAFT') return res.status(400).json({ error: 'Only DRAFT receipts can be updated' });

            const { receipt_number, receipt_date, customer_id, bank_account_id, currency_id, total_amount, notes, allocations = [] } = req.body;

            const totalAllocated = allocations.reduce((sum, a) => sum + parseFloat(a.allocated_amount || 0), 0);
            if (Math.abs(totalAllocated - parseFloat(total_amount)) > 0.01) {
                return res.status(400).json({ error: 'Allocation total must match receipt amount' });
            }

            await conn.query(`
                UPDATE ar_receipts 
                SET receipt_number = ?, receipt_date = ?, customer_id = ?, bank_account_id = ?, currency_id = ?, total_amount = ?, notes = ?
                WHERE id = ?
            `, [receipt_number, receipt_date, customer_id, bank_account_id, currency_id, total_amount, notes, receipt.id]);

            await conn.query(`DELETE FROM ar_receipt_allocations WHERE receipt_id = ?`, [receipt.id]);

            for (const alloc of allocations) {
                await conn.query(`INSERT INTO ar_receipt_allocations (receipt_id, invoice_id, allocated_amount) VALUES (?, ?, ?)`, [receipt.id, alloc.invoice_id, alloc.allocated_amount]);
            }

            const [[updatedReceipt]] = await conn.query(`SELECT * FROM ar_receipts WHERE id = ?`, [receipt.id]);
            res.json(updatedReceipt);
        } catch (error) {
            throw error;
        }
    }).catch(next);
}

async function postReceipt(req, res, next) {
    await tx(async (conn) => {
        try {
            const { id } = req.params;
            const userId = req.session?.user?.id;
            if (!userId) return res.status(401).json({ error: 'Unauthorized' });

            const [receipts] = await conn.query(`SELECT id FROM ar_receipts WHERE id = ? OR receipt_uniqid = ?`, [id, id]);
            if (receipts.length === 0) return res.status(404).json({ error: 'Receipt not found' });

            await arReceiptsService.postReceipt(conn, receipts[0].id, userId);
            res.json({ success: true, message: 'Receipt posted successfully' });
        } catch (error) {
            throw error;
        }
    }).catch(next);
}

async function cancelReceipt(req, res, next) {
    await tx(async (conn) => {
        try {
            const { id } = req.params;
            const userId = req.session?.user?.id;
            if (!userId) return res.status(401).json({ error: 'Unauthorized' });

            const [receipts] = await conn.query(`SELECT id FROM ar_receipts WHERE id = ? OR receipt_uniqid = ?`, [id, id]);
            if (receipts.length === 0) return res.status(404).json({ error: 'Receipt not found' });

            await arReceiptsService.cancelReceipt(conn, receipts[0].id, userId);
            res.json({ success: true, message: 'Receipt cancelled successfully' });
        } catch (error) {
            throw error;
        }
    }).catch(next);
}

async function getOpenInvoices(req, res, next) {
    try {
        const { customerId } = req.params;
        const [rows] = await pool.query(`
            SELECT ai.id, ai.invoice_number, ai.invoice_date, ai.due_date, ai.total,
                (
                    COALESCE((SELECT SUM(CASE WHEN p.currency_id = ai.currency_id THEN pa.amount_bank ELSE pa.amount_base END) FROM tbl_payment_allocation pa INNER JOIN tbl_payment p ON p.id = pa.payment_id WHERE pa.alloc_type = 'invoice' AND pa.reference_id = ai.id AND (p.is_deleted = 0 OR p.is_deleted IS NULL) AND p.status_id = 1 AND p.direction = 'IN'), 0)
                ) as received_amount,
                (ai.total - (
                    COALESCE((SELECT SUM(CASE WHEN p.currency_id = ai.currency_id THEN pa.amount_bank ELSE pa.amount_base END) FROM tbl_payment_allocation pa INNER JOIN tbl_payment p ON p.id = pa.payment_id WHERE pa.alloc_type = 'invoice' AND pa.reference_id = ai.id AND (p.is_deleted = 0 OR p.is_deleted IS NULL) AND p.status_id = 1 AND p.direction = 'IN'), 0)
                )) as outstanding_amount
            FROM ar_invoices ai
            WHERE ai.customer_id = ? AND ai.status_id = 1
            GROUP BY ai.id
            HAVING outstanding_amount > 0
            ORDER BY ai.invoice_date ASC
        `, [customerId]);
        res.json(rows);
    } catch (error) {
        next(error);
    }
}

module.exports = { listReceipts, getReceipt, createReceipt, updateReceipt, postReceipt, cancelReceipt, getOpenInvoices };

