// server/src/modules/ar/arInvoices.controller.js
const { tx } = require('../../db/tx.cjs');
const { pool } = require('../../db/tx.cjs');
const { generateARInvoiceNumber } = require('../../utils/docNo.cjs');
const arInvoicesService = require('./arInvoices.service.cjs');
const inventoryService = require('../inventory/inventory.service.cjs');
const { isInventoryMovementEnabled } = require('../../utils/inventoryHelper.cjs');
const crypto = require('crypto');

// Helper function to add history entries
async function addHistory(conn, { module, moduleId, userId, action, details }) {
    if (!module || !moduleId || !userId || !action) return;
    await conn.query(
        'INSERT INTO history (module, module_id, user_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
        [module, moduleId, userId, action, JSON.stringify(details || {})]
    );
}

/**
 * UNIVERSAL STOCK CALCULATION HELPER
 * 
 * Formula: Available Stock = Stock on Hand + Inventory Transaction Quantities (for this invoice)
 * 
 * This calculation works for ALL invoice statuses (Draft, Submitted, Approved, Rejected, etc.)
 * If an invoice has inventory_transactions (regardless of current status),
 * those quantities were already reduced from stock, so we add them back to show correct available stock.
 * 
 * @param {Object} conn - Database connection
 * @param {number} invoiceId - Invoice ID
 * @param {number} productId - Product ID (optional, for filtering)
 * @param {number} warehouseId - Warehouse ID (optional, for filtering)
 * @returns {Object} Map of batch quantities keyed by "productId_batchId_warehouseId"
 */
async function getInvoiceInventoryTransactionQuantities(conn, invoiceId, productId = null, warehouseId = null) {
    // Get quantities from inventory_transactions where source_type = 'AR_INVOICE'
    // and source_id matches the invoice
    // We match by source_id (invoice) and product_id only - no need to check source_line_id
    // IMPORTANT: We check for transactions regardless of invoice status
    // because if transactions exist, stock was already reduced and needs to be added back
    let inventoryTxnsQuery = `
        SELECT it.batch_id, it.qty, it.product_id, it.warehouse_id
        FROM inventory_transactions it
        WHERE it.source_type = 'AR_INVOICE' 
        AND it.source_id = ? 
        AND it.movement = 'OUT'
        AND (it.is_deleted = 0 OR it.is_deleted IS NULL)
    `;
    const inventoryTxnsParams = [invoiceId];

    if (productId) {
        // Filter by product_id to get only transactions for this specific product
        inventoryTxnsQuery += ` AND it.product_id = ?`;
        inventoryTxnsParams.push(parseInt(productId, 10));
    }

    // If warehouse_id is provided, also filter by warehouse to get more accurate results
    if (warehouseId) {
        inventoryTxnsQuery += ` AND it.warehouse_id = ?`;
        inventoryTxnsParams.push(parseInt(warehouseId, 10));
    }

    const [inventoryTxns] = await conn.query(inventoryTxnsQuery, inventoryTxnsParams);

    // Group by batch_id, product_id, and warehouse_id
    // Use key format: productId_batchId_warehouseId for proper matching
    // These are the quantities from inventory_transactions for this invoice
    const invoiceBatchQuantities = {};
    inventoryTxns.forEach(txn => {
        const whId = txn.warehouse_id || warehouseId || 'any';
        const key = `${txn.product_id}_${txn.batch_id}_${whId}`;
        if (!invoiceBatchQuantities[key]) {
            invoiceBatchQuantities[key] = 0;
        }
        invoiceBatchQuantities[key] += parseFloat(txn.qty || 0);
    });

    return invoiceBatchQuantities;
}

/**
 * Calculate available stock for a specific batch
 * Formula: Available Stock = Stock on Hand + Inventory Transaction Quantities (for this invoice)
 * 
 * @param {number} stockOnHand - Current stock on hand from inventory_stock_batches
 * @param {number} inventoryTransactionQty - Quantity from inventory_transactions for this invoice
 * @returns {number} Available stock
 */
function calculateAvailableStock(stockOnHand, inventoryTransactionQty) {
    return parseFloat(stockOnHand || 0) + parseFloat(inventoryTransactionQty || 0);
}

// Helper function to track field changes
function getChangedFields(oldValues, newValues) {
    const changes = [];
    const fieldsToTrack = [
        'invoice_number', 'invoice_date', 'invoice_time', 'due_date',
        'customer_id', 'company_id', 'warehouse_id', 'currency_id',
        'payment_terms_id', 'subtotal', 'discount_type', 'discount_amount', 'tax_total', 'total', 'notes', 'proforma_invoice_id',
        'customer_address', 'delivery_address', 'delivery_address_id'
    ];

    for (const field of fieldsToTrack) {
        const oldVal = oldValues[field];
        const newVal = newValues[field];

        // Handle numeric fields - compare as numbers with tolerance for floating point
        if (['subtotal', 'discount_amount', 'tax_total', 'total'].includes(field)) {
            const normalizedOld = oldVal != null ? Number(oldVal) : null;
            const normalizedNew = newVal != null ? Number(newVal) : null;

            // Compare numbers with small tolerance for floating point (0.01)
            if (normalizedOld !== normalizedNew &&
                (normalizedOld == null || normalizedNew == null ||
                    Math.abs((normalizedOld || 0) - (normalizedNew || 0)) > 0.01)) {
                changes.push({
                    field: field,
                    from: normalizedOld != null ? normalizedOld.toFixed(2) : '—',
                    to: normalizedNew != null ? normalizedNew.toFixed(2) : '—'
                });
            }
        } else {
            // For non-numeric fields, compare as strings (trimmed)
            const oldStr = String(oldVal || '').trim();
            const newStr = String(newVal || '').trim();

            if (oldStr !== newStr) {
                changes.push({
                    field: field,
                    from: oldStr || '—',
                    to: newStr || '—'
                });
            }
        }
    }

    return changes;
}

async function listInvoices(req, res, next) {
    try {
        const page = Math.max(parseInt(req.query.page || '1', 10), 1);
        const perPage = Math.min(Math.max(parseInt(req.query.per_page || '10', 10), 1), 100);
        const offset = (page - 1) * perPage;
        const search = (req.query.search || '').trim();
        const customerId = req.query.customer_id ? parseInt(req.query.customer_id, 10) : null;
        const salesOrderId = req.query.sales_order_id ? parseInt(req.query.sales_order_id, 10) : null;
        const status = req.query.status || '';
        const statusId = req.query.status_id ? parseInt(req.query.status_id, 10) : null;
        const editRequestStatus = req.query.edit_request_status ? parseInt(req.query.edit_request_status, 10) : null;
        const createdBy = req.query.created_by ? parseInt(req.query.created_by, 10) : null;

        let whereClause = 'WHERE 1=1';
        const params = [];

        if (createdBy) {
            whereClause += ' AND ai.user_id = ?';
            params.push(createdBy);
        }
        if (customerId) {
            whereClause += ' AND ai.customer_id = ?';
            params.push(customerId);
        }
        if (salesOrderId) {
            whereClause += ' AND ai.sales_order_id = ?';
            params.push(salesOrderId);
        }
        if (status) {
            whereClause += ' AND s.name = ?';
            params.push(status);
        }
        if (statusId) {
            whereClause += ' AND ai.status_id = ?';
            params.push(statusId);
        }
        if (editRequestStatus) {
            whereClause += ' AND ai.edit_request_status = ?';
            params.push(editRequestStatus);
        }
        if (search) {
            whereClause += ' AND (ai.invoice_number LIKE ? OR v.display_name LIKE ?)';
            const searchPattern = `%${search}%`;
            params.push(searchPattern, searchPattern);
        }

        const [countRows] = await pool.query(`SELECT COUNT(*) as total FROM ar_invoices ai LEFT JOIN vendor v ON v.id = ai.customer_id LEFT JOIN status s ON s.id = ai.status_id ${whereClause}`, params);
        const total = countRows[0].total;

        const [rows] = await pool.query(`
            SELECT ai.*, v.display_name as customer_name, c.name as currency_code,
                (
                    COALESCE((SELECT SUM(ra.allocated_amount) FROM ar_receipt_allocations ra INNER JOIN ar_receipts ar_receipt ON ar_receipt.id = ra.receipt_id WHERE ra.invoice_id = ai.id AND ar_receipt.status = 'POSTED'), 0) +
                    COALESCE((SELECT SUM(CASE WHEN p.currency_id = ai.currency_id THEN pa.amount_bank ELSE pa.amount_base END) FROM tbl_payment_allocation pa INNER JOIN tbl_payment p ON p.id = pa.payment_id WHERE pa.alloc_type = 'invoice' AND pa.reference_id = ai.id AND (p.is_deleted = 0 OR p.is_deleted IS NULL) AND p.status_id = 1 AND p.direction = 'IN'), 0)
                ) as received_amount,
                (ai.total - (
                    COALESCE((SELECT SUM(ra.allocated_amount) FROM ar_receipt_allocations ra INNER JOIN ar_receipts ar_receipt ON ar_receipt.id = ra.receipt_id WHERE ra.invoice_id = ai.id AND ar_receipt.status = 'POSTED'), 0) +
                    COALESCE((SELECT SUM(CASE WHEN p.currency_id = ai.currency_id THEN pa.amount_bank ELSE pa.amount_base END) FROM tbl_payment_allocation pa INNER JOIN tbl_payment p ON p.id = pa.payment_id WHERE pa.alloc_type = 'invoice' AND pa.reference_id = ai.id AND (p.is_deleted = 0 OR p.is_deleted IS NULL) AND p.status_id = 1 AND p.direction = 'IN'), 0)
                )) as outstanding_amount,
                s.name as status_name, s.id as status_id, s.colour as status_colour, s.bg_colour as status_bg_colour,
                u1.name as created_by_name, u2.name as approved_by_name, u3.name as edit_requested_by_name
            FROM ar_invoices ai
            LEFT JOIN vendor v ON v.id = ai.customer_id
            LEFT JOIN currency c ON c.id = ai.currency_id
            LEFT JOIN status s ON s.id = ai.status_id
            LEFT JOIN user u1 ON u1.id = ai.user_id
            LEFT JOIN user u2 ON u2.id = ai.approved_by
            LEFT JOIN user u3 ON u3.id = ai.edit_requested_by
            ${whereClause}
            ORDER BY ai.invoice_date DESC, ai.id DESC
            LIMIT ? OFFSET ?
        `, [...params, perPage, offset]);

        res.json({ data: rows, total, page, perPage });
    } catch (error) {
        next(error);
    }
}

