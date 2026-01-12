import express from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/authz.js';
import { getBankExchangeRate } from './bankAccounts.js';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import multer from 'multer';
import fs from 'fs';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const glService = require('../src/modules/gl/gl.service.cjs');

const router = express.Router();
const errPayload = (message, type = 'APP_ERROR', hint) => ({ error: { message, type, hint } });

// Multer setup for fund transfer attachments
const FUND_TRANSFER_UPLOAD_DIR = path.resolve("uploads/fund-transfers");
if (!fs.existsSync(FUND_TRANSFER_UPLOAD_DIR)) {
  fs.mkdirSync(FUND_TRANSFER_UPLOAD_DIR, { recursive: true });
}

const fundTransferStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, FUND_TRANSFER_UPLOAD_DIR),
  filename: (_req, file, cb) =>
    cb(null, crypto.randomBytes(16).toString("hex") + path.extname(file.originalname)),
});

const fundTransferUpload = multer({ storage: fundTransferStorage }).array('attachments', 10);
const relPath = (f) => (f ? `/uploads/fund-transfers/${path.basename(f.path)}` : null);

// Helper function to generate transfer number
async function generateTransferNumber(conn) {
  const [result] = await conn.query(`
    SELECT transfer_no FROM tbl_fund_transfer 
    ORDER BY id DESC LIMIT 1
  `);
  
  if (result.length === 0) {
    return 'TRF-000001';
  }
  
  const lastNumber = result[0].transfer_no;
  const match = lastNumber.match(/TRF-(\d+)/);
  if (match) {
    const num = parseInt(match[1], 10) + 1;
    return `TRF-${String(num).padStart(6, '0')}`;
  }
  return 'TRF-000001';
}

