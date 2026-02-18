// server/routes/inwardPayments.js
// Customer Payment (INWARD) routes - mirrors outwardPayments.js structure
import { Router } from 'express';
import crypto from 'crypto';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import db from '../db.js';
import { requireAuth, requirePerm } from '../middleware/authz.js';
import { getBankExchangeRate } from './bankAccounts.js';
import glService from '../src/modules/gl/gl.service.cjs';

const router = Router();

// Multer setup for payment attachments
const PAYMENT_UPLOAD_DIR = path.resolve("uploads/payments");
if (!fs.existsSync(PAYMENT_UPLOAD_DIR)) {
  fs.mkdirSync(PAYMENT_UPLOAD_DIR, { recursive: true });
}

const paymentStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, PAYMENT_UPLOAD_DIR),
  filename: (_req, file, cb) =>
    cb(null, crypto.randomBytes(16).toString("hex") + path.extname(file.originalname)),
});

const paymentUpload = multer({ storage: paymentStorage }).array('attachments', 10);
const relPath = (f) => (f ? `/uploads/payments/${path.basename(f.path)}` : null);

// Helper function for error responses
const errPayload = (message, code, details) => ({
  error: { message, code, details }
});

// Helper function to update invoice outstanding balance and open_balance
const updateInvoiceOutstanding = async (conn, invoiceId, paymentCurrencyId = null) => {
  const [invoiceData] = await conn.query(`
    SELECT 
      ai.total,
      ai.currency_id,
      COALESCE(
        (SELECT SUM(
          CASE 
            WHEN ? IS NOT NULL AND p.currency_id = ai.currency_id THEN pa.amount_bank
            ELSE pa.amount_base
          END
        )
         FROM tbl_payment_allocation pa
         INNER JOIN tbl_payment p ON p.id = pa.payment_id
         WHERE pa.alloc_type = 'invoice' AND pa.reference_id = ai.id
           AND (p.is_deleted = 0 OR p.is_deleted IS NULL)
           AND p.direction = 'IN'), 
        0
      ) as received_amount
    FROM ar_invoices ai
    WHERE ai.id = ?
  `, [paymentCurrencyId, invoiceId]);

  if (invoiceData.length > 0) {
    const invoice = invoiceData[0];
    const outstanding = parseFloat(invoice.total) - parseFloat(invoice.received_amount);
    // Update open_balance in ar_invoices
    await conn.query(`
      UPDATE ar_invoices 
      SET open_balance = ? 
      WHERE id = ?
    `, [outstanding, invoiceId]);
  }
};

// Helper function to update proforma invoice open_balance
const updateProformaOpenBalance = async (conn, proformaId, paymentCurrencyId = null) => {
  const [proformaData] = await conn.query(`
    SELECT 
      pi.grand_total,
      pi.currency_sale as currency_id,
      COALESCE(
        (SELECT SUM(
          CASE 
            WHEN ? IS NOT NULL AND p.currency_id = pi.currency_sale THEN pa.amount_bank
            ELSE pa.amount_base
          END
        )
         FROM tbl_payment_allocation pa
         INNER JOIN tbl_payment p ON p.id = pa.payment_id
         WHERE pa.alloc_type = 'advance' AND pa.reference_id = pi.id
           AND (p.is_deleted = 0 OR p.is_deleted IS NULL)
           AND p.direction = 'IN'), 
        0
      ) as advance_paid
    FROM proforma_invoice pi
    WHERE pi.id = ?
  `, [paymentCurrencyId, proformaId]);

  if (proformaData.length > 0) {
    const proforma = proformaData[0];
    const openBalance = parseFloat(proforma.grand_total) - parseFloat(proforma.advance_paid);
    await conn.query(`
      UPDATE proforma_invoice 
      SET open_balance = ? 
      WHERE id = ?
    `, [openBalance, proformaId]);
  }
};

// Helper function to generate payment number (PAY-IN-000001 format)
const generatePaymentNumber = async (conn) => {
  const [rows] = await conn.query(`
    SELECT payment_number FROM tbl_payment 
    WHERE payment_number LIKE 'PAY-IN-%' AND direction = 'IN'
    ORDER BY payment_number DESC LIMIT 1
  `);

  if (rows.length === 0) {
    return 'PAY-IN-000001';
  }

  const lastNumber = rows[0].payment_number;
  const match = lastNumber.match(/PAY-IN-(\d+)/);
  if (match) {
    const num = parseInt(match[1], 10) + 1;
    return `PAY-IN-${String(num).padStart(6, '0')}`;
  }

  return 'PAY-IN-000001';
};

// GET /api/payments/customers/search?q= - Search customers
// IMPORTANT: This route must come before /payments/customer/:id routes to avoid route conflicts
router.get('/payments/customers/search', requireAuth, async (req, res) => {
  try {
    const { q = '' } = req.query;
    const searchTerm = `%${q}%`;

    let query = `
      SELECT 
        v.id,
        v.display_name AS name,
        v.company_name,
        v.uniqid,
        vo.currency_id,
        c.name AS currency_code
      FROM vendor v
      LEFT JOIN vendor_other vo ON vo.vendor_id = v.id
      LEFT JOIN currency c ON c.id = vo.currency_id
      WHERE v.company_type_id = 2 
        AND v.is_deleted = 0
    `;
    const params = [];

    if (q && q.trim()) {
      query += ` AND (v.display_name LIKE ? OR v.company_name LIKE ?)`;
      params.push(searchTerm, searchTerm);
    }

    query += ` ORDER BY v.display_name ASC LIMIT 50`;

    const [customers] = await db.promise().query(query, params);

    res.json(customers || []);
  } catch (e) {
    console.error('Error searching customers:', e);
    res.status(500).json(errPayload('Failed to search customers', 'DB_ERROR', e.message));
  }
});

