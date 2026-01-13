// server/src/modules/gl/gl.service.js
// General Ledger service

const { tx } = require('../../db/tx.cjs');
const { generateGLJournalNumber } = require('../../utils/docNo.cjs');
const { validateEntityRequired } = require('../../utils/ledgerEntityHelper.cjs');
const { updateEntityBalances } = require('./entityBalance.service.cjs');

/**
 * Create a GL journal entry with automatic entity balance updates
 * This is the main function to use for posting journals
 * @param {Object} conn - Database connection (must be in transaction)
 * @param {Object} params - Journal parameters
 * @param {string} params.source_type - Source type (e.g., 'AR_INVOICE', 'AP_BILL')
 * @param {number} params.source_id - Source document ID
 * @param {Date} params.journal_date - Journal date
 * @param {string} params.memo - Journal memo
 * @param {number} params.created_by - User ID who created the journal
 * @param {number} [params.company_id=1] - Company ID (defaults to 1)
 * @param {Array} params.lines - Array of journal lines
 * @returns {Promise<number>} - Journal ID
 */
async function createJournal(conn, params) {
    const {
        source_type,
        source_id,
        journal_date = new Date(),
        memo = null,
        created_by,
        company_id = 1,
        currency_id = null,
        exchange_rate = null,
        foreign_amount = null,
        total_amount = null,
        source_name = null,
        source_date = null,
        reconcile_date = null,
        reconcile_number = null,
        is_deleted = 0,
        lines = []
    } = params;

    if (!lines || lines.length === 0) {
        throw new Error('Journal must have at least one line');
    }

    // Validate double entry
    const totalDebits = lines.reduce((sum, line) => sum + parseFloat(line.debit || 0), 0);
    const totalCredits = lines.reduce((sum, line) => sum + parseFloat(line.credit || 0), 0);

    if (Math.abs(totalDebits - totalCredits) > 0.01) {
        throw new Error(`Journal is not balanced. Debits: ${totalDebits}, Credits: ${totalCredits}`);
    }

    // Currency conversion logic:
    // foreign_amount = amount in foreign currency (bill's currency, e.g., USD)
    // exchange_rate = conversion rate from foreign currency to default currency (e.g., 1 USD = 3.67 AED)
    // total_amount = foreign_amount * exchange_rate (converted to default currency)
    
    // If total_amount is provided, use it; otherwise calculate from foreign_amount and exchange_rate
    let journalTotalAmount;
    let journalForeignAmount;
    
    if (foreign_amount !== null && exchange_rate && exchange_rate > 0) {
        // foreign_amount is provided, calculate total_amount
        journalForeignAmount = parseFloat(foreign_amount);
        journalTotalAmount = total_amount !== null 
            ? parseFloat(total_amount) 
            : journalForeignAmount * parseFloat(exchange_rate);
    } else if (total_amount !== null) {
        // total_amount is provided, calculate foreign_amount if exchange_rate exists
        journalTotalAmount = parseFloat(total_amount);
        journalForeignAmount = foreign_amount !== null 
            ? parseFloat(foreign_amount)
            : (exchange_rate && exchange_rate > 0 ? journalTotalAmount / parseFloat(exchange_rate) : journalTotalAmount);
    } else {
        // Neither provided, use debits total as default (assume default currency)
        journalTotalAmount = totalDebits;
        journalForeignAmount = foreign_amount !== null ? parseFloat(foreign_amount) : journalTotalAmount;
    }

    // Generate journal number
    const journalNumber = await generateGLJournalNumber(conn, new Date(journal_date).getFullYear());

    // Insert journal header
    const [journalResult] = await conn.query(`
        INSERT INTO gl_journals 
        (journal_number, journal_date, source_type, source_id, memo, created_by,
         currency_id, exchange_rate, foreign_amount, total_amount, source_name, source_date, reconcile_date, reconcile_number, is_deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [journalNumber, journal_date, source_type, source_id, memo, created_by,
        currency_id, exchange_rate, journalForeignAmount, journalTotalAmount, source_name, source_date, reconcile_date, reconcile_number, is_deleted]);

    const journalId = journalResult.insertId;

    // Insert journal lines
    if (lines.length > 0) {
        // Validate entity requirements for all lines before inserting
        for (const line of lines) {
            await validateEntityRequired(conn, line, source_type);
        }

        const lineValues = lines.map((line, index) => {
            const lineDebit = parseFloat(line.debit || 0);
            const lineCredit = parseFloat(line.credit || 0);
            const lineAmount = lineDebit > 0 ? lineDebit : lineCredit; // The amount for this line
            
            // Calculate currency fields for the line
            let lineCurrencyId = currency_id;
            let lineForeignAmount = null;
            let lineTotalAmount = null;
            
            // Check if it's default currency (exchange_rate === 1.0 or no exchange_rate)
            const isDefaultCurrency = !exchange_rate || parseFloat(exchange_rate) === 1.0;
            
            if (currency_id && exchange_rate && exchange_rate > 0 && !isDefaultCurrency) {
                // Journal has foreign currency - convert line amounts
                lineForeignAmount = lineAmount; // Line amount is in foreign currency
                lineTotalAmount = lineAmount * parseFloat(exchange_rate); // Convert to default currency
            } else {
                // Default currency (AED) - always save currency_id and set foreign_amount = total_amount
                lineCurrencyId = currency_id; // Keep currency_id even for default currency
                lineForeignAmount = lineAmount; // For default currency, foreign_amount = total_amount
                lineTotalAmount = lineAmount;
            }
            
            return [
            journalId,
            index + 1,
            line.account_id,
                lineDebit,
                lineCredit,
            line.entity_type || null,
            line.entity_id || null,
                line.description || null,
                lineCurrencyId,
                lineForeignAmount,
                lineTotalAmount,
                line.buyer_id || null,
                line.product_id || null,
                line.is_advance !== undefined ? (line.is_advance ? 1 : 0) : 0,
                line.invoice_id || null
            ];
        });

        await conn.query(`
            INSERT INTO gl_journal_lines 
            (journal_id, line_no, account_id, debit, credit, entity_type, entity_id, description, currency_id, foreign_amount, total_amount, buyer_id, product_id, is_advance, invoice_id)
            VALUES ?
        `, [lineValues]);

        // Update entity ledger balances for lines with entity_type and entity_id
        await updateEntityBalances(conn, company_id, lines);
    }

    return journalId;
}

/**
 * Create a reversal journal (swap debits and credits)
 */
async function createReversalJournal(conn, originalJournalId, created_by) {
    // Get original journal
    const [journals] = await conn.query(`
        SELECT * FROM gl_journals WHERE id = ?
    `, [originalJournalId]);

    if (journals.length === 0) {
        throw new Error('Original journal not found');
    }

    const originalJournal = journals[0];

    // Get original journal lines
    const [lines] = await conn.query(`
        SELECT * FROM gl_journal_lines WHERE journal_id = ? ORDER BY line_no
    `, [originalJournalId]);

    // Swap debits and credits
    const reversalLines = lines.map(line => ({
        account_id: line.account_id,
        debit: line.credit,
        credit: line.debit,
        entity_type: line.entity_type,
        entity_id: line.entity_id,
        description: `Reversal: ${line.description || ''}`
    }));

    // Calculate reversal amounts (total will be same, but debits/credits swapped)
    const reversalTotalDebits = reversalLines.reduce((sum, line) => sum + parseFloat(line.debit || 0), 0);
    // For reversal, preserve the same foreign_amount and total_amount as original
    // (debits/credits are swapped, but amounts remain the same)
    const reversalForeignAmount = originalJournal.foreign_amount || null;
    const reversalTotalAmount = originalJournal.total_amount || reversalTotalDebits;

    // Create reversal journal (preserve currency fields from original)
    const reversalJournalId = await createJournal(conn, {
        source_type: originalJournal.source_type,
        source_id: originalJournal.source_id,
        journal_date: new Date(),
        memo: `Reversal of ${originalJournal.journal_number}`,
        created_by,
        currency_id: originalJournal.currency_id || null,
        exchange_rate: originalJournal.exchange_rate || null,
        foreign_amount: reversalForeignAmount,
        total_amount: reversalTotalAmount,
        is_deleted: originalJournal.is_deleted || 0,
        lines: reversalLines
    });

    return reversalJournalId;
}

/**
 * Get account ID by code, name, or direct ID
 * Supports:
 * - Direct ID lookup (if accountCode is numeric)
 * - Name lookup
 * - Account code lookup (if exists)
 */
async function getAccountByCode(conn, accountCode) {
    // If accountCode is numeric, treat it as direct ID
    if (/^\d+$/.test(accountCode)) {
        const [rows] = await conn.query(`
            SELECT id FROM acc_chart_accounts WHERE id = ? LIMIT 1
        `, [accountCode]);
        if (rows.length > 0) {
            return rows[0].id;
        }
    }

    // Try to find by name
    let [rows] = await conn.query(`
        SELECT id FROM acc_chart_accounts WHERE name = ? LIMIT 1
    `, [accountCode]);

    return rows.length > 0 ? rows[0].id : null;
}

module.exports = {
    createJournal,
    createReversalJournal,
    getAccountByCode
};