async function getNextInvoiceNumber(req, res, next) {
    try {
        const { tx } = require('../../db/tx.cjs');
        const year = new Date().getFullYear();
        const invoiceNumber = await tx(async (conn) => {
            return await generateARInvoiceNumber(conn, year);
        });
        res.json({ invoice_number: invoiceNumber });
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
            SELECT ai.*, v.display_name as customer_name, 
                   c.name as currency_code,
                   c.label as currency_label,
                   c.subunit_label,
                   vsh.ship_attention, vsh.ship_address_1, vsh.ship_address_2, vsh.ship_city, 
                   vsh.ship_state_id, vsh.ship_zip_code, vsh.ship_country_id, vsh.ship_phone, vsh.ship_fax,
                   ship_state.name as ship_state_name, ship_country.name as ship_country_name,
                   s.name as status_name, s.id as status_id, s.colour as status_colour, s.bg_colour as status_bg_colour,
                   u.name as created_by_name
            FROM ar_invoices ai
            LEFT JOIN vendor v ON v.id = ai.customer_id
            LEFT JOIN currency c ON c.id = ai.currency_id
            LEFT JOIN vendor_shipping_addresses vsh ON vsh.id = ai.delivery_address_id
            LEFT JOIN state ship_state ON ship_state.id = vsh.ship_state_id
            LEFT JOIN country ship_country ON ship_country.id = vsh.ship_country_id
            LEFT JOIN status s ON s.id = ai.status_id
            LEFT JOIN user u ON u.id = ai.user_id
            WHERE ${whereField} = ?
        `, [id]);

        if (invoices.length === 0) {
            return res.status(404).json({ error: 'Invoice not found' });
        }

        const invoice = invoices[0];
        const [lines] = await pool.query(`
            SELECT 
                ail.*, 
                um.name as uom_name,
                p.item_type,
                p.item_id,
                t.tax_name,
                (SELECT pi.file_path 
                 FROM product_images pi 
                 WHERE pi.product_id = ail.product_id 
                 ORDER BY pi.is_primary DESC, pi.id ASC 
                 LIMIT 1) as product_image
            FROM ar_invoice_lines ail
            LEFT JOIN uom_master um ON um.id = ail.uom_id
            LEFT JOIN products p ON p.id = ail.product_id
            LEFT JOIN taxes t ON t.id = ail.tax_id
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

        // Fetch attachments
        const [attachments] = await pool.query(`
            SELECT id, file_name, file_path, mime_type, size_bytes, created_at
            FROM ar_invoices_attachments
            WHERE invoice_id = ?
            ORDER BY created_at ASC
        `, [invoice.id]);

        // Fetch history
        const [history] = await pool.query(`
            SELECT h.*, u.name as user_name
            FROM history h
            LEFT JOIN user u ON u.id = h.user_id
            WHERE h.module = 'ar_invoice' AND h.module_id = ?
            ORDER BY h.created_at DESC
        `, [invoice.id]);

        // --- Document Template (signature & stamp) ---
        // document_id = 2 for Customer Invoice
        let documentTemplate = null;
        try {
            const invoiceCompanyId = invoice.company_id;
            const [tplRows] = await pool.query(`
                SELECT
                    id,
                    document_id,
                    company_ids,
                    sign_path      AS signature_path,
                    stamp_path     AS stamp_path,
                    template_attachment_path
                FROM document_templates
                WHERE document_id = 2
                    AND (
                        FIND_IN_SET(?, company_ids) > 0
                        OR company_ids IS NULL
                        OR company_ids = ''
                    )
                ORDER BY
                    CASE WHEN FIND_IN_SET(?, company_ids) > 0 THEN 0 ELSE 1 END,
                    id ASC
                LIMIT 1
            `, [invoiceCompanyId, invoiceCompanyId]);

            documentTemplate = tplRows?.[0] || null;
        } catch (e) {
            console.error("document_templates fetch error:", e);
            documentTemplate = null;
        }

        invoice.lines = lines;
        invoice.attachments = attachments || [];
        invoice.history = history || [];
        invoice.documentTemplate = documentTemplate;
        if (invoice.proforma_invoice_id) {
            const [proformaRows] = await pool.query(`SELECT proforma_invoice_no FROM proforma_invoice WHERE id = ?`, [invoice.proforma_invoice_id]);
            invoice.proforma_invoice_no = proformaRows[0]?.proforma_invoice_no || null;
        }
        res.json(invoice);
    } catch (error) {
        next(error);
    }
}

async function getInvoiceTransactions(req, res, next) {
    try {
        const { id } = req.params;
        const isNumeric = /^\d+$/.test(id);
        const whereField = isNumeric ? 'ai.id' : 'ai.invoice_uniqid';

        // First, get the invoice to find its ID
        const [invoices] = await pool.query(`
            SELECT ai.id FROM ar_invoices ai WHERE ${whereField} = ?
        `, [id]);

        if (invoices.length === 0) {
            return res.status(404).json({ error: 'Invoice not found' });
        }

        const invoiceId = invoices[0].id;

        // Fetch GL journal entries for this invoice (only non-deleted journals)
        const [journalEntries] = await pool.query(`
            SELECT 
                gj.id as journal_id,
                gj.journal_number,
                gj.journal_date,
                gj.memo,
                gj.currency_id,
                gj.exchange_rate,
                gj.foreign_amount,
                gj.total_amount,
                gj.source_name,
                gj.source_date,
                gjl.id as line_id,
                gjl.account_id,
                gjl.debit,
                gjl.credit,
                gjl.description as line_description,
                gjl.buyer_id,
                gjl.product_id,
                aca.name as account_name,
                aca.id as account_id
            FROM gl_journals gj
            INNER JOIN gl_journal_lines gjl ON gjl.journal_id = gj.id
            LEFT JOIN acc_chart_accounts aca ON aca.id = gjl.account_id
            WHERE gj.source_type = 'AR_INVOICE' AND gj.source_id = ?
            AND (gj.is_deleted = 0 OR gj.is_deleted IS NULL)
            ORDER BY gj.journal_date DESC, gj.id DESC, gjl.id ASC
        `, [invoiceId]);

        res.json({ transactions: journalEntries || [] });
    } catch (error) {
        next(error);
    }
}