// GET /api/payments/customer/:id/open-invoices - Get open invoices for a customer
// Optional query param: currency_id - filter invoices by currency (to match payment currency)
router.get('/payments/customer/:id/open-invoices', requireAuth, async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    const { id } = req.params;
    const { currency_id } = req.query;

    // Build WHERE clause - filter by currency if provided
    let currencyFilter = '';
    const params = [id];
    if (currency_id) {
      currencyFilter = ' AND ai.currency_id = ?';
      params.push(parseInt(currency_id));
    }

    // Calculate outstanding amount for each invoice
    // Use amount_bank (payment currency) when payment currency matches invoice currency
    // Check if invoice_id column exists, otherwise use alloc_type and reference_id
    const [invoices] = await conn.query(`
      SELECT 
        ai.id,
        ai.invoice_number,
        ai.invoice_date,
        ai.due_date,
        ai.total,
        ai.currency_id,
        c.name AS currency_code,
        ai.sales_order_id,
        ai.sales_order_number,
        so.order_no AS sales_order_no,
        COALESCE(
          (SELECT SUM(
            CASE 
              WHEN p.currency_id = ai.currency_id THEN pa.amount_bank
              ELSE pa.amount_base
            END
          )
           FROM tbl_payment_allocation pa
           INNER JOIN tbl_payment p ON p.id = pa.payment_id
           WHERE pa.alloc_type = 'invoice' AND pa.reference_id = ai.id
             AND (p.is_deleted = 0 OR p.is_deleted IS NULL)
             AND p.direction = 'IN'), 
          0
        ) as received_amount,
        (ai.total - COALESCE(
          (SELECT SUM(
            CASE 
              WHEN p.currency_id = ai.currency_id THEN pa.amount_bank
              ELSE pa.amount_base
            END
          )
           FROM tbl_payment_allocation pa
           INNER JOIN tbl_payment p ON p.id = pa.payment_id
           WHERE pa.alloc_type = 'invoice' AND pa.reference_id = ai.id
             AND (p.is_deleted = 0 OR p.is_deleted IS NULL)
             AND p.direction = 'IN'), 
          0
        )) as outstanding_amount
      FROM ar_invoices ai
      LEFT JOIN currency c ON c.id = ai.currency_id
      LEFT JOIN sales_orders so ON so.id = ai.sales_order_id
      WHERE ai.customer_id = ? 
        AND ai.status_id = 1
        ${currencyFilter}
      HAVING outstanding_amount > 0.01
      ORDER BY ai.invoice_date ASC
    `, params);

    // Update open_balance fields in ar_invoices table for each invoice
    for (const invoice of invoices) {
      await conn.query(`
        UPDATE ar_invoices 
        SET open_balance = ? 
        WHERE id = ?
      `, [invoice.outstanding_amount, invoice.id]);
    }

    res.json(invoices || []);
  } catch (e) {
    console.error('Error fetching open invoices:', e);
    res.status(500).json(errPayload('Failed to fetch open invoices', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// GET /api/payments/inward - List inward payments
router.get('/payments/inward', requireAuth, async (req, res) => {
  try {
    const { page = 1, per_page = 25, search = '', status_id, edit_request_status } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(per_page);
    const searchTerm = `%${search}%`;

    let whereClause = "WHERE p.direction = 'IN' AND p.party_type = 'CUSTOMER' AND (p.is_deleted = 0 OR p.is_deleted IS NULL)";
    const params = [];

    if (search) {
      whereClause += " AND (p.payment_number LIKE ? OR p.cheque_no LIKE ? OR p.tt_ref_no LIKE ? OR v.display_name LIKE ?)";
      params.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    if (status_id) {
      whereClause += " AND p.status_id = ?";
      params.push(parseInt(status_id, 10));
    }

    if (edit_request_status !== undefined && edit_request_status !== null) {
      whereClause += " AND p.edit_request_status = ?";
      params.push(parseInt(edit_request_status, 10));
    }

    if (req.query.created_by) {
      whereClause += " AND p.created_by = ?";
      params.push(parseInt(req.query.created_by, 10));
    }

    const [rows] = await db.promise().query(`
      SELECT 
        p.*,
        v.display_name AS customer_name,
        b.bank_name,
        b.acc_no AS bank_account_number,
        c.name AS currency_name,
        s.name AS status_name,
        s.bg_colour AS status_bg_colour,
        s.colour AS status_colour,
        created_user.name AS created_by_name,
        approved_user.name AS approved_by_name,
        p.reconcile_date,
        p.reconcile_number,
        edit_req_user.name AS edit_requested_by_name,
        (SELECT COUNT(*) FROM tbl_payment_attachments a WHERE a.payment_id = p.id) AS attachment_count,
        (SELECT a.file_path FROM tbl_payment_attachments a WHERE a.payment_id = p.id ORDER BY a.id ASC LIMIT 1) AS first_attachment_path,
        (SELECT a.mime_type FROM tbl_payment_attachments a WHERE a.payment_id = p.id ORDER BY a.id ASC LIMIT 1) AS first_attachment_mime_type,
        (SELECT a.file_name FROM tbl_payment_attachments a WHERE a.payment_id = p.id ORDER BY a.id ASC LIMIT 1) AS first_attachment_file_name
      FROM tbl_payment p
      LEFT JOIN vendor v ON v.id = p.party_id
      LEFT JOIN acc_bank_details b ON b.id = p.bank_account_id
      LEFT JOIN currency c ON c.name COLLATE utf8mb4_unicode_ci = p.currency_code COLLATE utf8mb4_unicode_ci
      LEFT JOIN status s ON s.id = p.status_id
      LEFT JOIN user created_user ON created_user.id = p.created_by
      LEFT JOIN user approved_user ON approved_user.id = p.approved_by
      LEFT JOIN user edit_req_user ON edit_req_user.id = p.edit_requested_by
      ${whereClause}
      ORDER BY p.transaction_date DESC, p.id DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(per_page), offset]);

    const [countRows] = await db.promise().query(`
      SELECT COUNT(*) AS total
      FROM tbl_payment p
      LEFT JOIN vendor v ON v.id = p.party_id
      ${whereClause}
    `, params);

    res.json({
      data: rows || [],
      total: countRows[0]?.total || 0,
      page: parseInt(page),
      per_page: parseInt(per_page)
    });
  } catch (e) {
    console.error('Error listing inward payments:', e);
    res.status(500).json(errPayload('Failed to list payments', 'DB_ERROR', e.message));
  }
});

// GET /api/payments/inward/:id - Get single inward payment
router.get('/payments/inward/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const isNumeric = /^\d+$/.test(id);
    const whereField = isNumeric ? 'p.id' : 'p.payment_uniqid';

    const [payments] = await db.promise().query(`
      SELECT 
        p.*,
        v.display_name AS customer_name,
        v.company_name AS customer_company,
        b.bank_name,
        b.acc_no AS bank_account_number,
        c.name AS currency_name,
        s.name AS status_name,
        s.bg_colour AS status_bg_colour,
        s.colour AS status_colour,
        approved_user.name AS approved_by_name,
        p.reconcile_date,
        p.reconcile_number,
        created_user.name AS created_by_name,
        pt.id AS payment_type_id, pt.name AS payment_type_name, pt.code AS payment_type_code
      FROM tbl_payment p
      LEFT JOIN vendor v ON v.id = p.party_id
      LEFT JOIN acc_bank_details b ON b.id = p.bank_account_id
      LEFT JOIN currency c ON c.name COLLATE utf8mb4_unicode_ci = p.currency_code COLLATE utf8mb4_unicode_ci
      LEFT JOIN status s ON s.id = p.status_id
      LEFT JOIN user approved_user ON approved_user.id = p.approved_by
      LEFT JOIN user created_user ON created_user.id = p.created_by
      LEFT JOIN payment_type pt ON pt.id = p.payment_type_id
      WHERE ${whereField} = ? AND p.direction = 'IN' AND p.party_type = 'CUSTOMER' AND (p.is_deleted = 0 OR p.is_deleted IS NULL)
    `, [id]);

    if (payments.length === 0) {
      return res.status(404).json(errPayload('Payment not found', 'NOT_FOUND'));
    }

    const payment = payments[0];

    // Get allocations
    const [allocations] = await db.promise().query(`
      SELECT 
        pa.*,
        CASE WHEN pa.alloc_type = 'invoice' THEN pa.reference_id ELSE NULL END AS invoice_id,
        CASE WHEN pa.alloc_type = 'advance' THEN pa.reference_id ELSE NULL END AS proforma_id,
        CASE WHEN pa.alloc_type = 'invoice' THEN 'balance' WHEN pa.alloc_type = 'advance' THEN 'advance' ELSE pa.alloc_type END AS allocation_type,
        ai.invoice_number,
        ai.invoice_date,
        ai.total AS invoice_total,
        ai.currency_id AS invoice_currency_id,
        ai.customer_id AS invoice_customer_id,
        pi.proforma_invoice_no,
        pi.date_issue AS proforma_date,
        pi.grand_total AS proforma_total,
        pi.currency_sale AS proforma_currency_id,
        pi.buyer_id AS proforma_customer_id,
        c.name AS invoice_currency_code,
        c2.name AS proforma_currency_code,
        v.display_name AS customer_name
      FROM tbl_payment_allocation pa
      LEFT JOIN ar_invoices ai ON pa.alloc_type = 'invoice' AND ai.id = pa.reference_id
      LEFT JOIN proforma_invoice pi ON pa.alloc_type = 'advance' AND pi.id = pa.reference_id
      LEFT JOIN currency c ON c.id = ai.currency_id
      LEFT JOIN currency c2 ON c2.id = pi.currency_sale
      LEFT JOIN vendor v ON v.id = COALESCE(pa.buyer_id, ai.customer_id, pi.buyer_id)
      WHERE pa.payment_id = ?
    `, [payment.id]);

    payment.allocations = allocations || [];

    const [attachments] = await db.promise().query(`
      SELECT id, file_name, file_path, mime_type, size_bytes, created_at
      FROM tbl_payment_attachments
      WHERE payment_id = ?
      ORDER BY id ASC
    `, [payment.id]);
    payment.attachments = attachments || [];

    res.json(payment);
  } catch (e) {
    console.error('Error fetching payment:', e);
    res.status(500).json(errPayload('Failed to fetch payment', 'DB_ERROR', e.message));
  }
});

// POST /api/payments/inward - Create inward payment (DRAFT)
router.post('/payments/inward', requireAuth, requirePerm('Sales', 'create'), paymentUpload, async (req, res) => {
  const conn = await db.promise().getConnection();
  const userId = req.user?.id ?? req.session?.user?.id;

  try {
    await conn.beginTransaction();

    // Parse allocations: may be array (JSON body) or JSON string (FormData)
    let allocations = [];
    try {
      if (Array.isArray(req.body.allocations)) {
        allocations = req.body.allocations;
      } else if (req.body.allocations && typeof req.body.allocations === 'string') {
        allocations = JSON.parse(req.body.allocations);
      }
    } catch (e) {
      allocations = [];
    }

    const {
      transaction_date,
      payment_type,
      payment_type_id,
      bank_account_id,
      cash_account_id,
      cheque_no,
      cheque_date,
      tt_ref_no,
      value_date,
      reference_no,
      notes
    } = req.body;

    // Get customer_id from first allocation if not in body
    let customer_id = req.body.customer_id;
    if (!customer_id && allocations.length > 0 && allocations[0].customer_id) {
      customer_id = allocations[0].customer_id;
    }

    // Validation
    if (!transaction_date || (!payment_type && !payment_type_id) || !customer_id) {
      await conn.rollback();
      return res.status(400).json(errPayload('Transaction date, payment type, and customer are required', 'VALIDATION_ERROR'));
    }

    // Get payment type code if only ID is provided
    let paymentTypeCode = payment_type;
    if (!paymentTypeCode && payment_type_id) {
      const [[pt]] = await conn.query(`SELECT code FROM payment_type WHERE id = ?`, [payment_type_id]);
      if (!pt) {
        await conn.rollback();
        return res.status(400).json(errPayload('Invalid payment type ID', 'VALIDATION_ERROR'));
      }
      paymentTypeCode = pt.code;
    }

    if (!['CASH', 'CHEQUE', 'TT'].includes(paymentTypeCode)) {
      await conn.rollback();
      return res.status(400).json(errPayload('Invalid payment type. Must be CASH, CHEQUE, or TT', 'VALIDATION_ERROR'));
    }

    // Payment type specific validation
    if (paymentTypeCode === 'CHEQUE') {
      if (!bank_account_id) {
        await conn.rollback();
        return res.status(400).json(errPayload('Bank account is required for CHEQUE payments', 'VALIDATION_ERROR'));
      }
      if (!cheque_no || !cheque_date) {
        await conn.rollback();
        return res.status(400).json(errPayload('Cheque number and cheque date are required for CHEQUE payments', 'VALIDATION_ERROR'));
      }
    }

    if (paymentTypeCode === 'TT') {
      if (!bank_account_id) {
        await conn.rollback();
        return res.status(400).json(errPayload('Bank account is required for TT payments', 'VALIDATION_ERROR'));
      }
      if (!tt_ref_no || !value_date) {
        await conn.rollback();
        return res.status(400).json(errPayload('TT reference number and value date are required for TT payments', 'VALIDATION_ERROR'));
      }
    }

    if (!allocations || allocations.length === 0) {
      await conn.rollback();
      return res.status(400).json(errPayload('At least one allocation is required', 'VALIDATION_ERROR'));
    }

    // Determine account (bank or cash) - only required for CHEQUE and TT, not CASH
    const accountId = bank_account_id || cash_account_id;
    if (paymentTypeCode !== 'CASH' && !accountId) {
      await conn.rollback();
      return res.status(400).json(errPayload('Bank account or cash account is required', 'VALIDATION_ERROR'));
    }

    // Get account details (if account is provided)
    let accountCurrency = 'AED'; // Payment currency (bank/cash currency)
    let currencyId = null;       // currency.id for this payment
    let effectiveFxRate = 1.0;

    if (accountId) {
      const [[account]] = await conn.query(`
        SELECT id, currency_code, acc_currency 
        FROM acc_bank_details 
        WHERE id = ?
      `, [accountId]);

      if (!account) {
        await conn.rollback();
        return res.status(404).json(errPayload('Account not found', 'NOT_FOUND'));
      }

      currencyId = account.acc_currency || null;
      accountCurrency = account.currency_code || 'AED';
      if (!accountCurrency && account.acc_currency) {
        try {
          const [[currency]] = await conn.query(`SELECT id, name FROM currency WHERE id = ?`, [account.acc_currency]);
          if (currency && currency.name) {
            accountCurrency = currency.name;
            currencyId = currency.id;
          }
        } catch (e) {
          console.warn('Error fetching currency for account:', e);
          accountCurrency = 'AED';
        }
      }

      if (!currencyId && accountCurrency) {
        try {
          const [[currencyRow]] = await conn.query(`SELECT id FROM currency WHERE name = ? LIMIT 1`, [accountCurrency]);
          if (currencyRow && currencyRow.id) {
            currencyId = currencyRow.id;
          }
        } catch (e) {
          console.warn('Error resolving currency_id for payment:', e);
        }
      }

      // Get FX rate for transaction date
      const fxRate = await getBankExchangeRate(accountId, transaction_date);
      if (!fxRate && accountCurrency !== 'AED') {
        await conn.rollback();
        return res.status(400).json(errPayload(`No exchange rate found for account currency ${accountCurrency} on ${transaction_date}`, 'VALIDATION_ERROR'));
      }

      effectiveFxRate = fxRate || 1.0;
    } else {
      // CASH payments without a specific bank/cash account - default to base currency (e.g., AED)
      try {
        const [[baseCurr]] = await conn.query(`SELECT id FROM currency WHERE name = ? LIMIT 1`, [accountCurrency]);
        if (baseCurr && baseCurr.id) {
          currencyId = baseCurr.id;
        }
      } catch (e) {
        console.warn('Error resolving base currency_id for CASH payment:', e);
      }
    }

    // Calculate total amount from allocations
    const totalAmount = allocations.reduce((sum, a) => sum + parseFloat(a.amount || 0), 0);

    if (totalAmount <= 0) {
      await conn.rollback();
      return res.status(400).json(errPayload('Total amount must be greater than zero', 'VALIDATION_ERROR'));
    }

    const totalAmountBase = totalAmount * effectiveFxRate;

    // Generate payment number
    const paymentNumber = await generatePaymentNumber(conn);

    // Check for duplicate payment number
    const [existing] = await conn.query(`
      SELECT id FROM tbl_payment WHERE payment_number = ?
    `, [paymentNumber]);

    if (existing.length > 0) {
      await conn.rollback();
      return res.status(409).json(errPayload('Payment number already exists', 'DUPLICATE'));
    }

    // Generate unique ID
    const paymentUniqid = `in_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

    // Insert payment with status_id = 3 (DRAFT)
    const [paymentResult] = await conn.query(`
      INSERT INTO tbl_payment (
        payment_uniqid, payment_number, transaction_date, payment_type, payment_type_id,
        bank_account_id, cash_account_id, cheque_no, cheque_date,
        tt_ref_no, value_date, reference_no,
        direction, is_customer_payment, party_type, party_id,
        currency_id, currency_code, total_amount_bank, total_amount_base, fx_rate,
        notes, status_id, user_id, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'IN', 1, 'CUSTOMER', ?, ?, ?, ?, ?, ?, ?, 3, ?, ?, NOW())
    `, [
      paymentUniqid, paymentNumber, transaction_date, paymentTypeCode, payment_type_id || null,
      bank_account_id || null, cash_account_id || null,
      cheque_no || null, cheque_date || null,
      tt_ref_no || null, value_date || null, reference_no || null,
      customer_id, currencyId || null, accountCurrency, totalAmount, totalAmountBase, effectiveFxRate,
      notes || null, userId, userId
    ]);

    const paymentId = paymentResult.insertId;

    // Validate allocations don't exceed outstanding (for invoice allocations)
    for (const alloc of allocations) {
      if (alloc.type === 'invoice' && alloc.invoice_id) {
        const [invoices] = await conn.query(`
          SELECT 
            ai.id,
            ai.invoice_number,
            ai.total,
            ai.currency_id as invoice_currency_id,
            COALESCE(
              (SELECT SUM(
                CASE 
                  WHEN p.currency_id = ai.currency_id THEN pa.amount_bank
                  ELSE pa.amount_base
                END
              )
               FROM tbl_payment_allocation pa
               INNER JOIN tbl_payment p ON p.id = pa.payment_id
               WHERE pa.alloc_type = 'invoice' AND pa.reference_id = ai.id
                 AND (p.is_deleted = 0 OR p.is_deleted IS NULL)
                 AND p.direction = 'IN'), 
              0
            ) as received_amount
          FROM ar_invoices ai
          WHERE ai.id = ?
        `, [alloc.invoice_id]);

        if (invoices.length === 0) {
          await conn.rollback();
          return res.status(404).json(errPayload(`Invoice ${alloc.invoice_id} not found`, 'NOT_FOUND'));
        }

        const invoice = invoices[0];
        const outstanding = parseFloat(invoice.total) - parseFloat(invoice.received_amount);
        const allocAmountBase = parseFloat(alloc.amount || 0) * effectiveFxRate;

        // Sum all allocations for this invoice in the current request
        const totalAllocatedForInvoice = allocations
          .filter(a => a.type === 'invoice' && a.invoice_id === alloc.invoice_id)
          .reduce((sum, a) => sum + (parseFloat(a.amount || 0) * effectiveFxRate), 0);

        if (totalAllocatedForInvoice > outstanding + 0.01) {
          await conn.rollback();
          return res.status(400).json(errPayload(`Allocation amount (${totalAllocatedForInvoice.toFixed(2)}) exceeds outstanding balance (${outstanding.toFixed(2)}) for invoice ${invoice.invoice_number || alloc.invoice_id}`, 'VALIDATION_ERROR'));
        }
      }
    }

    // Insert allocations
    for (const alloc of allocations) {
      const { type, allocation_type, invoice_id, proforma_id, customer_id: allocCustomerId, amount } = alloc;
      const finalCustomerId = allocCustomerId || customer_id;

      // Determine alloc_type and reference_id based on allocation_type or type
      let allocType = null;
      let referenceId = null;

      if (allocation_type === 'balance' || type === 'invoice') {
        allocType = 'invoice';
        if (!invoice_id) {
          await conn.rollback();
          return res.status(400).json(errPayload('Invoice ID is required for balance/invoice allocations', 'VALIDATION_ERROR'));
        }
        referenceId = invoice_id;
      } else if (allocation_type === 'advance' || type === 'proforma') {
        allocType = 'advance';
        // Use proforma_id from request body as reference_id
        if (!proforma_id) {
          await conn.rollback();
          return res.status(400).json(errPayload('Proforma ID is required for advance/proforma allocations', 'VALIDATION_ERROR'));
        }
        referenceId = proforma_id;
      } else {
        await conn.rollback();
        return res.status(400).json(errPayload('Invalid allocation type. Must be balance/invoice or advance/proforma', 'VALIDATION_ERROR'));
      }

      if (!amount) {
        await conn.rollback();
        return res.status(400).json(errPayload('Allocation amount is required', 'VALIDATION_ERROR'));
      }

      // Validate invoice belongs to customer and get invoice number
      let referenceNumber = null;
      if (allocType === 'invoice' && referenceId) {
        const [invoices] = await conn.query(`
          SELECT invoice_number FROM ar_invoices WHERE id = ? AND customer_id = ?
        `, [referenceId, finalCustomerId]);

        if (invoices.length === 0) {
          await conn.rollback();
          return res.status(404).json(errPayload(`Invoice ${referenceId} not found or does not belong to customer`, 'NOT_FOUND'));
        }
        referenceNumber = invoices[0].invoice_number || null;
      }

      // Validate proforma belongs to customer and get proforma invoice number
      if (allocType === 'advance' && referenceId) {
        const [proformas] = await conn.query(`
          SELECT proforma_invoice_no FROM proforma_invoice WHERE id = ? AND buyer_id = ?
        `, [referenceId, finalCustomerId]);

        if (proformas.length === 0) {
          await conn.rollback();
          return res.status(404).json(errPayload(`Proforma invoice ${referenceId} not found or does not belong to customer`, 'NOT_FOUND'));
        }
        referenceNumber = proformas[0].proforma_invoice_no || null;
      }

      const allocAmount = parseFloat(amount);
      const allocAmountBase = allocAmount * effectiveFxRate;

      await conn.query(`
        INSERT INTO tbl_payment_allocation (
          payment_id, alloc_type, reference_id, buyer_id, reference_number, amount_bank, amount_base, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
      `, [
        paymentId, allocType, referenceId, finalCustomerId, referenceNumber, allocAmount, allocAmountBase, userId
      ]);
    }

    // Update open_balance for all invoices affected by this payment
    const invoiceIds = allocations
      .filter(a => (a.allocation_type === 'balance' || a.type === 'invoice') && a.invoice_id)
      .map(a => a.invoice_id);
    for (const invoiceId of invoiceIds) {
      await updateInvoiceOutstanding(conn, invoiceId, currencyId);
    }

    // Update open_balance for all proforma invoices affected by this payment
    const proformaIds = allocations
      .filter(a => (a.allocation_type === 'advance' || a.type === 'proforma') && (a.proforma_id || (a.allocation_type === 'advance' && a.reference_id)))
      .map(a => a.proforma_id || (a.allocation_type === 'advance' ? a.reference_id : null))
      .filter(Boolean);
    for (const proformaId of proformaIds) {
      await updateProformaOpenBalance(conn, proformaId, currencyId);
    }

    // Handle attachments - save to existing tbl_payment_attachments
    if (req.files && req.files.length > 0) {
      const attachmentValues = req.files.map(f => [
        paymentId,
        f.originalname || 'attachment',
        relPath(f),
        f.mimetype || null,
        f.size || 0,
        userId,
        new Date()
      ]);
      await conn.query(`
        INSERT INTO tbl_payment_attachments 
        (payment_id, file_name, file_path, mime_type, size_bytes, created_by, created_at)
        VALUES ?
      `, [attachmentValues]);
    }


    // Log history - CREATED
    await conn.query(`
      INSERT INTO history (module, module_id, user_id, action, details)
      VALUES (?, ?, ?, ?, ?)
    `, [
      'inward_payment',
      paymentId,
      userId,
      'CREATED',
      JSON.stringify({ payment_number: paymentNumber })
    ]);

    await conn.commit();

    // Fetch and return created payment
    const [createdPayment] = await db.promise().query(`
      SELECT 
        p.*,
        pt.id AS payment_type_id, pt.name AS payment_type_name, pt.code AS payment_type_code,
        v.display_name AS customer_name,
        s.name AS status_name,
        s.bg_colour AS status_bg_colour,
        s.colour AS status_colour
      FROM tbl_payment p
      LEFT JOIN payment_type pt ON pt.id = p.payment_type_id
      LEFT JOIN vendor v ON v.id = p.party_id
      LEFT JOIN status s ON s.id = p.status_id
      WHERE p.id = ?
    `, [paymentId]);

    res.status(201).json(createdPayment[0] || { id: paymentId, message: 'Payment created successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error creating inward payment:', e);
    res.status(500).json(errPayload('Failed to create payment', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// PUT /api/payments/inward/:id - Update inward payment (DRAFT only)
router.put('/payments/inward/:id', requireAuth, requirePerm('Sales', 'edit'), paymentUpload, async (req, res) => {
  const conn = await db.promise().getConnection();
  const userId = req.user?.id ?? req.session?.user?.id;

  try {
    await conn.beginTransaction();

    const { id } = req.params;
    const isNumeric = /^\d+$/.test(id);
    const whereField = isNumeric ? 'id' : 'payment_uniqid';

    // Get existing payment
    const [payments] = await conn.query(`
      SELECT * FROM tbl_payment 
      WHERE ${whereField} = ? AND direction = 'IN' AND party_type = 'CUSTOMER' AND (is_deleted = 0 OR is_deleted IS NULL)
    `, [id]);

    if (payments.length === 0) {
      await conn.rollback();
      return res.status(404).json(errPayload('Payment not found', 'NOT_FOUND'));
    }

    const existingPayment = payments[0];

    // Allow editing for: DRAFT (3), REJECTED (2), SUBMITTED_FOR_APPROVAL (8), or payments with approved edit requests (edit_request_status = 1)
    const allowedStatusIds = [2, 3, 8]; // REJECTED, DRAFT, SUBMITTED_FOR_APPROVAL
    const canEdit = allowedStatusIds.includes(existingPayment.status_id) || existingPayment.edit_request_status === 1;

    if (!canEdit) {
      await conn.rollback();
      return res.status(400).json(errPayload('Only draft, rejected, submitted for approval payments, or payments with approved edit requests can be edited', 'VALIDATION_ERROR'));
    }

    // Parse allocations: may be array (JSON body) or JSON string (FormData)
    let allocations = [];
    try {
      if (Array.isArray(req.body.allocations)) {
        allocations = req.body.allocations;
      } else if (req.body.allocations && typeof req.body.allocations === 'string') {
        allocations = JSON.parse(req.body.allocations);
      }
    } catch (e) {
      allocations = [];
    }

    const {
      transaction_date,
      payment_type,
      payment_type_id,
      bank_account_id,
      cash_account_id,
      cheque_no,
      cheque_date,
      tt_ref_no,
      value_date,
      reference_no,
      notes
    } = req.body;

    // Get customer_id from first allocation if not in body
    let customer_id = req.body.customer_id;
    if (!customer_id && allocations.length > 0 && allocations[0].customer_id) {
      customer_id = allocations[0].customer_id;
    }

    // Validation
    if (!transaction_date || (!payment_type && !payment_type_id) || !customer_id) {
      await conn.rollback();
      return res.status(400).json(errPayload('Transaction date, payment type, and customer are required', 'VALIDATION_ERROR'));
    }

    // Get payment type code if only ID is provided
    let paymentTypeCode = payment_type;
    if (!paymentTypeCode && payment_type_id) {
      const [[pt]] = await conn.query(`SELECT code FROM payment_type WHERE id = ?`, [payment_type_id]);
      if (!pt) {
        await conn.rollback();
        return res.status(400).json(errPayload('Invalid payment type ID', 'VALIDATION_ERROR'));
      }
      paymentTypeCode = pt.code;
    }

    if (!['CASH', 'CHEQUE', 'TT'].includes(paymentTypeCode)) {
      await conn.rollback();
      return res.status(400).json(errPayload('Invalid payment type. Must be CASH, CHEQUE, or TT', 'VALIDATION_ERROR'));
    }

    // Payment type specific validation
    if (paymentTypeCode === 'CHEQUE') {
      if (!bank_account_id) {
        await conn.rollback();
        return res.status(400).json(errPayload('Bank account is required for CHEQUE payments', 'VALIDATION_ERROR'));
      }
      if (!cheque_no || !cheque_date) {
        await conn.rollback();
        return res.status(400).json(errPayload('Cheque number and cheque date are required for CHEQUE payments', 'VALIDATION_ERROR'));
      }
    }

    if (paymentTypeCode === 'TT') {
      if (!bank_account_id) {
        await conn.rollback();
        return res.status(400).json(errPayload('Bank account is required for TT payments', 'VALIDATION_ERROR'));
      }
      if (!tt_ref_no || !value_date) {
        await conn.rollback();
        return res.status(400).json(errPayload('TT reference number and value date are required for TT payments', 'VALIDATION_ERROR'));
      }
    }

    if (!allocations || allocations.length === 0) {
      await conn.rollback();
      return res.status(400).json(errPayload('At least one allocation is required', 'VALIDATION_ERROR'));
    }

    // Determine account (bank or cash)
    const accountId = bank_account_id || cash_account_id;
    if (paymentTypeCode !== 'CASH' && !accountId) {
      await conn.rollback();
      return res.status(400).json(errPayload('Bank account or cash account is required', 'VALIDATION_ERROR'));
    }

    // Get account details
    let accountCurrency = 'AED';
    let currencyId = null;
    let effectiveFxRate = 1.0;

    if (accountId) {
      const [[account]] = await conn.query(`
        SELECT id, currency_code, acc_currency 
        FROM acc_bank_details 
        WHERE id = ?
      `, [accountId]);

      if (!account) {
        await conn.rollback();
        return res.status(404).json(errPayload('Account not found', 'NOT_FOUND'));
      }

      currencyId = account.acc_currency || null;
      accountCurrency = account.currency_code || 'AED';
      if (!accountCurrency && account.acc_currency) {
        try {
          const [[currency]] = await conn.query(`SELECT id, name FROM currency WHERE id = ?`, [account.acc_currency]);
          if (currency && currency.name) {
            accountCurrency = currency.name;
            currencyId = currency.id;
          }
        } catch (e) {
          console.warn('Error fetching currency for account:', e);
          accountCurrency = 'AED';
        }
      }

      if (!currencyId && accountCurrency) {
        try {
          const [[currencyRow]] = await conn.query(`SELECT id FROM currency WHERE name = ? LIMIT 1`, [accountCurrency]);
          if (currencyRow && currencyRow.id) {
            currencyId = currencyRow.id;
          }
        } catch (e) {
          console.warn('Error resolving currency_id for payment:', e);
        }
      }

      const fxRate = await getBankExchangeRate(accountId, transaction_date);
      if (!fxRate && accountCurrency !== 'AED') {
        await conn.rollback();
        return res.status(400).json(errPayload(`No exchange rate found for account currency ${accountCurrency} on ${transaction_date}`, 'VALIDATION_ERROR'));
      }

      effectiveFxRate = fxRate || 1.0;
    } else {
      try {
        const [[baseCurr]] = await conn.query(`SELECT id FROM currency WHERE name = ? LIMIT 1`, [accountCurrency]);
        if (baseCurr && baseCurr.id) {
          currencyId = baseCurr.id;
        }
      } catch (e) {
        console.warn('Error resolving base currency_id for CASH payment:', e);
      }
    }

    // Calculate total amount from allocations
    const totalAmount = allocations.reduce((sum, a) => sum + parseFloat(a.amount || 0), 0);

    if (totalAmount <= 0) {
      await conn.rollback();
      return res.status(400).json(errPayload('Total amount must be greater than zero', 'VALIDATION_ERROR'));
    }

    const totalAmountBase = totalAmount * effectiveFxRate;

    // If payment is approved and has GL journal, soft-delete the journal before updating
    if (existingPayment.status_id === 1) {
      await conn.query(`
        UPDATE gl_journals 
        SET is_deleted = 1 
        WHERE source_type = 'INWARD_PAYMENT' AND source_id = ?
      `, [existingPayment.id]);
    }

    // Update payment
    await conn.query(`
      UPDATE tbl_payment SET
        transaction_date = ?,
        payment_type = ?,
        payment_type_id = ?,
        bank_account_id = ?,
        cash_account_id = ?,
        cheque_no = ?,
        cheque_date = ?,
        tt_ref_no = ?,
        value_date = ?,
        reference_no = ?,
        party_id = ?,
        currency_id = ?,
        currency_code = ?,
        total_amount_bank = ?,
        total_amount_base = ?,
        fx_rate = ?,
        notes = ?,
        updated_by = ?,
        updated_at = NOW(),
        status_id = 3,
        edit_request_status = 0
      WHERE id = ?
    `, [
      transaction_date, paymentTypeCode, payment_type_id || null,
      bank_account_id || null, cash_account_id || null,
      cheque_no || null, cheque_date || null,
      tt_ref_no || null, value_date || null, reference_no || null,
      customer_id, currencyId || null, accountCurrency, totalAmount, totalAmountBase, effectiveFxRate,
      notes || null, userId, existingPayment.id
    ]);

    // Fetch existing allocations before deleting (to update open_balance for removed ones)
    const [existingAllocationsRows] = await conn.query(`
      SELECT 
        pa.alloc_type,
        pa.reference_id
      FROM tbl_payment_allocation pa
      WHERE pa.payment_id = ?
    `, [existingPayment.id]);
    const existingAllocations = existingAllocationsRows || [];

    // Delete existing allocations
    await conn.query(`DELETE FROM tbl_payment_allocation WHERE payment_id = ?`, [existingPayment.id]);

    // Validate allocations don't exceed outstanding
    for (const alloc of allocations) {
      if (alloc.type === 'invoice' && alloc.invoice_id) {
        const [invoices] = await conn.query(`
          SELECT 
            ai.id,
            ai.invoice_number,
            ai.total,
            ai.currency_id as invoice_currency_id,
            COALESCE(
              (SELECT SUM(
                CASE 
                  WHEN p.currency_id = ai.currency_id THEN pa.amount_bank
                  ELSE pa.amount_base
                END
              )
               FROM tbl_payment_allocation pa
               INNER JOIN tbl_payment p ON p.id = pa.payment_id
               WHERE pa.alloc_type = 'invoice' AND pa.reference_id = ai.id
                 AND p.id != ?
                 AND (p.is_deleted = 0 OR p.is_deleted IS NULL)
                 AND p.direction = 'IN'), 
              0
            ) as received_amount
          FROM ar_invoices ai
          WHERE ai.id = ?
        `, [existingPayment.id, alloc.invoice_id]);

        if (invoices.length === 0) {
          await conn.rollback();
          return res.status(404).json(errPayload(`Invoice ${alloc.invoice_id} not found`, 'NOT_FOUND'));
        }

        const invoice = invoices[0];
        const outstanding = parseFloat(invoice.total) - parseFloat(invoice.received_amount);
        const allocAmountBase = parseFloat(alloc.amount || 0) * effectiveFxRate;

        const totalAllocatedForInvoice = allocations
          .filter(a => a.type === 'invoice' && a.invoice_id === alloc.invoice_id)
          .reduce((sum, a) => sum + (parseFloat(a.amount || 0) * effectiveFxRate), 0);

        if (totalAllocatedForInvoice > outstanding + 0.01) {
          await conn.rollback();
          return res.status(400).json(errPayload(`Allocation amount (${totalAllocatedForInvoice.toFixed(2)}) exceeds outstanding balance (${outstanding.toFixed(2)}) for invoice ${invoice.invoice_number || alloc.invoice_id}`, 'VALIDATION_ERROR'));
        }
      }
    }

    // Insert new allocations
    for (const alloc of allocations) {
      const { type, allocation_type, invoice_id, proforma_id, customer_id: allocCustomerId, amount } = alloc;
      const finalCustomerId = allocCustomerId || customer_id;

      // Determine alloc_type and reference_id based on allocation_type or type
      let allocType = null;
      let referenceId = null;

      if (allocation_type === 'balance' || type === 'invoice') {
        allocType = 'invoice';
        if (!invoice_id) {
          await conn.rollback();
          return res.status(400).json(errPayload('Invoice ID is required for balance/invoice allocations', 'VALIDATION_ERROR'));
        }
        referenceId = invoice_id;
      } else if (allocation_type === 'advance' || type === 'proforma') {
        allocType = 'advance';
        // Use proforma_id from request body as reference_id
        if (!proforma_id) {
          await conn.rollback();
          return res.status(400).json(errPayload('Proforma ID is required for advance/proforma allocations', 'VALIDATION_ERROR'));
        }
        referenceId = proforma_id;
      } else {
        await conn.rollback();
        return res.status(400).json(errPayload('Invalid allocation type. Must be balance/invoice or advance/proforma', 'VALIDATION_ERROR'));
      }

      if (!amount) {
        await conn.rollback();
        return res.status(400).json(errPayload('Allocation amount is required', 'VALIDATION_ERROR'));
      }

      // Validate invoice belongs to customer and get invoice number
      let referenceNumber = null;
      if (allocType === 'invoice' && referenceId) {
        const [invoices] = await conn.query(`
          SELECT invoice_number FROM ar_invoices WHERE id = ? AND customer_id = ?
        `, [referenceId, finalCustomerId]);

        if (invoices.length === 0) {
          await conn.rollback();
          return res.status(404).json(errPayload(`Invoice ${referenceId} not found or does not belong to customer`, 'NOT_FOUND'));
        }
        referenceNumber = invoices[0].invoice_number || null;
      }

      // Validate proforma belongs to customer and get proforma invoice number
      if (allocType === 'advance' && referenceId) {
        const [proformas] = await conn.query(`
          SELECT proforma_invoice_no FROM proforma_invoice WHERE id = ? AND buyer_id = ?
        `, [referenceId, finalCustomerId]);

        if (proformas.length === 0) {
          await conn.rollback();
          return res.status(404).json(errPayload(`Proforma invoice ${referenceId} not found or does not belong to customer`, 'NOT_FOUND'));
        }
        referenceNumber = proformas[0].proforma_invoice_no || null;
      }

      const allocAmount = parseFloat(amount);
      const allocAmountBase = allocAmount * effectiveFxRate;

      await conn.query(`
        INSERT INTO tbl_payment_allocation (
          payment_id, alloc_type, reference_id, buyer_id, reference_number, amount_bank, amount_base, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
      `, [
        existingPayment.id, allocType, referenceId, finalCustomerId, referenceNumber, allocAmount, allocAmountBase, userId
      ]);
    }

    // Update open_balance for all invoices affected by this payment
    const invoiceIds = allocations
      .filter(a => (a.allocation_type === 'balance' || a.type === 'invoice') && a.invoice_id)
      .map(a => a.invoice_id);
    for (const invoiceId of invoiceIds) {
      await updateInvoiceOutstanding(conn, invoiceId, currencyId);
    }

    // Update open_balance for all proforma invoices affected by this payment
    const proformaIds = allocations
      .filter(a => (a.allocation_type === 'advance' || a.type === 'proforma') && (a.proforma_id || (a.allocation_type === 'advance' && a.reference_id)))
      .map(a => a.proforma_id || (a.allocation_type === 'advance' ? a.reference_id : null))
      .filter(Boolean);
    for (const proformaId of proformaIds) {
      await updateProformaOpenBalance(conn, proformaId, currencyId);
    }

    // Also update invoices/proformas from old allocations that were removed
    const oldInvoiceIds = existingAllocations
      .filter(a => a.alloc_type === 'invoice' && a.reference_id)
      .map(a => a.reference_id);
    const oldProformaIds = existingAllocations
      .filter(a => a.alloc_type === 'advance' && a.reference_id)
      .map(a => a.reference_id);
    for (const invoiceId of oldInvoiceIds) {
      if (!invoiceIds.includes(invoiceId)) {
        await updateInvoiceOutstanding(conn, invoiceId, currencyId);
      }
    }
    for (const proformaId of oldProformaIds) {
      if (!proformaIds.includes(proformaId)) {
        await updateProformaOpenBalance(conn, proformaId, currencyId);
      }
    }

    // Handle deleted attachments
    if (req.body.deleted_attachments) {
      let deletedIds = [];
      try {
        deletedIds = JSON.parse(req.body.deleted_attachments);
      } catch (e) {
        // checks if it is a single id
        if (typeof req.body.deleted_attachments === 'string' || typeof req.body.deleted_attachments === 'number') {
          deletedIds = [req.body.deleted_attachments];
        } else if (Array.isArray(req.body.deleted_attachments)) {
          deletedIds = req.body.deleted_attachments;
        }
      }

      if (Array.isArray(deletedIds) && deletedIds.length > 0) {
        // Optional: Fetch file paths to delete physical files if needed
        // const [filesToDelete] = await conn.query('SELECT file_path FROM tbl_payment_attachments WHERE id IN (?) AND payment_id = ?', [deletedIds, existingPayment.id]);

        await conn.query('DELETE FROM tbl_payment_attachments WHERE id IN (?) AND payment_id = ?', [deletedIds, existingPayment.id]);
      }
    }

    // Handle attachments (add new ones, existing ones remain)
    if (req.files && req.files.length > 0) {
      const attachmentValues = req.files.map(f => [
        existingPayment.id,
        f.originalname || 'attachment',
        relPath(f),
        f.mimetype || null
      ]);
      await conn.query(`
        INSERT INTO tbl_payment_attachments (payment_id, file_name, file_path, mime_type)
        VALUES ?
      `, [attachmentValues]);
    }

    // Log history - STATUS_CHANGED if status changed, otherwise UPDATED
    const oldStatusId = existingPayment.status_id;
    const newStatusId = 3; // Always reset to DRAFT on update

    if (oldStatusId !== newStatusId) {
      // Fetch status names for history
      const [fromStatusRows] = await conn.query(`SELECT name FROM status WHERE id = ? LIMIT 1`, [oldStatusId]);
      const [toStatusRows] = await conn.query(`SELECT name FROM status WHERE id = ? LIMIT 1`, [newStatusId]);

      const fromStatusName = fromStatusRows[0]?.name || 'N/A';
      const toStatusName = toStatusRows[0]?.name || 'Draft';

      await conn.query(`
        INSERT INTO history (module, module_id, user_id, action, details)
        VALUES (?, ?, ?, ?, ?)
      `, [
        'inward_payment',
        existingPayment.id,
        userId,
        'STATUS_CHANGED',
        JSON.stringify({
          from_status_id: oldStatusId,
          to_status_id: newStatusId,
          from_status_name: fromStatusName,
          to_status_name: toStatusName,
          reason: 'Payment updated - reset to Draft'
        })
      ]);
    }

    // Log history - UPDATED
    await conn.query(`
      INSERT INTO history (module, module_id, user_id, action, details)
      VALUES (?, ?, ?, ?, ?)
    `, [
      'inward_payment',
      existingPayment.id,
      userId,
      'UPDATED',
      JSON.stringify({ payment_number: existingPayment.payment_number })
    ]);

    await conn.commit();

    // Fetch and return updated payment
    const [updatedPayment] = await db.promise().query(`
      SELECT 
        p.*,
        pt.id AS payment_type_id, pt.name AS payment_type_name, pt.code AS payment_type_code,
        v.display_name AS customer_name,
        s.name AS status_name,
        s.bg_colour AS status_bg_colour,
        s.colour AS status_colour
      FROM tbl_payment p
      LEFT JOIN payment_type pt ON pt.id = p.payment_type_id
      LEFT JOIN vendor v ON v.id = p.party_id
      LEFT JOIN status s ON s.id = p.status_id
      WHERE p.id = ?
    `, [existingPayment.id]);

    res.json(updatedPayment[0] || { id: existingPayment.id, message: 'Payment updated successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error updating inward payment:', e);
    res.status(500).json(errPayload('Failed to update payment', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// POST /api/payments/inward/:id/approve - Approve payment (creates ledger + updates invoices)
router.post('/payments/inward/:id/approve', requireAuth, requirePerm('CUSTOMER_PAYMENT', 'approve'), async (req, res) => {
  const conn = await db.promise().getConnection();
  const userId = req.session?.user?.id;

  try {
    await conn.beginTransaction();

    const { id } = req.params;
    const { comment, reconcile_date, reconcile_number } = req.body;

    // Validate mandatory reconcile fields
    if (!reconcile_date || !reconcile_date.trim()) {
      await conn.rollback();
      return res.status(400).json(errPayload('Reconcile date is required for approval', 'VALIDATION_ERROR'));
    }

    if (!reconcile_number || !reconcile_number.trim()) {
      await conn.rollback();
      return res.status(400).json(errPayload('Reconcile number is required for approval', 'VALIDATION_ERROR'));
    }
    const isNumeric = /^\d+$/.test(id);
    const whereField = isNumeric ? 'id' : 'payment_uniqid';

    // Get payment
    const [payments] = await conn.query(`
      SELECT * FROM tbl_payment WHERE ${whereField} = ? AND direction = 'IN' AND party_type = 'CUSTOMER'
    `, [id]);

    if (payments.length === 0) {
      await conn.rollback();
      return res.status(404).json(errPayload('Payment not found', 'NOT_FOUND'));
    }

    const payment = payments[0];

    // Validate status is Submitted for Approval (8)
    if (payment.status_id !== 8) {
      await conn.rollback();
      return res.status(400).json(errPayload('Only payments submitted for approval can be approved', 'VALIDATION_ERROR'));
    }

    // Get allocations
    const [allocations] = await conn.query(`
      SELECT * FROM tbl_payment_allocation WHERE payment_id = ?
    `, [payment.id]);

    if (allocations.length === 0) {
      await conn.rollback();
      return res.status(400).json(errPayload('Payment has no allocations', 'VALIDATION_ERROR'));
    }

    // Validate allocations don't exceed outstanding (re-check at approval time)
    for (const alloc of allocations) {
      if (alloc.alloc_type === 'invoice' && alloc.invoice_id) {
        const [invoices] = await conn.query(`
          SELECT 
            ai.total,
            ai.currency_id as invoice_currency_id,
            COALESCE(
              (SELECT SUM(
                CASE 
                  WHEN p.currency_id = ai.currency_id THEN pa.amount_bank
                  ELSE pa.amount_base
                END
              )
               FROM tbl_payment_allocation pa
               INNER JOIN tbl_payment p ON p.id = pa.payment_id
               WHERE pa.alloc_type = 'invoice' AND pa.reference_id = ai.id
                 AND (p.is_deleted = 0 OR p.is_deleted IS NULL)
                 AND p.direction = 'IN'), 
              0
            ) as received_amount
          FROM ar_invoices ai
          WHERE ai.id = ?
        `, [alloc.invoice_id]);

        if (invoices.length === 0) {
          await conn.rollback();
          return res.status(404).json(errPayload(`Invoice ${alloc.invoice_id} not found`, 'NOT_FOUND'));
        }

        const invoice = invoices[0];
        const outstanding = parseFloat(invoice.total) - parseFloat(invoice.received_amount);

        if (parseFloat(alloc.amount_base) > outstanding + 0.01) {
          await conn.rollback();
          return res.status(400).json(errPayload(`Allocation exceeds outstanding for invoice ${alloc.invoice_id}`, 'VALIDATION_ERROR'));
        }
      }
    }

    // Determine account (bank or cash) for GL entry
    let accountCoaId = null;

    if (payment.payment_type === 'CASH') {
      // Find Cash in Hand account directly from chart of accounts
      const [cashCoa] = await conn.query(`
        SELECT id 
        FROM acc_chart_accounts 
        WHERE name LIKE '%Cash%' OR id = 3
        ORDER BY CASE WHEN id = 3 THEN 0 ELSE 1 END, id
        LIMIT 1
      `);

      if (cashCoa.length > 0) {
        accountCoaId = cashCoa[0].id;
      }

      if (!accountCoaId) {
        await conn.rollback();
        return res.status(400).json(errPayload('Cash in Hand account not found in chart of accounts. Please configure a Cash account.', 'VALIDATION_ERROR'));
      }
    } else {
      // For CHEQUE and TT we use the selected bank account's COA
      const accountId = payment.bank_account_id || payment.cash_account_id;

      if (!accountId) {
        await conn.rollback();
        return res.status(400).json(errPayload('Bank account is required for non-cash payments', 'VALIDATION_ERROR'));
      }

      const [[account]] = await conn.query(`
        SELECT coa_id FROM acc_bank_details WHERE id = ?
      `, [accountId]);

      if (!account || !account.coa_id) {
        await conn.rollback();
        return res.status(400).json(errPayload('Selected bank account does not have a chart of accounts head configured', 'VALIDATION_ERROR'));
      }

      accountCoaId = account.coa_id;
    }

    // Get Accounts Receivable (A/R) account from chart of accounts
    // Try to get by name "Accounts Receivable (A/R)" or fallback to id 1
    const [arAccounts] = await conn.query(`
      SELECT id 
      FROM acc_chart_accounts 
      WHERE name LIKE '%Accounts Receivable%' OR id = 1
      LIMIT 1
    `);
    const arAccountId = arAccounts.length > 0 ? arAccounts[0].id : 1;

    if (!arAccountId) {
      await conn.rollback();
      return res.status(400).json(errPayload('Accounts Receivable account not found in chart of accounts', 'VALIDATION_ERROR'));
    }

    // Before creating a new GL journal, soft-delete any existing journal for this payment
    await conn.query(`
      UPDATE gl_journals 
      SET is_deleted = 1 
      WHERE source_type = 'INWARD_PAYMENT' AND source_id = ?
    `, [payment.id]);

    // Prepare currency fields for GL journal
    let journalCurrencyId = payment.currency_id || null;
    let journalExchangeRate = null;
    let journalForeignAmount = parseFloat(payment.total_amount_bank || 0);
    let journalTotalAmount = parseFloat(payment.total_amount_base || 0);

    // Derive FX and currency_id from bank account if available
    if (payment.payment_type !== 'CASH') {
      const accountId = payment.bank_account_id || payment.cash_account_id;
      if (accountId) {
        const [[account]] = await conn.query(`
          SELECT id, currency_code, acc_currency 
          FROM acc_bank_details 
          WHERE id = ?
        `, [accountId]);

        if (account) {
          if (!journalCurrencyId) {
            journalCurrencyId = account.acc_currency || null;
            if (!journalCurrencyId && account.currency_code) {
              try {
                const [[curr]] = await conn.query(`SELECT id FROM currency WHERE name = ? LIMIT 1`, [account.currency_code]);
                if (curr && curr.id) journalCurrencyId = curr.id;
              } catch (e) {
                console.warn('Error resolving currency for GL journal:', e);
              }
            }
          }

          const fxRate = await getBankExchangeRate(accountId, payment.transaction_date);
          journalExchangeRate = fxRate && parseFloat(fxRate) > 0 ? parseFloat(fxRate) : 1.0;
        }
      }
    }

    // Fallbacks if FX not resolved
    if (!journalExchangeRate || journalExchangeRate <= 0) {
      journalExchangeRate = payment.fx_rate && parseFloat(payment.fx_rate) > 0
        ? parseFloat(payment.fx_rate)
        : 1.0;
    }

    // Create separate GL journal lines for each allocation
    // Each allocation gets a pair of lines: Bank/Cash debit and AR credit
    const journalLines = [];

    for (const alloc of allocations) {
      const allocForeignAmount = parseFloat(alloc.amount_bank || 0);

      // Determine invoice_id and is_advance based on allocation type
      let invoiceId = null;
      let isAdvance = 0;

      if (alloc.alloc_type === 'invoice') {
        // Balance allocation - use reference_id as invoice_id
        invoiceId = alloc.reference_id || null;
        isAdvance = 0;
      } else if (alloc.alloc_type === 'advance') {
        // Advance allocation - save proforma_id (reference_id) in invoice_id field
        invoiceId = alloc.reference_id || null;
        isAdvance = 1;
      }

      // Build description based on allocation type
      let allocDescription = '';
      if (alloc.alloc_type === 'invoice' && invoiceId) {
        const [invoiceInfo] = await conn.query(`
          SELECT invoice_number FROM ar_invoices WHERE id = ?
        `, [invoiceId]);
        const invoiceNumber = invoiceInfo.length > 0 ? invoiceInfo[0].invoice_number : `Invoice #${invoiceId}`;
        allocDescription = `Invoice payment ${invoiceNumber} - ${payment.payment_number}`;
      } else if (alloc.alloc_type === 'advance' && alloc.reference_id) {
        const [proformaInfo] = await conn.query(`
          SELECT proforma_invoice_no FROM proforma_invoice WHERE id = ?
        `, [alloc.reference_id]);
        const proformaNumber = proformaInfo.length > 0 ? proformaInfo[0].proforma_invoice_no : `Proforma #${alloc.reference_id}`;
        allocDescription = `Advance payment ${proformaNumber} - ${payment.payment_number}`;
      } else {
        allocDescription = `Payment allocation - ${payment.payment_number}`;
      }

      // Add Bank/Cash debit line for this allocation
      journalLines.push({
        account_id: accountCoaId,
        debit: allocForeignAmount,
        credit: 0,
        description: allocDescription,
        buyer_id: payment.party_id,
        invoice_id: invoiceId,
        is_advance: isAdvance
      });

      // Add AR credit line for this allocation
      journalLines.push({
        account_id: arAccountId,
        debit: 0,
        credit: allocForeignAmount,
        description: allocDescription,
        buyer_id: payment.party_id,
        invoice_id: invoiceId,
        is_advance: isAdvance
      });
    }

    // Create GL journal entry with multiple lines (one pair per allocation)
    await glService.createJournal(conn, {
      source_type: 'INWARD_PAYMENT',
      source_id: payment.id,
      journal_date: payment.transaction_date,
      memo: `Inward Payment ${payment.payment_number}`,
      created_by: userId,
      currency_id: journalCurrencyId,
      exchange_rate: journalExchangeRate,
      foreign_amount: journalForeignAmount,
      total_amount: journalTotalAmount,
      source_name: payment.payment_number,
      source_date: payment.transaction_date,
      reconcile_date: reconcile_date || null,
      reconcile_number: reconcile_number || null,
      lines: journalLines
    });

    // Update payment status to APPROVED (1) with reconcile fields
    await conn.query(`
      UPDATE tbl_payment 
      SET status_id = 1, approved_by = ?, approved_at = NOW(), edit_request_status = 0, 
          reconcile_date = ?, reconcile_number = ?
      WHERE id = ?
    `, [userId, reconcile_date, reconcile_number.trim(), payment.id]);

    // Add history entry with approval comment
    await conn.query(`
      INSERT INTO history (module, module_id, user_id, action, details)
      VALUES (?, ?, ?, ?, ?)
    `, [
      'inward_payment',
      payment.id,
      userId,
      'APPROVED',
      JSON.stringify({
        comment: comment || 'No comment provided.',
        payment_number: payment.payment_number
      })
    ]);

    // Update outstanding_amount and open_balance for all invoices affected by this payment
    const invoiceIds = allocations
      .filter(a => a.alloc_type === 'invoice' && a.reference_id)
      .map(a => a.reference_id);
    for (const invoiceId of invoiceIds) {
      await updateInvoiceOutstanding(conn, invoiceId, payment.currency_id);
    }

    // Update open_balance for all proforma invoices affected by this payment
    const proformaIds = allocations
      .filter(a => a.alloc_type === 'advance' && a.reference_id)
      .map(a => a.reference_id);
    for (const proformaId of proformaIds) {
      await updateProformaOpenBalance(conn, proformaId, payment.currency_id);
    }

    await conn.commit();

    // Fetch and return updated payment
    const [updatedPayment] = await conn.query(`
      SELECT * FROM tbl_payment WHERE id = ?
    `, [payment.id]);

    res.json(updatedPayment[0]);
  } catch (e) {
    await conn.rollback();
    console.error('Error approving payment:', e);
    res.status(500).json(errPayload('Failed to approve payment', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// PUT /api/payments/inward/:id/status - Update payment status
router.put('/payments/inward/:id/status', requireAuth, requirePerm('Sales', 'edit'), async (req, res) => {
  const conn = await db.promise().getConnection();
  const userId = req.session?.user?.id;

  try {
    await conn.beginTransaction();

    const { id } = req.params;
    const { status_id, reason, comment } = req.body;

    if (!status_id) {
      await conn.rollback();
      return res.status(400).json(errPayload('status_id is required', 'VALIDATION_ERROR'));
    }

    const isNumeric = /^\d+$/.test(id);
    const whereField = isNumeric ? 'id' : 'payment_uniqid';

    // Get payment
    const [payments] = await conn.query(`
      SELECT id, status_id FROM tbl_payment 
      WHERE ${whereField} = ? AND direction = 'IN' AND party_type = 'CUSTOMER'
    `, [id]);

    if (payments.length === 0) {
      await conn.rollback();
      return res.status(404).json(errPayload('Payment not found', 'NOT_FOUND'));
    }

    const payment = payments[0];
    const oldStatusId = payment.status_id;
    const newStatusId = parseInt(status_id, 10);

    // Allow status change from DRAFT (3) to SUBMITTED_FOR_APPROVAL (8)
    // Or from SUBMITTED_FOR_APPROVAL (8) to REJECTED (2)
    if (oldStatusId === 3 && newStatusId === 8) {
      // Allow: DRAFT -> SUBMITTED_FOR_APPROVAL
    } else if (oldStatusId === 8 && newStatusId === 2) {
      // Allow: SUBMITTED_FOR_APPROVAL -> REJECTED
    } else {
      await conn.rollback();
      return res.status(400).json(errPayload('Invalid status transition. Only DRAFT to SUBMITTED_FOR_APPROVAL or SUBMITTED_FOR_APPROVAL to REJECTED is allowed', 'VALIDATION_ERROR'));
    }

    // Fetch status names for history
    const [fromStatusRows] = await conn.query(`SELECT name, colour, bg_colour FROM status WHERE id = ? LIMIT 1`, [oldStatusId]);
    const [toStatusRows] = await conn.query(`SELECT name, colour, bg_colour FROM status WHERE id = ? LIMIT 1`, [newStatusId]);

    const fromStatusName = fromStatusRows[0]?.name || 'N/A';
    const toStatusName = toStatusRows[0]?.name || 'N/A';

    // Update status
    await conn.query(`
      UPDATE tbl_payment SET status_id = ? WHERE id = ?
    `, [newStatusId, payment.id]);

    // Add history entry
    const action = (oldStatusId === 8 && newStatusId === 2) ? 'REJECTED' : 'STATUS_CHANGED';
    const historyDetails = (oldStatusId === 8 && newStatusId === 2)
      ? JSON.stringify({
        reason: reason || comment || 'No reason provided.',
        comment: comment || reason || null,
        from_status_id: oldStatusId,
        to_status_id: newStatusId,
        from_status_name: fromStatusName,
        to_status_name: toStatusName
      })
      : JSON.stringify({
        from_status_id: oldStatusId,
        to_status_id: newStatusId,
        from_status_name: fromStatusName,
        to_status_name: toStatusName
      });

    await conn.query(`
      INSERT INTO history (module, module_id, user_id, action, details)
      VALUES (?, ?, ?, ?, ?)
    `, [
      'inward_payment',
      payment.id,
      userId,
      action,
      historyDetails
    ]);

    await conn.commit();

    res.json({
      status_id: newStatusId,
      status_name: toStatusRows[0]?.name || 'N/A',
      status_colour: toStatusRows[0]?.colour || null,
      status_bg_colour: toStatusRows[0]?.bg_colour || null
    });
  } catch (e) {
    await conn.rollback();
    console.error('Error updating payment status:', e);
    res.status(500).json(errPayload('Failed to update payment status', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// POST /api/payments/inward/:id/request-edit - Request edit for approved payment
router.post('/payments/inward/:id/request-edit', requireAuth, async (req, res) => {
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

    const isNumeric = /^\d+$/.test(id);
    const whereField = isNumeric ? 'id' : 'payment_uniqid';

    // Get payment
    const [payments] = await conn.query(`
      SELECT id, status_id, edit_request_status 
      FROM tbl_payment 
      WHERE ${whereField} = ? AND direction = 'IN' AND party_type = 'CUSTOMER'
    `, [id]);

    if (payments.length === 0) {
      await conn.rollback();
      return res.status(404).json(errPayload('Payment not found', 'NOT_FOUND'));
    }

    const payment = payments[0];

    // Only allow edit requests for APPROVED payments (status_id = 1)
    if (payment.status_id !== 1) {
      await conn.rollback();
      return res.status(400).json(errPayload('Only approved payments can have edit requests', 'VALIDATION_ERROR'));
    }

    // Prevent new requests if one is already pending (3)
    if (payment.edit_request_status === 3) {
      await conn.rollback();
      return res.status(400).json(errPayload('An edit request is already pending for this payment', 'VALIDATION_ERROR'));
    }

    // Update payment with edit request
    await conn.query(`
      UPDATE tbl_payment SET 
        edit_request_status = 3,
        edit_requested_by = ?,
        edit_requested_at = NOW(),
        edit_request_reason = ?,
        edit_approved_by = NULL,
        edit_approved_at = NULL,
        edit_rejection_reason = NULL
      WHERE id = ?
    `, [userId, reason.trim(), payment.id]);

    // Add history entry
    await conn.query(`
      INSERT INTO history (module, module_id, user_id, action, details)
      VALUES (?, ?, ?, ?, ?)
    `, [
      'inward_payment',
      payment.id,
      userId,
      'EDIT_REQUESTED',
      JSON.stringify({ reason: reason.trim() })
    ]);

    await conn.commit();
    res.json({ success: true, message: 'Edit request submitted successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error requesting edit for payment:', e);
    res.status(500).json(errPayload('Failed to submit edit request', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// POST /api/payments/inward/:id/decide-edit-request - Approve/reject edit request
router.post('/payments/inward/:id/decide-edit-request', requireAuth, requirePerm('CUSTOMER_PAYMENT', 'approve'), async (req, res) => {
  const conn = await db.promise().getConnection();
  const userId = req.session?.user?.id;

  try {
    await conn.beginTransaction();

    const { id } = req.params;
    const { decision, reason, reconcile_date, reconcile_number } = req.body;

    if (!userId) {
      await conn.rollback();
      return res.status(401).json(errPayload('Authentication required', 'AUTH_ERROR'));
    }

    if (!decision || !['approve', 'reject'].includes(decision)) {
      await conn.rollback();
      return res.status(400).json(errPayload('Decision must be "approve" or "reject"', 'VALIDATION_ERROR'));
    }

    const isNumeric = /^\d+$/.test(id);
    const whereField = isNumeric ? 'id' : 'payment_uniqid';

    // Get payment
    const [payments] = await conn.query(`
      SELECT id, status_id, edit_request_status 
      FROM tbl_payment 
      WHERE ${whereField} = ? AND direction = 'IN' AND party_type = 'CUSTOMER'
    `, [id]);

    if (payments.length === 0) {
      await conn.rollback();
      return res.status(404).json(errPayload('Payment not found', 'NOT_FOUND'));
    }

    const payment = payments[0];

    // Only allow decisions on pending edit requests (edit_request_status = 3)
    if (payment.edit_request_status !== 3) {
      await conn.rollback();
      return res.status(400).json(errPayload('No pending edit request found for this payment', 'VALIDATION_ERROR'));
    }

    // Update payment based on decision
    if (decision === 'approve') {
      // Build update query with optional reconcile fields
      const updateFields = [
        'edit_request_status = 1',
        'edit_approved_by = ?',
        'edit_approved_at = NOW()',
        'edit_rejection_reason = NULL'
      ];
      const updateValues = [userId];

      // Include reconcile fields if provided
      if (reconcile_date) {
        updateFields.push('reconcile_date = ?');
        updateValues.push(reconcile_date);
      }
      if (reconcile_number) {
        updateFields.push('reconcile_number = ?');
        updateValues.push(reconcile_number);
      }

      updateValues.push(payment.id);

      await conn.query(`
        UPDATE tbl_payment SET 
          ${updateFields.join(', ')}
        WHERE id = ?
      `, updateValues);

      // Add history entry
      await conn.query(`
        INSERT INTO history (module, module_id, user_id, action, details)
        VALUES (?, ?, ?, ?, ?)
      `, [
        'inward_payment',
        payment.id,
        userId,
        'EDIT_APPROVED',
        JSON.stringify({ reason: reason || null })
      ]);
    } else {
      await conn.query(`
        UPDATE tbl_payment SET 
          edit_request_status = 2,
          edit_approved_by = NULL,
          edit_approved_at = NULL,
          edit_rejection_reason = ?
        WHERE id = ?
      `, [reason || 'No reason provided.', payment.id]);

      // Add history entry
      await conn.query(`
        INSERT INTO history (module, module_id, user_id, action, details)
        VALUES (?, ?, ?, ?, ?)
      `, [
        'inward_payment',
        payment.id,
        userId,
        'EDIT_REJECTED',
        JSON.stringify({ reason: reason || 'No reason provided.' })
      ]);
    }

    await conn.commit();
    res.json({
      success: true,
      message: `Edit request ${decision === 'approve' ? 'approved' : 'rejected'} successfully`,
      edit_request_status: decision === 'approve' ? 1 : 2
    });
  } catch (e) {
    await conn.rollback();
    console.error('Error deciding edit request for payment:', e);
    res.status(500).json(errPayload('Failed to process edit request decision', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// GET /api/payments/inward/:id/attachments - Get payment attachments
router.get('/payments/inward/:id/attachments', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const isNumeric = /^\d+$/.test(id);
    const whereField = isNumeric ? 'id' : 'payment_uniqid';

    const [payments] = await db.promise().query(`
      SELECT id FROM tbl_payment WHERE ${whereField} = ? AND direction = 'IN' AND party_type = 'CUSTOMER' AND (is_deleted = 0 OR is_deleted IS NULL)
    `, [id]);

    if (payments.length === 0) {
      return res.status(404).json(errPayload('Payment not found', 'NOT_FOUND'));
    }

    const [attachments] = await db.promise().query(`
      SELECT id, file_name, file_path, mime_type, size_bytes, created_at
      FROM tbl_payment_attachments
      WHERE payment_id = ?
      ORDER BY created_at DESC
    `, [payments[0].id]);

    res.json(attachments || []);
  } catch (e) {
    console.error('Error fetching attachments:', e);
    res.status(500).json(errPayload('Failed to fetch attachments', 'DB_ERROR', e.message));
  }
});

// POST /api/payments/inward/:id/attachments - Add attachments to payment
router.post('/payments/inward/:id/attachments', requireAuth, requirePerm('Sales', 'edit'), paymentUpload, async (req, res) => {
  const conn = await db.promise().getConnection();
  const userId = req.user?.id ?? req.session?.user?.id;

  try {
    await conn.beginTransaction();

    const { id } = req.params;
    const isNumeric = /^\d+$/.test(id);
    const whereField = isNumeric ? 'id' : 'payment_uniqid';

    const [payments] = await conn.query(`
      SELECT id FROM tbl_payment WHERE ${whereField} = ? AND direction = 'IN' AND party_type = 'CUSTOMER'
    `, [id]);

    if (payments.length === 0) {
      await conn.rollback();
      return res.status(404).json(errPayload('Payment not found', 'NOT_FOUND'));
    }

    const paymentId = payments[0].id;

    if (!req.files || req.files.length === 0) {
      await conn.rollback();
      return res.status(400).json(errPayload('No files were uploaded', 'VALIDATION_ERROR'));
    }

    const attachmentValues = req.files.map(f => [
      paymentId,
      f.originalname || 'attachment',
      relPath(f),
      f.mimetype || null
    ]);
    await conn.query(`
      INSERT INTO tbl_payment_attachments (payment_id, file_name, file_path, mime_type)
      VALUES ?
    `, [attachmentValues]);

    await conn.commit();
    res.status(201).json({ success: true, message: 'Attachments added successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error adding attachments:', e);
    res.status(500).json(errPayload('Failed to add attachments', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// GET /api/payments/inward/:id/journal-entries - Get GL journal entries for payment
router.get('/payments/inward/:id/journal-entries', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const isNumeric = /^\d+$/.test(id);
    const whereField = isNumeric ? 'id' : 'payment_uniqid';

    const [payments] = await db.promise().query(`
      SELECT id FROM tbl_payment WHERE ${whereField} = ? AND direction = 'IN' AND party_type = 'CUSTOMER' AND (is_deleted = 0 OR is_deleted IS NULL)
    `, [id]);

    if (payments.length === 0) {
      return res.status(404).json(errPayload('Payment not found', 'NOT_FOUND'));
    }

    const paymentId = payments[0].id;

    // Fetch GL journal entries for this payment (non-deleted journals and lines)
    const [journalEntries] = await db.promise().query(`
      SELECT 
        gj.id as journal_id,
        gj.journal_number,
        gj.journal_date,
        gj.memo,
        gj.source_name,
        gj.source_date,
        gj.currency_id as journal_currency_id,
        gj.exchange_rate,
        gj.foreign_amount,
        gj.total_amount,
        gjl.id as line_id,
        gjl.line_no,
        gjl.account_id,
        gjl.debit,
        gjl.credit,
        gjl.description,
        gjl.buyer_id,
        gjl.invoice_id,
        acc.name as account_name,
        c.name as currency_code
      FROM gl_journals gj
      INNER JOIN gl_journal_lines gjl ON gjl.journal_id = gj.id
      LEFT JOIN acc_chart_accounts acc ON acc.id = gjl.account_id
      LEFT JOIN currency c ON c.id = gj.currency_id
      WHERE gj.source_type = 'INWARD_PAYMENT'
        AND gj.source_id = ?
        AND (gj.is_deleted = 0 OR gj.is_deleted IS NULL)
      ORDER BY gj.journal_date DESC, gj.id DESC, gjl.line_no ASC
    `, [paymentId]);

    res.json({ data: journalEntries || [] });
  } catch (e) {
    console.error('Error fetching journal entries:', e);
    res.status(500).json(errPayload('Failed to fetch journal entries', 'DB_ERROR', e.message));
  }
});

// GET /api/payments/inward/:id/history - Get payment history
router.get('/payments/inward/:id/history', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const isNumeric = /^\d+$/.test(id);
    const whereField = isNumeric ? 'id' : 'payment_uniqid';

    const [payments] = await db.promise().query(`
      SELECT id FROM tbl_payment WHERE ${whereField} = ? AND direction = 'IN' AND party_type = 'CUSTOMER' AND (is_deleted = 0 OR is_deleted IS NULL)
    `, [id]);

    if (payments.length === 0) {
      return res.status(404).json(errPayload('Payment not found', 'NOT_FOUND'));
    }

    const paymentId = payments[0].id;

    const [history] = await db.promise().query(`
      SELECT 
        h.id,
        h.action,
        h.details,
        h.created_at,
        u.name AS user_name
      FROM history h
      LEFT JOIN user u ON u.id = h.user_id
      WHERE h.module = 'inward_payment' AND h.module_id = ?
      ORDER BY h.created_at DESC
    `, [paymentId]);

    res.json(history || []);
  } catch (e) {
    console.error('Error fetching history:', e);
    res.status(500).json(errPayload('Failed to fetch history', 'DB_ERROR', e.message));
  }
});

// DELETE /api/payments/inward/:id/attachments/:attachmentId - Delete attachment
router.delete('/payments/inward/:id/attachments/:attachmentId', requireAuth, requirePerm('Sales', 'delete'), async (req, res) => {
  const conn = await db.promise().getConnection();
  const userId = req.session?.user?.id;

  try {
    await conn.beginTransaction();

    const { id, attachmentId } = req.params;
    const isNumeric = /^\d+$/.test(id);
    const whereField = isNumeric ? 'id' : 'payment_uniqid';

    const [payments] = await conn.query(`
      SELECT id FROM tbl_payment WHERE ${whereField} = ? AND direction = 'IN' AND party_type = 'CUSTOMER' AND (is_deleted = 0 OR is_deleted IS NULL)
    `, [id]);

    if (payments.length === 0) {
      await conn.rollback();
      return res.status(404).json(errPayload('Payment not found', 'NOT_FOUND'));
    }

    const paymentId = payments[0].id;

    // Check if attachment exists and belongs to this payment
    const [attachments] = await conn.query(`
      SELECT id, file_name FROM tbl_payment_attachments WHERE id = ? AND payment_id = ?
    `, [attachmentId, paymentId]);

    if (attachments.length === 0) {
      await conn.rollback();
      return res.status(404).json(errPayload('Attachment not found', 'NOT_FOUND'));
    }

    // Delete attachment
    await conn.query(`
      DELETE FROM tbl_payment_attachments WHERE id = ?
    `, [attachmentId]);

    // Log history
    await conn.query(`
      INSERT INTO history (module, module_id, user_id, action, details)
      VALUES (?, ?, ?, ?, ?)
    `, [
      'inward_payment',
      paymentId,
      userId,
      'ATTACHMENT_DELETED',
      JSON.stringify({ attachment_id: attachmentId, file_name: attachments[0].file_name })
    ]);

    await conn.commit();
    res.json({ success: true, message: 'Attachment deleted successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error deleting attachment:', e);
    res.status(500).json(errPayload('Failed to delete attachment', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// DELETE /api/payments/inward/:id - Delete payment (soft delete)
router.delete('/payments/inward/:id', requireAuth, requirePerm('Sales', 'delete'), async (req, res) => {
  const conn = await db.promise().getConnection();
  const userId = req.session?.user?.id;

  try {
    await conn.beginTransaction();

    const { id } = req.params;
    const isNumeric = /^\d+$/.test(id);
    const whereField = isNumeric ? 'id' : 'payment_uniqid';

    const [payments] = await conn.query(`
      SELECT id, payment_number, status_id FROM tbl_payment 
      WHERE ${whereField} = ? AND direction = 'IN' AND party_type = 'CUSTOMER' AND (is_deleted = 0 OR is_deleted IS NULL)
    `, [id]);

    if (payments.length === 0) {
      await conn.rollback();
      return res.status(404).json(errPayload('Payment not found', 'NOT_FOUND'));
    }

    const payment = payments[0];

    // Only allow deletion of DRAFT payments
    if (payment.status_id !== 3) {
      await conn.rollback();
      return res.status(400).json(errPayload('Only draft payments can be deleted', 'VALIDATION_ERROR'));
    }

    // Soft delete payment
    await conn.query(`
      UPDATE tbl_payment SET is_deleted = 1, updated_by = ?, updated_at = NOW() WHERE id = ?
    `, [userId, payment.id]);

    // Soft delete associated GL journals if any
    await conn.query(`
      UPDATE gl_journals SET is_deleted = 1 
      WHERE source_type = 'INWARD_PAYMENT' AND source_id = ?
    `, [payment.id]);

    // Log history
    await conn.query(`
      INSERT INTO history (module, module_id, user_id, action, details)
      VALUES (?, ?, ?, ?, ?)
    `, [
      'inward_payment',
      payment.id,
      userId,
      'DELETED',
      JSON.stringify({ payment_number: payment.payment_number })
    ]);

    await conn.commit();
    res.json({ success: true, message: 'Payment deleted successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error deleting payment:', e);
    res.status(500).json(errPayload('Failed to delete payment', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

export default router;
