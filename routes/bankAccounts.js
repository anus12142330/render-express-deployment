// server/routes/bankAccounts.js
import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requirePerm } from '../middleware/authz.js';

const router = Router();

// Helper function for error responses
const errPayload = (message, code, details) => ({
  error: { message, code, details }
});

// Helper function to get exchange rate for a bank account on a specific date
export const getBankExchangeRate = async (bankAccountId, date) => {
  try {
    // Get currency code for the bank account
    const [[bankAccount]] = await db.promise().query(`
      SELECT currency_code FROM acc_bank_details WHERE id = ?
    `, [bankAccountId]);

    if (!bankAccount) {
      throw new Error('Bank account not found');
    }

    // If currency is AED, return 1.0
    if (bankAccount.currency_code === 'AED' || !bankAccount.currency_code) {
      return 1.0;
    }

    // Get the latest rate where effective_from <= date
    const [[rate]] = await db.promise().query(`
      SELECT rate_to_aed 
      FROM tbl_bank_exchange_rate 
      WHERE bank_account_id = ? AND effective_from <= ?
      ORDER BY effective_from DESC 
      LIMIT 1
    `, [bankAccountId, date]);

    if (!rate) {
      // If no rate found, return null (caller should handle)
      return null;
    }

    return parseFloat(rate.rate_to_aed);
  } catch (e) {
    console.error('Error getting bank exchange rate:', e);
    return null;
  }
};

// GET /api/bank-accounts - List all bank accounts
router.get('/', requireAuth, async (req, res) => {
  try {
    const { search } = req.query;
    let whereClause = 'WHERE 1=1';
    const params = [];

    if (search) {
      whereClause += ' AND (bank_name LIKE ? OR acc_name LIKE ? OR acc_no LIKE ?)';
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
    }

    const [rows] = await db.promise().query(`
      SELECT 
        b.id,
        b.bank_name,
        b.nick_name as bank_alias,
        b.acc_no as account_number,
        b.acc_name as account_name,
        b.company_id,
        b.acc_currency,
        b.currency_code,
        b.opening_balance,
        b.opening_balance_date,
        b.coa_id as ledger_account_id,
        b.in_active as is_active,
        c.name as company_name,
        curr.name as currency_name
      FROM acc_bank_details b
      LEFT JOIN company_settings c ON c.id = b.company_id
      LEFT JOIN currency curr ON curr.id = b.acc_currency
      ${whereClause}
      ORDER BY b.bank_name ASC
    `, params);

    res.json(rows || []);
  } catch (e) {
    console.error('Error fetching bank accounts:', e);
    res.status(500).json(errPayload('Failed to fetch bank accounts', 'DB_ERROR', e.message));
  }
});

// GET /api/bank-accounts/:id - Get single bank account with exchange rates
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const [[bankAccount]] = await db.promise().query(`
      SELECT 
        b.id,
        b.bank_name,
        b.nick_name as bank_alias,
        b.acc_no as account_number,
        b.acc_name as account_name,
        b.company_id,
        b.acc_currency,
        b.currency_code,
        b.opening_balance,
        b.opening_balance_date,
        b.coa_id as ledger_account_id,
        b.in_active as is_active,
        b.address,
        b.iban_no,
        b.swift_code,
        b.branch,
        c.name as company_name,
        curr.name as currency_name
      FROM acc_bank_details b
      LEFT JOIN company_settings c ON c.id = b.company_id
      LEFT JOIN currency curr ON curr.id = b.acc_currency
      WHERE b.id = ?
    `, [id]);

    if (!bankAccount) {
      return res.status(404).json(errPayload('Bank account not found', 'NOT_FOUND'));
    }

    // Get exchange rates
    const [exchangeRates] = await db.promise().query(`
      SELECT 
        id,
        bank_account_id,
        effective_from,
        rate_to_aed,
        created_at,
        created_by
      FROM tbl_bank_exchange_rate
      WHERE bank_account_id = ?
      ORDER BY effective_from DESC
    `, [id]);

    res.json({
      ...bankAccount,
      exchange_rates: exchangeRates || []
    });
  } catch (e) {
    console.error('Error fetching bank account:', e);
    res.status(500).json(errPayload('Failed to fetch bank account', 'DB_ERROR', e.message));
  }
});

