// server/src/modules/ar/ar.routes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const arInvoicesController = require('./arInvoices.controller.cjs');
const arReceiptsController = require('./arReceipts.controller.cjs');

// Setup multer for AR invoice attachments
const UPLOAD_DIR = path.join(__dirname, '../../..', 'uploads', 'ar_invoices');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname || '');
        const base = path.basename(file.originalname || 'file', ext).replace(/[^a-z0-9_\-\.]/gi, '_');
        cb(null, `${Date.now()}_${crypto.randomBytes(8).toString('hex')}_${base}${ext}`);
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024, files: 20 }
});

// Setup multer for AR invoice PDF files (same pattern as purchase orders)
const PDF_DIR = path.resolve('uploads/ar-invoices/pdf');
fs.mkdirSync(PDF_DIR, { recursive: true });

const pdfStorage = multer.diskStorage({
    destination: (_req, _file, cb) => {
        // Ensure directory exists
        fs.mkdirSync(PDF_DIR, { recursive: true });
        cb(null, PDF_DIR);
    },
    filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname || '');
        cb(null, `invoice_${crypto.randomBytes(12).toString('hex')}${ext}`);
    },
});

const uploadPdf = multer({ 
    storage: pdfStorage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

router.get('/invoices', arInvoicesController.listInvoices);
router.get('/invoices/next-number', arInvoicesController.getNextInvoiceNumber);
router.get('/invoices/available-batches', arInvoicesController.getAvailableBatches);
router.get('/invoices/:id', arInvoicesController.getInvoice);
router.get('/invoices/:id/history', arInvoicesController.getInvoiceHistory);
router.get('/invoices/:id/transactions', arInvoicesController.getInvoiceTransactions);
router.post('/invoices', upload.array('attachments', 20), arInvoicesController.createInvoice);
router.put('/invoices/:id', upload.array('attachments', 20), arInvoicesController.updateInvoice);
router.post('/invoices/:id/auto-allocate', arInvoicesController.autoAllocate);
router.post('/invoices/:id/post', arInvoicesController.postInvoice);
router.post('/invoices/:id/cancel', arInvoicesController.cancelInvoice);
router.put('/invoices/:id/status', arInvoicesController.changeStatus);
router.post('/invoices/:id/approve', uploadPdf.single('pdfFile'), arInvoicesController.approveInvoice);
router.post('/invoices/:id/reject', arInvoicesController.rejectInvoice);
router.post('/invoices/:id/request-edit', arInvoicesController.requestEdit);
router.post('/invoices/:id/decide-edit-request', arInvoicesController.decideEditRequest);
router.get('/invoices/:id/stock-details', arInvoicesController.getInvoiceStockDetails);
router.post('/invoices/:id/attachments', upload.array('attachments', 20), arInvoicesController.addAttachment);
router.delete('/invoices/:id/attachments/:attachmentId', arInvoicesController.deleteAttachment);

router.get('/receipts', arReceiptsController.listReceipts);
router.get('/receipts/:id', arReceiptsController.getReceipt);
router.post('/receipts', arReceiptsController.createReceipt);
router.put('/receipts/:id', arReceiptsController.updateReceipt);
router.post('/receipts/:id/post', arReceiptsController.postReceipt);
router.post('/receipts/:id/cancel', arReceiptsController.cancelReceipt);

router.get('/customers/:customerId/open-invoices', arReceiptsController.getOpenInvoices);

// Get proforma invoices for selection
router.get('/proforma-invoices', async (req, res, next) => {
    try {
        const { pool } = require('../../db/tx.cjs');
        const search = (req.query.search || '').trim();
        const customerId = req.query.customer_id ? parseInt(req.query.customer_id, 10) : null;
        const statusId = req.query.status_id ? parseInt(req.query.status_id, 10) : null;
        
        let whereClause = 'WHERE 1=1';
        const params = [];
        
        if (customerId) {
            whereClause += ' AND pi.buyer_id = ?';
            params.push(customerId);
        }
        if (statusId) {
            whereClause += ' AND pi.status_id = ?';
            params.push(statusId);
        }
        if (search) {
            whereClause += ' AND (pi.proforma_invoice_no LIKE ? OR c.display_name LIKE ?)';
            const searchPattern = `%${search}%`;
            params.push(searchPattern, searchPattern);
        }
        
        const [rows] = await pool.query(`
            SELECT pi.id, pi.uniqid, pi.proforma_invoice_no, pi.date_issue, 
                   pi.grand_total, c.display_name as customer_name,
                   curr.id as currency_id, curr.name as currency_code, 
                   pi.currency_sale, s.name as status_name, pi.status_id,
                   pi.buyer_id
            FROM proforma_invoice pi
            LEFT JOIN vendor c ON c.id = pi.buyer_id
            LEFT JOIN currency curr ON curr.id = pi.currency_sale
            LEFT JOIN status s ON s.id = pi.status_id
            ${whereClause}
            ORDER BY pi.date_issue DESC
            LIMIT 100
        `, params);
        
        res.json({ data: rows });
    } catch (error) {
        next(error);
    }
});

// Get proforma invoice details for creating invoice
router.get('/proforma-invoices/:id', async (req, res, next) => {
    try {
        const { pool } = require('../../db/tx.cjs');
        const { id } = req.params;
        const isNumeric = /^\d+$/.test(id);
        const whereField = isNumeric ? 'pi.id' : 'pi.uniqid';
        
        const [[header]] = await pool.query(`
            SELECT pi.*, c.display_name as customer_name, c.id as customer_id,
                   curr.id as currency_id, curr.name as currency_code,
                   pi.expo_id as company_id
            FROM proforma_invoice pi
            LEFT JOIN vendor c ON c.id = pi.buyer_id
            LEFT JOIN currency curr ON curr.id = pi.currency_sale
            WHERE ${whereField} = ?
        `, [id]);
        
        if (!header) {
            return res.status(404).json({ error: 'Proforma invoice not found' });
        }
        
        const [items] = await pool.query(`
            SELECT 
                pii.*, 
                um.name as uom_name,
                (SELECT pi.file_path 
                 FROM product_images pi 
                 WHERE pi.product_id = pii.product_id 
                 ORDER BY pi.is_primary DESC, pi.id ASC 
                 LIMIT 1) as product_image
            FROM proforma_invoice_items pii
            LEFT JOIN uom_master um ON um.id = pii.uom_id
            WHERE pii.proforma_invoice_id = ?
            ORDER BY pii.id
        `, [header.id]);
        
        header.items = items;
        res.json(header);
    } catch (error) {
        next(error);
    }
});

// GET /api/ar/invoices/:id/payment-allocations - Get payment allocations for a customer invoice
router.get('/invoices/:id/payment-allocations', async (req, res, next) => {
    try {
        const { pool } = require('../../db/tx.cjs');
        const { id } = req.params;
        const isNumeric = /^\d+$/.test(id);
        const whereField = isNumeric ? 'ai.id' : 'ai.invoice_uniqid';
        
        // Get invoice info
        const [[invoice]] = await pool.query(`
            SELECT ai.id, ai.invoice_uniqid, ai.invoice_number, ai.total, ai.currency_id, ai.invoice_date,
                   c.name as currency_code, v.display_name as customer_name
            FROM ar_invoices ai
            LEFT JOIN currency c ON c.id = ai.currency_id
            LEFT JOIN vendor v ON v.id = ai.customer_id
            WHERE ${whereField} = ?
        `, [id]);
        
        if (!invoice) {
            return res.status(404).json({ error: 'Invoice not found' });
        }
        
        // Get payment allocations for this invoice (balance payments)
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
            WHERE pa.reference_id = ?
              AND pa.alloc_type = 'invoice'
              AND (p.is_deleted = 0 OR p.is_deleted IS NULL)
            ORDER BY p.transaction_date DESC, p.id DESC
        `, [invoice.id]);
        
        // Calculate totals
        const totalAmount = parseFloat(invoice.total || 0);
        const totalAdjusted = allocations.reduce((sum, alloc) => {
            // Use amount_bank if payment currency matches invoice currency, otherwise amount_base
            const invoiceCurrencyId = invoice.currency_id;
            const paymentCurrencyId = alloc.payment_currency_id;
            const amount = (invoiceCurrencyId && paymentCurrencyId && invoiceCurrencyId === paymentCurrencyId) 
                ? parseFloat(alloc.amount_bank || 0) 
                : parseFloat(alloc.amount_base || 0);
            return sum + amount;
        }, 0);
        const outstanding = totalAmount - totalAdjusted;
        
        res.json({
            invoice: {
                id: invoice.id,
                invoice_uniqid: invoice.invoice_uniqid,
                invoice_number: invoice.invoice_number,
                invoice_date: invoice.invoice_date,
                total: totalAmount,
                currency_id: invoice.currency_id,
                currency_code: invoice.currency_code,
                customer_name: invoice.customer_name
            },
            allocations: allocations || [],
            summary: {
                total_amount: totalAmount,
                total_adjusted: totalAdjusted,
                outstanding: outstanding,
                currency_code: invoice.currency_code
            }
        });
    } catch (error) {
        next(error);
    }
});

// GET /api/ar/proforma-invoices/:id/payment-allocations - Get payment allocations for a proforma invoice
router.get('/proforma-invoices/:id/payment-allocations', async (req, res, next) => {
    try {
        const { pool } = require('../../db/tx.cjs');
        const { id } = req.params;
        const isNumeric = /^\d+$/.test(id);
        const whereField = isNumeric ? 'pi.id' : 'pi.uniqid';
        
        // Get proforma invoice info
        const [[proforma]] = await pool.query(`
            SELECT pi.id, pi.uniqid, pi.proforma_invoice_no, pi.grand_total as total, pi.currency_sale as currency_id, pi.date_issue,
                   c.name as currency_code, v.display_name as customer_name
            FROM proforma_invoice pi
            LEFT JOIN currency c ON c.id = pi.currency_sale
            LEFT JOIN vendor v ON v.id = pi.buyer_id
            WHERE ${whereField} = ?
        `, [id]);
        
        if (!proforma) {
            return res.status(404).json({ error: 'Proforma invoice not found' });
        }
        
        // Get payment allocations for this proforma (advance payments)
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
            WHERE pa.reference_id = ?
              AND pa.alloc_type = 'advance'
              AND (p.is_deleted = 0 OR p.is_deleted IS NULL)
            ORDER BY p.transaction_date DESC, p.id DESC
        `, [proforma.id]);
        
        // Calculate totals
        const totalAmount = parseFloat(proforma.total || 0);
        const totalAdjusted = allocations.reduce((sum, alloc) => {
            // Use amount_bank if payment currency matches proforma currency, otherwise amount_base
            const proformaCurrencyId = proforma.currency_id;
            const paymentCurrencyId = alloc.payment_currency_id;
            const amount = (proformaCurrencyId && paymentCurrencyId && proformaCurrencyId === paymentCurrencyId) 
                ? parseFloat(alloc.amount_bank || 0) 
                : parseFloat(alloc.amount_base || 0);
            return sum + amount;
        }, 0);
        const outstanding = totalAmount - totalAdjusted;
        
        res.json({
            proforma: {
                id: proforma.id,
                uniqid: proforma.uniqid,
                proforma_invoice_no: proforma.proforma_invoice_no,
                date_issue: proforma.date_issue,
                total: totalAmount,
                currency_id: proforma.currency_id,
                currency_code: proforma.currency_code,
                customer_name: proforma.customer_name
            },
            allocations: allocations || [],
            summary: {
                total_amount: totalAmount,
                total_adjusted: totalAdjusted,
                outstanding: outstanding,
                currency_code: proforma.currency_code
            }
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;

