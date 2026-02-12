// server/routes/outwardPayments.js
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

// Helper function to update bill open balance
const updateBillOpenBalance = async (conn, billId, paymentCurrencyId = null) => {
  const [billData] = await conn.query(`
    SELECT 
      ab.total,
      ab.currency_id,
      COALESCE(
        (SELECT SUM(
          CASE 
            WHEN ? IS NOT NULL AND p.currency_id = ab.currency_id THEN pa.amount_bank
            ELSE pa.amount_base
          END
        )
         FROM tbl_payment_allocation pa
         INNER JOIN tbl_payment p ON p.id = pa.payment_id
         WHERE pa.bill_id = ab.id 
           AND (p.is_deleted = 0 OR p.is_deleted IS NULL)), 
        0
      ) as paid_amount
    FROM ap_bills ab
    WHERE ab.id = ?
  `, [paymentCurrencyId, billId]);

  if (billData.length > 0) {
    const bill = billData[0];
    const openBalance = parseFloat(bill.total) - parseFloat(bill.paid_amount);
    await conn.query(`
      UPDATE ap_bills 
      SET open_balance = ? 
      WHERE id = ?
    `, [openBalance, billId]);
  }
};

// Helper function to update PO open balance
const updatePOOpenBalance = async (conn, poId, paymentCurrencyId = null) => {
  const [poData] = await conn.query(`
    SELECT 
      po.total,
      po.currency_id,
      COALESCE(
        (SELECT SUM(
          CASE 
            WHEN ? IS NOT NULL AND p.currency_id = po.currency_id THEN pa.amount_bank
            ELSE pa.amount_base
          END
        )
         FROM tbl_payment_allocation pa
         INNER JOIN tbl_payment p ON p.id = pa.payment_id
         WHERE pa.po_id = po.id 
           AND pa.alloc_type = 'advance'
           AND (p.is_deleted = 0 OR p.is_deleted IS NULL)), 
        0
      ) as allocated_amount
    FROM purchase_orders po
    WHERE po.id = ?
  `, [paymentCurrencyId, poId]);

  if (poData.length > 0) {
    const po = poData[0];
    const openBalance = parseFloat(po.total) - parseFloat(po.allocated_amount);
    await conn.query(`
      UPDATE purchase_orders 
      SET open_balance = ? 
      WHERE id = ?
    `, [openBalance, poId]);
  }
};

// Helper function to generate payment number (PAY-OUT-000001 format)
const generatePaymentNumber = async (conn) => {
  const [rows] = await conn.query(`
    SELECT payment_number FROM tbl_payment 
    WHERE payment_number LIKE 'PAY-OUT-%' AND direction = 'OUT'
    ORDER BY payment_number DESC LIMIT 1
  `);
  
  if (rows.length === 0) {
    return 'PAY-OUT-000001';
  }
  
  const lastNumber = rows[0].payment_number;
  const match = lastNumber.match(/PAY-OUT-(\d+)/);
  if (match) {
    const num = parseInt(match[1], 10) + 1;
    return `PAY-OUT-${String(num).padStart(6, '0')}`;
  }
  
  return 'PAY-OUT-000001';
};

