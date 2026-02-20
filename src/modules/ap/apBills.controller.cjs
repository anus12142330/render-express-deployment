// server/src/modules/ap/apBills.controller.js
// AP Bills controller

const { tx } = require('../../db/tx.cjs');
const { pool } = require('../../db/tx.cjs');
const { generateAPBillNumber } = require('../../utils/docNo.cjs');
const apBillsService = require('./apBills.service.cjs');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Helper to add history entries
async function addHistory(conn, { module, moduleId, userId, action, details }) {
    if (!module || !moduleId || !userId || !action) return;
    await conn.query(
        'INSERT INTO history (module, module_id, user_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
        [module, moduleId, userId, action, JSON.stringify(details || {})]
    );
}

// Helper to format value for display
function formatValueForDisplay(value, field) {
    // Handle null, undefined, or empty string
    if (value === null || value === undefined || value === '') {
        return '—';
    }

    // Format numbers with 2 decimal places (handle 0 as valid value)
    if (['subtotal', 'tax_total', 'total'].includes(field)) {
        const num = Number(value);
        if (isNaN(num)) return '—';
        return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    // Format dates
    if (['bill_date', 'due_date'].includes(field) && value) {
        try {
            const date = new Date(value);
            if (isNaN(date.getTime())) return String(value);
            return date.toISOString().split('T')[0]; // YYYY-MM-DD format
        } catch {
            return String(value);
        }
    }

    // For ID fields, value should already be the name from the lookup
    // Just return as string
    return String(value);
}

// Helper to get changed fields between old and new values
function getChangedFields(oldValues, newValues) {
    const changes = [];
    const fields = ['bill_number', 'bill_date', 'due_date', 'supplier_id', 'company_id', 'shipment_id', 'container_no', 'warehouse_id', 'currency_id', 'subtotal', 'tax_total', 'total', 'notes', 'purchase_order_id'];

    fields.forEach(field => {
        const oldVal = oldValues[field];
        const newVal = newValues[field];

        // Normalize values for comparison
        let normalizedOld = oldVal;
        let normalizedNew = newVal;

        // Handle numeric fields - compare as numbers
        if (['subtotal', 'tax_total', 'total'].includes(field)) {
            normalizedOld = oldVal != null ? Number(oldVal) : null;
            normalizedNew = newVal != null ? Number(newVal) : null;

            // Compare numbers with small tolerance for floating point
            if (normalizedOld !== normalizedNew &&
                (normalizedOld == null || normalizedNew == null ||
                    Math.abs((normalizedOld || 0) - (normalizedNew || 0)) > 0.01)) {
                changes.push({
                    field,
                    from: formatValueForDisplay(oldVal, field),
                    to: formatValueForDisplay(newVal, field)
                });
            }
        } else {
            // For non-numeric fields, compare as strings (trimmed)
            const oldStr = String(oldVal || '').trim();
            const newStr = String(newVal || '').trim();

            if (oldStr !== newStr) {
                changes.push({
                    field,
                    from: formatValueForDisplay(oldVal, field),
                    to: formatValueForDisplay(newVal, field)
                });
            }
        }
    });

    return changes;
}

// Multer setup for bill attachments
const BILL_UPLOAD_DIR = path.resolve('uploads/bills');
if (!fs.existsSync(BILL_UPLOAD_DIR)) {
    fs.mkdirSync(BILL_UPLOAD_DIR, { recursive: true });
}

const billStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, BILL_UPLOAD_DIR),
    filename: (_req, file, cb) =>
        cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname)),
});

const billUpload = multer({ storage: billStorage }).array('attachments', 10);

const relPath = (f) => (f ? `/uploads/bills/${path.basename(f.path)}` : null);

async function listBills(req, res, next) {
    try {
        const page = Math.max(parseInt(req.query.page || '1', 10), 1);
        const perPage = Math.min(Math.max(parseInt(req.query.per_page || '10', 10), 1), 100);
        const offset = (page - 1) * perPage;
        const search = (req.query.search || '').trim();
        const supplierId = req.query.supplier_id ? parseInt(req.query.supplier_id, 10) : null;
        const statusId = req.query.status_id ? parseInt(req.query.status_id, 10) : null;
        const editRequestStatus = req.query.edit_request_status ? parseInt(req.query.edit_request_status, 10) : null;
        const isServiceFilter = req.query.is_service !== undefined ? Number(req.query.is_service) : null;

        let whereClause = 'WHERE 1=1';
        const params = [];

        if (supplierId) {
            whereClause += ' AND ab.supplier_id = ?';
            params.push(supplierId);
        }
        if (statusId) {
            whereClause += ' AND ab.status_id = ?';
            params.push(statusId);
        }
        if (editRequestStatus) {
            whereClause += ' AND ab.edit_request_status = ?';
            params.push(editRequestStatus);
        }
        if (Number.isFinite(isServiceFilter)) {
            whereClause += ' AND ab.is_service = ?';
            params.push(isServiceFilter);
        }
        if (search) {
            whereClause += ' AND (ab.bill_number LIKE ? OR v.display_name LIKE ?)';
            const searchPattern = `%${search}%`;
            params.push(searchPattern, searchPattern);
        }

        const [countRows] = await pool.query(`
            SELECT COUNT(*) as total 
            FROM ap_bills ab
            LEFT JOIN vendor v ON v.id = ab.supplier_id
            ${whereClause}
        `, params);
        const total = countRows[0].total;

        const [rows] = await pool.query(`
            SELECT 
                ab.*,
                v.display_name as supplier_name,
                c.name as currency_code,
                c.label as currency_label,
                c.subunit_label as currency_subunit_label,
                s.name as status_name,
                s.bg_colour,
                s.colour,
                u.name as created_by_name,
                ua.name as approved_by_name,
                edit_req_user.name as edit_requested_by_name,
                po.po_number as purchase_order_number,
                po.mode_shipment_id as po_mode_of_shipment_id,
                (SELECT COALESCE(SUM(pa.amount_bank), 0) 
                 FROM tbl_payment_allocation pa 
                 WHERE pa.bill_id = ab.id AND pa.alloc_type = 'bill') as paid_amount,
                (ab.total - COALESCE((SELECT SUM(pa.amount_bank) FROM tbl_payment_allocation pa WHERE pa.bill_id = ab.id AND pa.alloc_type = 'bill'), 0)) as outstanding_amount
            FROM ap_bills ab
            LEFT JOIN vendor v ON v.id = ab.supplier_id
            LEFT JOIN currency c ON c.id = ab.currency_id
            LEFT JOIN status s ON s.id = ab.status_id
            LEFT JOIN user u ON u.id = ab.user_id
            LEFT JOIN user ua ON ua.id = ab.approved_by
            LEFT JOIN user edit_req_user ON edit_req_user.id = ab.edit_requested_by
            LEFT JOIN purchase_orders po ON po.id = ab.purchase_order_id
            ${whereClause}
            ORDER BY ab.bill_date DESC, ab.id DESC
            LIMIT ? OFFSET ?
        `, [...params, perPage, offset]);

        res.json({ data: rows, total, page, perPage });
    } catch (error) {
        next(error);
    }
}

