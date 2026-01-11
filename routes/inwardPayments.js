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

// Helper function to update invoice outstanding balance
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
         WHERE pa.invoice_id = ai.id 
           AND (p.is_deleted = 0 OR p.is_deleted IS NULL)), 
        0
      ) as received_amount
    FROM ar_invoices ai
    WHERE ai.id = ?
  `, [paymentCurrencyId, invoiceId]);

  if (invoiceData.length > 0) {
    const invoice = invoiceData[0];
    const outstanding = parseFloat(invoice.total) - parseFloat(invoice.received_amount);
    // Update outstanding_amount in ar_invoices if column exists, otherwise calculate on-the-fly
    await conn.query(`
      UPDATE ar_invoices 
      SET outstanding_amount = ? 
      WHERE id = ?
    `, [outstanding, invoiceId]);
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
    const [invoices] = await conn.query(`
      SELECT 
        ai.id,
        ai.invoice_number,
        ai.invoice_date,
        ai.due_date,
        ai.total,
        ai.currency_id,
        c.name AS currency_code,
        COALESCE(
          (SELECT SUM(
            CASE 
              WHEN p.currency_id = ai.currency_id THEN pa.amount_bank
              ELSE pa.amount_base
            END
          )
           FROM tbl_payment_allocation pa
           INNER JOIN tbl_payment p ON p.id = pa.payment_id
           WHERE pa.invoice_id = ai.id 
             AND (p.is_deleted = 0 OR p.is_deleted IS NULL)), 
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
           WHERE pa.invoice_id = ai.id 
             AND (p.is_deleted = 0 OR p.is_deleted IS NULL)), 
          0
        )) as outstanding_amount
      FROM ar_invoices ai
      LEFT JOIN currency c ON c.id = ai.currency_id
      WHERE ai.customer_id = ? 
        AND ai.status_id = 1
        ${currencyFilter}
      HAVING outstanding_amount > 0.01
      ORDER BY ai.invoice_date ASC
    `, params);
    
    // Update outstanding_amount field in ar_invoices table for each invoice
    for (const invoice of invoices) {
      await conn.query(`
        UPDATE ar_invoices 
        SET outstanding_amount = ? 
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
        edit_req_user.name AS edit_requested_by_name
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
        ai.invoice_number,
        ai.invoice_date,
        ai.total AS invoice_total,
        ai.currency_id AS invoice_currency_id,
        ai.customer_id AS invoice_customer_id,
        c.name AS invoice_currency_code,
        v.display_name AS customer_name
      FROM tbl_payment_allocation pa
      LEFT JOIN ar_invoices ai ON ai.id = pa.invoice_id AND pa.alloc_type = 'invoice'
      LEFT JOIN currency c ON c.id = ai.currency_id
      LEFT JOIN vendor v ON v.id = COALESCE(pa.buyer_id, ai.customer_id)
      WHERE pa.payment_id = ?
    `, [payment.id]);
    
    payment.allocations = allocations || [];
    
    res.json(payment);
  } catch (e) {
    console.error('Error fetching payment:', e);
    res.status(500).json(errPayload('Failed to fetch payment', 'DB_ERROR', e.message));
  }
});

// POST /api/payments/inward - Create inward payment (DRAFT)
router.post('/payments/inward', requireAuth, requirePerm('Sales', 'create'), paymentUpload, async (req, res) => {
  const conn = await db.promise().getConnection();
  const userId = req.session?.user?.id;
  
  try {
    await conn.beginTransaction();
    
    // Parse FormData fields
    let allocations = [];
    try {
      allocations = req.body.allocations ? JSON.parse(req.body.allocations) : [];
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
        direction, party_type, party_id,
        currency_id, currency_code, total_amount_bank, total_amount_base, fx_rate,
        notes, status_id, user_id, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'IN', 'CUSTOMER', ?, ?, ?, ?, ?, ?, ?, 3, ?, ?, NOW())
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
               WHERE pa.invoice_id = ai.id 
                 AND (p.is_deleted = 0 OR p.is_deleted IS NULL)), 
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
      const { type, invoice_id, customer_id: allocCustomerId, amount } = alloc;
      const finalCustomerId = allocCustomerId || customer_id;
      
      if (!type || !amount) {
        await conn.rollback();
        return res.status(400).json(errPayload('Allocation type and amount are required', 'VALIDATION_ERROR'));
      }
      
      if (type === 'invoice' && !invoice_id) {
        await conn.rollback();
        return res.status(400).json(errPayload('Invoice ID is required for invoice allocations', 'VALIDATION_ERROR'));
      }
      
      // Validate invoice belongs to customer
      if (type === 'invoice' && invoice_id) {
        const [invoices] = await conn.query(`
          SELECT invoice_number FROM ar_invoices WHERE id = ? AND customer_id = ?
        `, [invoice_id, finalCustomerId]);
        
        if (invoices.length === 0) {
          await conn.rollback();
          return res.status(404).json(errPayload(`Invoice ${invoice_id} not found or does not belong to customer`, 'NOT_FOUND'));
        }
      }
      
      const allocAmount = parseFloat(amount);
      const allocAmountBase = allocAmount * effectiveFxRate;
      
      await conn.query(`
        INSERT INTO tbl_payment_allocation (
          payment_id, alloc_type, invoice_id, buyer_id, amount_bank, amount_base, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
      `, [
        paymentId, type, invoice_id || null, finalCustomerId, allocAmount, allocAmountBase, userId
      ]);
    }
    
    // Update outstanding_amount for all invoices affected by this payment
    const invoiceIds = allocations.filter(a => a.type === 'invoice' && a.invoice_id).map(a => a.invoice_id);
    for (const invoiceId of invoiceIds) {
      await updateInvoiceOutstanding(conn, invoiceId, currencyId);
    }
    
    // Handle attachments
    if (req.files && req.files.length > 0) {
      const attachmentValues = req.files.map(f => [
        paymentId,
        f.originalname,
        relPath(f),
        f.mimetype || null,
        f.size || null,
        userId
      ]);
      
      await conn.query(`
        INSERT INTO tbl_payment_attachments 
        (payment_id, file_name, file_path, mime_type, size_bytes, created_by, created_at)
        VALUES ?
      `, [attachmentValues.map(v => [...v, new Date()])]);
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

export default router;
