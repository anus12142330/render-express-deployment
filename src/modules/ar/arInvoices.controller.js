// server/src/modules/ar/arInvoices.controller.js
const { tx } = require('../../db/tx.cjs');
const { pool } = require('../../db/tx.cjs');
const { generateARInvoiceNumber } = require('../../utils/docNo.cjs');
const arInvoicesService = require('./arInvoices.service');
const inventoryService = require('../inventory/inventory.service');
const crypto = require('crypto');

async function listInvoices(req, res, next) {
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
            whereClause += ' AND ai.customer_id = ?';
            params.push(customerId);
        }
        if (status) {
            whereClause += ' AND ai.status = ?';
            params.push(status);
        }
        if (search) {
            whereClause += ' AND (ai.invoice_number LIKE ? OR v.display_name LIKE ?)';
            const searchPattern = `%${search}%`;
            params.push(searchPattern, searchPattern);
        }

        const [countRows] = await pool.query(`SELECT COUNT(*) as total FROM ar_invoices ai LEFT JOIN vendor v ON v.id = ai.customer_id ${whereClause}`, params);
        const total = countRows[0].total;

        const [rows] = await pool.query(`
            SELECT ai.*, v.display_name as customer_name, c.name as currency_code,
                (SELECT COALESCE(SUM(CASE WHEN p.currency_id = ai.currency_id THEN pa.amount_bank ELSE pa.amount_base END), 0) FROM tbl_payment_allocation pa INNER JOIN tbl_payment p ON p.id = pa.payment_id WHERE pa.alloc_type = 'invoice' AND pa.reference_id = ai.id AND (p.is_deleted = 0 OR p.is_deleted IS NULL) AND p.status_id = 1 AND p.direction = 'IN') as received_amount,
                (ai.total - COALESCE((SELECT SUM(CASE WHEN p.currency_id = ai.currency_id THEN pa.amount_bank ELSE pa.amount_base END) FROM tbl_payment_allocation pa INNER JOIN tbl_payment p ON p.id = pa.payment_id WHERE pa.alloc_type = 'invoice' AND pa.reference_id = ai.id AND (p.is_deleted = 0 OR p.is_deleted IS NULL) AND p.status_id = 1 AND p.direction = 'IN'), 0)) as outstanding_amount
            FROM ar_invoices ai
            LEFT JOIN vendor v ON v.id = ai.customer_id
            LEFT JOIN currency c ON c.id = ai.currency_id
            ${whereClause}
            ORDER BY ai.invoice_date DESC, ai.id DESC
            LIMIT ? OFFSET ?
        `, [...params, perPage, offset]);

        res.json({ data: rows, total, page, perPage });
    } catch (error) {
        next(error);
    }
}

async function getInvoice(req, res, next) {
    try {
        const { id } = req.params;
        const isNumeric = /^\d+$/.test(id);
        const whereField = isNumeric ? 'ai.id' : 'ai.invoice_uniqid';

        const [invoices] = await pool.query(`
            SELECT ai.*, v.display_name as customer_name, c.name as currency_code
            FROM ar_invoices ai
            LEFT JOIN vendor v ON v.id = ai.customer_id
            LEFT JOIN currency c ON c.id = ai.currency_id
            WHERE ${whereField} = ?
        `, [id]);

        if (invoices.length === 0) {
            return res.status(404).json({ error: 'Invoice not found' });
        }

        const invoice = invoices[0];
        const [lines] = await pool.query(`
            SELECT ail.*, um.name as uom_name, p.product_name
            FROM ar_invoice_lines ail
            LEFT JOIN uom_master um ON um.id = ail.uom_id
            LEFT JOIN products p ON p.id = ail.product_id
            WHERE ail.invoice_id = ?
            ORDER BY ail.line_no
        `, [invoice.id]);

        for (const line of lines) {
            const [batches] = await pool.query(`
                SELECT ailb.*, ib.batch_no, ib.mfg_date, ib.exp_date
                FROM ar_invoice_line_batches ailb
                JOIN inventory_batches ib ON ib.id = ailb.batch_id
                WHERE ailb.invoice_line_id = ?
            `, [line.id]);
            line.batches = batches;
        }

        invoice.lines = lines;
        res.json(invoice);
    } catch (error) {
        next(error);
    }
}