async function getBill(req, res, next) {
    try {
        const { id } = req.params;
        const isNumeric = /^\d+$/.test(id);
        const whereField = isNumeric ? 'ab.id' : 'ab.bill_uniqid';

        const [bills] = await pool.query(`
            SELECT 
                ab.*, 
                v.display_name as supplier_name,
                v.company_name as vendor_company,
                va.bill_address_1 as vendor_address_line1,
                va.bill_address_2 as vendor_address_line2,
                va.bill_city as vendor_city,
                vs.name as vendor_state,
                vc.name as vendor_country,
                va.bill_zip_code as vendor_postal_code,
                va.bill_phone as vendor_phone,
                va.bill_fax as vendor_fax,
                c.name as currency_code,
                c.label as currency_label,
                c.subunit_label as currency_subunit_label,
                st.name as status_name,
                st.bg_colour,
                st.colour,
                edit_req_user.name as edit_requested_by_name,
                po.company_id as po_company_id,
                po.po_number as purchase_order_number,
                s.ship_uniqid as shipment_uniqid,
                s.lot_number as shipment_lot_number,
                s.total_lots as shipment_total_lots,
                s.shipment_stage_id as shipment_stage_id,
                po_ship.po_number as shipment_po_number
            FROM ap_bills ab
            LEFT JOIN vendor v ON v.id = ab.supplier_id
            LEFT JOIN vendor_address va ON va.vendor_id = v.id
            LEFT JOIN state vs ON vs.id = va.bill_state_id
            LEFT JOIN country vc ON vc.id = va.bill_country_id
            LEFT JOIN currency c ON c.id = ab.currency_id
            LEFT JOIN status st ON st.id = ab.status_id
            LEFT JOIN user edit_req_user ON edit_req_user.id = ab.edit_requested_by
            LEFT JOIN purchase_orders po ON po.id = ab.purchase_order_id
            LEFT JOIN shipment s ON s.id = ab.shipment_id
            LEFT JOIN purchase_orders po_ship ON po_ship.id = s.po_id
            WHERE ${whereField} = ?
        `, [id]);

        if (bills.length === 0) {
            return res.status(404).json({ error: 'Bill not found' });
        }

        const bill = bills[0];
        const billId = bill.id;

        const [lines] = await pool.query(`
            SELECT 
                abl.*, 
                um.name as uom_name,
                p.item_type,
                p.item_id,
                p.inventory_account_id,
                p.purchase_account_id,
                COALESCE(
                    (SELECT pi.thumbnail_path FROM product_images pi WHERE pi.product_id = abl.product_id AND pi.is_primary = 1 LIMIT 1),
                    (SELECT pi.thumbnail_path FROM product_images pi WHERE pi.product_id = abl.product_id ORDER BY pi.id ASC LIMIT 1)
                ) as product_image_url
            FROM ap_bill_lines abl
            LEFT JOIN uom_master um ON um.id = abl.uom_id
            LEFT JOIN products p ON p.id = abl.product_id
            WHERE abl.bill_id = ?
            ORDER BY abl.line_no
        `, [billId]);

        for (const line of lines) {
            const [batches] = await pool.query(`
                SELECT 
                    albb.*, 
                    COALESCE(albb.batch_no, ib.batch_no) as batch_no,
                    COALESCE(albb.mfg_date, ib.mfg_date) as mfg_date,
                    COALESCE(albb.exp_date, ib.exp_date) as exp_date
                FROM ap_bill_line_batches albb
                LEFT JOIN inventory_batches ib ON ib.id = albb.batch_id
                WHERE albb.bill_line_id = ?
            `, [line.id]);
            line.batches = batches;
        }

        bill.lines = lines;

        // Fetch history
        const [history] = await pool.query(`
            SELECT h.id, h.action, h.details, h.created_at, u.name as user_name
            FROM history h
            LEFT JOIN user u ON u.id = h.user_id
            WHERE h.module = 'ap_bill' AND h.module_id = ?
            ORDER BY h.created_at DESC
        `, [billId]);

        bill.history = (history || []).map(h => ({
            ...h,
            details: h.details ? (typeof h.details === 'string' ? JSON.parse(h.details) : h.details) : {}
        }));

        // Fetch attachments
        const [attachments] = await pool.query(`
            SELECT *, 'ap' as source
            FROM ap_bill_attachments
            WHERE bill_id = ?
            ORDER BY created_at DESC
        `, [billId]);

        bill.attachments = attachments || [];

        res.json(bill);
    } catch (error) {
        next(error);
    }
}