// POST /api/bank-accounts - Create new bank account
router.post('/', requireAuth, requirePerm('Settings', 'create'), async (req, res) => {
  const conn = await db.promise().getConnection();
  const userId = req.session?.user?.id;

  try {
    await conn.beginTransaction();

    const {
      bank_name,
      bank_alias,
      account_number,
      account_name,
      company_id,
      currency_code,
      acc_currency,
      opening_balance,
      opening_balance_date,
      ledger_account_id,
      is_active,
      address,
      iban_no,
      swift_code,
      branch
    } = req.body;

    // Validation
    if (!bank_name || !account_number) {
      await conn.rollback();
      return res.status(400).json(errPayload('Bank name and account number are required', 'VALIDATION_ERROR'));
    }

    if (!company_id) {
      await conn.rollback();
      return res.status(400).json(errPayload('Company name is required', 'VALIDATION_ERROR'));
    }

    if (!currency_code && !acc_currency) {
      await conn.rollback();
      return res.status(400).json(errPayload('Currency is required', 'VALIDATION_ERROR'));
    }

    if (!ledger_account_id) {
      await conn.rollback();
      return res.status(400).json(errPayload('Chart of Accounts Head is required', 'VALIDATION_ERROR'));
    }

    // Insert bank account
    const [result] = await conn.query(`
      INSERT INTO acc_bank_details (
        bank_name, nick_name, acc_no, acc_name, company_id,
        acc_currency, currency_code, opening_balance, opening_balance_date,
        coa_id, in_active, address, iban_no, swift_code, branch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      bank_name,
      bank_alias || null,
      account_number,
      account_name || null,
      company_id || null,
      acc_currency || null,
      currency_code || null,
      opening_balance ? parseFloat(opening_balance) : 0,
      opening_balance_date || null,
      ledger_account_id || null,
      is_active !== undefined ? (is_active ? 0 : 1) : 0, // in_active: 0 = active, 1 = inactive
      address || null,
      iban_no || null,
      swift_code || null,
      branch || null
    ]);

    const bankAccountId = result.insertId;

    await conn.commit();
    res.json({ id: bankAccountId, message: 'Bank account created successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error creating bank account:', e);
    res.status(500).json(errPayload('Failed to create bank account', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// PUT /api/bank-accounts/:id - Update bank account
router.put('/:id', requireAuth, requirePerm('Settings', 'edit'), async (req, res) => {
  const conn = await db.promise().getConnection();
  const userId = req.session?.user?.id;

  try {
    await conn.beginTransaction();

    const { id } = req.params;
    const {
      bank_name,
      bank_alias,
      account_number,
      account_name,
      company_id,
      currency_code,
      acc_currency,
      opening_balance,
      opening_balance_date,
      ledger_account_id,
      is_active,
      address,
      iban_no,
      swift_code,
      branch
    } = req.body;

    // Validation
    if (!bank_name || !account_number) {
      await conn.rollback();
      return res.status(400).json(errPayload('Bank name and account number are required', 'VALIDATION_ERROR'));
    }

    if (!company_id) {
      await conn.rollback();
      return res.status(400).json(errPayload('Company name is required', 'VALIDATION_ERROR'));
    }

    if (!currency_code && !acc_currency) {
      await conn.rollback();
      return res.status(400).json(errPayload('Currency is required', 'VALIDATION_ERROR'));
    }

    if (!ledger_account_id) {
      await conn.rollback();
      return res.status(400).json(errPayload('Chart of Accounts Head is required', 'VALIDATION_ERROR'));
    }

    // Check if bank account exists
    const [[existing]] = await conn.query(`
      SELECT id FROM acc_bank_details WHERE id = ?
    `, [id]);

    if (!existing) {
      await conn.rollback();
      return res.status(404).json(errPayload('Bank account not found', 'NOT_FOUND'));
    }

    // Update bank account
    await conn.query(`
      UPDATE acc_bank_details SET
        bank_name = ?,
        nick_name = ?,
        acc_no = ?,
        acc_name = ?,
        company_id = ?,
        acc_currency = ?,
        currency_code = ?,
        opening_balance = ?,
        opening_balance_date = ?,
        coa_id = ?,
        in_active = ?,
        address = ?,
        iban_no = ?,
        swift_code = ?,
        branch = ?
      WHERE id = ?
    `, [
      bank_name,
      bank_alias || null,
      account_number,
      account_name || null,
      company_id || null,
      acc_currency || null,
      currency_code || null,
      opening_balance ? parseFloat(opening_balance) : 0,
      opening_balance_date || null,
      ledger_account_id || null,
      is_active !== undefined ? (is_active ? 0 : 1) : 0,
      address || null,
      iban_no || null,
      swift_code || null,
      branch || null,
      id
    ]);

    await conn.commit();
    res.json({ message: 'Bank account updated successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error updating bank account:', e);
    res.status(500).json(errPayload('Failed to update bank account', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// GET /api/bank-accounts/:id/exchange-rates - Get exchange rates for a bank account
router.get('/:id/exchange-rates', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const [rates] = await db.promise().query(`
      SELECT 
        id,
        bank_account_id,
        effective_from,
        rate_to_aed,
        created_at,
        created_by
      FROM tbl_bank_exchange_rate
      WHERE bank_account_id = ?
      ORDER BY effective_from DESC
    `, [id]);

    res.json(rates || []);
  } catch (e) {
    console.error('Error fetching exchange rates:', e);
    res.status(500).json(errPayload('Failed to fetch exchange rates', 'DB_ERROR', e.message));
  }
});

// POST /api/bank-accounts/:id/exchange-rates - Add new exchange rate
router.post('/:id/exchange-rates', requireAuth, requirePerm('Settings', 'edit'), async (req, res) => {
  const conn = await db.promise().getConnection();
  const userId = req.session?.user?.id;

  try {
    await conn.beginTransaction();

    const { id } = req.params;
    const { effective_from, rate_to_aed } = req.body;

    // Validation
    if (!effective_from || !rate_to_aed) {
      await conn.rollback();
      return res.status(400).json(errPayload('Effective from date and rate are required', 'VALIDATION_ERROR'));
    }

    // Check if bank account exists
    const [[bankAccount]] = await conn.query(`
      SELECT id, currency_code FROM acc_bank_details WHERE id = ?
    `, [id]);

    if (!bankAccount) {
      await conn.rollback();
      return res.status(404).json(errPayload('Bank account not found', 'NOT_FOUND'));
    }

    // Check if rate already exists for this date
    const [[existing]] = await conn.query(`
      SELECT id FROM tbl_bank_exchange_rate 
      WHERE bank_account_id = ? AND effective_from = ?
    `, [id, effective_from]);

    if (existing) {
      await conn.rollback();
      return res.status(400).json(errPayload('Exchange rate already exists for this date', 'VALIDATION_ERROR'));
    }

    // Insert new rate
    const [result] = await conn.query(`
      INSERT INTO tbl_bank_exchange_rate (
        bank_account_id, effective_from, rate_to_aed, created_by
      ) VALUES (?, ?, ?, ?)
    `, [id, effective_from, parseFloat(rate_to_aed), userId]);

    await conn.commit();
    res.json({ id: result.insertId, message: 'Exchange rate added successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error adding exchange rate:', e);
    res.status(500).json(errPayload('Failed to add exchange rate', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// GET /api/bank-accounts/:id/exchange-rate?date=YYYY-MM-DD - Get exchange rate for a specific date
router.get('/:id/exchange-rate', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { date } = req.query;
    
    if (!date) {
      return res.status(400).json(errPayload('Date parameter is required', 'VALIDATION_ERROR'));
    }
    
    // Use the helper function to get the rate
    const rate = await getBankExchangeRate(parseInt(id), date);
    
    res.json({ rate_to_aed: rate });
  } catch (e) {
    console.error('Error getting exchange rate:', e);
    res.status(500).json(errPayload('Failed to get exchange rate', 'DB_ERROR', e.message));
  }
});

// DELETE /api/bank-accounts/exchange-rates/:rateId - Delete exchange rate
router.delete('/exchange-rates/:rateId', requireAuth, requirePerm('Settings', 'delete'), async (req, res) => {
  const conn = await db.promise().getConnection();

  try {
    await conn.beginTransaction();

    const { rateId } = req.params;

    // Check if rate exists
    const [[rate]] = await conn.query(`
      SELECT id, bank_account_id, effective_from 
      FROM tbl_bank_exchange_rate 
      WHERE id = ?
    `, [rateId]);

    if (!rate) {
      await conn.rollback();
      return res.status(404).json(errPayload('Exchange rate not found', 'NOT_FOUND'));
    }

    // Note: Exchange rates are reference data used for currency conversion
    // Deleting a rate won't break existing transactions as they use the rate that was effective at the time
    // We allow deletion, but you can add validation here if needed based on your business rules

    // Delete the rate
    await conn.query(`
      DELETE FROM tbl_bank_exchange_rate WHERE id = ?
    `, [rateId]);

    await conn.commit();
    res.json({ message: 'Exchange rate deleted successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error deleting exchange rate:', e);
    res.status(500).json(errPayload('Failed to delete exchange rate', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

export default router;