async function createInvoice(req, res, next) {
    await tx(async (conn) => {
        try {
            const userId = req.session?.user?.id;
            if (!userId) return res.status(401).json({ error: 'Unauthorized' });

            const { invoice_number, invoice_date, due_date, customer_id, warehouse_id, currency_id, subtotal, tax_total, total, notes, lines = [] } = req.body;

            let finalInvoiceNumber = invoice_number;
            if (!finalInvoiceNumber) {
                finalInvoiceNumber = await generateARInvoiceNumber(conn, new Date(invoice_date || new Date()).getFullYear());
            }

            const [existing] = await conn.query(`SELECT id FROM ar_invoices WHERE invoice_number = ?`, [finalInvoiceNumber]);
            if (existing.length > 0) {
                return res.status(409).json({ error: 'Invoice number already exists' });
            }

            const invoiceUniqid = `ari_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

            const [invoiceResult] = await conn.query(`
                INSERT INTO ar_invoices 
                (invoice_uniqid, invoice_number, invoice_date, due_date, customer_id, warehouse_id, currency_id, subtotal, tax_total, total, notes, user_id, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT')
            `, [invoiceUniqid, finalInvoiceNumber, invoice_date, due_date, customer_id, warehouse_id, currency_id, subtotal, tax_total, total, notes, userId]);

            const invoiceId = invoiceResult.insertId;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const [lineResult] = await conn.query(`
                    INSERT INTO ar_invoice_lines 
                    (invoice_id, line_no, product_id, item_name, description, quantity, uom_id, rate, tax_id, tax_rate, line_total)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [invoiceId, i + 1, line.product_id, line.item_name, line.description, line.quantity, line.uom_id, line.rate, line.tax_id, line.tax_rate, line.line_total]);

                const lineId = lineResult.insertId;

                if (line.batches && Array.isArray(line.batches)) {
                    for (const batch of line.batches) {
                        await conn.query(`
                            INSERT INTO ar_invoice_line_batches 
                            (invoice_line_id, batch_id, quantity, unit_cost)
                            VALUES (?, ?, ?, ?)
                        `, [lineId, batch.batch_id, batch.quantity, batch.unit_cost]);
                    }
                }
            }

            const [[newInvoice]] = await conn.query(`SELECT * FROM ar_invoices WHERE id = ?`, [invoiceId]);
            res.status(201).json(newInvoice);
        } catch (error) {
            throw error;
        }
    }).catch(next);
}