async function createBill(req, res, next) {
    await tx(async (conn) => {
        try {
            const userId = req.session?.user?.id;
            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            // Handle both JSON and FormData
            let lines = [];
            if (typeof req.body.lines === 'string') {
                // FormData sends lines as JSON string
                try {
                    lines = JSON.parse(req.body.lines);
                } catch (e) {
                    return res.status(400).json({ error: 'Invalid lines data format' });
                }
            } else {
                lines = req.body.lines || [];
            }

            const {
                bill_number,
                bill_date,
                due_date,
                supplier_id,
                company_id,
                shipment_id,
                warehouse_id,
                currency_id,
                subtotal,
                tax_total,
                total,
                notes,
                purchase_order_id,
                container_no,
                is_reverse_tax,
                is_service
            } = req.body;

            // Parse numeric/boolean fields if they come from FormData (strings)
            const parsedSupplierId = typeof supplier_id === 'string' ? parseInt(supplier_id) : supplier_id;
            const parsedCompanyId = typeof company_id === 'string' ? parseInt(company_id) : company_id;
            const parsedShipmentId = typeof shipment_id === 'string' ? parseInt(shipment_id) : shipment_id;
            const parsedWarehouseId = typeof warehouse_id === 'string' ? parseInt(warehouse_id) : warehouse_id;
            const parsedCurrencyId = typeof currency_id === 'string' ? parseInt(currency_id) : currency_id;
            const parsedSubtotal = typeof subtotal === 'string' ? parseFloat(subtotal) : subtotal;
            const parsedTaxTotal = typeof tax_total === 'string' ? parseFloat(tax_total) : tax_total;
            const parsedTotal = typeof total === 'string' ? parseFloat(total) : total;
            const parsedPoId = purchase_order_id ? (typeof purchase_order_id === 'string' ? parseInt(purchase_order_id) : purchase_order_id) : null;
            const parsedIsReverseTax =
                is_reverse_tax === 1 ||
                is_reverse_tax === true ||
                is_reverse_tax === '1' ||
                is_reverse_tax === 'true';
            const parsedIsService =
                is_service === 1 ||
                is_service === true ||
                is_service === '1' ||
                is_service === 'true';

            if (!parsedShipmentId) {
                return res.status(400).json({ error: 'Shipment is required' });
            }

            let finalBillNumber = bill_number;
            if (!finalBillNumber) {
                finalBillNumber = await generateAPBillNumber(conn, new Date(bill_date || new Date()).getFullYear());
            }

            const [existing] = await conn.query(`
                SELECT id FROM ap_bills WHERE bill_number = ?
            `, [finalBillNumber]);

            if (existing.length > 0) {
                return res.status(409).json({ error: 'Bill number already exists' });
            }

            const billUniqid = `apb_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

            const [billResult] = await conn.query(`
                INSERT INTO ap_bills 
                (bill_uniqid, bill_number, bill_date, due_date, supplier_id, purchase_order_id, company_id, shipment_id, container_no, warehouse_id, 
                 currency_id, subtotal, tax_total, total, notes, is_reverse_tax, is_service, user_id, status_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 3)
            `, [billUniqid, finalBillNumber, bill_date, due_date, parsedSupplierId, parsedPoId, parsedCompanyId, parsedShipmentId, container_no, parsedWarehouseId,
                parsedCurrencyId, parsedSubtotal, parsedTaxTotal, parsedTotal, notes, (parsedIsReverseTax ? 1 : 0), (parsedIsService ? 1 : 0), userId]);

            const billId = billResult.insertId;

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
                // Parse numeric fields if they come from FormData (strings)
                const parsedProductId = typeof line.product_id === 'string' ? parseInt(line.product_id) : line.product_id;
                const parsedQuantity = typeof line.quantity === 'string' ? parseFloat(line.quantity) : line.quantity;
                const parsedUomId = typeof line.uom_id === 'string' ? parseInt(line.uom_id) : (line.uom_id || null);
                const parsedRate = typeof line.rate === 'string' ? parseFloat(line.rate) : line.rate;
                const parsedTaxId = typeof line.tax_id === 'string' ? parseInt(line.tax_id) : (line.tax_id || null);
                const parsedTaxRate = typeof line.tax_rate === 'string' ? parseFloat(line.tax_rate) : line.tax_rate;
                const parsedLineTotal = typeof line.line_total === 'string' ? parseFloat(line.line_total) : line.line_total;

                const [lineResult] = await conn.query(`
                    INSERT INTO ap_bill_lines 
                    (bill_id, line_no, product_id, item_name, description, quantity, uom_id, rate, tax_id, tax_rate, line_total)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [billId, i + 1, parsedProductId, line.item_name, line.description,
                    parsedQuantity, parsedUomId, parsedRate, parsedTaxId, parsedTaxRate, parsedLineTotal]);

                const lineId = lineResult.insertId;

                const pinfo = parsedProductId ? productTypeMap.get(Number(parsedProductId)) : null;
                const isServiceLine = (String(pinfo?.item_type || '').toLowerCase() === 'service') || Number(pinfo?.item_id) === 1;

                if (!isServiceLine && line.batches && Array.isArray(line.batches)) {
                    for (const batch of line.batches) {
                        // Parse numeric fields if they come from FormData (strings)
                        const parsedBatchId = typeof batch.batch_id === 'string' ? parseInt(batch.batch_id) : (batch.batch_id || null);
                        const parsedBatchQuantity = typeof batch.quantity === 'string' ? parseFloat(batch.quantity) : batch.quantity;
                        const parsedUnitCost = typeof batch.unit_cost === 'string' ? parseFloat(batch.unit_cost) : batch.unit_cost;
                        const parsedContainerId = typeof batch.container_id === 'string' ? parseInt(batch.container_id) : (batch.container_id || null);

                        await conn.query(`
                            INSERT INTO ap_bill_line_batches 
                            (bill_line_id, batch_id, batch_no, container_id, container_no, quantity, unit_cost, mfg_date, exp_date)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        `, [lineId, parsedBatchId, batch.batch_no || '', parsedContainerId, batch.container_no || null, parsedBatchQuantity, parsedUnitCost, batch.mfg_date || null, batch.exp_date || null]);
                    }
                }
            }

            // Handle attachments if uploaded
            if (req.files && req.files.length > 0) {
                const attachmentValues = req.files.map(f => [
                    billId,
                    f.originalname,
                    relPath(f),
                    f.mimetype,
                    f.size
                ]);
                await conn.query(`
                    INSERT INTO ap_bill_attachments (bill_id, file_name, file_path, mime_type, size_bytes)
                    VALUES ?
                `, [attachmentValues]);
            }

            // Add history entry for bill creation
            await addHistory(conn, {
                module: 'ap_bill',
                moduleId: billId,
                userId: userId,
                action: 'CREATED',
                details: {
                    bill_number: finalBillNumber,
                    supplier_id: parsedSupplierId,
                    warehouse_id: parsedWarehouseId,
                    total: parsedTotal,
                    line_count: lines.length
                }
            });

            const [[newBill]] = await conn.query(`SELECT * FROM ap_bills WHERE id = ?`, [billId]);
            res.status(201).json(newBill);
        } catch (error) {
            throw error;
        }
    }).catch((error) => {
        if (res.headersSent) return next(error);
        const message = error?.sqlMessage || error?.message || 'Internal Server Error';
        res.status(500).json({ error: message });
    });
}