// GET /api/payments/vendors/search?q= - Search vendors
router.get('/payments/vendors/search', requireAuth, async (req, res) => {
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
      WHERE v.company_type_id = 1 
        AND v.is_deleted = 0
    `;
    const params = [];
    
    if (q && q.trim()) {
      query += ` AND (v.display_name LIKE ? OR v.company_name LIKE ?)`;
      params.push(searchTerm, searchTerm);
    }
    
    query += ` ORDER BY v.display_name ASC LIMIT 50`;
    
    const [vendors] = await db.promise().query(query, params);
    
    res.json(vendors || []);
  } catch (e) {
    console.error('Error searching vendors:', e);
    res.status(500).json(errPayload('Failed to search vendors', 'DB_ERROR', e.message));
  }
});

// GET /api/payments/vendor/:id/open-bills - Get open bills for a vendor
// Optional query param: currency_id - filter bills by currency (to match payment currency)
router.get('/payments/vendor/:id/open-bills', requireAuth, async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    const { id } = req.params;
    const { currency_id } = req.query;
    
    // Build WHERE clause - filter by currency if provided
    let currencyFilter = '';
    const params = [id];
    if (currency_id) {
      currencyFilter = ' AND ab.currency_id = ?';
      params.push(parseInt(currency_id));
    }
    
    // Calculate outstanding amount for each bill
    // Use amount_bank (payment currency) when payment currency matches bill currency
    // This ensures correct calculation for multi-currency scenarios
    const [bills] = await conn.query(`
      SELECT 
        ab.id,
        ab.bill_number,
        ab.bill_date,
        ab.due_date,
        ab.total,
        ab.currency_id,
        c.name AS currency_code,
        COALESCE(
          (SELECT SUM(
            CASE 
              WHEN p.currency_id = ab.currency_id THEN pa.amount_bank
              ELSE pa.amount_base
            END
          )
           FROM tbl_payment_allocation pa
           INNER JOIN tbl_payment p ON p.id = pa.payment_id
           WHERE pa.bill_id = ab.id 
             AND (p.is_deleted = 0 OR p.is_deleted IS NULL)), 
          0
        ) as paid_amount,
        (ab.total - COALESCE(
          (SELECT SUM(
            CASE 
              WHEN p.currency_id = ab.currency_id THEN pa.amount_bank
              ELSE pa.amount_base
            END
          )
           FROM tbl_payment_allocation pa
           INNER JOIN tbl_payment p ON p.id = pa.payment_id
           WHERE pa.bill_id = ab.id 
             AND (p.is_deleted = 0 OR p.is_deleted IS NULL)), 
          0
        )) as outstanding_amount
      FROM ap_bills ab
      LEFT JOIN currency c ON c.id = ab.currency_id
      WHERE ab.supplier_id = ? 
        AND ab.status_id = 1
        ${currencyFilter}
      HAVING outstanding_amount > 0.01
      ORDER BY ab.bill_date ASC
    `, params);
    
    // Update open_balance field in ap_bills table for each bill
    for (const bill of bills) {
      await conn.query(`
        UPDATE ap_bills 
        SET open_balance = ? 
        WHERE id = ?
      `, [bill.outstanding_amount, bill.id]);
    }
    
    res.json(bills || []);
  } catch (e) {
    console.error('Error fetching open bills:', e);
    res.status(500).json(errPayload('Failed to fetch open bills', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// GET /api/payments/outward - List outward payments
router.get('/payments/outward', requireAuth, async (req, res) => {
  try {
    const { page = 1, per_page = 25, search = '', status_id, edit_request_status } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(per_page);
    const searchTerm = `%${search}%`;
    
    let whereClause = "WHERE p.direction = 'OUT' AND p.party_type = 'SUPPLIER' AND (p.is_deleted = 0 OR p.is_deleted IS NULL)";
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
        v.display_name AS supplier_name,
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
    console.error('Error listing outward payments:', e);
    res.status(500).json(errPayload('Failed to list payments', 'DB_ERROR', e.message));
  }
});

// GET /api/payments/outward/:id - Get single outward payment
router.get('/payments/outward/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const isNumeric = /^\d+$/.test(id);
    const whereField = isNumeric ? 'p.id' : 'p.payment_uniqid';
    
    const [payments] = await db.promise().query(`
      SELECT 
        p.*,
        v.display_name AS supplier_name,
        v.company_name AS supplier_company,
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
      WHERE ${whereField} = ? AND p.direction = 'OUT' AND p.party_type = 'SUPPLIER' AND (p.is_deleted = 0 OR p.is_deleted IS NULL)
    `, [id]);
    
    if (payments.length === 0) {
      return res.status(404).json(errPayload('Payment not found', 'NOT_FOUND'));
    }
    
    const payment = payments[0];
    
    // Get allocations
    const [allocations] = await db.promise().query(`
      SELECT 
        pa.*,
        ab.bill_number,
        ab.bill_date,
        ab.total AS bill_total,
        ab.currency_id AS bill_currency_id,
        ab.supplier_id AS bill_supplier_id,
        c.name AS bill_currency_code,
        po.po_number,
        po.po_date,
        po.vendor_id AS po_supplier_id,
        v.display_name AS supplier_name
      FROM tbl_payment_allocation pa
      LEFT JOIN ap_bills ab ON ab.id = pa.bill_id AND pa.alloc_type = 'bill'
      LEFT JOIN currency c ON c.id = ab.currency_id
      LEFT JOIN purchase_orders po ON po.id = pa.po_id AND pa.alloc_type = 'advance'
      LEFT JOIN vendor v ON v.id = COALESCE(pa.supplier_id, ab.supplier_id, po.vendor_id)
      WHERE pa.payment_id = ?
    `, [payment.id]);
    
    payment.allocations = allocations || [];
    
    res.json(payment);
  } catch (e) {
    console.error('Error fetching payment:', e);
    res.status(500).json(errPayload('Failed to fetch payment', 'DB_ERROR', e.message));
  }
});

// POST /api/payments/outward - Create outward payment (DRAFT)
router.post('/payments/outward', requireAuth, requirePerm('Purchase', 'create'), paymentUpload, async (req, res) => {
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
    
    // Get supplier_id from first allocation if not in body
    let supplier_id = req.body.supplier_id;
    if (!supplier_id && allocations.length > 0 && allocations[0].supplier_id) {
      supplier_id = allocations[0].supplier_id;
    }
    
    // Validation
    if (!transaction_date || (!payment_type && !payment_type_id) || !supplier_id) {
      await conn.rollback();
      return res.status(400).json(errPayload('Transaction date, payment type, and supplier are required', 'VALIDATION_ERROR'));
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
      
      // If acc_currency is a currency ID, use it directly; also ensure we know the currency code
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

      // If we still don't have a currencyId, try to find it by currency name
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
    const paymentUniqid = `out_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    
    // Insert payment with status_id = 3 (DRAFT)
    const [paymentResult] = await conn.query(`
      INSERT INTO tbl_payment (
        payment_uniqid, payment_number, transaction_date, payment_type, payment_type_id,
        bank_account_id, cash_account_id, cheque_no, cheque_date,
        tt_ref_no, value_date, reference_no,
        direction, is_customer_payment, party_type, party_id,
        currency_id, currency_code, total_amount_bank, total_amount_base, fx_rate,
        notes, status_id, user_id, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OUT', 0, 'SUPPLIER', ?, ?, ?, ?, ?, ?, ?, 3, ?, ?, NOW())
    `, [
      paymentUniqid, paymentNumber, transaction_date, paymentTypeCode, payment_type_id || null,
      bank_account_id || null, cash_account_id || null,
      cheque_no || null, cheque_date || null,
      tt_ref_no || null, value_date || null, reference_no || null,
      supplier_id, currencyId || null, accountCurrency, totalAmount, totalAmountBase, effectiveFxRate,
      notes || null, userId, userId
    ]);
    
    const paymentId = paymentResult.insertId;
    
    // Validate allocations don't exceed outstanding (for bill allocations)
    for (const alloc of allocations) {
      if (alloc.type === 'bill' && alloc.bill_id) {
        const [bills] = await conn.query(`
          SELECT 
            ab.id,
            ab.bill_number,
            ab.total,
            ab.currency_id as bill_currency_id,
            COALESCE(
              (SELECT SUM(
                CASE 
                  WHEN p.currency_id = ab.currency_id THEN pa.amount_bank
                  ELSE pa.amount_base
                END
              )
               FROM tbl_payment_allocation pa
               INNER JOIN tbl_payment p ON p.id = pa.payment_id
               WHERE pa.bill_id = ab.id 
                 AND (p.is_deleted = 0 OR p.is_deleted IS NULL)), 
              0
            ) as paid_amount
          FROM ap_bills ab
          WHERE ab.id = ?
        `, [alloc.bill_id]);
        
        if (bills.length === 0) {
          await conn.rollback();
          return res.status(404).json(errPayload(`Bill ${alloc.bill_id} not found`, 'NOT_FOUND'));
        }
        
        const bill = bills[0];
        const outstanding = parseFloat(bill.total) - parseFloat(bill.paid_amount);
        const allocAmountBase = parseFloat(alloc.amount || 0) * effectiveFxRate;
        
        // Sum all allocations for this bill in the current request
        const totalAllocatedForBill = allocations
          .filter(a => a.type === 'bill' && a.bill_id === alloc.bill_id)
          .reduce((sum, a) => sum + (parseFloat(a.amount || 0) * effectiveFxRate), 0);
        
        if (totalAllocatedForBill > outstanding + 0.01) {
          await conn.rollback();
          return res.status(400).json(errPayload(`Allocation amount (${totalAllocatedForBill.toFixed(2)}) exceeds outstanding balance (${outstanding.toFixed(2)}) for bill ${bill.bill_number || alloc.bill_id}`, 'VALIDATION_ERROR'));
        }
      }
    }
    
    // Insert allocations
    for (const alloc of allocations) {
      const { type, bill_id, po_id, supplier_id: allocSupplierId, amount } = alloc;
      const finalSupplierId = allocSupplierId || supplier_id;
      
      if (!type || !amount) {
        await conn.rollback();
        return res.status(400).json(errPayload('Allocation type and amount are required', 'VALIDATION_ERROR'));
      }
      
      if (type === 'bill' && !bill_id) {
        await conn.rollback();
        return res.status(400).json(errPayload('Bill ID is required for bill allocations', 'VALIDATION_ERROR'));
      }
      
      if (type === 'advance' && !po_id) {
        await conn.rollback();
        return res.status(400).json(errPayload('Purchase Order ID is required for advance allocations', 'VALIDATION_ERROR'));
      }
      
      // Validate bill belongs to supplier
      if (type === 'bill' && bill_id) {
        const [bills] = await conn.query(`
          SELECT bill_number FROM ap_bills WHERE id = ? AND supplier_id = ?
        `, [bill_id, finalSupplierId]);
        
        if (bills.length === 0) {
          await conn.rollback();
          return res.status(404).json(errPayload(`Bill ${bill_id} not found or does not belong to supplier`, 'NOT_FOUND'));
        }
      }
      
      // Validate PO belongs to supplier (PO table uses vendor_id, not supplier_id)
      if (type === 'advance' && po_id) {
        const [pos] = await conn.query(`
          SELECT po_number FROM purchase_orders WHERE id = ? AND vendor_id = ?
        `, [po_id, finalSupplierId]);
        
        if (pos.length === 0) {
          await conn.rollback();
          return res.status(404).json(errPayload(`Purchase Order ${po_id} not found or does not belong to supplier`, 'NOT_FOUND'));
        }
      }
      
      const allocAmount = parseFloat(amount);
      const allocAmountBase = allocAmount * effectiveFxRate;
      
      await conn.query(`
        INSERT INTO tbl_payment_allocation (
          payment_id, alloc_type, bill_id, po_id, supplier_id, amount_bank, amount_base, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
      `, [
        paymentId, type, bill_id || null, po_id || null, finalSupplierId, allocAmount, allocAmountBase, userId
      ]);
    }
    
    // Update open_balance for all bills and POs affected by this payment
    const billIds = allocations.filter(a => a.type === 'bill' && a.bill_id).map(a => a.bill_id);
    for (const billId of billIds) {
      await updateBillOpenBalance(conn, billId, currencyId);
    }
    
    const poIds = allocations.filter(a => a.type === 'advance' && a.po_id).map(a => a.po_id);
    for (const poId of poIds) {
      await updatePOOpenBalance(conn, poId, currencyId);
    }
    
    // Handle attachments
    if (req.files && req.files.length > 0) {
      // Create payment_attachments table if it doesn't exist (or use existing structure)
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
      'outward_payment',
      paymentId,
      userId,
      'CREATED',
      JSON.stringify({ payment_number: paymentNumber })
    ]);
    
    await conn.commit();
    
    // Fetch and return created payment (use a new connection since transaction is committed)
    const [createdPayment] = await db.promise().query(`
      SELECT 
        p.*,
        pt.id AS payment_type_id, pt.name AS payment_type_name, pt.code AS payment_type_code,
        v.display_name AS supplier_name,
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
    console.error('Error creating outward payment:', e);
    res.status(500).json(errPayload('Failed to create payment', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// PUT /api/payments/outward/:id - Update outward payment (DRAFT only)
router.put('/payments/outward/:id', requireAuth, requirePerm('Purchase', 'edit'), paymentUpload, async (req, res) => {
  const conn = await db.promise().getConnection();
  const userId = req.session?.user?.id;
  const { id } = req.params;
  
  try {
    await conn.beginTransaction();
    
    // Check if payment exists and is in DRAFT or Submitted for Approval status - get all fields for comparison
    const [[existingPayment]] = await conn.query(`
      SELECT * FROM tbl_payment WHERE id = ? AND direction = 'OUT' AND party_type = 'SUPPLIER'
    `, [id]);
    
    if (!existingPayment) {
      await conn.rollback();
      return res.status(404).json(errPayload('Payment not found', 'NOT_FOUND'));
    }
    
    // Allow editing if status is DRAFT (3), Submitted for Approval (8), REJECTED (2), or APPROVED with approved edit request (status_id = 1 with edit_request_status = 1)
    const canEdit = existingPayment.status_id === 3 || 
                    existingPayment.status_id === 8 || 
                    existingPayment.status_id === 2 ||
                    (existingPayment.status_id === 1 && existingPayment.edit_request_status === 1);
    
    if (!canEdit) {
      await conn.rollback();
      return res.status(400).json(errPayload('Only DRAFT, Submitted for Approval, REJECTED, or APPROVED with approved edit request payments can be updated', 'VALIDATION_ERROR'));
    }
    
    // Clear edit_request_status when payment is edited after an approved edit request
    // Once the user has edited and re-saved, the edit cycle is complete and a new request can be made later.
    const shouldClearEditRequest = existingPayment.edit_request_status === 1;
    
    // Parse FormData fields (same as POST)
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
    
    // Get supplier_id from first allocation if not in body
    let supplier_id = req.body.supplier_id;
    if (!supplier_id && allocations.length > 0 && allocations[0].supplier_id) {
      supplier_id = allocations[0].supplier_id;
    }
    
    // Validation (same as POST)
    if (!transaction_date || (!payment_type && !payment_type_id) || !supplier_id) {
      await conn.rollback();
      return res.status(400).json(errPayload('Transaction date, payment type, and supplier are required', 'VALIDATION_ERROR'));
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
      
      // If acc_currency is a currency ID, use it directly; also ensure we know the currency code
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

      // If we still don't have a currencyId, try to find it by currency name
      if (!currencyId && accountCurrency) {
        try {
          const [[currencyRow]] = await conn.query(`SELECT id FROM currency WHERE name = ? LIMIT 1`, [accountCurrency]);
          if (currencyRow && currencyRow.id) {
            currencyId = currencyRow.id;
          }
        } catch (e) {
          console.warn('Error resolving currency_id for payment (update):', e);
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
        console.warn('Error resolving base currency_id for CASH payment (update):', e);
      }
    }
    
    // Calculate total amount from allocations
    const totalAmount = allocations.reduce((sum, a) => sum + parseFloat(a.amount || 0), 0);
    
    if (totalAmount <= 0) {
      await conn.rollback();
      return res.status(400).json(errPayload('Total amount must be greater than zero', 'VALIDATION_ERROR'));
    }
    
    const totalAmountBase = totalAmount * effectiveFxRate;
    
    // Update payment and set status back to DRAFT (3) when editing
    // Clear edit_request_status if it was approved
    const updateQuery = shouldClearEditRequest 
      ? `UPDATE tbl_payment SET
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
          status_id = 3,
          edit_request_status = NULL,
          edit_approved_by = NULL,
          edit_approved_at = NULL,
          updated_at = NOW(),
          updated_by = ?
        WHERE id = ?`
      : `UPDATE tbl_payment SET
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
          status_id = 3,
          updated_at = NOW(),
          updated_by = ?
        WHERE id = ?`;
    
    await conn.query(updateQuery, [
       transaction_date, paymentTypeCode, payment_type_id || null,
       bank_account_id || null, cash_account_id || null,
       cheque_no || null, cheque_date || null,
       tt_ref_no || null, value_date || null, reference_no || null,
       supplier_id, currencyId || null, accountCurrency, totalAmount, totalAmountBase, effectiveFxRate,
       notes || null, userId, id
     ]);
    
    // Get existing allocations for this payment (to exclude from outstanding calculation)
    const [existingAllocations] = await conn.query(`
      SELECT bill_id, amount_base 
      FROM tbl_payment_allocation 
      WHERE payment_id = ?
    `, [id]);
    
    // Validate allocations don't exceed outstanding (for bill allocations)
    // When updating, we need to add back the current payment's allocations to outstanding
    for (const alloc of allocations) {
      if (alloc.type === 'bill' && alloc.bill_id) {
        // Get outstanding amount EXCLUDING the current payment's allocations
        // Formula: Open Balance = Bill Total - (Allocated amounts from all payments EXCEPT current payment)
        // Use amount_bank when payment currency matches bill currency
        const [bills] = await conn.query(`
          SELECT 
            ab.id,
            ab.bill_number,
            ab.total,
            ab.currency_id as bill_currency_id,
            COALESCE(
              (SELECT SUM(
                CASE 
                  WHEN p.currency_id = ab.currency_id THEN pa.amount_bank
                  ELSE pa.amount_base
                END
              )
               FROM tbl_payment_allocation pa
               INNER JOIN tbl_payment p ON p.id = pa.payment_id
               WHERE pa.bill_id = ab.id 
                 AND (p.is_deleted = 0 OR p.is_deleted IS NULL) 
                 AND p.id != ?), 
              0
            ) as paid_amount
          FROM ap_bills ab
          WHERE ab.id = ?
        `, [id, alloc.bill_id]);
        
        if (bills.length === 0) {
          await conn.rollback();
          return res.status(404).json(errPayload(`Bill ${alloc.bill_id} not found`, 'NOT_FOUND'));
        }
        
        const bill = bills[0];
        
        // Outstanding = Bill Total - Allocated amounts (excluding current payment)
        // Use amount_bank when payment currency matches bill currency
        const outstanding = parseFloat(bill.total) - parseFloat(bill.paid_amount);
        
        // Sum all new allocations for this bill in the current request
        const totalAllocatedForBill = allocations
          .filter(a => a.type === 'bill' && a.bill_id === alloc.bill_id)
          .reduce((sum, a) => sum + (parseFloat(a.amount || 0) * effectiveFxRate), 0);
        
        if (totalAllocatedForBill > outstanding + 0.01) {
          await conn.rollback();
          return res.status(400).json(errPayload(`Allocation amount (${totalAllocatedForBill.toFixed(2)}) exceeds outstanding balance (${outstanding.toFixed(2)}) for bill ${bill.bill_number || alloc.bill_id}`, 'VALIDATION_ERROR'));
        }
      }
    }
    
    // Delete existing allocations
    await conn.query(`DELETE FROM tbl_payment_allocation WHERE payment_id = ?`, [id]);
    
    // Insert new allocations
    for (const alloc of allocations) {
      const { type, bill_id, po_id, supplier_id: allocSupplierId, amount } = alloc;
      const finalSupplierId = allocSupplierId || supplier_id;
      
      if (!type || !amount) {
        await conn.rollback();
        return res.status(400).json(errPayload('Allocation type and amount are required', 'VALIDATION_ERROR'));
      }
      
      if (type === 'bill' && !bill_id) {
        await conn.rollback();
        return res.status(400).json(errPayload('Bill ID is required for bill allocations', 'VALIDATION_ERROR'));
      }
      
      if (type === 'advance' && !po_id) {
        await conn.rollback();
        return res.status(400).json(errPayload('Purchase Order ID is required for advance allocations', 'VALIDATION_ERROR'));
      }
      
      // Validate bill belongs to supplier
      if (type === 'bill' && bill_id) {
        const [bills] = await conn.query(`
          SELECT bill_number FROM ap_bills WHERE id = ? AND supplier_id = ?
        `, [bill_id, finalSupplierId]);
        
        if (bills.length === 0) {
          await conn.rollback();
          return res.status(404).json(errPayload(`Bill ${bill_id} not found or does not belong to supplier`, 'NOT_FOUND'));
        }
      }
      
      // Validate PO belongs to supplier (PO table uses vendor_id, not supplier_id)
      if (type === 'advance' && po_id) {
        const [pos] = await conn.query(`
          SELECT po_number FROM purchase_orders WHERE id = ? AND vendor_id = ?
        `, [po_id, finalSupplierId]);
        
        if (pos.length === 0) {
          await conn.rollback();
          return res.status(404).json(errPayload(`Purchase Order ${po_id} not found or does not belong to supplier`, 'NOT_FOUND'));
        }
      }
      
      const allocAmount = parseFloat(amount);
      const allocAmountBase = allocAmount * effectiveFxRate;
      
      await conn.query(`
        INSERT INTO tbl_payment_allocation (
          payment_id, alloc_type, bill_id, po_id, supplier_id, amount_bank, amount_base, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
      `, [
        id, type, bill_id || null, po_id || null, finalSupplierId, allocAmount, allocAmountBase, userId
      ]);
    }
    
    // Update open_balance for all bills and POs affected by this payment
    const billIds = allocations.filter(a => a.type === 'bill' && a.bill_id).map(a => a.bill_id);
    for (const billId of billIds) {
      await updateBillOpenBalance(conn, billId, currencyId);
    }
    
    const poIds = allocations.filter(a => a.type === 'advance' && a.po_id).map(a => a.po_id);
    for (const poId of poIds) {
      await updatePOOpenBalance(conn, poId, currencyId);
    }
    
    // Handle attachments (add new ones, existing ones remain)
    if (req.files && req.files.length > 0) {
      const attachmentValues = req.files.map(f => [
        id,
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
    
    // Track field changes for history
    const changes = [];
    
    // Helper function to format date from MySQL (handles both Date objects and strings)
    // Never calls toISOString to avoid errors with MySQL date objects
    const formatDate = (date) => {
      if (!date) return '';
      try {
        // Convert to string first to avoid any toISOString issues
        let dateStr = '';
        if (date instanceof Date) {
          // For Date objects, use getFullYear, getMonth, getDate to avoid toISOString
          const year = date.getFullYear();
          const month = String(date.getMonth() + 1).padStart(2, '0');
          const day = String(date.getDate()).padStart(2, '0');
          dateStr = `${year}-${month}-${day}`;
        } else if (typeof date === 'string') {
          dateStr = date;
        } else {
          // For any other type, convert to string safely
          dateStr = String(date);
        }
        // Extract YYYY-MM-DD part from string (handles formats like "2024-01-15" or "2024-01-15 10:30:00")
        const parts = dateStr.split('T');
        if (parts.length > 0) {
          const datePart = parts[0].split(' ')[0];
          return datePart;
        }
        return dateStr.split(' ')[0];
      } catch (e) {
        // If anything fails, try to extract date from string representation
        try {
          const dateStr = String(date);
          return dateStr.split('T')[0].split(' ')[0];
        } catch (e2) {
          return '';
        }
      }
    };
    
    // Compare fields - safely access date properties
    let existingTransactionDate = '';
    try {
      existingTransactionDate = formatDate(existingPayment?.transaction_date);
    } catch (e) {
      console.error('Error formatting transaction_date:', e);
      existingTransactionDate = '';
    }
    if (existingTransactionDate && transaction_date && existingTransactionDate !== transaction_date) {
      changes.push({ field: 'transaction_date', from: existingTransactionDate, to: transaction_date });
    }
    if (existingPayment.payment_type !== paymentTypeCode) {
      changes.push({ field: 'payment_type', from: existingPayment.payment_type || '', to: paymentTypeCode || '' });
    }
    if (String(existingPayment.bank_account_id || '') !== String(bank_account_id || '')) {
      changes.push({ field: 'bank_account_id', from: existingPayment.bank_account_id || '', to: bank_account_id || '' });
    }
    if (String(existingPayment.cash_account_id || '') !== String(cash_account_id || '')) {
      changes.push({ field: 'cash_account_id', from: existingPayment.cash_account_id || '', to: cash_account_id || '' });
    }
    if ((existingPayment.cheque_no || '') !== (cheque_no || '')) {
      changes.push({ field: 'cheque_no', from: existingPayment.cheque_no || '', to: cheque_no || '' });
    }
    let existingChequeDate = '';
    try {
      existingChequeDate = formatDate(existingPayment?.cheque_date);
    } catch (e) {
      console.error('Error formatting cheque_date:', e);
      existingChequeDate = '';
    }
    if (existingChequeDate && cheque_date && existingChequeDate !== cheque_date) {
      changes.push({ field: 'cheque_date', from: existingChequeDate, to: cheque_date });
    } else if (!existingChequeDate && cheque_date) {
      changes.push({ field: 'cheque_date', from: '', to: cheque_date });
    } else if (existingChequeDate && !cheque_date) {
      changes.push({ field: 'cheque_date', from: existingChequeDate, to: '' });
    }
    if ((existingPayment.tt_ref_no || '') !== (tt_ref_no || '')) {
      changes.push({ field: 'tt_ref_no', from: existingPayment.tt_ref_no || '', to: tt_ref_no || '' });
    }
    let existingValueDate = '';
    try {
      existingValueDate = formatDate(existingPayment?.value_date);
    } catch (e) {
      console.error('Error formatting value_date:', e);
      existingValueDate = '';
    }
    if (existingValueDate && value_date && existingValueDate !== value_date) {
      changes.push({ field: 'value_date', from: existingValueDate, to: value_date });
    } else if (!existingValueDate && value_date) {
      changes.push({ field: 'value_date', from: '', to: value_date });
    } else if (existingValueDate && !value_date) {
      changes.push({ field: 'value_date', from: existingValueDate, to: '' });
    }
    if ((existingPayment.reference_no || '') !== (reference_no || '')) {
      changes.push({ field: 'reference_no', from: existingPayment.reference_no || '', to: reference_no || '' });
    }
    if (String(existingPayment.party_id || '') !== String(supplier_id || '')) {
      changes.push({ field: 'party_id', from: existingPayment.party_id || '', to: supplier_id || '' });
    }
    if ((existingPayment.currency_code || '') !== (accountCurrency || '')) {
      changes.push({ field: 'currency_code', from: existingPayment.currency_code || '', to: accountCurrency || '' });
    }
    // Compare numeric fields as numbers to avoid false positives from formatting differences
    const existingTotalAmount = parseFloat(existingPayment.total_amount_bank || 0);
    const newTotalAmount = parseFloat(totalAmount || 0);
    if (Math.abs(existingTotalAmount - newTotalAmount) > 0.01) { // Use small epsilon for floating point comparison
      changes.push({ field: 'total_amount_bank', from: existingTotalAmount, to: newTotalAmount });
    }
    if ((existingPayment.notes || '') !== (notes || '')) {
      changes.push({ field: 'notes', from: existingPayment.notes || '', to: notes || '' });
    }
    
    // Log history - UPDATED (only if there are changes)
    if (changes.length > 0) {
      await conn.query(`
        INSERT INTO history (module, module_id, user_id, action, details)
        VALUES (?, ?, ?, ?, ?)
      `, [
        'outward_payment',
        id,
        userId,
        'UPDATED',
        JSON.stringify(changes)
      ]);
    }
    
    // Update open_balance for all bills affected by this payment update
    // Get all bill IDs from both old and new allocations
    const allBillIds = new Set();
    
    // Add bill IDs from existing allocations
    if (existingAllocations.length > 0) {
      existingAllocations.forEach(a => {
        if (a.bill_id) allBillIds.add(a.bill_id);
      });
    }
    
    // Add bill IDs from new allocations
    allocations.forEach(a => {
      if (a.type === 'bill' && a.bill_id) allBillIds.add(a.bill_id);
    });
    
    // Update open_balance for each affected bill
    for (const billId of allBillIds) {
      const [billData] = await conn.query(`
        SELECT 
          ab.total,
          COALESCE(
            (SELECT SUM(pa.amount_base) 
             FROM tbl_payment_allocation pa 
             WHERE pa.bill_id = ab.id 
               AND pa.payment_id IN (SELECT id FROM tbl_payment WHERE (is_deleted = 0 OR is_deleted IS NULL))), 
            0
          ) as paid_amount
        FROM ap_bills ab
        WHERE ab.id = ?
      `, [billId]);
      
      if (billData.length > 0) {
        const bill = billData[0];
        const openBalance = parseFloat(bill.total) - parseFloat(bill.paid_amount);
        await conn.query(`
          UPDATE ap_bills 
          SET open_balance = ? 
          WHERE id = ?
        `, [openBalance, billId]);
      }
    }
    
    await conn.commit();
    
    // Fetch and return updated payment
    const [updatedPayment] = await db.promise().query(`
      SELECT 
        p.*,
        pt.id AS payment_type_id, pt.name AS payment_type_name, pt.code AS payment_type_code,
        v.display_name AS supplier_name,
        s.name AS status_name,
        s.bg_colour AS status_bg_colour,
        s.colour AS status_colour
      FROM tbl_payment p
      LEFT JOIN payment_type pt ON pt.id = p.payment_type_id
      LEFT JOIN vendor v ON v.id = p.party_id
      LEFT JOIN status s ON s.id = p.status_id
      WHERE p.id = ?
    `, [id]);
    
    res.json(updatedPayment[0] || { id, message: 'Payment updated successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error updating outward payment:', e);
    res.status(500).json(errPayload('Failed to update payment', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// POST /api/payments/outward/:id/approve - Approve payment (creates ledger + updates bills)
router.post('/payments/outward/:id/approve', requireAuth, requirePerm('SUPPLIER_PAYMENT', 'approve'), async (req, res) => {
  const conn = await db.promise().getConnection();
  const userId = req.session?.user?.id;
  
  try {
    await conn.beginTransaction();
    
    const { id } = req.params;
    const { comment, reconcile_date, reconcile_number } = req.body;
    const isNumeric = /^\d+$/.test(id);
    const whereField = isNumeric ? 'id' : 'payment_uniqid';
    
    // Get payment
    const [payments] = await conn.query(`
      SELECT * FROM tbl_payment WHERE ${whereField} = ? AND direction = 'OUT' AND party_type = 'SUPPLIER'
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
      if (alloc.alloc_type === 'bill' && alloc.bill_id) {
        const [bills] = await conn.query(`
          SELECT 
            ab.total,
            ab.currency_id as bill_currency_id,
            COALESCE(
              (SELECT SUM(
                CASE 
                  WHEN p.currency_id = ab.currency_id THEN pa.amount_bank
                  ELSE pa.amount_base
                END
              )
               FROM tbl_payment_allocation pa
               INNER JOIN tbl_payment p ON p.id = pa.payment_id
               WHERE pa.bill_id = ab.id 
                 AND (p.is_deleted = 0 OR p.is_deleted IS NULL)), 
              0
            ) as paid_amount
          FROM ap_bills ab
          WHERE ab.id = ?
        `, [alloc.bill_id]);
        
        if (bills.length === 0) {
          await conn.rollback();
          return res.status(404).json(errPayload(`Bill ${alloc.bill_id} not found`, 'NOT_FOUND'));
        }
        
        const bill = bills[0];
        const outstanding = parseFloat(bill.total) - parseFloat(bill.paid_amount);
        
        if (parseFloat(alloc.amount_base) > outstanding + 0.01) {
          await conn.rollback();
          return res.status(400).json(errPayload(`Allocation exceeds outstanding for bill ${alloc.bill_id}`, 'VALIDATION_ERROR'));
        }
      }
    }
    
    // Determine account (bank or cash) for GL entry
    // For CASH payments we always credit the Cash in Hand ledger (from chart of accounts),
    // not any linked bank account.
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

      // If still no account found, we can't create GL entry
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
    
    // Get vendor's AP account if you later decide to store it per-vendor.
    // Currently we don't rely on vendor_other.ap_account_id (column not present in your DB),
    // so we fall back to the global Accounts Payable (A/P) account from chart of accounts.
    let apAccountId = null;

    // Try to get by name "Accounts Payable (A/P)" or fallback to id 6
    const [apAccounts] = await conn.query(`
      SELECT id 
      FROM acc_chart_accounts 
      WHERE name LIKE '%Accounts Payable%' OR id = 6
      LIMIT 1
    `);
    apAccountId = apAccounts.length > 0 ? apAccounts[0].id : 6;

    if (!apAccountId) {
      await conn.rollback();
      return res.status(400).json(errPayload('Accounts Payable account not found in chart of accounts', 'VALIDATION_ERROR'));
    }
    
    // Before creating a new GL journal, soft-delete any existing journal for this payment
    // This ensures edits + re-approval don't create duplicate GL entries.
    await conn.query(`
      UPDATE gl_journals 
      SET is_deleted = 1 
      WHERE source_type = 'OUTWARD_PAYMENT' AND source_id = ?
    `, [payment.id]);

    // Prepare currency fields for GL journal
    // foreign_amount = amount in payment form currency (bank/payment currency)
    // total_amount = payment amount * payment currency conversion (already stored in total_amount_base)
    let journalCurrencyId = payment.currency_id || null;
    let journalExchangeRate = null;
    let journalForeignAmount = parseFloat(payment.total_amount_bank || 0);  // amount in payment (form) currency
    let journalTotalAmount = parseFloat(payment.total_amount_base || 0);    // amount in base currency (payment amount * conversion)

    // Derive FX and currency_id from bank account if available (for non-cash payments)
    if (payment.payment_type !== 'CASH') {
      const accountId = payment.bank_account_id || payment.cash_account_id;
      if (accountId) {
        const [[account]] = await conn.query(`
          SELECT id, currency_code, acc_currency 
          FROM acc_bank_details 
          WHERE id = ?
        `, [accountId]);

        if (account) {
          // Resolve currency_id if missing
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

          // Get FX rate for transaction date (account currency -> base)
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
    // Each allocation gets a pair of lines: AP debit and Bank/Cash credit
    const journalLines = [];
    
    for (const alloc of allocations) {
      // Get allocation amount in payment currency (foreign amount)
      const allocForeignAmount = parseFloat(alloc.amount_bank || 0);
      const allocIsAdvance = alloc.alloc_type === 'advance' ? 1 : 0;
      
      // Build description based on allocation type
      let allocDescription = '';
      if (alloc.alloc_type === 'bill' && alloc.bill_id) {
        // Get bill number for description
        const [billInfo] = await conn.query(`
          SELECT bill_number FROM ap_bills WHERE id = ?
        `, [alloc.bill_id]);
        const billNumber = billInfo.length > 0 ? billInfo[0].bill_number : `Bill #${alloc.bill_id}`;
        allocDescription = `Bill payment ${billNumber} - ${payment.payment_number}`;
      } else if (alloc.alloc_type === 'advance' && alloc.po_id) {
        // Get PO number for description
        const [poInfo] = await conn.query(`
          SELECT po_number FROM purchase_orders WHERE id = ?
        `, [alloc.po_id]);
        const poNumber = poInfo.length > 0 ? poInfo[0].po_number : `PO #${alloc.po_id}`;
        allocDescription = `PO advance ${poNumber} - ${payment.payment_number}`;
      } else {
        allocDescription = `Payment allocation - ${payment.payment_number}`;
      }
      
      // Determine invoice_id (bill_id for bill allocations, po_id for advance allocations)
      const invoiceId = alloc.alloc_type === 'bill' ? alloc.bill_id : (alloc.alloc_type === 'advance' ? alloc.po_id : null);
      
      // Add AP debit line for this allocation
      journalLines.push({
        account_id: apAccountId,
        debit: allocForeignAmount,
        credit: 0,
        description: allocDescription,
        entity_type: 'SUPPLIER',
        entity_id: payment.party_id,
        buyer_id: payment.party_id,
        is_advance: allocIsAdvance,
        invoice_id: invoiceId // Save bill_id or po_id as invoice_id
      });
      
      // Add Bank/Cash credit line for this allocation
      journalLines.push({
        account_id: accountCoaId,
        debit: 0,
        credit: allocForeignAmount,
        description: allocDescription,
        entity_type: 'SUPPLIER',
        entity_id: payment.party_id,
        buyer_id: payment.party_id,
        is_advance: allocIsAdvance,
        invoice_id: invoiceId // Save bill_id or po_id as invoice_id
      });
    }
    
    // Create GL journal entry with multiple lines (one pair per allocation)
    await glService.createJournal(conn, {
      source_type: 'OUTWARD_PAYMENT',
      source_id: payment.id,
      journal_date: payment.transaction_date,
      memo: `Outward Payment ${payment.payment_number}`,
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
    
    // Update payment status to APPROVED (1)
    // Reset edit_request_status to 0 when approving
    // Save reconcile_date and reconcile_number
    // Do NOT modify notes; store approval comment only in history
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
      'outward_payment',
      payment.id,
      userId,
      'APPROVED',
      JSON.stringify({
        comment: comment || 'No comment provided.',
        payment_number: payment.payment_number
      })
    ]);
    
    // Update open_balance for all bills affected by this payment
    const billIds = allocations.filter(a => a.alloc_type === 'bill' && a.bill_id).map(a => a.bill_id);
    for (const billId of billIds) {
      const [billData] = await conn.query(`
        SELECT 
          ab.total,
          ab.currency_id,
          COALESCE(
            (SELECT SUM(
              CASE 
                WHEN p.currency_id = ab.currency_id THEN pa.amount_bank
                ELSE pa.amount_base
              END
            )
             FROM tbl_payment_allocation pa
             INNER JOIN tbl_payment p ON p.id = pa.payment_id
             WHERE pa.bill_id = ab.id 
               AND (p.is_deleted = 0 OR p.is_deleted IS NULL)), 
            0
          ) as paid_amount
        FROM ap_bills ab
        WHERE ab.id = ?
      `, [billId]);
      
      if (billData.length > 0) {
        const bill = billData[0];
        const openBalance = parseFloat(bill.total) - parseFloat(bill.paid_amount);
        await conn.query(`
          UPDATE ap_bills 
          SET open_balance = ? 
          WHERE id = ?
        `, [openBalance, billId]);
      }
    }
    
    // Update open_balance for all POs affected by this payment
    const poIds = allocations.filter(a => a.alloc_type === 'advance' && a.po_id).map(a => a.po_id);
    for (const poId of poIds) {
      await updatePOOpenBalance(conn, poId, payment.currency_id);
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

// PUT /api/payments/outward/:id/status - Update payment status
router.put('/payments/outward/:id/status', requireAuth, requirePerm('Purchase', 'edit'), async (req, res) => {
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
      WHERE ${whereField} = ? AND direction = 'OUT' AND party_type = 'SUPPLIER'
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
    
    // Add history entry - use REJECTED action if rejecting, otherwise STATUS_CHANGED
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
      'outward_payment',
      payment.id,
      userId,
      action,
      historyDetails
    ]);
    
    await conn.commit();
    
    // Fetch and return updated payment with status details
    const [updatedPayments] = await conn.query(`
      SELECT 
        p.*,
        s.name AS status_name,
        s.bg_colour AS status_bg_colour,
        s.colour AS status_colour
      FROM tbl_payment p
      LEFT JOIN status s ON s.id = p.status_id
      WHERE p.id = ?
    `, [payment.id]);
    
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

// GET /api/payments/outward/:id/attachments - Get payment attachments
router.get('/payments/outward/:id/attachments', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const isNumeric = /^\d+$/.test(id);
    const whereField = isNumeric ? 'id' : 'payment_uniqid';
    
    const [payments] = await db.promise().query(`
      SELECT id FROM tbl_payment WHERE ${whereField} = ? AND direction = 'OUT' AND party_type = 'SUPPLIER' AND (is_deleted = 0 OR is_deleted IS NULL)
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

// POST /api/payments/outward/:id/attachments - Add attachments to payment
router.post('/payments/outward/:id/attachments', requireAuth, requirePerm('Purchase', 'edit'), paymentUpload, async (req, res) => {
  const conn = await db.promise().getConnection();
  const userId = req.session?.user?.id;
  
  try {
    await conn.beginTransaction();
    
    const { id } = req.params;
    const isNumeric = /^\d+$/.test(id);
    const whereField = isNumeric ? 'id' : 'payment_uniqid';
    
    const [payments] = await conn.query(`
      SELECT id FROM tbl_payment WHERE ${whereField} = ? AND direction = 'OUT' AND party_type = 'SUPPLIER'
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
      f.originalname,
      relPath(f),
      f.mimetype || null,
      f.size || null,
      userId
    ]);
    
    await conn.query(`
      INSERT INTO tbl_payment_attachments 
      (payment_id, file_name, file_path, mime_type, size_bytes, created_by)
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

// POST /api/payments/outward/:id/request-edit - Request edit for approved payment
router.post('/payments/outward/:id/request-edit', requireAuth, async (req, res) => {
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
      WHERE ${whereField} = ? AND direction = 'OUT' AND party_type = 'SUPPLIER'
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
      'outward_payment',
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

// POST /api/payments/outward/:id/decide-edit-request - Approve/reject edit request
router.post('/payments/outward/:id/decide-edit-request', requireAuth, requirePerm('SUPPLIER_PAYMENT', 'approve'), async (req, res) => {
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
      return res.status(400).json(errPayload('Decision must be \"approve\" or \"reject\"', 'VALIDATION_ERROR'));
    }

    const isNumeric = /^\d+$/.test(id);
    const whereField = isNumeric ? 'id' : 'payment_uniqid';

    // Get payment with pending edit request
    const [payments] = await conn.query(`
      SELECT id, status_id, edit_request_status 
      FROM tbl_payment 
      WHERE ${whereField} = ? AND direction = 'OUT' AND party_type = 'SUPPLIER' AND edit_request_status = 3
    `, [id]);

    if (payments.length === 0) {
      await conn.rollback();
      return res.status(404).json(errPayload('No pending edit request found for this payment', 'NOT_FOUND'));
    }

    const payment = payments[0];

    if (decision === 'approve') {
      // Approve edit request - set status to DRAFT (3) to allow editing
      await conn.query(`
        UPDATE tbl_payment SET 
          status_id = 3,
          edit_request_status = 1,
          edit_approved_by = ?,
          edit_approved_at = NOW()
        WHERE id = ?
      `, [userId, payment.id]);

      // Add history entry
      await conn.query(`
        INSERT INTO history (module, module_id, user_id, action, details)
        VALUES (?, ?, ?, ?, ?)
      `, [
        'outward_payment',
        payment.id,
        userId,
        'EDIT_REQUEST_APPROVED',
        JSON.stringify({ comment: reason || 'Edit request approved' })
      ]);
    } else {
      // Reject edit request
      await conn.query(`
        UPDATE tbl_payment SET 
          edit_request_status = 2,
          edit_rejection_reason = ?
        WHERE id = ?
      `, [reason || 'Edit request rejected', payment.id]);

      // Add history entry
      await conn.query(`
        INSERT INTO history (module, module_id, user_id, action, details)
        VALUES (?, ?, ?, ?, ?)
      `, [
        'outward_payment',
        payment.id,
        userId,
        'EDIT_REQUEST_REJECTED',
        JSON.stringify({ reason: reason || 'Edit request rejected' })
      ]);
    }

    await conn.commit();
    res.json({ success: true, message: `Edit request ${decision}d successfully` });
  } catch (e) {
    await conn.rollback();
    console.error('Error deciding payment edit request:', e);
    res.status(500).json(errPayload('Failed to process edit request', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// GET /api/payments/outward/:id/history - Get payment history
router.get('/payments/outward/:id/history', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const isNumeric = /^\d+$/.test(id);
    const whereField = isNumeric ? 'id' : 'payment_uniqid';
    
    const [payments] = await db.promise().query(`
      SELECT id FROM tbl_payment WHERE ${whereField} = ? AND direction = 'OUT' AND party_type = 'SUPPLIER'
    `, [id]);
    
    if (payments.length === 0) {
      return res.status(404).json(errPayload('Payment not found', 'NOT_FOUND'));
    }
    
    const paymentId = payments[0].id;
    
    const [history] = await db.promise().query(`
      SELECT h.id, h.action, h.details, h.created_at, u.name as user_name
      FROM history h
      LEFT JOIN \`user\` u ON u.id = h.user_id
      WHERE h.module = 'outward_payment' AND h.module_id = ?
      ORDER BY h.created_at DESC
    `, [paymentId]);
    
    res.json((history || []).map(h => {
      let details = {};
      if (h.details) {
        try {
          details = typeof h.details === 'string' ? JSON.parse(h.details) : h.details;
        } catch (e) {
          details = {};
        }
      }
      return {
        ...h,
        details
      };
    }));
  } catch (e) {
    console.error('Error fetching payment history:', e);
    res.status(500).json(errPayload('Failed to fetch payment history', 'DB_ERROR', e.message));
  }
});

// DELETE /api/payments/outward/:id/attachments/:attachmentId - Delete attachment
router.delete('/payments/outward/:id/attachments/:attachmentId', requireAuth, requirePerm('Purchase', 'delete'), async (req, res) => {
  const conn = await db.promise().getConnection();
  
  try {
    await conn.beginTransaction();
    
    const { id, attachmentId } = req.params;
    const isNumeric = /^\d+$/.test(id);
    const whereField = isNumeric ? 'id' : 'payment_uniqid';
    
    const [payments] = await conn.query(`
      SELECT id FROM tbl_payment WHERE ${whereField} = ? AND direction = 'OUT' AND party_type = 'SUPPLIER'
    `, [id]);
    
    if (payments.length === 0) {
      await conn.rollback();
      return res.status(404).json(errPayload('Payment not found', 'NOT_FOUND'));
    }
    
    const [attachments] = await conn.query(`
      SELECT id, file_path FROM tbl_payment_attachments 
      WHERE id = ? AND payment_id = ?
    `, [attachmentId, payments[0].id]);
    
    if (attachments.length === 0) {
      await conn.rollback();
      return res.status(404).json(errPayload('Attachment not found', 'NOT_FOUND'));
    }
    
    // Delete file from filesystem
    const filePath = path.resolve(attachments[0].file_path.replace('/uploads/', 'uploads/'));
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    
    // Delete from database
    await conn.query(`
      DELETE FROM tbl_payment_attachments WHERE id = ?
    `, [attachmentId]);
    
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

// GET /api/payments/outward/:id/journal-entries - Get GL journal entries for payment
router.get('/payments/outward/:id/journal-entries', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const isNumeric = /^\d+$/.test(id);
    const whereField = isNumeric ? 'id' : 'payment_uniqid';
    
    // Get payment ID
    const [payments] = await db.promise().query(`
      SELECT id FROM tbl_payment 
      WHERE ${whereField} = ? AND direction = 'OUT' AND party_type = 'SUPPLIER' AND (is_deleted = 0 OR is_deleted IS NULL)
    `, [id]);
    
    if (payments.length === 0) {
      return res.status(404).json(errPayload('Payment not found', 'NOT_FOUND'));
    }
    
    const paymentId = payments[0].id;
    
    // Fetch GL journal entries for this payment
    const [journalEntries] = await db.promise().query(`
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
      WHERE gj.source_type = 'OUTWARD_PAYMENT' AND gj.source_id = ?
      AND (gj.is_deleted = 0 OR gj.is_deleted IS NULL)
      ORDER BY gj.journal_date DESC, gj.id DESC, gjl.id ASC
    `, [paymentId]);
    
    res.json({ data: journalEntries || [] });
  } catch (e) {
    console.error('Error fetching journal entries:', e);
    res.status(500).json(errPayload('Failed to fetch journal entries', 'DB_ERROR', e.message));
  }
});

// DELETE /api/payments/outward/:id - Soft delete payment
router.delete('/payments/outward/:id', requireAuth, requirePerm('Purchase', 'delete'), async (req, res) => {
  const conn = await db.promise().getConnection();
  
  try {
    await conn.beginTransaction();
    
    const { id } = req.params;
    const userId = req.session?.user?.id;
    const isNumeric = /^\d+$/.test(id);
    const whereField = isNumeric ? 'id' : 'payment_uniqid';
    
    const [payments] = await conn.query(`
      SELECT id, payment_number FROM tbl_payment 
      WHERE ${whereField} = ? AND direction = 'OUT' AND party_type = 'SUPPLIER'
    `, [id]);
    
    if (payments.length === 0) {
      await conn.rollback();
      return res.status(404).json(errPayload('Payment not found', 'NOT_FOUND'));
    }
    
    const paymentId = payments[0].id;
    
    // Soft delete - set is_deleted = 1
    await conn.query(`
      UPDATE tbl_payment 
      SET is_deleted = 1 
      WHERE id = ?
    `, [paymentId]);
    
    // Log history
    await conn.query(`
      INSERT INTO history (module, module_id, user_id, action, details)
      VALUES (?, ?, ?, ?, ?)
    `, [
      'outward_payment',
      paymentId,
      userId,
      'DELETED',
      JSON.stringify({ payment_number: payments[0].payment_number })
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