async function createInvoice(req, res, next) {
    await tx(async (conn) => {
        try {
            const userId = req.session?.user?.id;
            if (!userId) return res.status(401).json({ error: 'Unauthorized' });

            // Parse body - handle both JSON and FormData
            let bodyData = req.body;
            if (req.body && req.body.payload) {
                try {
                    bodyData = typeof req.body.payload === 'string' ? JSON.parse(req.body.payload) : req.body.payload;
                } catch (e) {
                    bodyData = req.body;
                }
            }

            const {
                invoice_number, invoice_date, invoice_time, due_date, payment_terms_id,
                customer_id, company_id, warehouse_id, currency_id, subtotal,
                discount_type, discount_amount, tax_total, total, notes,
                proforma_invoice_id, sales_order_id, sales_order_number,
                customer_address, delivery_address, delivery_address_id,
                allow_stock_override, lines = [], deleted_attachment_ids
            } = bodyData;


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
                (invoice_uniqid, invoice_number, invoice_date, invoice_time, due_date, payment_terms_id, customer_id, customer_address, delivery_address, delivery_address_id, company_id, warehouse_id, currency_id, subtotal, discount_type, discount_amount, tax_total, total, notes, proforma_invoice_id, sales_order_id, sales_order_number, allow_stock_override, user_id, status_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 3)
            `, [
                invoiceUniqid, finalInvoiceNumber, invoice_date, invoice_time || null,
                due_date || null, payment_terms_id || null, customer_id,
                customer_address || null, delivery_address || null, delivery_address_id || null,
                company_id || null, warehouse_id, currency_id, subtotal,
                discount_type || 'fixed', discount_amount || 0, tax_total, total,
                notes, proforma_invoice_id || null, sales_order_id || null, sales_order_number || null,
                allow_stock_override ? 1 : 0, userId
            ]);

            const invoiceId = invoiceResult.insertId;

            const productIds = [...new Set(lines.map(l => Number(l.product_id)).filter(Boolean))];
            let productTypeMap = new Map();
            if (productIds.length > 0) {
                const [prodRows] = await conn.query(
                    `SELECT id, item_type, item_id FROM products WHERE id IN (?)`,
                    [productIds]
                );
                productTypeMap = new Map(prodRows.map(r => [Number(r.id), r]));
            }

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const [lineResult] = await conn.query(`
                    INSERT INTO ar_invoice_lines 
                    (invoice_id, line_no, product_id, item_name, description, quantity, uom_id, rate, tax_id, tax_rate, line_total)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [invoiceId, i + 1, line.product_id, line.item_name, line.description, line.quantity, line.uom_id, line.rate, line.tax_id, line.tax_rate, line.line_total]);

                const lineId = lineResult.insertId;

                const pinfo = line.product_id ? productTypeMap.get(Number(line.product_id)) : null;
                const isServiceLine = (String(pinfo?.item_type || '').toLowerCase() === 'service') || Number(pinfo?.item_id) === 1;

                if (!isServiceLine && line.batches && Array.isArray(line.batches)) {
                    for (const batch of line.batches) {
                        await conn.query(`
                            INSERT INTO ar_invoice_line_batches 
                            (invoice_line_id, batch_id, quantity, unit_cost)
                            VALUES (?, ?, ?, ?)
                        `, [lineId, batch.batch_id, batch.quantity, batch.unit_cost]);
                    }
                }
            }

            // Handle attachments
            if (req.files && req.files.length > 0) {
                const path = require('path');
                const relPath = (f) => {
                    if (!f || !f.path) return null;
                    const basename = path.basename(f.path);
                    return `uploads/ar_invoices/${basename}`;
                };

                const attachmentValues = req.files.map(f => [
                    invoiceId,
                    f.originalname,
                    relPath(f),
                    f.mimetype || null,
                    f.size || null,
                    new Date()
                ]);

                await conn.query(`
                    INSERT INTO ar_invoices_attachments 
                    (invoice_id, file_name, file_path, mime_type, size_bytes, created_at)
                    VALUES ?
                `, [attachmentValues]);
            }

            // Add history entry for invoice creation
            await addHistory(conn, {
                module: 'ar_invoice',
                moduleId: invoiceId,
                userId: userId,
                action: 'CREATED',
                details: {
                    invoice_number: finalInvoiceNumber,
                    customer_id: customer_id,
                    company_id: company_id,
                    warehouse_id: warehouse_id,
                    total: total,
                    line_count: lines.length,
                    proforma_invoice_id: proforma_invoice_id || null,
                    sales_order_id: sales_order_id || null,
                    sales_order_number: sales_order_number || null
                }
            });

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
            // Allow editing if:
            // - DRAFT (3)
            // - SUBMITTED FOR APPROVAL (8)
            // - REJECTED (2)
            // - APPROVED (1) with approved edit request (edit_request_status = 1)
            const canEdit = invoice.status_id === 3 ||
                invoice.status_id === 8 ||
                invoice.status_id === 2 ||
                (invoice.status_id === 1 && invoice.edit_request_status === 1);

            if (!canEdit) {
                return res.status(400).json({ error: 'Only DRAFT, SUBMITTED FOR APPROVAL, REJECTED invoices, or APPROVED invoices with approved edit requests can be updated' });
            }

            // Parse body - handle both JSON and FormData
            let bodyData = req.body;
            if (req.body && req.body.payload) {
                try {
                    bodyData = typeof req.body.payload === 'string' ? JSON.parse(req.body.payload) : req.body.payload;
                } catch (e) {
                    bodyData = req.body;
                }
            }

            const {
                invoice_number, invoice_date, invoice_time, due_date, payment_terms_id,
                customer_id, company_id, warehouse_id, currency_id, subtotal,
                discount_type, discount_amount, tax_total, total, notes,
                proforma_invoice_id, sales_order_id, sales_order_number,
                customer_address, delivery_address, delivery_address_id,
                allow_stock_override, lines = [], deleted_attachment_ids
            } = bodyData;


            // Get old values for comparison (fetch names for IDs) - BEFORE updating
            const [oldCustomer] = await conn.query(`SELECT display_name FROM vendor WHERE id = ?`, [invoice.customer_id]);
            const [oldWarehouse] = await conn.query(`SELECT warehouse_name FROM warehouses WHERE id = ?`, [invoice.warehouse_id]);
            const [oldCurrency] = await conn.query(`SELECT name FROM currency WHERE id = ?`, [invoice.currency_id]);
            const [oldCompany] = invoice.company_id ? await conn.query(`SELECT name FROM company_settings WHERE id = ?`, [invoice.company_id]) : [[]];
            const [oldPaymentTerms] = invoice.payment_terms_id ? await conn.query(`SELECT terms FROM payment_terms WHERE id = ?`, [invoice.payment_terms_id]) : [[]];
            const [oldProforma] = invoice.proforma_invoice_id ? await conn.query(`SELECT proforma_invoice_no FROM proforma_invoice WHERE id = ?`, [invoice.proforma_invoice_id]) : [[]];

            const [oldDeliveryAddress] = invoice.delivery_address_id ? await conn.query(`
                SELECT CONCAT_WS(', ', ship_address_1, ship_address_2, ship_city, ship_zip_code) as address
                FROM vendor_shipping_addresses WHERE id = ?
            `, [invoice.delivery_address_id]) : [[]];

            const oldValues = {
                invoice_number: invoice.invoice_number || '',
                invoice_date: invoice.invoice_date ? String(invoice.invoice_date).split('T')[0] : '',
                invoice_time: invoice.invoice_time || '',
                due_date: invoice.due_date ? String(invoice.due_date).split('T')[0] : '',
                customer_id: oldCustomer[0]?.display_name || String(invoice.customer_id || ''),
                company_id: oldCompany[0]?.name || (invoice.company_id ? String(invoice.company_id) : ''),
                warehouse_id: oldWarehouse[0]?.warehouse_name || String(invoice.warehouse_id || ''),
                currency_id: oldCurrency[0]?.name || String(invoice.currency_id || ''),
                payment_terms_id: oldPaymentTerms[0]?.terms || (invoice.payment_terms_id ? String(invoice.payment_terms_id) : ''),
                subtotal: invoice.subtotal || 0,
                tax_total: invoice.tax_total || 0,
                total: invoice.total || 0,
                notes: invoice.notes || '',
                proforma_invoice_id: oldProforma[0]?.proforma_invoice_no || (invoice.proforma_invoice_id ? String(invoice.proforma_invoice_id) : ''),
                customer_address: invoice.customer_address || '',
                delivery_address: invoice.delivery_address || '',
                delivery_address_id: oldDeliveryAddress[0]?.address || (invoice.delivery_address_id ? String(invoice.delivery_address_id) : '')
            };

            // Get new values (fetch names for IDs)
            const [newCustomer] = customer_id ? await conn.query(`SELECT display_name FROM vendor WHERE id = ?`, [customer_id]) : [[]];
            const [newWarehouse] = warehouse_id ? await conn.query(`SELECT warehouse_name FROM warehouses WHERE id = ?`, [warehouse_id]) : [[]];
            const [newCurrency] = currency_id ? await conn.query(`SELECT name FROM currency WHERE id = ?`, [currency_id]) : [[]];
            const [newCompany] = company_id ? await conn.query(`SELECT name FROM company_settings WHERE id = ?`, [company_id]) : [[]];
            const [newPaymentTerms] = payment_terms_id ? await conn.query(`SELECT terms FROM payment_terms WHERE id = ?`, [payment_terms_id]) : [[]];
            const [newProforma] = proforma_invoice_id ? await conn.query(`SELECT proforma_invoice_no FROM proforma_invoice WHERE id = ?`, [proforma_invoice_id]) : [[]];
            const [newDeliveryAddress] = delivery_address_id ? await conn.query(`
                SELECT CONCAT_WS(', ', ship_address_1, ship_address_2, ship_city, ship_zip_code) as address
                FROM vendor_shipping_addresses WHERE id = ?
            `, [delivery_address_id]) : [[]];
            const [newSalesOrder] = sales_order_id ? await conn.query(`SELECT order_no AS sales_order_no FROM sales_orders WHERE id = ?`, [sales_order_id]) : [[]];

            const newValues = {
                invoice_number: invoice_number || '',
                invoice_date: invoice_date ? String(invoice_date).split('T')[0] : '',
                invoice_time: invoice_time || '',
                due_date: due_date ? String(due_date).split('T')[0] : '',
                customer_id: newCustomer[0]?.display_name || (customer_id ? String(customer_id) : ''),
                company_id: newCompany[0]?.name || (company_id ? String(company_id) : ''),
                warehouse_id: newWarehouse[0]?.warehouse_name || (warehouse_id ? String(warehouse_id) : ''),
                currency_id: newCurrency[0]?.name || (currency_id ? String(currency_id) : ''),
                payment_terms_id: newPaymentTerms[0]?.terms || (payment_terms_id ? String(payment_terms_id) : ''),
                subtotal: subtotal || 0,
                tax_total: tax_total || 0,
                total: total || 0,
                notes: notes || '',
                proforma_invoice_id: newProforma[0]?.proforma_invoice_no || (proforma_invoice_id ? String(proforma_invoice_id) : ''),
                sales_order_id: newSalesOrder[0]?.sales_order_no || (sales_order_id ? String(sales_order_id) : ''),
                customer_address: customer_address || '',
                delivery_address: delivery_address || '',
                delivery_address_id: newDeliveryAddress[0]?.address || (delivery_address_id ? String(delivery_address_id) : '')
            };

            // Track changes BEFORE updating
            const changes = getChangedFields(oldValues, newValues);

            // If invoice was in "Submitted for Approval" (status_id = 8), "REJECTED" (status_id = 2), or "APPROVED with edit request" (status_id = 1 with edit_request_status = 1), change it back to DRAFT (status_id = 3)
            const oldStatusId = invoice.status_id;
            const shouldRevertToDraft = oldStatusId === 8 || oldStatusId === 2 || (oldStatusId === 1 && invoice.edit_request_status === 1);
            const newStatusId = shouldRevertToDraft ? 3 : invoice.status_id;

            // Clear edit_request_status when invoice is edited after edit request approval
            const clearEditRequestStatus = oldStatusId === 1 && invoice.edit_request_status === 1;

            await conn.query(`
                UPDATE ar_invoices 
                SET invoice_number = ?, invoice_date = ?, invoice_time = ?, due_date = ?, payment_terms_id = ?, customer_id = ?, customer_address = ?, delivery_address = ?, delivery_address_id = ?, company_id = ?, warehouse_id = ?, currency_id = ?, subtotal = ?, discount_type = ?, discount_amount = ?, tax_total = ?, total = ?, notes = ?, proforma_invoice_id = ?, sales_order_id = ?, sales_order_number = ?, allow_stock_override = ?, status_id = ?, edit_request_status = ?
                WHERE id = ?
            `, [
                invoice_number, invoice_date, invoice_time || null, due_date || null,
                payment_terms_id || null, customer_id, customer_address || null,
                delivery_address || null, delivery_address_id || null, company_id || null,
                warehouse_id, currency_id, subtotal, discount_type || 'fixed',
                discount_amount || 0, tax_total, total, notes,
                proforma_invoice_id || null, sales_order_id || null, sales_order_number || null,
                allow_stock_override ? 1 : 0, newStatusId,
                clearEditRequestStatus ? null : invoice.edit_request_status, invoice.id
            ]);

            // If status was changed from "Submitted for Approval" (8), "REJECTED" (2), or "APPROVED with edit request" (1) to "Draft" (3), add history record
            if (shouldRevertToDraft && newStatusId === 3) {
                const [oldStatus] = await conn.query('SELECT name FROM status WHERE id = ?', [oldStatusId]);
                const [newStatus] = await conn.query('SELECT name FROM status WHERE id = ?', [3]);

                let reason = 'Invoice edited';
                if (oldStatusId === 1 && invoice.edit_request_status === 1) {
                    reason = 'Edit request approved - Invoice edited';
                }

                await conn.query(`
                    INSERT INTO history (module, module_id, user_id, action, details, created_at)
                    VALUES (?, ?, ?, ?, ?, NOW())
                `, [
                    'ar_invoice',
                    invoice.id,
                    userId,
                    'STATUS_CHANGED',
                    JSON.stringify({
                        from_status_id: oldStatusId,
                        from_status_name: oldStatus[0]?.name || 'N/A',
                        to_status_id: 3,
                        to_status_name: newStatus[0]?.name || 'Draft',
                        reason: reason
                    })
                ]);
            }

            await conn.query(`DELETE FROM ar_invoice_line_batches WHERE invoice_line_id IN (SELECT id FROM ar_invoice_lines WHERE invoice_id = ?)`, [invoice.id]);
            await conn.query(`DELETE FROM ar_invoice_lines WHERE invoice_id = ?`, [invoice.id]);

            const productIds = [...new Set(lines.map(l => Number(l.product_id)).filter(Boolean))];
            let productTypeMap = new Map();
            if (productIds.length > 0) {
                const [prodRows] = await conn.query(
                    `SELECT id, item_type, item_id FROM products WHERE id IN (?)`,
                    [productIds]
                );
                productTypeMap = new Map(prodRows.map(r => [Number(r.id), r]));
            }

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const [lineResult] = await conn.query(`
                    INSERT INTO ar_invoice_lines 
                    (invoice_id, line_no, product_id, item_name, description, quantity, uom_id, rate, tax_id, tax_rate, line_total)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [invoice.id, i + 1, line.product_id, line.item_name, line.description, line.quantity, line.uom_id, line.rate, line.tax_id, line.tax_rate, line.line_total]);

                const lineId = lineResult.insertId;

                const pinfo = line.product_id ? productTypeMap.get(Number(line.product_id)) : null;
                const isServiceLine = (String(pinfo?.item_type || '').toLowerCase() === 'service') || Number(pinfo?.item_id) === 1;

                if (!isServiceLine && line.batches && Array.isArray(line.batches)) {
                    for (const batch of line.batches) {
                        await conn.query(`
                            INSERT INTO ar_invoice_line_batches 
                            (invoice_line_id, batch_id, quantity, unit_cost)
                            VALUES (?, ?, ?, ?)
                        `, [lineId, batch.batch_id, batch.quantity, batch.unit_cost]);
                    }
                }
            }

            // Handle deleted attachments
            if (deleted_attachment_ids) {
                let deletedIds = [];
                try {
                    deletedIds = Array.isArray(deleted_attachment_ids) ? deleted_attachment_ids : JSON.parse(deleted_attachment_ids);
                } catch (e) {
                    deletedIds = [];
                }

                if (deletedIds.length > 0) {
                    const fs = require('fs');
                    const path = require('path');
                    const [filesToDelete] = await conn.query(
                        `SELECT id, file_path FROM ar_invoices_attachments WHERE id IN (?) AND invoice_id = ?`,
                        [deletedIds, invoice.id]
                    );

                    for (const file of filesToDelete) {
                        if (file.file_path) {
                            const fullPath = path.join(__dirname, '../../..', file.file_path);
                            await fs.promises.unlink(fullPath).catch(e => console.warn(`Failed to delete file: ${fullPath}`, e));
                        }
                    }

                    await conn.query(`DELETE FROM ar_invoices_attachments WHERE id IN (?) AND invoice_id = ?`, [deletedIds, invoice.id]);
                }
            }

            // Handle new attachments
            if (req.files && req.files.length > 0) {
                const path = require('path');
                const relPath = (f) => {
                    if (!f || !f.path) return null;
                    const basename = path.basename(f.path);
                    return `uploads/ar_invoices/${basename}`;
                };

                const attachmentValues = req.files.map(f => [
                    invoice.id,
                    f.originalname,
                    relPath(f),
                    f.mimetype || null,
                    f.size || null,
                    new Date()
                ]);

                await conn.query(`
                    INSERT INTO ar_invoices_attachments 
                    (invoice_id, file_name, file_path, mime_type, size_bytes, created_at)
                    VALUES ?
                `, [attachmentValues]);
            }

            // Add history entry for invoice update only if there are actual changes
            if (changes.length > 0) {
                await addHistory(conn, {
                    module: 'ar_invoice',
                    moduleId: invoice.id,
                    userId: userId,
                    action: 'UPDATED',
                    details: {
                        changes: changes,
                        line_count: lines.length
                    }
                });
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
        const excludeInvoiceId = req.query.exclude_invoice_id; // Invoice ID to exclude from stock calculation

        if (!productId) {
            return res.status(400).json({ error: 'product_id is required' });
        }

        const { pool } = require('../../db/tx.cjs');

        // Get quantities allocated to the current invoice (if editing) to add back to available stock
        // UNIVERSAL FORMULA: Available Stock = Stock on Hand + Inventory Transaction Quantities (for this invoice)
        // This calculation works for ALL statuses (Draft, Submitted, Approved, Rejected, etc.)
        // If an invoice has inventory_transactions (regardless of current status),
        // those quantities were already reduced from stock, so we add them back
        let invoiceBatchQuantities = {};
        if (excludeInvoiceId) {
            const isNumeric = /^\d+$/.test(excludeInvoiceId);
            const whereField = isNumeric ? 'id' : 'invoice_uniqid';
            const [invoices] = await pool.query(`SELECT id, status_id FROM ar_invoices WHERE ${whereField} = ?`, [excludeInvoiceId]);

            if (invoices.length > 0) {
                const invoiceId = invoices[0].id;
                const invoiceStatusId = invoices[0].status_id;

                // Use the universal helper function to get inventory transaction quantities
                invoiceBatchQuantities = await getInvoiceInventoryTransactionQuantities(
                    pool,
                    invoiceId,
                    productId ? parseInt(productId, 10) : null,
                    warehouseId ? parseInt(warehouseId, 10) : null
                );

                const txnCount = Object.keys(invoiceBatchQuantities).length;
                console.log(`[Stock Calculation] Invoice ${invoiceId} (status_id=${invoiceStatusId}): Found ${txnCount} batch quantity entries for product ${productId}, warehouse ${warehouseId}`);
            }
        }

        // If warehouse_id is provided, get batches for that warehouse only
        // Otherwise, get batches for all warehouses
        if (warehouseId) {
            const batches = await inventoryService.getAvailableBatches(parseInt(productId, 10), parseInt(warehouseId, 10));
            // Add warehouse info to each batch and add back excluded invoice quantities
            const [warehouses] = await pool.query('SELECT id, warehouse_name FROM warehouses WHERE id = ?', [warehouseId]);
            const warehouseName = warehouses[0]?.warehouse_name || `Warehouse ${warehouseId}`;

            // Apply UNIVERSAL FORMULA: Available Stock = Stock on Hand + Inventory Transaction Quantities (for this invoice)
            // This works for ALL statuses - if transactions exist, add them back to stock on hand
            const batchesWithWarehouse = await Promise.all((batches || []).map(async (b) => {
                // Match key format: productId_batchId_warehouseId
                const key = `${productId}_${b.batch_id}_${warehouseId}`;
                const inventoryTransactionQty = invoiceBatchQuantities[key] || 0;

                // Calculate available stock using universal formula
                const availableStock = calculateAvailableStock(b.qty_on_hand, inventoryTransactionQty);

                if (inventoryTransactionQty > 0) {
                    console.log(`[Stock Calculation] Batch ${b.batch_id}: stock_on_hand=${b.qty_on_hand}, inventory_txn_qty=${inventoryTransactionQty}, available_stock=${availableStock}`);
                }

                return {
                    ...b,
                    warehouse_id: parseInt(warehouseId, 10),
                    warehouse_name: warehouseName,
                    qty_on_hand: availableStock
                };
            }));

            res.json(batchesWithWarehouse);
        } else {
            // Get stock for all warehouses
            const [warehouses] = await pool.query('SELECT id, warehouse_name FROM warehouses WHERE is_inactive = 0');
            const allBatches = [];

            for (const wh of warehouses) {
                try {
                    const batches = await inventoryService.getAvailableBatches(parseInt(productId, 10), wh.id);
                    // Add warehouse info to each batch and add back excluded invoice quantities
                    if (batches && Array.isArray(batches)) {
                        // Apply UNIVERSAL FORMULA: Available Stock = Stock on Hand + Inventory Transaction Quantities (for this invoice)
                        const batchesWithWarehouse = await Promise.all(batches.map(async (b) => {
                            // Match key format: productId_batchId_warehouseId
                            const key = `${productId}_${b.batch_id}_${wh.id}`;
                            const inventoryTransactionQty = invoiceBatchQuantities[key] || 0;

                            // Calculate available stock using universal formula
                            const availableStock = calculateAvailableStock(b.qty_on_hand, inventoryTransactionQty);

                            return {
                                ...b,
                                warehouse_id: wh.id,
                                warehouse_name: wh.warehouse_name,
                                qty_on_hand: availableStock
                            };
                        }));
                        allBatches.push(...batchesWithWarehouse);
                    }
                } catch (err) {
                    console.warn(`Failed to get batches for warehouse ${wh.id}:`, err);
                }
            }

            res.json(allBatches);
        }
    } catch (error) {
        next(error);
    }
}

async function getInvoiceHistory(req, res, next) {
    try {
        const { id } = req.params;
        const isNumeric = /^\d+$/.test(id);
        const whereField = isNumeric ? 'ai.id' : 'ai.invoice_uniqid';

        const [invoices] = await pool.query(`
            SELECT ai.id
            FROM ar_invoices ai
            WHERE ${whereField} = ?
        `, [id]);

        if (invoices.length === 0) {
            return res.status(404).json({ error: 'Invoice not found' });
        }

        const invoiceId = invoices[0].id;

        const [history] = await pool.query(`
            SELECT h.id, h.action, h.details, h.created_at, u.name as user_name
            FROM history h
            LEFT JOIN user u ON u.id = h.user_id
            WHERE h.module = 'ar_invoice' AND h.module_id = ?
            ORDER BY h.created_at DESC
        `, [invoiceId]);

        res.json((history || []).map((h) => ({
            ...h,
            details: h.details ? JSON.parse(h.details) : {}
        })));
    } catch (error) {
        next(error);
    }
}

async function changeStatus(req, res, next) {
    try {
        const { id } = req.params;
        const rawStatusId = req.body?.status_id;
        const userId = req.user?.id ?? req.session?.user?.id;

        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        if (rawStatusId === undefined || rawStatusId === null || rawStatusId === '') {
            return res.status(400).json({ error: 'status_id is required' });
        }

        const status_id = parseInt(rawStatusId, 10);
        if (Number.isNaN(status_id)) {
            return res.status(400).json({ error: 'status_id must be a number' });
        }

        const isNumeric = /^\d+$/.test(String(id).trim());
        const whereField = isNumeric ? 'id' : 'invoice_uniqid';

        // Get current invoice
        const [invoices] = await pool.query(`SELECT id, status_id FROM ar_invoices WHERE ${whereField} = ?`, [id]);
        if (invoices.length === 0) {
            return res.status(404).json({ error: 'Invoice not found' });
        }

        const invoice = invoices[0];
        const oldStatusId = invoice.status_id;

        // Update status
        await pool.query('UPDATE ar_invoices SET status_id = ? WHERE id = ?', [status_id, invoice.id]);

        // Get status details for history and response
        const [oldStatus] = await pool.query('SELECT name, colour, bg_colour FROM status WHERE id = ?', [oldStatusId]);
        const [newStatus] = await pool.query('SELECT name, colour, bg_colour FROM status WHERE id = ?', [status_id]);

        // Add history record
        await pool.query(`
            INSERT INTO history (module, module_id, user_id, action, details, created_at)
            VALUES (?, ?, ?, ?, ?, NOW())
        `, [
            'ar_invoice',
            invoice.id,
            userId,
            'STATUS_CHANGED',
            JSON.stringify({
                from_status_id: oldStatusId,
                from_status_name: oldStatus[0]?.name || 'N/A',
                to_status_id: status_id,
                to_status_name: newStatus[0]?.name || 'N/A'
            })
        ]);

        res.json({
            status_id: status_id,
            status_name: newStatus[0]?.name || 'N/A',
            status_colour: newStatus[0]?.colour || '#fff',
            status_bg_colour: newStatus[0]?.bg_colour || '#9e9e9e'
        });
    } catch (error) {
        next(error);
    }
}

async function approveInvoice(req, res, next) {
    await tx(async (conn) => {
        try {
            const { id } = req.params;
            const { comment } = req.body;
            const userId = req.session?.user?.id;
            const pdfFile = req.file; // PDF file uploaded from client

            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            // Comment is mandatory for approval
            if (!comment || !comment.trim()) {
                return res.status(400).json({ error: 'Approval comment is required' });
            }

            const isNumeric = /^\d+$/.test(id);
            const whereField = isNumeric ? 'id' : 'invoice_uniqid';

            const [invoices] = await conn.query(`SELECT id, status_id, invoice_uniqid, invoice_number FROM ar_invoices WHERE ${whereField} = ?`, [id]);
            if (invoices.length === 0) {
                return res.status(404).json({ error: 'Invoice not found' });
            }

            const invoice = invoices[0];
            if (invoice.status_id !== 8) {
                return res.status(400).json({ error: 'Only invoices submitted for approval can be approved' });
            }

            // Validate stock availability before approval
            const inventoryEnabled = await isInventoryMovementEnabled();
            // Get all invoice lines with batch allocations
            const [invoiceLines] = await conn.query(`
                SELECT ail.id, ail.product_id, ail.item_name, ail.quantity, ai.warehouse_id, p.item_type, p.item_id
                FROM ar_invoice_lines ail
                JOIN ar_invoices ai ON ai.id = ail.invoice_id
                LEFT JOIN products p ON p.id = ail.product_id
                WHERE ail.invoice_id = ?
                ORDER BY ail.line_no
            `, [invoice.id]);

            const stockErrors = [];

            for (const line of invoiceLines) {
                if (!line.product_id) continue;
                const isServiceLine = String(line.item_type || '').toLowerCase() === 'service' || Number(line.item_id) === 1;
                if (isServiceLine || !inventoryEnabled) {
                    continue;
                }

                // Get batch allocations for this line
                const [batchAllocs] = await conn.query(`
                    SELECT ailb.batch_id, ailb.quantity, ib.batch_no
                    FROM ar_invoice_line_batches ailb
                    JOIN inventory_batches ib ON ib.id = ailb.batch_id
                    WHERE ailb.invoice_line_id = ?
                `, [line.id]);

                if (batchAllocs.length === 0) {
                    stockErrors.push(`Line "${line.item_name}": No batch allocations found`);
                    continue;
                }

                // Get inventory transaction quantities for this invoice using universal helper
                // UNIVERSAL FORMULA: Available Stock = Stock on Hand + Inventory Transaction Quantities (for this invoice)
                const invoiceTxnQuantities = await getInvoiceInventoryTransactionQuantities(
                    conn,
                    invoice.id,
                    line.product_id,
                    line.warehouse_id
                );

                // Check each batch allocation
                for (const alloc of batchAllocs) {
                    const requiredQty = parseFloat(alloc.quantity);

                    // Get current stock on hand
                    const [stockRows] = await conn.query(`
                        SELECT qty_on_hand
                        FROM inventory_stock_batches 
                        WHERE batch_id = ? AND warehouse_id = ? AND product_id = ?
                    `, [alloc.batch_id, line.warehouse_id, line.product_id]);

                    if (stockRows.length === 0) {
                        stockErrors.push(`Line "${line.item_name}", Batch ${alloc.batch_no || alloc.batch_id}: Batch not found in warehouse`);
                        continue;
                    }

                    const stockOnHand = parseFloat(stockRows[0].qty_on_hand || 0);

                    // Calculate available stock using universal formula
                    // Key format: productId_batchId_warehouseId
                    const key = `${line.product_id}_${alloc.batch_id}_${line.warehouse_id}`;
                    const inventoryTransactionQty = invoiceTxnQuantities[key] || 0;
                    const availableStock = calculateAvailableStock(stockOnHand, inventoryTransactionQty);

                    if (availableStock < requiredQty) {
                        stockErrors.push(
                            `Line "${line.item_name}", Batch ${alloc.batch_no || alloc.batch_id}: Insufficient stock. ` +
                            `Required: ${requiredQty.toFixed(2)}, Available: ${availableStock.toFixed(2)} ` +
                            `(Stock on hand: ${stockOnHand.toFixed(2)}${inventoryTransactionQty > 0 ? ` + Inventory transaction qty: ${inventoryTransactionQty.toFixed(2)}` : ''})`
                        );
                    }
                }
            }

            if (stockErrors.length > 0) {
                return res.status(400).json({
                    error: 'Insufficient stock available for approval',
                    details: stockErrors
                });
            }

            // Post the invoice FIRST (create inventory and GL entries)
            await arInvoicesService.postInvoice(conn, invoice.id, userId);

            // Save PDF path if PDF file was uploaded (generated on client-side)
            // Multer automatically saves the file to disk when uploadPdf.single('pdfFile') middleware runs
            // The file is saved to PDF_DIR with the generated filename before this controller is called
            const path = require('path');
            let pdfPath = null;

            if (pdfFile) {
                // Multer has already saved the file to PDF_DIR with the generated filename
                // Construct the relative path for database storage (same pattern as purchase orders)
                pdfPath = path.join('uploads/ar-invoices/pdf', pdfFile.filename).replace(/\\/g, '/');

                // Verify file was actually saved by multer (pdfFile.path contains the full path where multer saved it)
                const fs = require('fs');
                if (pdfFile.path && !fs.existsSync(pdfFile.path)) {
                    console.error(`[PDF Save Error] File not found at multer path: ${pdfFile.path}`);
                    console.error(`[PDF Save Error] pdfFile object:`, {
                        filename: pdfFile.filename,
                        path: pdfFile.path,
                        originalname: pdfFile.originalname,
                        size: pdfFile.size,
                        mimetype: pdfFile.mimetype
                    });
                    throw new Error('PDF file was not saved correctly by multer');
                }

                console.log(`[PDF Save] File saved by multer: ${pdfFile.path}`);
                console.log(`[PDF Save] Filename: ${pdfFile.filename}`);
                console.log(`[PDF Save] Relative path for DB: ${pdfPath}`);
            } else {
                console.warn(`[PDF Save] No PDF file received in request for invoice ${invoice.id}`);
            }

            // Update status to APPROVED (1) AFTER successful posting
            await conn.query(`
                UPDATE ar_invoices 
                SET status_id = 1, posted_at = NOW(), posted_by = ?, approved_by = ?, approval_comment = ?, pdf_path = ?
                WHERE id = ?
            `, [userId, userId, comment.trim(), pdfPath, invoice.id]);

            // Add history entry
            await addHistory(conn, {
                module: 'ar_invoice',
                moduleId: invoice.id,
                userId: userId,
                action: 'APPROVED',
                details: {
                    comment: comment.trim(),
                    pdf_path: pdfPath || null
                }
            });

            res.json({ success: true, message: 'Invoice approved successfully', pdf_path: pdfPath });
        } catch (error) {
            // If something fails, delete the uploaded PDF file to prevent orphans (same as purchase orders)
            if (req.file) {
                const fs = require('fs');
                const path = require('path');
                fs.promises.unlink(req.file.path).catch(err =>
                    console.error('[PDF Cleanup] Failed to delete PDF file on error:', err)
                );
            }
            throw error;
        }
    }).catch(next);
}

async function rejectInvoice(req, res, next) {
    await tx(async (conn) => {
        try {
            const { id } = req.params;
            const { comment } = req.body;
            const userId = req.session?.user?.id;

            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            if (!comment || !comment.trim()) {
                return res.status(400).json({ error: 'Rejection reason is required' });
            }

            const isNumeric = /^\d+$/.test(id);
            const whereField = isNumeric ? 'id' : 'invoice_uniqid';

            const [invoices] = await conn.query(`SELECT id, status_id FROM ar_invoices WHERE ${whereField} = ?`, [id]);
            if (invoices.length === 0) {
                return res.status(404).json({ error: 'Invoice not found' });
            }

            const invoice = invoices[0];
            if (invoice.status_id !== 8) {
                return res.status(400).json({ error: 'Only invoices submitted for approval can be rejected' });
            }

            const [fromStatusRows] = await conn.query(`SELECT name FROM status WHERE id = ? LIMIT 1`, [invoice.status_id]);
            const [toStatusRows] = await conn.query(`SELECT name FROM status WHERE id = ? LIMIT 1`, [2]); // REJECTED status_id = 2

            const fromStatusName = fromStatusRows[0]?.name || 'N/A';
            const toStatusName = toStatusRows[0]?.name || 'N/A';

            // Update status to REJECTED (2)
            await conn.query(`
                UPDATE ar_invoices 
                SET status_id = 2, rejected_by = ?, rejection_comment = ?, rejected_at = NOW()
                WHERE id = ?
            `, [userId, comment.trim(), invoice.id]);

            // Add history entry
            await addHistory(conn, {
                module: 'ar_invoice',
                moduleId: invoice.id,
                userId: userId,
                action: 'STATUS_CHANGED',
                details: {
                    from_status_id: invoice.status_id,
                    from_status_name: fromStatusName,
                    to_status_id: 2,
                    to_status_name: toStatusName,
                    comment: comment.trim()
                }
            });

            res.json({ success: true, message: 'Invoice rejected successfully' });
        } catch (error) {
            throw error;
        }
    }).catch(next);
}

async function requestEdit(req, res, next) {
    await tx(async (conn) => {
        try {
            const { id } = req.params;
            const { reason } = req.body;
            const userId = req.session?.user?.id;

            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            if (!reason || !reason.trim()) {
                return res.status(400).json({ error: 'Reason for edit request is required' });
            }

            const isNumeric = /^\d+$/.test(id);
            const whereField = isNumeric ? 'id' : 'invoice_uniqid';

            const [invoices] = await conn.query(`SELECT id, status_id, edit_request_status FROM ar_invoices WHERE ${whereField} = ?`, [id]);
            if (invoices.length === 0) {
                return res.status(404).json({ error: 'Invoice not found' });
            }

            const invoice = invoices[0];
            if (invoice.status_id !== 1) {
                return res.status(400).json({ error: 'Only approved invoices can have edit requests' });
            }

            if (invoice.edit_request_status === 3) {
                return res.status(400).json({ error: 'An edit request is already pending for this invoice' });
            }

            await conn.query(`
                UPDATE ar_invoices SET 
                    edit_request_status = 3,
                    edit_requested_by = ?,
                    edit_requested_at = NOW(),
                    edit_request_reason = ?,
                    edit_approved_by = NULL,
                    edit_approved_at = NULL,
                    edit_rejection_reason = NULL
                WHERE id = ?
            `, [userId, reason.trim(), invoice.id]);

            await addHistory(conn, {
                module: 'ar_invoice',
                moduleId: invoice.id,
                userId: userId,
                action: 'EDIT_REQUESTED',
                details: { reason: reason.trim() }
            });

            res.json({ success: true, message: 'Edit request submitted successfully' });
        } catch (error) {
            throw error;
        }
    }).catch(next);
}

async function decideEditRequest(req, res, next) {
    await tx(async (conn) => {
        try {
            const { id } = req.params;
            const { decision, reason } = req.body;
            const managerId = req.session?.user?.id;

            if (!managerId) {
                return res.status(401).json({ error: 'Authentication required' });
            }

            if (!['approve', 'reject'].includes(decision)) {
                return res.status(400).json({ error: 'Invalid decision. Must be approve or reject' });
            }

            // Comment is mandatory for both approve and reject
            if (!reason || !reason.trim()) {
                const actionText = decision === 'approve' ? 'approval' : 'rejection';
                return res.status(400).json({ error: `A comment is required for ${actionText}` });
            }

            const isNumeric = /^\d+$/.test(id);
            const whereField = isNumeric ? 'id' : 'invoice_uniqid';

            const [invoices] = await conn.query(`SELECT id, status_id, edit_request_status FROM ar_invoices WHERE ${whereField} = ?`, [id]);
            if (invoices.length === 0) {
                return res.status(404).json({ error: 'Invoice not found' });
            }

            const invoice = invoices[0];
            if (invoice.edit_request_status !== 3) {
                return res.status(400).json({ error: 'No pending edit request found for this invoice' });
            }

            if (decision === 'approve') {
                await conn.query(`
                    UPDATE ar_invoices SET 
                        status_id = 3,
                        edit_request_status = 1,
                        edit_approved_by = ?,
                        edit_approved_at = NOW()
                    WHERE id = ?
                `, [managerId, invoice.id]);

                await addHistory(conn, {
                    module: 'ar_invoice',
                    moduleId: invoice.id,
                    userId: managerId,
                    action: 'EDIT_REQUEST_APPROVED',
                    details: {
                        comment: reason.trim()
                    }
                });
            } else {
                await conn.query(`
                    UPDATE ar_invoices SET 
                        edit_request_status = 2,
                        edit_rejection_reason = ?
                    WHERE id = ?
                `, [reason.trim(), invoice.id]);

                await addHistory(conn, {
                    module: 'ar_invoice',
                    moduleId: invoice.id,
                    userId: managerId,
                    action: 'EDIT_REQUEST_REJECTED',
                    details: { reason: reason.trim() }
                });
            }

            res.json({ success: true, message: `Edit request ${decision}ed successfully` });
        } catch (error) {
            throw error;
        }
    }).catch(next);
}

async function addAttachment(req, res, next) {
    await tx(async (conn) => {
        try {
            const { id } = req.params;
            const userId = req.session?.user?.id;
            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            // Check if id is numeric (invoice ID) or uniqid
            const isNumeric = /^\d+$/.test(id);
            const whereField = isNumeric ? 'id' : 'invoice_uniqid';

            const [invoices] = await conn.query(`
                SELECT id FROM ar_invoices WHERE ${whereField} = ?
            `, [id]);

            if (invoices.length === 0) {
                return res.status(404).json({ error: 'Invoice not found' });
            }

            const invoiceId = invoices[0].id;

            if (!req.files || req.files.length === 0) {
                return res.status(400).json({ error: 'No files were uploaded' });
            }

            // Save attachments
            const path = require('path');
            const relPath = (f) => (f ? `/uploads/ar_invoices/${path.basename(f.path)}` : null);

            const attachmentValues = req.files.map(f => [
                invoiceId,
                f.originalname,
                relPath(f),
                f.mimetype,
                f.size
            ]);

            await conn.query(`
                INSERT INTO ar_invoices_attachments (invoice_id, file_name, file_path, mime_type, size_bytes, created_at)
                VALUES ?
            `, [attachmentValues.map(v => [...v, new Date()])]);

            // Add history entry
            await addHistory(conn, {
                module: 'ar_invoice',
                moduleId: invoiceId,
                userId: userId,
                action: 'ATTACHMENT_ADDED',
                details: {
                    file_count: req.files.length,
                    file_names: req.files.map(f => f.originalname)
                }
            });

            res.json({ success: true, message: 'Attachments uploaded successfully' });
        } catch (error) {
            throw error;
        }
    }).catch(next);
}

async function deleteAttachment(req, res, next) {
    try {
        const { id, attachmentId } = req.params;
        const isNumeric = /^\d+$/.test(id);
        const whereField = isNumeric ? 'id' : 'invoice_uniqid';

        const [invoices] = await pool.query(`
            SELECT id FROM ar_invoices WHERE ${whereField} = ?
        `, [id]);

        if (invoices.length === 0) {
            return res.status(404).json({ error: 'Invoice not found' });
        }

        const invoiceId = invoices[0].id;

        // Check if attachment exists and belongs to this invoice
        const [attachments] = await pool.query(`
            SELECT * FROM ar_invoices_attachments WHERE id = ? AND invoice_id = ?
        `, [attachmentId, invoiceId]);

        if (attachments.length === 0) {
            return res.status(404).json({ error: 'Attachment not found' });
        }

        const attachment = attachments[0];

        // Delete file from filesystem
        if (attachment.file_path) {
            const fs = require('fs');
            const path = require('path');
            const filePath = path.resolve(attachment.file_path.startsWith('/') ? attachment.file_path.slice(1) : attachment.file_path);
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            } catch (err) {
                console.error('Error deleting file:', err);
            }
        }

        // Delete from database
        await pool.query(`
            DELETE FROM ar_invoices_attachments WHERE id = ?
        `, [attachmentId]);

        res.json({ success: true });
    } catch (error) {
        next(error);
    }
}

async function getInvoiceStockDetails(req, res, next) {
    try {
        const { id } = req.params;
        const isNumeric = /^\d+$/.test(id);
        const whereField = isNumeric ? 'id' : 'invoice_uniqid';

        const [invoices] = await pool.query(`
            SELECT id, warehouse_id FROM ar_invoices WHERE ${whereField} = ?
        `, [id]);

        if (invoices.length === 0) {
            return res.status(404).json({ error: 'Invoice not found' });
        }

        const invoice = invoices[0];

        // Get all invoice lines with batch allocations
        const [invoiceLines] = await pool.query(`
            SELECT ail.id, ail.product_id, ail.item_name, ail.quantity, ai.warehouse_id
            FROM ar_invoice_lines ail
            JOIN ar_invoices ai ON ai.id = ail.invoice_id
            WHERE ail.invoice_id = ?
            ORDER BY ail.line_no
        `, [invoice.id]);

        const stockDetails = [];

        for (const line of invoiceLines) {
            if (!line.product_id) continue;

            // Get batch allocations for this line
            const [batchAllocs] = await pool.query(`
                SELECT ailb.batch_id, ailb.quantity, ib.batch_no
                FROM ar_invoice_line_batches ailb
                JOIN inventory_batches ib ON ib.id = ailb.batch_id
                WHERE ailb.invoice_line_id = ?
            `, [line.id]);

            if (batchAllocs.length === 0) {
                stockDetails.push({
                    product_id: line.product_id,
                    item_name: line.item_name,
                    line_quantity: parseFloat(line.quantity || 0),
                    batches: [],
                    has_allocations: false
                });
                continue;
            }

            // Get inventory transaction quantities for this invoice using universal helper
            // UNIVERSAL FORMULA: Available Stock = Stock on Hand + Inventory Transaction Quantities (for this invoice)
            const invoiceTxnQuantities = await getInvoiceInventoryTransactionQuantities(
                pool,
                invoice.id,
                line.product_id,
                line.warehouse_id
            );

            const batchDetails = [];

            // Check each batch allocation
            for (const alloc of batchAllocs) {
                const requiredQty = parseFloat(alloc.quantity);

                // Get current stock on hand
                const [stockRows] = await pool.query(`
                    SELECT qty_on_hand
                    FROM inventory_stock_batches 
                    WHERE batch_id = ? AND warehouse_id = ? AND product_id = ?
                `, [alloc.batch_id, line.warehouse_id, line.product_id]);

                const stockOnHand = stockRows.length > 0 ? parseFloat(stockRows[0].qty_on_hand || 0) : 0;

                // Calculate available stock using universal formula
                // Key format: productId_batchId_warehouseId
                const key = `${line.product_id}_${alloc.batch_id}_${line.warehouse_id}`;
                const inventoryTransactionQty = invoiceTxnQuantities[key] || 0;
                const availableStock = calculateAvailableStock(stockOnHand, inventoryTransactionQty);

                batchDetails.push({
                    batch_id: alloc.batch_id,
                    batch_no: alloc.batch_no,
                    required_quantity: requiredQty,
                    stock_on_hand: stockOnHand,
                    inventory_transaction_quantity: inventoryTransactionQty,
                    available_stock: availableStock,
                    remaining_stock: availableStock - requiredQty,
                    is_sufficient: availableStock >= requiredQty
                });
            }

            stockDetails.push({
                product_id: line.product_id,
                item_name: line.item_name,
                line_quantity: parseFloat(line.quantity || 0),
                batches: batchDetails,
                has_allocations: batchAllocs.length > 0
            });
        }

        res.json({ success: true, stock_details: stockDetails });
    } catch (error) {
        next(error);
    }
}

async function getSalesOrderPayments(req, res, next) {
    try {
        const { id } = req.params;
        const soId = parseInt(id, 10);
        if (!soId) {
            return res.json({ success: true, data: [] });
        }

        const payments = [];

        // 1) Allocations from tbl_payment (inward payments)
        try {
            const [rows] = await pool.query(`
                SELECT 
                    pa.id,
                    pa.amount_bank,
                    pa.amount_base,
                    p.id as payment_id,
                    p.payment_uniqid,
                    p.payment_number,
                    p.transaction_date,
                    p.payment_type,
                    p.status_id,
                    p.currency_id as payment_currency_id,
                    COALESCE(p.currency_code, c.name) as payment_currency_code,
                    s.name as payment_status_name,
                    COALESCE(pt.name, p.payment_type) as payment_type_name,
                    ai.invoice_number,
                    ai.id as invoice_id
                FROM tbl_payment_allocation pa
                INNER JOIN tbl_payment p ON p.id = pa.payment_id
                INNER JOIN ar_invoices ai ON ai.id = pa.reference_id
                LEFT JOIN status s ON s.id = p.status_id
                LEFT JOIN payment_type pt ON pt.id = p.payment_type_id
                LEFT JOIN currency c ON c.id = p.currency_id
                WHERE ai.sales_order_id = ?
                  AND pa.alloc_type = 'invoice'
                  AND (p.is_deleted = 0 OR p.is_deleted IS NULL)
                  AND (p.status_id IN (1, 3, 8) OR p.status_id IS NULL)
                  AND (p.direction = 'IN' OR p.direction IS NULL)
                ORDER BY p.transaction_date DESC, p.id DESC
            `, [soId]);
            if (rows && rows.length) payments.push(...rows);
        } catch (err) {
            console.error('getSalesOrderPayments (tbl_payment):', err.message);
        }

        // 2) Allocations from ar_receipts
        try {
            const [rows] = await pool.query(`
                SELECT
                    ara.id,
                    ara.allocated_amount as amount_bank,
                    ara.allocated_amount as amount_base,
                    ar.id as payment_id,
                    ar.receipt_uniqid as payment_uniqid,
                    ar.receipt_number as payment_number,
                    ar.receipt_date as transaction_date,
                    'RECEIPT' as payment_type,
                    1 as status_id,
                    ar.currency_id as payment_currency_id,
                    COALESCE(curr.name, '') as payment_currency_code,
                    'Posted' as payment_status_name,
                    'Receipt' as payment_type_name,
                    ai.invoice_number,
                    ai.id as invoice_id
                FROM ar_receipt_allocations ara
                INNER JOIN ar_receipts ar ON ar.id = ara.receipt_id
                INNER JOIN ar_invoices ai ON ai.id = ara.invoice_id
                LEFT JOIN currency curr ON curr.id = ar.currency_id
                WHERE ai.sales_order_id = ?
                  AND ar.status = 'POSTED'
                ORDER BY ar.receipt_date DESC, ar.id DESC
            `, [soId]);
            if (rows && rows.length) payments.push(...rows);
        } catch (err) {
            console.error('getSalesOrderPayments (ar_receipts):', err.message);
        }

        // Sort combined by transaction_date DESC, payment_id DESC
        payments.sort((a, b) => {
            const dA = a.transaction_date ? new Date(a.transaction_date).getTime() : 0;
            const dB = b.transaction_date ? new Date(b.transaction_date).getTime() : 0;
            if (dB !== dA) return dB - dA;
            return (b.payment_id || 0) - (a.payment_id || 0);
        });

        res.json({ success: true, data: payments });
    } catch (error) {
        console.error('getSalesOrderPayments error:', error.message);
        next(error);
    }
}

async function getSalesOrderAdvanceReceivables(req, res, next) {
    try {
        const { id } = req.params;
        const soId = parseInt(id, 10);
        if (!soId) {
            return res.json({ success: true, data: [] });
        }
        const [rows] = await pool.query(`
            SELECT 
                pa.id,
                pa.amount_bank,
                pa.amount_base,
                p.id as payment_id,
                p.payment_uniqid,
                p.payment_number,
                p.transaction_date,
                p.payment_type,
                p.status_id,
                p.currency_code as payment_currency_code,
                s.name as payment_status_name,
                pt.name as payment_type_name,
                pi.proforma_invoice_no,
                pi.id as proforma_id
            FROM tbl_payment_allocation pa
            INNER JOIN tbl_payment p ON p.id = pa.payment_id
            INNER JOIN proforma_invoice pi ON pi.id = pa.reference_id
            INNER JOIN ar_invoices ai ON ai.proforma_invoice_id = pi.id AND ai.sales_order_id = ?
            LEFT JOIN status s ON s.id = p.status_id
            LEFT JOIN payment_type pt ON pt.id = p.payment_type_id
            WHERE pa.alloc_type = 'advance'
              AND (p.is_deleted = 0 OR p.is_deleted IS NULL)
              AND p.direction = 'IN'
            ORDER BY p.transaction_date DESC, p.id DESC
        `, [soId]);
        res.json({ success: true, data: rows || [] });
    } catch (error) {
        next(error);
    }
}

module.exports = { listInvoices, getNextInvoiceNumber, getInvoice, getInvoiceHistory, getInvoiceTransactions, createInvoice, updateInvoice, autoAllocate, postInvoice, cancelInvoice, getAvailableBatches, changeStatus, approveInvoice, rejectInvoice, requestEdit, decideEditRequest, addAttachment, deleteAttachment, getInvoiceStockDetails, getSalesOrderPayments, getSalesOrderAdvanceReceivables };