async function updateBill(req, res, next) {
    await tx(async (conn) => {
        try {
            const { id } = req.params;
            const userId = req.session?.user?.id;
            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            const [bills] = await conn.query(`
                SELECT * FROM ap_bills WHERE id = ? OR bill_uniqid = ?
            `, [id, id]);

            if (bills.length === 0) {
                return res.status(404).json({ error: 'Bill not found' });
            }

            const bill = bills[0];
            // Only allow editing of DRAFT (3), REJECTED (2), SUBMITTED_FOR_APPROVAL (8), or bills with approved edit request (1)
            if (bill.status_id !== 3 && bill.status_id !== 2 && bill.status_id !== 8 && bill.edit_request_status !== 1) {
                return res.status(400).json({ error: 'Only DRAFT, REJECTED, SUBMITTED_FOR_APPROVAL bills, or bills with approved edit requests can be updated' });
            }

            // If editing an approved bill (status_id = 1), we need to reverse inventory/GL transactions first
            const isApprovedBill = bill.status_id === 1;
            if (isApprovedBill) {
                // Check if bill has been posted (has inventory transactions or GL journals)
                const [invTxns] = await conn.query(`
                    SELECT COUNT(*) as count FROM inventory_transactions 
                    WHERE source_type = 'AP_BILL' AND source_id = ? AND txn_type = 'PURCHASE_BILL_RECEIPT'
                    AND (is_deleted = 0 OR is_deleted IS NULL)
                `, [bill.id]);

                const [glJournals] = await conn.query(`
                    SELECT COUNT(*) as count FROM gl_journals 
                    WHERE source_type = 'AP_BILL' AND source_id = ?
                `, [bill.id]);

                if (invTxns[0].count > 0 || glJournals[0].count > 0) {
                    // Reverse inventory transactions and GL journals before allowing edit
                    // Use reverseBillTransactions (not cancelBill) to reverse without changing status
                    await apBillsService.reverseBillTransactions(conn, bill.id, userId);

                    // Add history entry for reversal
                    await addHistory(conn, {
                        module: 'ap_bill',
                        moduleId: bill.id,
                        userId: userId,
                        action: 'TRANSACTIONS_REVERSED_FOR_EDIT',
                        details: {
                            reason: 'Transactions reversed to allow editing approved bill'
                        }
                    });
                }
            }

            // Track original status for history
            const originalStatusId = bill.status_id;
            const originalStatusName = bill.status_id === 2 ? 'REJECTED' : (bill.status_id === 3 ? 'DRAFT' : (bill.status_id === 1 ? 'APPROVED' : 'N/A'));

            // Handle both JSON and FormData
            let lines = [];
            if (typeof req.body.lines === 'string') {
                // FormData sends lines as JSON string
                try {
                    lines = JSON.parse(req.body.lines);
                } catch (e) {
                    return res.status(400).json({ error: 'Invalid lines data format' });
                }
            } else {
                lines = req.body.lines || [];
            }

            const {
                bill_number,
                bill_date,
                due_date,
                supplier_id,
                company_id,
                shipment_id,
                warehouse_id,
                currency_id,
                subtotal,
                tax_total,
                total,
                notes,
                purchase_order_id,
                container_no,
                is_reverse_tax,
                is_service
            } = req.body;

            // Parse numeric/boolean fields if they come from FormData (strings)
            const parsedSupplierId = typeof supplier_id === 'string' ? parseInt(supplier_id) : supplier_id;
            const parsedCompanyId = typeof company_id === 'string' ? parseInt(company_id) : company_id;
            const parsedShipmentId = typeof shipment_id === 'string' ? parseInt(shipment_id) : shipment_id;
            const parsedWarehouseId = typeof warehouse_id === 'string' ? parseInt(warehouse_id) : warehouse_id;
            const parsedCurrencyId = typeof currency_id === 'string' ? parseInt(currency_id) : currency_id;
            const parsedSubtotal = typeof subtotal === 'string' ? parseFloat(subtotal) : subtotal;
            const parsedTaxTotal = typeof tax_total === 'string' ? parseFloat(tax_total) : tax_total;
            const parsedTotal = typeof total === 'string' ? parseFloat(total) : total;
            const parsedPoId = purchase_order_id ? (typeof purchase_order_id === 'string' ? parseInt(purchase_order_id) : purchase_order_id) : null;
            const parsedIsReverseTax =
                is_reverse_tax === 1 ||
                is_reverse_tax === true ||
                is_reverse_tax === '1' ||
                is_reverse_tax === 'true';
            const parsedIsService =
                is_service === 1 ||
                is_service === true ||
                is_service === '1' ||
                is_service === 'true';

            if (!parsedShipmentId) {
                return res.status(400).json({ error: 'Shipment is required' });
            }

            // Check if bill_number is being changed and if the new number already exists (excluding current bill)
            if (bill_number && bill_number !== bill.bill_number) {
                const [existing] = await conn.query(`
                    SELECT id FROM ap_bills WHERE bill_number = ? AND id != ?
                `, [bill_number, bill.id]);

                if (existing.length > 0) {
                    return res.status(409).json({ error: 'Bill number already exists' });
                }
            }

            // Get old values for comparison (fetch names for IDs) - BEFORE updating
            const [oldSupplier] = await conn.query(`SELECT display_name FROM vendor WHERE id = ?`, [bill.supplier_id]);
            const [oldWarehouse] = await conn.query(`SELECT warehouse_name FROM warehouses WHERE id = ?`, [bill.warehouse_id]);
            const [oldCurrency] = await conn.query(`SELECT label, name FROM currency WHERE id = ?`, [bill.currency_id]);
            const [oldPO] = bill.purchase_order_id ? await conn.query(`SELECT po_number FROM purchase_orders WHERE id = ?`, [bill.purchase_order_id]) : [[]];

            const oldValues = {
                bill_number: bill.bill_number || '',
                bill_date: bill.bill_date ? String(bill.bill_date).split('T')[0] : '',
                due_date: bill.due_date ? String(bill.due_date).split('T')[0] : '',
                supplier_id: oldSupplier[0]?.display_name || String(bill.supplier_id || ''),
                company_id: bill.company_id ? String(bill.company_id) : '',
                shipment_id: bill.shipment_id ? String(bill.shipment_id) : '',
                warehouse_id: oldWarehouse[0]?.warehouse_name || String(bill.warehouse_id || ''),
                currency_id: oldCurrency[0]?.label || oldCurrency[0]?.name || String(bill.currency_id || ''),
                subtotal: bill.subtotal || 0,
                tax_total: bill.tax_total || 0,
                total: bill.total || 0,
                notes: bill.notes || '',
                purchase_order_id: oldPO[0]?.po_number || (bill.purchase_order_id ? String(bill.purchase_order_id) : ''),
                container_no: bill.container_no || ''
            };

            // Get new values (fetch names for IDs)
            const [newSupplier] = parsedSupplierId ? await conn.query(`SELECT display_name FROM vendor WHERE id = ?`, [parsedSupplierId]) : [[]];
            const [newWarehouse] = parsedWarehouseId ? await conn.query(`SELECT warehouse_name FROM warehouses WHERE id = ?`, [parsedWarehouseId]) : [[]];
            const [newCurrency] = parsedCurrencyId ? await conn.query(`SELECT label, name FROM currency WHERE id = ?`, [parsedCurrencyId]) : [[]];
            const [newPO] = parsedPoId ? await conn.query(`SELECT po_number FROM purchase_orders WHERE id = ?`, [parsedPoId]) : [[]];

            const newValues = {
                bill_number: bill_number || '',
                bill_date: bill_date ? String(bill_date).split('T')[0] : '',
                due_date: due_date ? String(due_date).split('T')[0] : '',
                supplier_id: newSupplier[0]?.display_name || (parsedSupplierId ? String(parsedSupplierId) : ''),
                company_id: parsedCompanyId ? String(parsedCompanyId) : '',
                shipment_id: parsedShipmentId ? String(parsedShipmentId) : '',
                warehouse_id: newWarehouse[0]?.warehouse_name || (parsedWarehouseId ? String(parsedWarehouseId) : ''),
                currency_id: newCurrency[0]?.label || newCurrency[0]?.name || (parsedCurrencyId ? String(parsedCurrencyId) : ''),
                subtotal: parsedSubtotal || 0,
                tax_total: parsedTaxTotal || 0,
                total: parsedTotal || 0,
                notes: notes || '',
                purchase_order_id: newPO[0]?.po_number || (parsedPoId ? String(parsedPoId) : ''),
                container_no: container_no || ''
            };

            // Track changes BEFORE updating
            const changes = getChangedFields(oldValues, newValues);

            // When any editable bill is edited and saved, automatically change to DRAFT (3)
            // This applies to REJECTED (2), DRAFT (3), and APPROVED (1) bills
            // For approved bills, we've already reversed transactions above, so set to DRAFT
            const newStatusId = 3; // Always set to DRAFT when edited
            const statusChanged = originalStatusId !== 3; // Track if status actually changed

            // Clear edit_request_status when bill is edited (request has been fulfilled)
            await conn.query(`
                UPDATE ap_bills 
                SET bill_number = ?, bill_date = ?, due_date = ?, supplier_id = ?, purchase_order_id = ?, company_id = ?, shipment_id = ?, container_no = ?, warehouse_id = ?,
                    currency_id = ?, subtotal = ?, tax_total = ?, total = ?, notes = ?, is_reverse_tax = ?, is_service = ?, status_id = ?,
                    edit_request_status = NULL, edit_approved_by = NULL, edit_approved_at = NULL
                WHERE id = ?
            `, [bill_number, bill_date, due_date, parsedSupplierId, parsedPoId, parsedCompanyId, parsedShipmentId, container_no, parsedWarehouseId,
                parsedCurrencyId, parsedSubtotal, parsedTaxTotal, parsedTotal, notes, (parsedIsReverseTax ? 1 : 0), (parsedIsService ? 1 : 0), newStatusId, bill.id]);

            await conn.query(`DELETE FROM ap_bill_line_batches WHERE bill_line_id IN (SELECT id FROM ap_bill_lines WHERE bill_id = ?)`, [bill.id]);
            await conn.query(`DELETE FROM ap_bill_lines WHERE bill_id = ?`, [bill.id]);

            const productIds = [...new Set(lines.map(l => Number(l.product_id)).filter(Boolean))];
            let productTypeMap = new Map();
            if (productIds.length > 0) {
                const [prodRows] = await conn.query(
                    `SELECT id, item_type, item_id FROM products WHERE id IN (?)`,
                    [productIds]
                );
                productTypeMap = new Map(prodRows.map(r => [Number(r.id), r]));
            }

            // Handle new attachments if uploaded
            if (req.files && req.files.length > 0) {
                const attachmentValues = req.files.map(f => [
                    bill.id,
                    f.originalname,
                    relPath(f),
                    f.mimetype,
                    f.size
                ]);
                await conn.query(`
                    INSERT INTO ap_bill_attachments (bill_id, file_name, file_path, mime_type, size_bytes)
                    VALUES ?
                `, [attachmentValues]);
            }

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                // Parse numeric fields if they come from FormData (strings)
                const parsedProductId = typeof line.product_id === 'string' ? parseInt(line.product_id) : line.product_id;
                const parsedQuantity = typeof line.quantity === 'string' ? parseFloat(line.quantity) : line.quantity;
                const parsedUomId = typeof line.uom_id === 'string' ? parseInt(line.uom_id) : (line.uom_id || null);
                const parsedRate = typeof line.rate === 'string' ? parseFloat(line.rate) : line.rate;
                const parsedTaxId = typeof line.tax_id === 'string' ? parseInt(line.tax_id) : (line.tax_id || null);
                const parsedTaxRate = typeof line.tax_rate === 'string' ? parseFloat(line.tax_rate) : line.tax_rate;
                const parsedLineTotal = typeof line.line_total === 'string' ? parseFloat(line.line_total) : line.line_total;

                const [lineResult] = await conn.query(`
                    INSERT INTO ap_bill_lines 
                    (bill_id, line_no, product_id, item_name, description, quantity, uom_id, rate, tax_id, tax_rate, line_total)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [bill.id, i + 1, parsedProductId, line.item_name, line.description,
                    parsedQuantity, parsedUomId, parsedRate, parsedTaxId, parsedTaxRate, parsedLineTotal]);

                const lineId = lineResult.insertId;

                const pinfo = parsedProductId ? productTypeMap.get(Number(parsedProductId)) : null;
                const isServiceLine = (String(pinfo?.item_type || '').toLowerCase() === 'service') || Number(pinfo?.item_id) === 1;

                if (!isServiceLine && line.batches && Array.isArray(line.batches)) {
                    for (const batch of line.batches) {
                        // Parse numeric fields if they come from FormData (strings)
                        const parsedBatchId = typeof batch.batch_id === 'string' ? parseInt(batch.batch_id) : (batch.batch_id || null);
                        const parsedBatchQuantity = typeof batch.quantity === 'string' ? parseFloat(batch.quantity) : batch.quantity;
                        const parsedUnitCost = typeof batch.unit_cost === 'string' ? parseFloat(batch.unit_cost) : batch.unit_cost;

                        const parsedContainerId = typeof batch.container_id === 'string' ? parseInt(batch.container_id) : (batch.container_id || null);

                        await conn.query(`
                            INSERT INTO ap_bill_line_batches 
                            (bill_line_id, batch_id, batch_no, container_id, container_no, quantity, unit_cost, mfg_date, exp_date)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        `, [lineId, parsedBatchId, batch.batch_no || '', parsedContainerId, batch.container_no || null, parsedBatchQuantity, parsedUnitCost, batch.mfg_date || null, batch.exp_date || null]);
                    }
                }
            }

            // Add history entry for status change if bill status changed to DRAFT
            if (statusChanged) {
                const [fromStatusRows] = await conn.query(`SELECT name FROM status WHERE id = ? LIMIT 1`, [originalStatusId]);
                const [toStatusRows] = await conn.query(`SELECT name FROM status WHERE id = ? LIMIT 1`, [3]); // DRAFT

                const fromStatusName = fromStatusRows[0]?.name || 'N/A';
                const toStatusName = toStatusRows[0]?.name || 'N/A';

                await addHistory(conn, {
                    module: 'ap_bill',
                    moduleId: bill.id,
                    userId: userId,
                    action: 'STATUS_CHANGED',
                    details: {
                        from_status_id: originalStatusId,
                        to_status_id: 3,
                        from_status_name: fromStatusName,
                        to_status_name: toStatusName,
                        comment: 'Bill edited and saved, status changed to DRAFT'
                    }
                });
            }

            // Add history entry for bill update only if there are actual changes
            if (changes.length > 0) {
                await addHistory(conn, {
                    module: 'ap_bill',
                    moduleId: bill.id,
                    userId: userId,
                    action: 'UPDATED',
                    details: {
                        changes: changes,
                        line_count: lines.length
                    }
                });
            }
            // Don't record history if nothing actually changed

            const [[updatedBill]] = await conn.query(`SELECT * FROM ap_bills WHERE id = ?`, [bill.id]);
            res.json(updatedBill);
        } catch (error) {
            throw error;
        }
    }).catch((error) => {
        if (res.headersSent) return next(error);
        const message = error?.sqlMessage || error?.message || 'Internal Server Error';
        res.status(500).json({ error: message });
    });
}

async function postBill(req, res, next) {
    await tx(async (conn) => {
        try {
            const { id } = req.params;
            const userId = req.session?.user?.id;
            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            const [bills] = await conn.query(`
                SELECT id FROM ap_bills WHERE id = ? OR bill_uniqid = ?
            `, [id, id]);

            if (bills.length === 0) {
                return res.status(404).json({ error: 'Bill not found' });
            }

            await apBillsService.postBill(conn, bills[0].id, userId);
            res.json({ success: true, message: 'Bill posted successfully' });
        } catch (error) {
            throw error;
        }
    }).catch(next);
}

async function cancelBill(req, res, next) {
    await tx(async (conn) => {
        try {
            const { id } = req.params;
            const userId = req.session?.user?.id;
            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            const [bills] = await conn.query(`
                SELECT id FROM ap_bills WHERE id = ? OR bill_uniqid = ?
            `, [id, id]);

            if (bills.length === 0) {
                return res.status(404).json({ error: 'Bill not found' });
            }

            await apBillsService.cancelBill(conn, bills[0].id, userId);
            res.json({ success: true, message: 'Bill cancelled successfully' });
        } catch (error) {
            throw error;
        }
    }).catch(next);
}

async function getSourcePOs(req, res, next) {
    try {
        const { vendor_id } = req.query;
        if (!vendor_id) {
            return res.json([]);
        }

        // Get POs that are in states: Issued (4), Approved (5), Confirmed (7), Partially Received (8)
        // Also include Draft (3) and Submitted for Approval (8) if needed
        const [pos] = await pool.query(`
            SELECT po.id, po.po_number, po.po_uniqid, v.display_name as vendor_name
            FROM purchase_orders po
            JOIN vendor v ON v.id = po.vendor_id
            WHERE po.vendor_id = ? AND po.status_id IN (3, 4, 5, 7, 8)
            ORDER BY po.po_date DESC
        `, [vendor_id]);

        res.json(pos || []);
    } catch (error) {
        console.error('Error in getSourcePOs:', error);
        next(error);
    }
}

async function addAttachment(req, res, next) {
    await tx(async (conn) => {
        try {
            const { id } = req.params;
            const userId = req.session?.user?.id;
            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            // Check if id is numeric (bill ID) or uniqid
            const isNumeric = /^\d+$/.test(id);
            const whereField = isNumeric ? 'id' : 'bill_uniqid';

            const [bills] = await conn.query(`
                SELECT id FROM ap_bills WHERE ${whereField} = ?
            `, [id]);

            if (bills.length === 0) {
                return res.status(404).json({ error: 'Bill not found' });
            }

            const billId = bills[0].id;

            if (!req.files || req.files.length === 0) {
                return res.status(400).json({ error: 'No files were uploaded' });
            }

            // Save attachments
            const attachmentValues = req.files.map(f => [
                billId,
                f.originalname,
                relPath(f),
                f.mimetype,
                f.size
            ]);

            await conn.query(`
                INSERT INTO ap_bill_attachments (bill_id, file_name, file_path, mime_type, size_bytes)
                VALUES ?
            `, [attachmentValues]);

            // Add history entry
            await addHistory(conn, {
                module: 'ap_bill',
                moduleId: billId,
                userId: userId,
                action: 'ATTACHMENT_ADDED',
                details: {
                    file_count: req.files.length,
                    file_names: req.files.map(f => f.originalname)
                }
            });

            res.json({ success: true, message: 'Attachments added successfully' });
        } catch (error) {
            throw error;
        }
    }).catch(next);
}

async function deleteAttachment(req, res, next) {
    try {
        const { id, attachmentId } = req.params;
        const isNumeric = /^\d+$/.test(id);
        const whereField = isNumeric ? 'id' : 'bill_uniqid';

        const [bills] = await pool.query(`
            SELECT id FROM ap_bills WHERE ${whereField} = ?
        `, [id]);

        if (bills.length === 0) {
            return res.status(404).json({ error: 'Bill not found' });
        }

        const billId = bills[0].id;

        // Check if attachment exists and belongs to this bill
        const [attachments] = await pool.query(`
            SELECT * FROM ap_bill_attachments WHERE id = ? AND bill_id = ?
        `, [attachmentId, billId]);

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
            DELETE FROM ap_bill_attachments WHERE id = ?
        `, [attachmentId]);

        res.json({ success: true });
    } catch (error) {
        next(error);
    }
}

async function updateStatus(req, res, next) {
    await tx(async (conn) => {
        try {
            const { id } = req.params;
            const { status_id } = req.body;
            const userId = req.session?.user?.id;

            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            if (!status_id) {
                return res.status(400).json({ error: 'status_id is required' });
            }

            // Check if id is numeric (bill ID) or uniqid
            const isNumeric = /^\d+$/.test(id);
            const whereField = isNumeric ? 'id' : 'bill_uniqid';

            const [bills] = await conn.query(`
                SELECT id, status_id FROM ap_bills WHERE ${whereField} = ?
            `, [id]);

            if (bills.length === 0) {
                return res.status(404).json({ error: 'Bill not found' });
            }

            const bill = bills[0];
            const newStatusId = parseInt(status_id);

            // Allow status changes:
            // 1. From DRAFT (3) to SUBMITTED_FOR_APPROVAL (8)
            // 2. From REJECTED (2) to DRAFT (3) or SUBMITTED_FOR_APPROVAL (8)
            if (bill.status_id === 3) {
                // DRAFT can only go to SUBMITTED_FOR_APPROVAL (8)
                if (newStatusId !== 8) {
                    return res.status(400).json({ error: 'DRAFT bills can only be changed to SUBMITTED_FOR_APPROVAL (8)' });
                }
            } else if (bill.status_id === 2) {
                // REJECTED can go to DRAFT (3) or SUBMITTED_FOR_APPROVAL (8)
                if (newStatusId !== 3 && newStatusId !== 8) {
                    return res.status(400).json({ error: 'REJECTED bills can only be changed to DRAFT (3) or SUBMITTED_FOR_APPROVAL (8)' });
                }
            } else {
                return res.status(400).json({ error: 'Status change not allowed from current status' });
            }

            // Fetch status names from status table
            const [fromStatusRows] = await conn.query(`SELECT name FROM status WHERE id = ? LIMIT 1`, [bill.status_id]);
            const [toStatusRows] = await conn.query(`SELECT name FROM status WHERE id = ? LIMIT 1`, [status_id]);

            const fromStatusName = fromStatusRows[0]?.name || 'N/A';
            const toStatusName = toStatusRows[0]?.name || 'N/A';

            // Update status
            await conn.query(`
                UPDATE ap_bills SET status_id = ? WHERE id = ?
            `, [status_id, bill.id]);

            // Add history entry
            await addHistory(conn, {
                module: 'ap_bill',
                moduleId: bill.id,
                userId: userId,
                action: 'STATUS_CHANGED',
                details: {
                    from_status_id: bill.status_id,
                    to_status_id: parseInt(status_id),
                    from_status_name: fromStatusName,
                    to_status_name: toStatusName,
                    comment: req.body.comment || null
                }
            });

            res.json({
                success: true,
                message: 'Status updated successfully',
                status_id: parseInt(status_id),
                status_name: toStatusName
            });
        } catch (error) {
            throw error;
        }
    }).catch(next);
}

async function approveBill(req, res, next) {
    await tx(async (conn) => {
        try {
            const { id } = req.params;
            const { comment } = req.body;
            const userId = req.session?.user?.id;

            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            // Check if id is numeric (bill ID) or uniqid
            const isNumeric = /^\d+$/.test(id);
            const whereField = isNumeric ? 'id' : 'bill_uniqid';

            const [bills] = await conn.query(`
                SELECT id, status_id FROM ap_bills WHERE ${whereField} = ?
            `, [id]);

            if (bills.length === 0) {
                return res.status(404).json({ error: 'Bill not found' });
            }

            const bill = bills[0];

            // Only allow approval of bills in SUBMITTED_FOR_APPROVAL status (8)
            if (bill.status_id !== 8) {
                return res.status(400).json({ error: 'Only bills submitted for approval can be approved' });
            }

            // Post the bill FIRST (create inventory and GL entries) - this validates and creates entries
            // This must happen BEFORE updating status to prevent duplicate postings
            await apBillsService.postBill(conn, bill.id, userId);

            // Update status to APPROVED (1) AFTER successful posting
            await conn.query(`
                UPDATE ap_bills 
                SET status_id = 1, posted_at = NOW(), posted_by = ?, approved_by = ?, approval_comment = ?
                WHERE id = ?
            `, [userId, userId, comment || 'No comment provided.', bill.id]);

            // Add history entry
            await addHistory(conn, {
                module: 'ap_bill',
                moduleId: bill.id,
                userId: userId,
                action: 'APPROVED',
                details: {
                    comment: comment || 'No comment provided.'
                }
            });

            res.json({ success: true, message: 'Bill approved successfully' });
        } catch (error) {
            throw error;
        }
    }).catch(next);
}

async function rejectBill(req, res, next) {
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

            // Check if id is numeric (bill ID) or uniqid
            const isNumeric = /^\d+$/.test(id);
            const whereField = isNumeric ? 'id' : 'bill_uniqid';

            const [bills] = await conn.query(`
                SELECT id, status_id FROM ap_bills WHERE ${whereField} = ?
            `, [id]);

            if (bills.length === 0) {
                return res.status(404).json({ error: 'Bill not found' });
            }

            const bill = bills[0];

            // Only allow rejection of bills in SUBMITTED_FOR_APPROVAL status (8)
            if (bill.status_id !== 8) {
                return res.status(400).json({ error: 'Only bills submitted for approval can be rejected' });
            }

            // Fetch status names from status table
            const [fromStatusRows] = await conn.query(`SELECT name FROM status WHERE id = ? LIMIT 1`, [bill.status_id]);
            const [toStatusRows] = await conn.query(`SELECT name FROM status WHERE id = ? LIMIT 1`, [2]); // REJECTED status_id = 2

            const fromStatusName = fromStatusRows[0]?.name || 'N/A';
            const toStatusName = toStatusRows[0]?.name || 'N/A';

            // Update status to REJECTED (2)
            await conn.query(`
                UPDATE ap_bills 
                SET status_id = 2, rejected_at = NOW(), rejected_by = ?, rejection_comment = ?
                WHERE id = ?
            `, [userId, comment.trim(), bill.id]);

            // Add history entry
            await addHistory(conn, {
                module: 'ap_bill',
                moduleId: bill.id,
                userId: userId,
                action: 'REJECTED',
                details: {
                    from_status_id: bill.status_id,
                    to_status_id: 2,
                    from_status_name: fromStatusName,
                    to_status_name: toStatusName,
                    comment: comment.trim()
                }
            });

            res.json({ success: true, message: 'Bill rejected successfully' });
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
                return res.status(401).json({ error: 'Authentication required' });
            }

            if (!reason || !reason.trim()) {
                return res.status(400).json({ error: 'A reason for the edit request is required' });
            }

            // Check if id is numeric (bill ID) or uniqid
            const isNumeric = /^\d+$/.test(id);
            const whereField = isNumeric ? 'id' : 'bill_uniqid';

            const [bills] = await conn.query(`
                SELECT id, status_id, edit_request_status FROM ap_bills WHERE ${whereField} = ?
            `, [id]);

            if (bills.length === 0) {
                return res.status(404).json({ error: 'Bill not found' });
            }

            const bill = bills[0];

            // Only allow edit requests for APPROVED bills (status_id = 1)
            if (bill.status_id !== 1) {
                return res.status(400).json({ error: 'Only approved bills can have edit requests' });
            }

            // Prevent new requests if one is already pending (3)
            if (bill.edit_request_status === 3) {
                return res.status(400).json({ error: 'An edit request is already pending for this bill' });
            }

            await conn.query(`
                UPDATE ap_bills SET 
                    edit_request_status = 3,
                    edit_requested_by = ?,
                    edit_requested_at = NOW(),
                    edit_request_reason = ?,
                    edit_approved_by = NULL,
                    edit_approved_at = NULL,
                    edit_rejection_reason = NULL
                WHERE id = ?
            `, [userId, reason.trim(), bill.id]);

            await addHistory(conn, {
                module: 'ap_bill',
                moduleId: bill.id,
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
            const { decision, reason } = req.body; // decision: 'approve' or 'reject'
            const managerId = req.session?.user?.id;

            if (!managerId) {
                return res.status(401).json({ error: 'Authentication required' });
            }

            if (!['approve', 'reject', 'confirm'].includes(decision)) {
                return res.status(400).json({ error: 'Invalid decision. Must be approve or reject' });
            }

            if (decision === 'reject' && (!reason || !reason.trim())) {
                return res.status(400).json({ error: 'A reason is required for rejection' });
            }

            // Check if id is numeric (bill ID) or uniqid
            const isNumeric = /^\d+$/.test(id);
            const whereField = isNumeric ? 'id' : 'bill_uniqid';

            const [bills] = await conn.query(`
                SELECT id, status_id, edit_request_status FROM ap_bills WHERE ${whereField} = ?
            `, [id]);

            if (bills.length === 0) {
                return res.status(404).json({ error: 'Bill not found' });
            }

            const bill = bills[0];

            if (bill.edit_request_status !== 3) {
                return res.status(400).json({ error: 'No pending edit request found for this bill' });
            }

            if (decision === 'approve' || decision === 'confirm') {
                // Revert status to DRAFT (3) to allow editing and set edit status to 'approved' (1)
                await conn.query(`
                    UPDATE ap_bills SET 
                        status_id = 3,
                        edit_request_status = 1,
                        edit_approved_by = ?,
                        edit_approved_at = NOW()
                    WHERE id = ?
                `, [managerId, bill.id]);

                await addHistory(conn, {
                    module: 'ap_bill',
                    moduleId: bill.id,
                    userId: managerId,
                    action: 'EDIT_REQUEST_APPROVED',
                    details: {}
                });
            } else { // Reject
                await conn.query(`
                    UPDATE ap_bills SET 
                        edit_request_status = 2,
                        edit_rejection_reason = ?
                    WHERE id = ?
                `, [reason.trim(), bill.id]);

                await addHistory(conn, {
                    module: 'ap_bill',
                    moduleId: bill.id,
                    userId: managerId,
                    action: 'EDIT_REQUEST_REJECTED',
                    details: { reason: reason.trim() }
                });
            }

            res.json({ success: true, message: `Edit request has been ${decision}d` });
        } catch (error) {
            throw error;
        }
    }).catch(next);
}