// GET /api/fund-transfer - List all fund transfers
router.get('/', requireAuth, async (req, res) => {
  try {
    const { page = 1, per_page = 20, search, status_id, edit_request_status } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(per_page);
    
    let whereClause = 'WHERE 1=1';
    const params = [];
    
    if (search) {
      whereClause += ' AND (ft.transfer_no LIKE ? OR ft.reference LIKE ?)';
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm);
    }
    if (status_id) {
      whereClause += ' AND ft.status_id = ?';
      params.push(parseInt(status_id, 10));
    }
    if (edit_request_status !== undefined) {
      whereClause += ' AND ft.edit_request_status = ?';
      params.push(parseInt(edit_request_status, 10));
    }
    
    const [rows] = await db.promise().query(`
      SELECT 
        ft.id,
        ft.transfer_no,
        ft.from_bank_account_id,
        ft.to_bank_account_id,
        ft.transfer_date,
        ft.amount_from_currency,
        ft.from_currency_code,
        ft.to_currency_code,
        ft.amount_aed,
        ft.amount_to_currency,
        ft.rate_overridden,
        ft.reference,
        ft.notes,
        ft.status_id,
        ft.approved_by,
        ft.approved_at,
        ft.created_at,
        ft.created_by,
        ft.edit_request_status,
        ft.edit_requested_by,
        ft.edit_requested_at,
        ft.edit_request_reason,
        ft.edit_approved_by,
        ft.edit_approved_at,
        ft.edit_rejection_reason,
        from_bank.bank_name as from_bank_name,
        from_bank.acc_no as from_account_number,
        to_bank.bank_name as to_bank_name,
        to_bank.acc_no as to_account_number,
        from_bank.coa_id as from_coa_id,
        to_bank.coa_id as to_coa_id,
        s.name as status_name,
        s.bg_colour as status_bg_colour,
        s.colour as status_colour,
        u1.name as created_by_name,
        u2.name as approved_by_name,
        u3.name as edit_requested_by_name,
        u4.name as edit_approved_by_name
      FROM tbl_fund_transfer ft
      LEFT JOIN acc_bank_details from_bank ON from_bank.id = ft.from_bank_account_id
      LEFT JOIN acc_bank_details to_bank ON to_bank.id = ft.to_bank_account_id
      LEFT JOIN status s ON s.id = ft.status_id
      LEFT JOIN user u1 ON u1.id = ft.created_by
      LEFT JOIN user u2 ON u2.id = ft.approved_by
      LEFT JOIN user u3 ON u3.id = ft.edit_requested_by
      LEFT JOIN user u4 ON u4.id = ft.edit_approved_by
      ${whereClause}
      ORDER BY ft.transfer_date DESC, ft.id DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(per_page), offset]);
    
    const [countResult] = await db.promise().query(`
      SELECT COUNT(*) as total FROM tbl_fund_transfer ft ${whereClause}
    `, params);
    
    const total = countResult[0]?.total || 0;
    
    res.json({
      data: rows || [],
      total,
      page: parseInt(page),
      per_page: parseInt(per_page)
    });
  } catch (e) {
    console.error('Error fetching fund transfers:', e);
    res.status(500).json(errPayload('Failed to fetch fund transfers', 'DB_ERROR', e.message));
  }
});

// GET /api/fund-transfer/:id - Get single fund transfer
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const isNumeric = /^\d+$/.test(id);
    const whereField = isNumeric ? 'ft.id' : 'ft.transfer_no';
    
    const [[transfer]] = await db.promise().query(`
      SELECT 
        ft.*,
        from_bank.bank_name as from_bank_name,
        from_bank.acc_no as from_account_number,
        from_bank.acc_currency as from_currency_id,
        from_bank.coa_id as from_coa_id,
        to_bank.bank_name as to_bank_name,
        to_bank.acc_no as to_account_number,
        to_bank.acc_currency as to_currency_id,
        to_bank.coa_id as to_coa_id,
        s.name as status_name,
        s.bg_colour as status_bg_colour,
        s.colour as status_colour,
        u1.name as created_by_name,
        u2.name as approved_by_name,
        u3.name as edit_requested_by_name,
        u4.name as edit_approved_by_name
      FROM tbl_fund_transfer ft
      LEFT JOIN acc_bank_details from_bank ON from_bank.id = ft.from_bank_account_id
      LEFT JOIN acc_bank_details to_bank ON to_bank.id = ft.to_bank_account_id
      LEFT JOIN status s ON s.id = ft.status_id
      LEFT JOIN user u1 ON u1.id = ft.created_by
      LEFT JOIN user u2 ON u2.id = ft.approved_by
      LEFT JOIN user u3 ON u3.id = ft.edit_requested_by
      LEFT JOIN user u4 ON u4.id = ft.edit_approved_by
      WHERE ${whereField} = ?
    `, [id]);
    
    if (!transfer) {
      return res.status(404).json(errPayload('Fund transfer not found', 'NOT_FOUND'));
    }
    
    res.json(transfer);
  } catch (e) {
    console.error('Error fetching fund transfer:', e);
    res.status(500).json(errPayload('Failed to fetch fund transfer', 'DB_ERROR', e.message));
  }
});

// POST /api/fund-transfer - Create new fund transfer (always DRAFT)
router.post('/', requireAuth, async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();
    const userId = req.user.id;
    const {
      from_bank_account_id,
      to_bank_account_id,
      transfer_date,
      amount_from_currency,
      reference,
      notes,
      rate_from_to_aed,
      rate_to_to_aed,
      rate_overridden = false
    } = req.body;
    
    // Validation
    if (!from_bank_account_id || !to_bank_account_id) {
      await conn.rollback();
      return res.status(400).json(errPayload('From and To bank accounts are required', 'VALIDATION_ERROR'));
    }
    
    if (from_bank_account_id === to_bank_account_id) {
      await conn.rollback();
      return res.status(400).json(errPayload('From and To accounts cannot be the same', 'VALIDATION_ERROR'));
    }
    
    if (!transfer_date || !amount_from_currency || parseFloat(amount_from_currency) <= 0) {
      await conn.rollback();
      return res.status(400).json(errPayload('Valid transfer date and amount are required', 'VALIDATION_ERROR'));
    }
    
    // Get bank account details
    const [[fromBank]] = await conn.query(`
      SELECT id, acc_currency, currency_code, coa_id 
      FROM acc_bank_details 
      WHERE id = ?
    `, [from_bank_account_id]);
    
    const [[toBank]] = await conn.query(`
      SELECT id, acc_currency, currency_code, coa_id 
      FROM acc_bank_details 
      WHERE id = ?
    `, [to_bank_account_id]);
    
    if (!fromBank || !toBank) {
      await conn.rollback();
      return res.status(404).json(errPayload('Bank account not found', 'NOT_FOUND'));
    }
    
    const fromCurrencyCode = fromBank.currency_code || 'AED';
    const toCurrencyCode = toBank.currency_code || 'AED';
    
    // Get exchange rates if not provided or if not overridden
    let finalRateFromToAED = rate_from_to_aed;
    let finalRateToToAED = rate_to_to_aed;
    
    if (!rate_overridden || !finalRateFromToAED) {
      if (fromCurrencyCode === 'AED') {
        finalRateFromToAED = 1.0;
      } else {
        const rateFrom = await getBankExchangeRate(from_bank_account_id, transfer_date);
        if (!rateFrom) {
          await conn.rollback();
          return res.status(400).json(
            errPayload(`No exchange rate found for ${fromCurrencyCode} on ${transfer_date}`, 'VALIDATION_ERROR')
          );
        }
        finalRateFromToAED = rateFrom;
      }
    }
    
    if (!rate_overridden || !finalRateToToAED) {
      if (toCurrencyCode === 'AED') {
        finalRateToToAED = 1.0;
      } else {
        const rateTo = await getBankExchangeRate(to_bank_account_id, transfer_date);
        if (!rateTo) {
          await conn.rollback();
          return res.status(400).json(
            errPayload(`No exchange rate found for ${toCurrencyCode} on ${transfer_date}`, 'VALIDATION_ERROR')
          );
        }
        finalRateToToAED = rateTo;
      }
    }
    
    // Calculate amounts
    const amountAED = parseFloat(amount_from_currency) * parseFloat(finalRateFromToAED);
    const amountToCurrency = amountAED / parseFloat(finalRateToToAED);
    
    // Generate transfer number
    const transferNo = await generateTransferNumber(conn);
    
    // Insert fund transfer
    const [result] = await conn.query(`
      INSERT INTO tbl_fund_transfer (
        transfer_no, from_bank_account_id, to_bank_account_id, transfer_date,
        amount_from_currency, from_currency_code, to_currency_code,
        rate_from_to_aed, rate_to_to_aed, amount_aed, amount_to_currency,
        rate_overridden, reference, notes, status_id, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 3, ?)
    `, [
      transferNo, from_bank_account_id, to_bank_account_id, transfer_date,
      amount_from_currency, fromCurrencyCode, toCurrencyCode,
      finalRateFromToAED, finalRateToToAED, amountAED, amountToCurrency,
      rate_overridden ? 1 : 0, reference || null, notes || null, userId
    ]);
    
    const transferId = result.insertId;
    
    await conn.commit();
    
    // Fetch and return the created transfer
    const [[transfer]] = await conn.query(`
      SELECT 
        ft.*,
        from_bank.bank_name as from_bank_name,
        from_bank.acc_no as from_account_number,
        to_bank.bank_name as to_bank_name,
        to_bank.acc_no as to_account_number,
        s.name as status_name
      FROM tbl_fund_transfer ft
      LEFT JOIN acc_bank_details from_bank ON from_bank.id = ft.from_bank_account_id
      LEFT JOIN acc_bank_details to_bank ON to_bank.id = ft.to_bank_account_id
      LEFT JOIN status s ON s.id = ft.status_id
      WHERE ft.id = ?
    `, [transferId]);
    
    res.status(201).json(transfer);
  } catch (e) {
    try {
      await conn.rollback();
    } catch (rollbackErr) {
      console.error('Error rolling back transaction (create transfer):', rollbackErr);
    }
    console.error('Error creating fund transfer:', e);
    res.status(500).json(errPayload('Failed to create fund transfer', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// POST /api/fund-transfer/:id/approve - Approve fund transfer
router.post('/:id/approve', requireAuth, async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();
    const userId = req.user.id;
    const { id } = req.params;
    const { comment } = req.body;
    
    // Get transfer details
    const [[transfer]] = await conn.query(`
      SELECT 
        ft.*,
        from_bank.coa_id as from_coa_id,
        from_bank.acc_currency as from_currency_id,
        from_bank.currency_code as from_currency_code,
        to_bank.coa_id as to_coa_id,
        to_bank.acc_currency as to_currency_id,
        to_bank.currency_code as to_currency_code
      FROM tbl_fund_transfer ft
      LEFT JOIN acc_bank_details from_bank ON from_bank.id = ft.from_bank_account_id
      LEFT JOIN acc_bank_details to_bank ON to_bank.id = ft.to_bank_account_id
      WHERE ft.id = ?
    `, [id]);
    
    if (!transfer) {
      await conn.rollback();
      return res.status(404).json(errPayload('Fund transfer not found', 'NOT_FOUND'));
    }
    
    // Allow approval for Submitted for Approval status (8)
    if (transfer.status_id !== 8) {
      await conn.rollback();
      return res.status(400).json(errPayload('Only transfers submitted for approval can be approved', 'VALIDATION_ERROR'));
    }
    
    if (!transfer.from_coa_id || !transfer.to_coa_id) {
      await conn.rollback();
      return res.status(400).json(errPayload('Bank accounts must have ledger accounts configured', 'VALIDATION_ERROR'));
    }
    
    // Before creating a new GL journal, soft-delete any existing journal for this transfer
    // This ensures edits + re-approval don't create duplicate GL entries
    await conn.query(`
      UPDATE gl_journals 
      SET is_deleted = 1 
      WHERE source_type = 'FUND_TRANSFER' AND source_id = ?
      AND (is_deleted = 0 OR is_deleted IS NULL)
    `, [transfer.id]);
    
    // Determine currency for GL journal (use from account currency)
    let journalCurrencyId = transfer.from_currency_id || null;
    let journalExchangeRate = transfer.rate_from_to_aed || 1.0;
    let journalForeignAmount = transfer.amount_from_currency || null;
    let journalTotalAmount = transfer.amount_aed || null;
    
    // If currency_id is not available, try to resolve it from currency_code
    if (!journalCurrencyId && transfer.from_currency_code) {
      try {
        const [[currency]] = await conn.query(`SELECT id FROM currency WHERE name = ? LIMIT 1`, [transfer.from_currency_code]);
        if (currency && currency.id) {
          journalCurrencyId = currency.id;
        }
      } catch (e) {
        console.warn('Error resolving currency_id for GL journal:', e);
      }
    }
    
    // Always ensure currency_id is set (even for AED/default currency)
    // If from currency is AED or no currency, get AED currency ID
    if (transfer.from_currency_code === 'AED' || !transfer.from_currency_code || !journalCurrencyId) {
      try {
        const [[aedCurrency]] = await conn.query(`SELECT id FROM currency WHERE name = 'AED' LIMIT 1`);
        if (aedCurrency && aedCurrency.id) {
          journalCurrencyId = aedCurrency.id;
        }
      } catch (e) {
        console.warn('Error resolving AED currency_id:', e);
      }
      journalExchangeRate = 1.0;
      // For default currency, foreign_amount = total_amount
      journalForeignAmount = journalTotalAmount;
    }
    
    // Calculate line amounts: if foreign currency, use foreign amounts; otherwise use AED amounts
    // Note: For default currency (AED), we still pass AED amounts, and GL service will set foreign_amount = total_amount
    const toAccountDebit = (journalCurrencyId && journalExchangeRate > 0 && journalExchangeRate !== 1.0)
      ? transfer.amount_from_currency  // Foreign currency amount
      : transfer.amount_aed;  // AED amount
    const fromAccountCredit = (journalCurrencyId && journalExchangeRate > 0 && journalExchangeRate !== 1.0)
      ? transfer.amount_from_currency  // Foreign currency amount
      : transfer.amount_aed;  // AED amount
    
    // Create GL journal entries
    await glService.createJournal(conn, {
      source_type: 'FUND_TRANSFER',
      source_id: transfer.id,
      journal_date: transfer.transfer_date,
      memo: `Fund Transfer ${transfer.transfer_no}`,
      created_by: userId,
      currency_id: journalCurrencyId,
      exchange_rate: journalExchangeRate,
      foreign_amount: journalForeignAmount,
      total_amount: journalTotalAmount,
      source_name: transfer.transfer_no,
      source_date: transfer.transfer_date,
      lines: [
        {
          account_id: transfer.to_coa_id,
          debit: toAccountDebit,
          credit: 0,
          description: `Fund transfer from ${transfer.from_currency_code} ${transfer.amount_from_currency} to ${transfer.to_currency_code} ${transfer.amount_to_currency}`
        },
        {
          account_id: transfer.from_coa_id,
          debit: 0,
          credit: fromAccountCredit,
          description: `Fund transfer from ${transfer.from_currency_code} ${transfer.amount_from_currency} to ${transfer.to_currency_code} ${transfer.amount_to_currency}`
        }
      ]
    });
    
    // Update transfer status to Approved (status_id = 1)
    // Reset edit_request_status to 0 if it was previously approved (edit request completed)
    await conn.query(`
      UPDATE tbl_fund_transfer 
      SET status_id = 1, 
          approved_by = ?, 
          approved_at = NOW(),
          edit_request_status = CASE WHEN edit_request_status = 1 THEN 0 ELSE edit_request_status END
      WHERE id = ?
    `, [userId, id]);
    
    // Add history entry
    await conn.query(`
      INSERT INTO history (module, module_id, user_id, action, details)
      VALUES (?, ?, ?, ?, ?)
    `, [
      'fund_transfer',
      id,
      userId,
      'APPROVED',
      JSON.stringify({
        comment: comment || 'No comment provided.',
        transfer_no: transfer.transfer_no
      })
    ]);
    
    await conn.commit();

    // Fetch and return updated transfer
    const [[updatedTransfer]] = await conn.query(`
      SELECT 
        ft.*,
        from_bank.bank_name as from_bank_name,
        from_bank.acc_no as from_account_number,
        to_bank.bank_name as to_bank_name,
        to_bank.acc_no as to_account_number,
        s.name as status_name,
        u2.name as approved_by_name
      FROM tbl_fund_transfer ft
      LEFT JOIN acc_bank_details from_bank ON from_bank.id = ft.from_bank_account_id
      LEFT JOIN acc_bank_details to_bank ON to_bank.id = ft.to_bank_account_id
      LEFT JOIN status s ON s.id = ft.status_id
      LEFT JOIN user u2 ON u2.id = ft.approved_by
      WHERE ft.id = ?
    `, [id]);
    
    res.json(updatedTransfer);
  } catch (e) {
    try {
      await conn.rollback();
    } catch (rollbackErr) {
      console.error('Error rolling back transaction (approve transfer):', rollbackErr);
    }
    console.error('Error approving fund transfer:', e);
    res.status(500).json(errPayload('Failed to approve fund transfer', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// POST /api/fund-transfer/:id/submit - Submit transfer for approval
router.post('/:id/submit', requireAuth, async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();

    const userId = req.user.id;
    const { id } = req.params;

    // Only DRAFT (status_id = 3) can be submitted
    const [[transfer]] = await conn.query(`
      SELECT * FROM tbl_fund_transfer WHERE id = ?
    `, [id]);

    if (!transfer) {
      await conn.rollback();
      return res.status(404).json(errPayload('Fund transfer not found', 'NOT_FOUND'));
    }

    if (transfer.status_id !== 3) {
      await conn.rollback();
      return res.status(400).json(errPayload('Only Draft transfers can be submitted for approval', 'VALIDATION_ERROR'));
    }

    // Use status_id = 8 for "Submitted for approval" (same as payments)
    await conn.query(`
      UPDATE tbl_fund_transfer
      SET status_id = 8
      WHERE id = ?
    `, [id]);

    // History
    await conn.query(`
      INSERT INTO history (module, module_id, user_id, action, details)
      VALUES (?, ?, ?, ?, ?)
    `, [
      'fund_transfer',
      id,
      userId,
      'SUBMITTED_FOR_APPROVAL',
      JSON.stringify({ transfer_no: transfer.transfer_no })
    ]);

    await conn.commit();

    const [[updated]] = await conn.query(`
      SELECT 
        ft.*,
        from_bank.bank_name as from_bank_name,
        from_bank.acc_no as from_account_number,
        to_bank.bank_name as to_bank_name,
        to_bank.acc_no as to_account_number,
        s.name as status_name
      FROM tbl_fund_transfer ft
      LEFT JOIN acc_bank_details from_bank ON from_bank.id = ft.from_bank_account_id
      LEFT JOIN acc_bank_details to_bank ON to_bank.id = ft.to_bank_account_id
      LEFT JOIN status s ON s.id = ft.status_id
      WHERE ft.id = ?
    `, [id]);

    res.json(updated);
  } catch (e) {
    try {
      await conn.rollback();
    } catch (rollbackErr) {
      console.error('Error rolling back transaction (submit transfer):', rollbackErr);
    }
    console.error('Error submitting fund transfer:', e);
    res.status(500).json(errPayload('Failed to submit fund transfer', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// PUT /api/fund-transfer/:id - Update fund transfer (only if Draft)
router.put('/:id', requireAuth, async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();
    const userId = req.user.id;
    const { id } = req.params;
    const {
      from_bank_account_id,
      to_bank_account_id,
      transfer_date,
      amount_from_currency,
      reference,
      notes,
      rate_from_to_aed,
      rate_to_to_aed,
      rate_overridden = false
    } = req.body;
    
    // Check if transfer exists and get current data
    const [[transfer]] = await conn.query(`
      SELECT * FROM tbl_fund_transfer WHERE id = ?
    `, [id]);
    
    if (!transfer) {
      await conn.rollback();
      return res.status(404).json(errPayload('Fund transfer not found', 'NOT_FOUND'));
    }
    
    const statusId = transfer.status_id;
    const canEditAllFields = statusId === 3 || statusId === 8 || statusId === 2; // Draft, Submitted for Approval, Rejected
    
    // For transfers that can't be fully edited, only allow updating reference and notes
    if (!canEditAllFields) {
      if (from_bank_account_id || to_bank_account_id || transfer_date || amount_from_currency !== undefined || 
          rate_from_to_aed !== undefined || rate_to_to_aed !== undefined) {
        await conn.rollback();
        return res.status(400).json(errPayload('Only reference and notes can be updated for this transfer status', 'VALIDATION_ERROR'));
      }
      
      // Track changes for history
      const changes = [];
      if ((transfer.reference || '') !== (reference || '')) {
        changes.push({ field: 'reference', from: transfer.reference || '', to: reference || '' });
      }
      if ((transfer.notes || '') !== (notes || '')) {
        changes.push({ field: 'notes', from: transfer.notes || '', to: notes || '' });
      }
      
      // Update only reference and notes
      await conn.query(`
        UPDATE tbl_fund_transfer 
        SET reference = ?, notes = ?, updated_by = ?, updated_at = NOW()
        WHERE id = ?
      `, [reference || null, notes || null, userId, id]);
      
      // Log history if there are changes
      if (changes.length > 0) {
        await conn.query(`
          INSERT INTO history (module, module_id, user_id, action, details)
          VALUES (?, ?, ?, ?, ?)
        `, [
          'fund_transfer',
          id,
          userId,
          'UPDATED',
          JSON.stringify({ changes })
        ]);
      }
      
      await conn.commit();
      
      // Fetch and return updated transfer
      const [[updatedTransfer]] = await conn.query(`
        SELECT 
          ft.*,
          from_bank.bank_name as from_bank_name,
          from_bank.acc_no as from_account_number,
          to_bank.bank_name as to_bank_name,
          to_bank.acc_no as to_account_number,
          s.name as status_name
        FROM tbl_fund_transfer ft
        LEFT JOIN acc_bank_details from_bank ON from_bank.id = ft.from_bank_account_id
        LEFT JOIN acc_bank_details to_bank ON to_bank.id = ft.to_bank_account_id
        LEFT JOIN status s ON s.id = ft.status_id
        WHERE ft.id = ?
      `, [id]);
      
      res.json(updatedTransfer);
      return;
    }
    
    // For Draft, Submitted for Approval, and Rejected transfers, allow updating all fields
    // Validation
    if (from_bank_account_id && to_bank_account_id && from_bank_account_id === to_bank_account_id) {
      await conn.rollback();
      return res.status(400).json(errPayload('From and To accounts cannot be the same', 'VALIDATION_ERROR'));
    }
    
    // Get bank account details if accounts are being updated
    let fromBank = null;
    let toBank = null;
    let fromCurrencyCode = null;
    let toCurrencyCode = null;
    
    if (from_bank_account_id || to_bank_account_id) {
      if (from_bank_account_id) {
        const [[fromBankResult]] = await conn.query(`
          SELECT id, acc_currency, currency_code, coa_id 
          FROM acc_bank_details 
          WHERE id = ?
        `, [from_bank_account_id]);
        if (!fromBankResult) {
          await conn.rollback();
          return res.status(404).json(errPayload('From bank account not found', 'NOT_FOUND'));
        }
        fromBank = fromBankResult;
        fromCurrencyCode = fromBank.currency_code || 'AED';
      }
      
      if (to_bank_account_id) {
        const [[toBankResult]] = await conn.query(`
          SELECT id, acc_currency, currency_code, coa_id 
          FROM acc_bank_details 
          WHERE id = ?
        `, [to_bank_account_id]);
        if (!toBankResult) {
          await conn.rollback();
          return res.status(404).json(errPayload('To bank account not found', 'NOT_FOUND'));
        }
        toBank = toBankResult;
        toCurrencyCode = toBank.currency_code || 'AED';
      }
    }
    
    // Get current transfer data for fields not being updated (already fetched above)
    const currentTransfer = transfer;
    
    const finalFromAccountId = from_bank_account_id || currentTransfer.from_bank_account_id;
    const finalToAccountId = to_bank_account_id || currentTransfer.to_bank_account_id;
    const finalTransferDate = transfer_date || currentTransfer.transfer_date;
    const finalAmount = amount_from_currency !== undefined ? parseFloat(amount_from_currency) : currentTransfer.amount_from_currency;
    const finalFromCurrency = fromCurrencyCode || currentTransfer.from_currency_code || 'AED';
    const finalToCurrency = toCurrencyCode || currentTransfer.to_currency_code || 'AED';
    
    // Get exchange rates if needed
    let finalRateFromToAED = rate_from_to_aed !== undefined ? parseFloat(rate_from_to_aed) : currentTransfer.rate_from_to_aed;
    let finalRateToToAED = rate_to_to_aed !== undefined ? parseFloat(rate_to_to_aed) : currentTransfer.rate_to_to_aed;
    
    if (!rate_overridden) {
      // Fetch rates if not provided
      if (finalFromCurrency !== 'AED' && (!finalRateFromToAED || finalRateFromToAED === 0)) {
        const rateFrom = await getBankExchangeRate(finalFromAccountId, finalTransferDate);
        if (rateFrom) {
          finalRateFromToAED = rateFrom;
        }
      } else if (finalFromCurrency === 'AED') {
        finalRateFromToAED = 1.0;
      }
      
      if (finalToCurrency !== 'AED' && (!finalRateToToAED || finalRateToToAED === 0)) {
        const rateTo = await getBankExchangeRate(finalToAccountId, finalTransferDate);
        if (rateTo) {
          finalRateToToAED = rateTo;
        }
      } else if (finalToCurrency === 'AED') {
        finalRateToToAED = 1.0;
      }
    }
    
    // Calculate amounts
    const amountAED = finalAmount * finalRateFromToAED;
    const amountToCurrency = amountAED / finalRateToToAED;
    
    // Track changes for history
    const changes = [];
    if (currentTransfer.from_bank_account_id !== finalFromAccountId) {
      changes.push({ field: 'from_bank_account_id', from: currentTransfer.from_bank_account_id, to: finalFromAccountId });
    }
    if (currentTransfer.to_bank_account_id !== finalToAccountId) {
      changes.push({ field: 'to_bank_account_id', from: currentTransfer.to_bank_account_id, to: finalToAccountId });
    }
    if (currentTransfer.transfer_date !== finalTransferDate) {
      changes.push({ field: 'transfer_date', from: currentTransfer.transfer_date, to: finalTransferDate });
    }
    if (Math.abs(parseFloat(currentTransfer.amount_from_currency || 0) - finalAmount) > 0.01) {
      changes.push({ field: 'amount_from_currency', from: currentTransfer.amount_from_currency, to: finalAmount });
    }
    if (currentTransfer.from_currency_code !== finalFromCurrency) {
      changes.push({ field: 'from_currency_code', from: currentTransfer.from_currency_code, to: finalFromCurrency });
    }
    if (currentTransfer.to_currency_code !== finalToCurrency) {
      changes.push({ field: 'to_currency_code', from: currentTransfer.to_currency_code, to: finalToCurrency });
    }
    if (Math.abs(parseFloat(currentTransfer.rate_from_to_aed || 0) - finalRateFromToAED) > 0.000001) {
      changes.push({ field: 'rate_from_to_aed', from: currentTransfer.rate_from_to_aed, to: finalRateFromToAED });
    }
    if (Math.abs(parseFloat(currentTransfer.rate_to_to_aed || 0) - finalRateToToAED) > 0.000001) {
      changes.push({ field: 'rate_to_to_aed', from: currentTransfer.rate_to_to_aed, to: finalRateToToAED });
    }
    if (Math.abs(parseFloat(currentTransfer.amount_aed || 0) - amountAED) > 0.01) {
      changes.push({ field: 'amount_aed', from: currentTransfer.amount_aed, to: amountAED });
    }
    if (Math.abs(parseFloat(currentTransfer.amount_to_currency || 0) - amountToCurrency) > 0.01) {
      changes.push({ field: 'amount_to_currency', from: currentTransfer.amount_to_currency, to: amountToCurrency });
    }
    if ((currentTransfer.rate_overridden ? 1 : 0) !== (rate_overridden ? 1 : 0)) {
      changes.push({ field: 'rate_overridden', from: currentTransfer.rate_overridden ? 1 : 0, to: rate_overridden ? 1 : 0 });
    }
    if ((currentTransfer.reference || '') !== (reference || '')) {
      changes.push({ field: 'reference', from: currentTransfer.reference || '', to: reference || '' });
    }
    if ((currentTransfer.notes || '') !== (notes || '')) {
      changes.push({ field: 'notes', from: currentTransfer.notes || '', to: notes || '' });
    }
    
    // If editing a non-Draft transfer, reset status to Draft (3)
    const oldStatusId = currentTransfer.status_id;
    const shouldResetToDraft = oldStatusId !== 3 && canEditAllFields;
    
    // Update transfer with all editable fields
    await conn.query(`
      UPDATE tbl_fund_transfer 
      SET 
        from_bank_account_id = ?,
        to_bank_account_id = ?,
        transfer_date = ?,
        amount_from_currency = ?,
        from_currency_code = ?,
        to_currency_code = ?,
        rate_from_to_aed = ?,
        rate_to_to_aed = ?,
        amount_aed = ?,
        amount_to_currency = ?,
        rate_overridden = ?,
        reference = ?,
        notes = ?,
        status_id = ?,
        updated_by = ?,
        updated_at = NOW()
      WHERE id = ?
    `, [
      finalFromAccountId,
      finalToAccountId,
      finalTransferDate,
      finalAmount,
      finalFromCurrency,
      finalToCurrency,
      finalRateFromToAED,
      finalRateToToAED,
      amountAED,
      amountToCurrency,
      rate_overridden ? 1 : 0,
      reference || null,
      notes || null,
      shouldResetToDraft ? 3 : oldStatusId, // Reset to Draft if editing non-Draft
      userId,
      id
    ]);
    
    // Log history if there are changes
    if (changes.length > 0) {
      await conn.query(`
        INSERT INTO history (module, module_id, user_id, action, details)
        VALUES (?, ?, ?, ?, ?)
      `, [
        'fund_transfer',
        id,
        userId,
        'UPDATED',
        JSON.stringify({ changes })
      ]);
    }
    
    // Log status change if reset to Draft
    if (shouldResetToDraft) {
      const [[oldStatus]] = await conn.query(`SELECT name FROM status WHERE id = ?`, [oldStatusId]);
      const [[newStatus]] = await conn.query(`SELECT name FROM status WHERE id = ?`, [3]);
      
      await conn.query(`
        INSERT INTO history (module, module_id, user_id, action, details)
        VALUES (?, ?, ?, ?, ?)
      `, [
        'fund_transfer',
        id,
        userId,
        'STATUS_CHANGED',
        JSON.stringify({
          from_status_id: oldStatusId,
          to_status_id: 3,
          from_status_name: oldStatus?.name || 'N/A',
          to_status_name: newStatus?.name || 'Draft',
          reason: 'Status reset to Draft after editing'
        })
      ]);
    }
    
    await conn.commit();

    // Fetch and return updated transfer
    const [[updatedTransfer]] = await conn.query(`
      SELECT 
        ft.*,
        from_bank.bank_name as from_bank_name,
        from_bank.acc_no as from_account_number,
        to_bank.bank_name as to_bank_name,
        to_bank.acc_no as to_account_number,
        s.name as status_name
      FROM tbl_fund_transfer ft
      LEFT JOIN acc_bank_details from_bank ON from_bank.id = ft.from_bank_account_id
      LEFT JOIN acc_bank_details to_bank ON to_bank.id = ft.to_bank_account_id
      LEFT JOIN status s ON s.id = ft.status_id
      WHERE ft.id = ?
    `, [id]);
    
    res.json(updatedTransfer);
  } catch (e) {
    try {
      await conn.rollback();
    } catch (rollbackErr) {
      console.error('Error rolling back transaction (update transfer):', rollbackErr);
    }
    console.error('Error updating fund transfer:', e);
    res.status(500).json(errPayload('Failed to update fund transfer', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// GET /api/fund-transfer/:id/history - Get transfer history
router.get('/:id/history', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    const [history] = await db.promise().query(`
      SELECT h.id, h.action, h.details, h.created_at, u.name as user_name
      FROM history h
      LEFT JOIN \`user\` u ON u.id = h.user_id
      WHERE h.module = 'fund_transfer' AND h.module_id = ?
      ORDER BY h.created_at DESC
    `, [id]);
    
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
    console.error('Error fetching transfer history:', e);
    res.status(500).json(errPayload('Failed to fetch transfer history', 'DB_ERROR', e.message));
  }
});