async function updateInvoice(req, res, next) {
    await tx(async (conn) => {
        try {
            const { id } = req.params;
            const userId = req.session?.user?.id;
            if (!userId) return res.status(401).json({ error: 'Unauthorized' });

            const [invoices] = await conn.query(`SELECT * FROM ar_invoices WHERE id = ? OR invoice_uniqid = ?`, [id, id]);
            if (invoices.length === 0) return res.status(404).json({ error: 'Invoice not found' });

            const invoice = invoices[0];
            if (invoice.status !== 'DRAFT') return res.status(400).json({ error: 'Only DRAFT invoices can be updated' });

            const { invoice_number, invoice_date, due_date, customer_id, warehouse_id, currency_id, subtotal, tax_total, total, notes, lines = [] } = req.body;

            await conn.query(`
                UPDATE ar_invoices 
                SET invoice_number = ?, invoice_date = ?, due_date = ?, customer_id = ?, warehouse_id = ?, currency_id = ?, subtotal = ?, tax_total = ?, total = ?, notes = ?
                WHERE id = ?
            `, [invoice_number, invoice_date, due_date, customer_id, warehouse_id, currency_id, subtotal, tax_total, total, notes, invoice.id]);

            await conn.query(`DELETE FROM ar_invoice_line_batches WHERE invoice_line_id IN (SELECT id FROM ar_invoice_lines WHERE invoice_id = ?)`, [invoice.id]);
            await conn.query(`DELETE FROM ar_invoice_lines WHERE invoice_id = ?`, [invoice.id]);

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const [lineResult] = await conn.query(`
                    INSERT INTO ar_invoice_lines 
                    (invoice_id, line_no, product_id, item_name, description, quantity, uom_id, rate, tax_id, tax_rate, line_total)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [invoice.id, i + 1, line.product_id, line.item_name, line.description, line.quantity, line.uom_id, line.rate, line.tax_id, line.tax_rate, line.line_total]);

                const lineId = lineResult.insertId;

                if (line.batches && Array.isArray(line.batches)) {
                    for (const batch of line.batches) {
                        await conn.query(`
                            INSERT INTO ar_invoice_line_batches 
                            (invoice_line_id, batch_id, quantity, unit_cost)
                            VALUES (?, ?, ?, ?)
                        `, [lineId, batch.batch_id, batch.quantity, batch.unit_cost]);
                    }
                }
            }

            const [[updatedInvoice]] = await conn.query(`SELECT * FROM ar_invoices WHERE id = ?`, [invoice.id]);
            res.json(updatedInvoice);
        } catch (error) {
            throw error;
        }
    }).catch(next);
}

async function autoAllocate(req, res, next) {
    await tx(async (conn) => {
        try {
            const { id } = req.params;
            const mode = (req.query.mode || 'FIFO').toUpperCase();

            if (!['FIFO', 'FEFO'].includes(mode)) {
                return res.status(400).json({ error: 'Mode must be FIFO or FEFO' });
            }

            const [invoices] = await conn.query(`SELECT id FROM ar_invoices WHERE id = ? OR invoice_uniqid = ?`, [id, id]);
            if (invoices.length === 0) return res.status(404).json({ error: 'Invoice not found' });

            const result = await arInvoicesService.autoAllocateBatches(conn, invoices[0].id, mode);
            res.json(result);
        } catch (error) {
            throw error;
        }
    }).catch(next);
}

async function postInvoice(req, res, next) {
    await tx(async (conn) => {
        try {
            const { id } = req.params;
            const userId = req.session?.user?.id;
            if (!userId) return res.status(401).json({ error: 'Unauthorized' });

            const [invoices] = await conn.query(`SELECT id FROM ar_invoices WHERE id = ? OR invoice_uniqid = ?`, [id, id]);
            if (invoices.length === 0) return res.status(404).json({ error: 'Invoice not found' });

            await arInvoicesService.postInvoice(conn, invoices[0].id, userId);
            res.json({ success: true, message: 'Invoice posted successfully' });
        } catch (error) {
            throw error;
        }
    }).catch(next);
}

async function cancelInvoice(req, res, next) {
    await tx(async (conn) => {
        try {
            const { id } = req.params;
            const userId = req.session?.user?.id;
            if (!userId) return res.status(401).json({ error: 'Unauthorized' });

            const [invoices] = await conn.query(`SELECT id FROM ar_invoices WHERE id = ? OR invoice_uniqid = ?`, [id, id]);
            if (invoices.length === 0) return res.status(404).json({ error: 'Invoice not found' });

            await arInvoicesService.cancelInvoice(conn, invoices[0].id, userId);
            res.json({ success: true, message: 'Invoice cancelled successfully' });
        } catch (error) {
            throw error;
        }
    }).catch(next);
}

async function getAvailableBatches(req, res, next) {
    try {
        const productId = req.query.product_id;
        const warehouseId = req.query.warehouse_id;

        if (!productId || !warehouseId) {
            return res.status(400).json({ error: 'product_id and warehouse_id are required' });
        }

        const batches = await inventoryService.getAvailableBatches(parseInt(productId, 10), parseInt(warehouseId, 10));
        res.json(batches);
    } catch (error) {
        next(error);
    }
}

module.exports = { listInvoices, getInvoice, createInvoice, updateInvoice, autoAllocate, postInvoice, cancelInvoice, getAvailableBatches };