/**
 * Get GL Journal Entries for a Purchase Bill
 */
async function getBillJournalEntries(req, res, next) {
    try {
        const { id } = req.params;
        const isNumeric = /^\d+$/.test(id);

        // First get the bill to get its numeric ID
        const whereField = isNumeric ? 'ab.id' : 'ab.bill_uniqid';
        const [bills] = await pool.query(`
            SELECT ab.id FROM ap_bills ab WHERE ${whereField} = ?
        `, [id]);

        if (bills.length === 0) {
            return res.status(404).json({ error: 'Bill not found' });
        }

        const billId = bills[0].id;

        // Get GL journal entries for this bill
        const [journalLines] = await pool.query(`
            SELECT 
                gjl.id,
                gjl.journal_id,
                gjl.account_id,
                gjl.debit,
                gjl.credit,
                gjl.description,
                gjl.line_no,
                gj.journal_date,
                gj.journal_number,
                gj.memo,
                acc.name as account_name,
                acc.id as account_code
            FROM gl_journal_lines gjl
            INNER JOIN gl_journals gj ON gj.id = gjl.journal_id
            LEFT JOIN acc_chart_accounts acc ON acc.id = gjl.account_id
            WHERE gj.source_type = 'AP_BILL' 
            AND gj.source_id = ?
            AND (gj.is_deleted = 0 OR gj.is_deleted IS NULL)
            ORDER BY gj.journal_date DESC, gj.id DESC, gjl.line_no ASC
        `, [billId]);

        res.json({ data: journalLines || [] });
    } catch (error) {
        next(error);
    }
}

