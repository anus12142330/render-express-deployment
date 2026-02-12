// server/src/modules/gl/gl.service.js
// General Ledger service

const { tx } = require('../../db/tx.cjs');
const { generateGLJournalNumber } = require('../../utils/docNo.cjs');

/**
 * Create a GL journal entry
 */
async function createJournal(conn, params) {
    const {
        source_type,
        source_id,
        journal_date = new Date(),
        memo = null,
        created_by,
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

    // Generate journal number
    const journalNumber = await generateGLJournalNumber(conn, new Date(journal_date).getFullYear());

    // Insert journal header
    const [journalResult] = await conn.query(`
        INSERT INTO gl_journals 
        (journal_number, journal_date, source_type, source_id, memo, created_by)
        VALUES (?, ?, ?, ?, ?, ?)
    `, [journalNumber, journal_date, source_type, source_id, memo, created_by]);

    const journalId = journalResult.insertId;

    // Insert journal lines
    if (lines.length > 0) {
        const lineValues = lines.map((line, index) => [
            journalId,
            index + 1,
            line.account_id,
            parseFloat(line.debit || 0),
            parseFloat(line.credit || 0),
            line.entity_type || null,
            line.entity_id || null,
            line.description || null
        ]);

        await conn.query(`
            INSERT INTO gl_journal_lines 
            (journal_id, line_no, account_id, debit, credit, entity_type, entity_id, description)
            VALUES ?
        `, [lineValues]);
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

    // Create reversal journal
    const reversalJournalId = await createJournal(conn, {
        source_type: originalJournal.source_type,
        source_id: originalJournal.source_id,
        journal_date: new Date(),
        memo: `Reversal of ${originalJournal.journal_number}`,
        created_by,
        lines: reversalLines
    });

    return reversalJournalId;
}

/**
 * Get account ID by code
 */
async function getAccountByCode(conn, accountCode) {
    const [rows] = await conn.query(`
        SELECT id FROM coa_accounts WHERE account_code = ? AND is_active = 1 LIMIT 1
    `, [accountCode]);

    return rows.length > 0 ? rows[0].id : null;
}

module.exports = {
    createJournal,
    createReversalJournal,
    getAccountByCode
};