// GET /api/fund-transfer/:id/journal-entries - Get GL journal entries for transfer
router.get('/:id/journal-entries', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Fetch GL journal entries for this transfer
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
      WHERE gj.source_type = 'FUND_TRANSFER' AND gj.source_id = ?
      AND (gj.is_deleted = 0 OR gj.is_deleted IS NULL)
      ORDER BY gj.journal_date DESC, gj.id DESC, gjl.id ASC
    `, [id]);
    
    res.json({ data: journalEntries || [] });
  } catch (e) {
    console.error('Error fetching journal entries:', e);
    res.status(500).json(errPayload('Failed to fetch journal entries', 'DB_ERROR', e.message));
  }
});

// GET /api/fund-transfer/:id/attachments - Get transfer attachments
router.get('/:id/attachments', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    const [transfers] = await db.promise().query(`
      SELECT id FROM tbl_fund_transfer WHERE id = ?
    `, [id]);
    
    if (transfers.length === 0) {
      return res.status(404).json(errPayload('Fund transfer not found', 'NOT_FOUND'));
    }
    
    const [attachments] = await db.promise().query(`
      SELECT id, file_name, file_path, mime_type, size_bytes, created_at
      FROM tbl_fund_transfer_attachments
      WHERE transfer_id = ?
      ORDER BY created_at DESC
    `, [transfers[0].id]);
    
    res.json(attachments || []);
  } catch (e) {
    console.error('Error fetching attachments:', e);
    res.status(500).json(errPayload('Failed to fetch attachments', 'DB_ERROR', e.message));
  }
});

// POST /api/fund-transfer/:id/attachments - Add attachments to transfer
router.post('/:id/attachments', requireAuth, fundTransferUpload, async (req, res) => {
  const conn = await db.promise().getConnection();
  const userId = req.user?.id || req.session?.user?.id;
  
  try {
    await conn.beginTransaction();
    
    const { id } = req.params;
    
    const [transfers] = await conn.query(`
      SELECT id FROM tbl_fund_transfer WHERE id = ?
    `, [id]);
    
    if (transfers.length === 0) {
      await conn.rollback();
      return res.status(404).json(errPayload('Fund transfer not found', 'NOT_FOUND'));
    }
    
    if (!req.files || req.files.length === 0) {
      await conn.rollback();
      return res.status(400).json(errPayload('No files were uploaded', 'VALIDATION_ERROR'));
    }
    
    const attachmentValues = req.files.map(f => [
      transfers[0].id,
      f.originalname,
      relPath(f),
      f.mimetype || null,
      f.size || null,
      userId
    ]);
    
    await conn.query(`
      INSERT INTO tbl_fund_transfer_attachments 
      (transfer_id, file_name, file_path, mime_type, size_bytes, created_by)
      VALUES ?
    `, [attachmentValues]);
    
    // Log history
    await conn.query(`
      INSERT INTO history (module, module_id, user_id, action, details)
      VALUES (?, ?, ?, ?, ?)
    `, [
      'fund_transfer',
      transfers[0].id,
      userId,
      'ATTACHMENT_ADDED',
      JSON.stringify({ file_count: req.files.length })
    ]);
    
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

// DELETE /api/fund-transfer/:id/attachments/:attachmentId - Delete attachment
router.delete('/:id/attachments/:attachmentId', requireAuth, async (req, res) => {
  const conn = await db.promise().getConnection();
  const userId = req.user?.id || req.session?.user?.id;
  
  try {
    await conn.beginTransaction();
    
    const { id, attachmentId } = req.params;
    
    const [transfers] = await conn.query(`
      SELECT id FROM tbl_fund_transfer WHERE id = ?
    `, [id]);
    
    if (transfers.length === 0) {
      await conn.rollback();
      return res.status(404).json(errPayload('Fund transfer not found', 'NOT_FOUND'));
    }
    
    const [attachments] = await conn.query(`
      SELECT id, file_path, file_name FROM tbl_fund_transfer_attachments 
      WHERE id = ? AND transfer_id = ?
    `, [attachmentId, transfers[0].id]);
    
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
      DELETE FROM tbl_fund_transfer_attachments WHERE id = ?
    `, [attachmentId]);
    
    // Log history
    await conn.query(`
      INSERT INTO history (module, module_id, user_id, action, details)
      VALUES (?, ?, ?, ?, ?)
    `, [
      'fund_transfer',
      transfers[0].id,
      userId,
      'ATTACHMENT_DELETED',
      JSON.stringify({ file_name: attachments[0].file_name })
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

// POST /api/fund-transfer/:id/request-edit - Request edit for approved transfer
router.post('/:id/request-edit', requireAuth, async (req, res) => {
  const conn = await db.promise().getConnection();
  const userId = req.user.id;

  try {
    await conn.beginTransaction();

    const { id } = req.params;
    const { reason } = req.body;

    if (!reason || !reason.trim()) {
      await conn.rollback();
      return res.status(400).json(errPayload('A reason for the edit request is required', 'VALIDATION_ERROR'));
    }

    // Get transfer
    const [[transfer]] = await conn.query(`
      SELECT id, status_id, edit_request_status 
      FROM tbl_fund_transfer 
      WHERE id = ?
    `, [id]);

    if (!transfer) {
      await conn.rollback();
      return res.status(404).json(errPayload('Fund transfer not found', 'NOT_FOUND'));
    }

    // Only allow edit requests for APPROVED transfers (status_id = 1)
    if (transfer.status_id !== 1) {
      await conn.rollback();
      return res.status(400).json(errPayload('Only approved transfers can have edit requests', 'VALIDATION_ERROR'));
    }

    // Prevent new requests if one is already pending (3)
    if (transfer.edit_request_status === 3) {
      await conn.rollback();
      return res.status(400).json(errPayload('An edit request is already pending for this transfer', 'VALIDATION_ERROR'));
    }

    // Update transfer with edit request
    await conn.query(`
      UPDATE tbl_fund_transfer SET 
        edit_request_status = 3,
        edit_requested_by = ?,
        edit_requested_at = NOW(),
        edit_request_reason = ?,
        edit_approved_by = NULL,
        edit_approved_at = NULL,
        edit_rejection_reason = NULL
      WHERE id = ?
    `, [userId, reason.trim(), transfer.id]);

    // Add history entry
    await conn.query(`
      INSERT INTO history (module, module_id, user_id, action, details)
      VALUES (?, ?, ?, ?, ?)
    `, [
      'fund_transfer',
      transfer.id,
      userId,
      'EDIT_REQUESTED',
      JSON.stringify({ reason: reason.trim() })
    ]);

    await conn.commit();
    res.json({ success: true, message: 'Edit request submitted successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error requesting edit for transfer:', e);
    res.status(500).json(errPayload('Failed to process edit request', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// POST /api/fund-transfer/:id/reject - Reject transfer
router.post('/:id/reject', requireAuth, async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();
    const userId = req.user.id;
    const { id } = req.params;
    const { reason } = req.body;
    
    // Get transfer
    const [[transfer]] = await conn.query(`
      SELECT status_id, transfer_no FROM tbl_fund_transfer WHERE id = ?
    `, [id]);
    
    if (!transfer) {
      await conn.rollback();
      return res.status(404).json(errPayload('Fund transfer not found', 'NOT_FOUND'));
    }
    
    // Only allow rejection for Submitted for Approval (8)
    if (transfer.status_id !== 8) {
      await conn.rollback();
      return res.status(400).json(errPayload('Only transfers submitted for approval can be rejected', 'VALIDATION_ERROR'));
    }
    
    // Update status to Rejected (2)
    await conn.query(`
      UPDATE tbl_fund_transfer 
      SET status_id = 2, updated_by = ?, updated_at = NOW()
      WHERE id = ?
    `, [userId, id]);
    
    // Add history entry
    await conn.query(`
      INSERT INTO history (module, module_id, user_id, action, details)
      VALUES (?, ?, ?, ?, ?)
    `, [
      'fund_transfer',
      id,
      userId,
      'REJECTED',
      JSON.stringify({
        reason: reason || 'No reason provided.',
        transfer_no: transfer.transfer_no
      })
    ]);
    
    await conn.commit();

    // Fetch and return updated transfer
    const [[updatedTransfer]] = await conn.query(`
      SELECT 
        ft.*,
        from_bank.bank_name as from_bank_name,
        from_bank.acc_no as from_account_number,
        to_bank.bank_name as to_bank_name,
        to_bank.acc_no as to_account_number,
        s.name as status_name
      FROM tbl_fund_transfer ft
      LEFT JOIN acc_bank_details from_bank ON from_bank.id = ft.from_bank_account_id
      LEFT JOIN acc_bank_details to_bank ON to_bank.id = ft.to_bank_account_id
      LEFT JOIN status s ON s.id = ft.status_id
      WHERE ft.id = ?
    `, [id]);
    
    res.json(updatedTransfer);
  } catch (e) {
    try {
      await conn.rollback();
    } catch (rollbackErr) {
      console.error('Error rolling back transaction (reject transfer):', rollbackErr);
    }
    console.error('Error rejecting fund transfer:', e);
    res.status(500).json(errPayload('Failed to reject fund transfer', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// POST /api/fund-transfer/:id/decide-edit-request - Approve/reject edit request
router.post('/:id/decide-edit-request', requireAuth, async (req, res) => {
  const conn = await db.promise().getConnection();
  const userId = req.user.id;

  try {
    await conn.beginTransaction();

    const { id } = req.params;
    const { decision, reason } = req.body;

    if (!decision || !['approve', 'reject'].includes(decision)) {
      await conn.rollback();
      return res.status(400).json(errPayload('Decision must be "approve" or "reject"', 'VALIDATION_ERROR'));
    }

    // Get transfer with pending edit request
    const [[transfer]] = await conn.query(`
      SELECT id, status_id, edit_request_status 
      FROM tbl_fund_transfer 
      WHERE id = ? AND edit_request_status = 3
    `, [id]);

    if (!transfer) {
      await conn.rollback();
      return res.status(404).json(errPayload('No pending edit request found for this transfer', 'NOT_FOUND'));
    }

    if (decision === 'approve') {
      // Approve edit request - set status to DRAFT (3) to allow editing
      await conn.query(`
        UPDATE tbl_fund_transfer SET 
          status_id = 3,
          edit_request_status = 1,
          edit_approved_by = ?,
          edit_approved_at = NOW()
        WHERE id = ?
      `, [userId, transfer.id]);

      // Add history entry
      await conn.query(`
        INSERT INTO history (module, module_id, user_id, action, details)
        VALUES (?, ?, ?, ?, ?)
      `, [
        'fund_transfer',
        transfer.id,
        userId,
        'EDIT_REQUEST_APPROVED',
        JSON.stringify({ comment: reason || 'Edit request approved' })
      ]);
    } else {
      // Reject edit request
      await conn.query(`
        UPDATE tbl_fund_transfer SET 
          edit_request_status = 2,
          edit_rejection_reason = ?
        WHERE id = ?
      `, [reason || 'Edit request rejected', transfer.id]);

      // Add history entry
      await conn.query(`
        INSERT INTO history (module, module_id, user_id, action, details)
        VALUES (?, ?, ?, ?, ?)
      `, [
        'fund_transfer',
        transfer.id,
        userId,
        'EDIT_REQUEST_REJECTED',
        JSON.stringify({ reason: reason || 'Edit request rejected' })
      ]);
    }

    await conn.commit();
    res.json({ success: true, message: `Edit request ${decision}d successfully` });
  } catch (e) {
    await conn.rollback();
    console.error('Error deciding transfer edit request:', e);
    res.status(500).json(errPayload('Failed to process edit request', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

export default router;