async function getBillPaymentAllocations(req, res, next) {
    try {
        const { id } = req.params;
        const isNumeric = /^\d+$/.test(id);
        const whereField = isNumeric ? 'ab.id' : 'ab.bill_uniqid';

        // Get bill info
        const [[bill]] = await pool.query(`
            SELECT ab.id, ab.bill_uniqid, ab.bill_number, ab.total, ab.currency_id, ab.bill_date,
                   c.name as currency_code, v.display_name as supplier_name
            FROM ap_bills ab
            LEFT JOIN currency c ON c.id = ab.currency_id
            LEFT JOIN vendor v ON v.id = ab.supplier_id
            WHERE ${whereField} = ?
        `, [id]);

        if (!bill) {
            return res.status(404).json({ error: 'Bill not found' });
        }

        // Get payment allocations for this bill
        const [allocations] = await pool.query(`
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
                p.currency_code as payment_currency_code,
                s.name as payment_status_name,
                pt.name as payment_type_name
            FROM tbl_payment_allocation pa
            INNER JOIN tbl_payment p ON p.id = pa.payment_id
            LEFT JOIN status s ON s.id = p.status_id
            LEFT JOIN payment_type pt ON pt.id = p.payment_type_id
            WHERE pa.bill_id = ?
              AND pa.alloc_type = 'bill'
              AND (p.is_deleted = 0 OR p.is_deleted IS NULL)
            ORDER BY p.transaction_date DESC, p.id DESC
        `, [bill.id]);

        // Calculate totals
        const totalAmount = parseFloat(bill.total || 0);
        const totalAdjusted = allocations.reduce((sum, alloc) => {
            // Use amount_bank if payment currency matches bill currency, otherwise amount_base
            const billCurrencyId = bill.currency_id;
            const paymentCurrencyId = alloc.payment_currency_id;
            const amount = (billCurrencyId && paymentCurrencyId && billCurrencyId === paymentCurrencyId)
                ? parseFloat(alloc.amount_bank || 0)
                : parseFloat(alloc.amount_base || 0);
            return sum + amount;
        }, 0);
        const outstanding = totalAmount - totalAdjusted;

        res.json({
            bill: {
                id: bill.id,
                bill_uniqid: bill.bill_uniqid,
                bill_number: bill.bill_number,
                bill_date: bill.bill_date,
                total: totalAmount,
                currency_id: bill.currency_id,
                currency_code: bill.currency_code,
                supplier_name: bill.supplier_name
            },
            allocations: allocations || [],
            summary: {
                total_amount: totalAmount,
                total_adjusted: totalAdjusted,
                outstanding: outstanding,
                currency_code: bill.currency_code
            }
        });
    } catch (e) {
        console.error('Error fetching payment allocations:', e);
        next(e);
    }
}

module.exports = {
    listBills,
    getBill,
    getSourcePOs,
    createBill,
    updateBill,
    postBill,
    cancelBill,
    updateStatus,
    approveBill,
    rejectBill,
    requestEdit,
    decideEditRequest,
    addAttachment,
    deleteAttachment,
    getBillJournalEntries,
    getBillPaymentAllocations,
    billUpload // Export multer middleware for routes
};

