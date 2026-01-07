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
                   curr.name as currency_code, s.name as status_name, pi.status_id
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

module.exports = router;

