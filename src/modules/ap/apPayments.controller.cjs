// server/src/modules/ap/apPayments.controller.js
const { tx } = require('../../db/tx.cjs');
const { pool } = require('../../db/tx.cjs');
const { generateAPPaymentNumber } = require('../../utils/docNo.cjs');
const apPaymentsService = require('./apPayments.service.cjs');
const crypto = require('crypto');

async function listPayments(req, res, next) {
    try {
        const page = Math.max(parseInt(req.query.page || '1', 10), 1);
        const perPage = Math.min(Math.max(parseInt(req.query.per_page || '10', 10), 1), 100);
        const offset = (page - 1) * perPage;
        const search = (req.query.search || '').trim();
        const supplierId = req.query.supplier_id ? parseInt(req.query.supplier_id, 10) : null;
        const status = req.query.status || '';

        let whereClause = 'WHERE 1=1';
        const params = [];

        if (supplierId) {
            whereClause += ' AND ap.supplier_id = ?';
            params.push(supplierId);
        }
        if (status) {
            whereClause += ' AND ap.status = ?';
            params.push(status);
        }
        if (search) {
            whereClause += ' AND (ap.payment_number LIKE ? OR v.display_name LIKE ?)';
            const searchPattern = `%${search}%`;
            params.push(searchPattern, searchPattern);
        }

        const [countRows] = await pool.query(`SELECT COUNT(*) as total FROM ap_payments ap LEFT JOIN vendor v ON v.id = ap.supplier_id ${whereClause}`, params);
        const total = countRows[0].total;

        const [rows] = await pool.query(`
            SELECT ap.*, v.display_name as supplier_name, c.name as currency_code
            FROM ap_payments ap
            LEFT JOIN vendor v ON v.id = ap.supplier_id
            LEFT JOIN currency c ON c.id = ap.currency_id
            ${whereClause}
            ORDER BY ap.payment_date DESC, ap.id DESC
            LIMIT ? OFFSET ?
        `, [...params, perPage, offset]);

        res.json({ data: rows, total, page, perPage });
    } catch (error) {
        next(error);
    }
}

async function getPayment(req, res, next) {
    try {
        const { id } = req.params;
        const isNumeric = /^\d+$/.test(id);
        const whereField = isNumeric ? 'ap.id' : 'ap.payment_uniqid';

        const [payments] = await pool.query(`
            SELECT ap.*, v.display_name as supplier_name, c.name as currency_code
            FROM ap_payments ap
            LEFT JOIN vendor v ON v.id = ap.supplier_id
            LEFT JOIN currency c ON c.id = ap.currency_id
            WHERE ${whereField} = ?
        `, [id]);

        if (payments.length === 0) {
            return res.status(404).json({ error: 'Payment not found' });
        }

        const payment = payments[0];
        const [allocations] = await pool.query(`
            SELECT apa.*, ab.bill_number, ab.bill_date, ab.total as bill_total,
                (SELECT COALESCE(SUM(pa.allocated_amount), 0) FROM ap_payment_allocations pa WHERE pa.bill_id = ab.id) as bill_paid_amount,
                (ab.total - COALESCE((SELECT SUM(pa.allocated_amount) FROM ap_payment_allocations pa WHERE pa.bill_id = ab.id), 0)) as bill_outstanding
            FROM ap_payment_allocations apa
            JOIN ap_bills ab ON ab.id = apa.bill_id
            WHERE apa.payment_id = ?
        `, [payment.id]);

        payment.allocations = allocations;
        res.json(payment);
    } catch (error) {
        next(error);
    }
}

async function createPayment(req, res, next) {
    await tx(async (conn) => {
        try {
            const userId = req.session?.user?.id;
            if (!userId) return res.status(401).json({ error: 'Unauthorized' });

            const { payment_number, payment_date, supplier_id, bank_account_id, currency_id, total_amount, notes, allocations = [] } = req.body;

            let finalPaymentNumber = payment_number;
            if (!finalPaymentNumber) {
                finalPaymentNumber = await generateAPPaymentNumber(conn, new Date(payment_date || new Date()).getFullYear());
            }

            const [existing] = await conn.query(`SELECT id FROM ap_payments WHERE payment_number = ?`, [finalPaymentNumber]);
            if (existing.length > 0) {
                return res.status(409).json({ error: 'Payment number already exists' });
            }

            const totalAllocated = allocations.reduce((sum, a) => sum + parseFloat(a.allocated_amount || 0), 0);
            if (Math.abs(totalAllocated - parseFloat(total_amount)) > 0.01) {
                return res.status(400).json({ error: 'Allocation total must match payment amount' });
            }

            const paymentUniqid = `app_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

            const [paymentResult] = await conn.query(`
                INSERT INTO ap_payments 
                (payment_uniqid, payment_number, payment_date, supplier_id, bank_account_id, currency_id, total_amount, notes, user_id, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT')
            `, [paymentUniqid, finalPaymentNumber, payment_date, supplier_id, bank_account_id, currency_id, total_amount, notes, userId]);

            const paymentId = paymentResult.insertId;

            for (const alloc of allocations) {
                await conn.query(`INSERT INTO ap_payment_allocations (payment_id, bill_id, allocated_amount) VALUES (?, ?, ?)`, [paymentId, alloc.bill_id, alloc.allocated_amount]);
            }

            const [[newPayment]] = await conn.query(`SELECT * FROM ap_payments WHERE id = ?`, [paymentId]);
            res.status(201).json(newPayment);
        } catch (error) {
            throw error;
        }
    }).catch(next);
}

async function updatePayment(req, res, next) {
    await tx(async (conn) => {
        try {
            const { id } = req.params;
            const userId = req.session?.user?.id;
            if (!userId) return res.status(401).json({ error: 'Unauthorized' });

            const [payments] = await conn.query(`SELECT * FROM ap_payments WHERE id = ? OR payment_uniqid = ?`, [id, id]);
            if (payments.length === 0) return res.status(404).json({ error: 'Payment not found' });

            const payment = payments[0];
            if (payment.status !== 'DRAFT') return res.status(400).json({ error: 'Only DRAFT payments can be updated' });

            const { payment_number, payment_date, supplier_id, bank_account_id, currency_id, total_amount, notes, allocations = [] } = req.body;

            const totalAllocated = allocations.reduce((sum, a) => sum + parseFloat(a.allocated_amount || 0), 0);
            if (Math.abs(totalAllocated - parseFloat(total_amount)) > 0.01) {
                return res.status(400).json({ error: 'Allocation total must match payment amount' });
            }

            await conn.query(`
                UPDATE ap_payments 
                SET payment_number = ?, payment_date = ?, supplier_id = ?, bank_account_id = ?, currency_id = ?, total_amount = ?, notes = ?
                WHERE id = ?
            `, [payment_number, payment_date, supplier_id, bank_account_id, currency_id, total_amount, notes, payment.id]);

            await conn.query(`DELETE FROM ap_payment_allocations WHERE payment_id = ?`, [payment.id]);

            for (const alloc of allocations) {
                await conn.query(`INSERT INTO ap_payment_allocations (payment_id, bill_id, allocated_amount) VALUES (?, ?, ?)`, [payment.id, alloc.bill_id, alloc.allocated_amount]);
            }

            const [[updatedPayment]] = await conn.query(`SELECT * FROM ap_payments WHERE id = ?`, [payment.id]);
            res.json(updatedPayment);
        } catch (error) {
            throw error;
        }
    }).catch(next);
}

async function postPayment(req, res, next) {
    await tx(async (conn) => {
        try {
            const { id } = req.params;
            const userId = req.session?.user?.id;
            if (!userId) return res.status(401).json({ error: 'Unauthorized' });

            const [payments] = await conn.query(`SELECT id FROM ap_payments WHERE id = ? OR payment_uniqid = ?`, [id, id]);
            if (payments.length === 0) return res.status(404).json({ error: 'Payment not found' });

            await apPaymentsService.postPayment(conn, payments[0].id, userId);
            res.json({ success: true, message: 'Payment posted successfully' });
        } catch (error) {
            throw error;
        }
    }).catch(next);
}

async function cancelPayment(req, res, next) {
    await tx(async (conn) => {
        try {
            const { id } = req.params;
            const userId = req.session?.user?.id;
            if (!userId) return res.status(401).json({ error: 'Unauthorized' });

            const [payments] = await conn.query(`SELECT id FROM ap_payments WHERE id = ? OR payment_uniqid = ?`, [id, id]);
            if (payments.length === 0) return res.status(404).json({ error: 'Payment not found' });

            await apPaymentsService.cancelPayment(conn, payments[0].id, userId);
            res.json({ success: true, message: 'Payment cancelled successfully' });
        } catch (error) {
            throw error;
        }
    }).catch(next);
}

async function getOpenBills(req, res, next) {
    try {
        const { supplierId } = req.params;
        const [rows] = await pool.query(`
            SELECT ab.id, ab.bill_number, ab.bill_date, ab.due_date, ab.total,
                COALESCE(SUM(pa.allocated_amount), 0) as paid_amount,
                (ab.total - COALESCE(SUM(pa.allocated_amount), 0)) as outstanding_amount
            FROM ap_bills ab
            LEFT JOIN ap_payment_allocations pa ON pa.bill_id = ab.id
            WHERE ab.supplier_id = ? AND ab.status = 'POSTED'
            GROUP BY ab.id
            HAVING outstanding_amount > 0
            ORDER BY ab.bill_date ASC
        `, [supplierId]);
        res.json(rows);
    } catch (error) {
        next(error);
    }
}

module.exports = { listPayments, getPayment, createPayment, updatePayment, postPayment, cancelPayment, getOpenBills };

