// server/src/modules/openingBalance/openingBalance.service.cjs
// Opening Balance service - handles GL posting for opening balances

const glService = require('../gl/gl.service.cjs');

/**
 * Get account ID by acc_type_id
 * Returns the first account of the specified type
 */
async function getAccountByTypeId(conn, accTypeId) {
    const [rows] = await conn.query(`
        SELECT id 
        FROM acc_chart_accounts 
        WHERE acc_type_id = ? 
        ORDER BY id ASC
        LIMIT 1
    `, [accTypeId]);

    return rows.length > 0 ? rows[0].id : null;
}

/**
 * Post Opening Balance Batch - creates GL journal entries
 * 
 * GL Posting Rules (NO ADVANCE ACCOUNTS):
 * 
 * For Customers:
 *   - If net > 0 (debit receivable):
 *     Dr Accounts Receivable (AR control, acc_type_id=1)    Net
 *     Cr Owner's Equity (acc_type_id=10)                    Net
 *   - If net < 0 (customer credit):
 *     Dr Owner's Equity (acc_type_id=10)                    ABS(Net)
 *     Cr Accounts Receivable (AR control, acc_type_id=1)   ABS(Net)
 *     (Credit balance stays as negative/contra in AR)
 * 
 * For Suppliers:
 *   - If net < 0 (typical payable, credit > debit):
 *     Dr Owner's Equity (acc_type_id=10)                    ABS(Net)
 *     Cr Accounts Payable (AP control, acc_type_id=6)      ABS(Net)
 *   - If net > 0 (supplier debit/prepaid):
 *     Dr Accounts Payable (AP control, acc_type_id=6)      Net
 *     Cr Owner's Equity (acc_type_id=10)                    Net
 *     (Debit balance stays as negative/contra in AP)
 */
async function postOpeningBalance(conn, batchId, userId) {
    // Get batch - must be in Submitted for Approval status (status_id = 8)
    const [batches] = await conn.query(`
        SELECT * FROM opening_balance_batch 
        WHERE id = ? AND status_id = 8
    `, [batchId]);

    if (batches.length === 0) {
        throw new Error('Opening balance batch not found or not in Submitted for Approval status');
    }

    const batch = batches[0];

    // If batch already has a GL journal (editing approved batch), mark it as deleted
    if (batch.gl_journal_id) {
        await conn.query(`
            UPDATE gl_journals 
            SET is_deleted = 1 
            WHERE id = ?
        `, [batch.gl_journal_id]);
    }

    // Get all lines
    const [lines] = await conn.query(`
        SELECT * FROM opening_balance_lines 
        WHERE batch_id = ?
        ORDER BY party_type, party_id
    `, [batchId]);

    if (lines.length === 0) {
        throw new Error('Opening balance batch must have at least one line');
    }

    // Use specific account IDs directly
    const arAccountId = 1; // Accounts Receivable
    const apAccountId = 6; // Accounts Payable
    const equityAccountId = 9; // Owner's Equity

    // Validate required accounts exist
    const [arCheck] = await conn.query(`SELECT id FROM acc_chart_accounts WHERE id = ?`, [arAccountId]);
    if (arCheck.length === 0) {
        throw new Error('Accounts Receivable account (ID=1) not found.');
    }
    const [apCheck] = await conn.query(`SELECT id FROM acc_chart_accounts WHERE id = ?`, [apAccountId]);
    if (apCheck.length === 0) {
        throw new Error('Accounts Payable account (ID=6) not found.');
    }
    const [equityCheck] = await conn.query(`SELECT id FROM acc_chart_accounts WHERE id = ?`, [equityAccountId]);
    if (equityCheck.length === 0) {
        throw new Error('Owner\'s Equity account (ID=9) not found.');
    }

    // Build GL journal lines
    const journalLines = [];
    let totalDebits = 0;
    let totalCredits = 0;

    // Process customer lines
    const customerLines = lines.filter(l => l.party_type === 'CUSTOMER');
    for (const line of customerLines) {
        const debitAed = parseFloat(line.debit_aed || 0);
        const creditAed = parseFloat(line.credit_aed || 0);
        const netAed = debitAed - creditAed;
        
        if (Math.abs(netAed) < 0.01) continue; // Skip zero lines

        if (netAed > 0) {
            // Customer owes us (debit receivable)
            // Dr AR / Cr Equity
            journalLines.push({
                account_id: arAccountId,
                debit: netAed,
                credit: 0,
                description: `Opening Balance - Customer ${line.party_id}`,
                entity_type: 'CUSTOMER',
                entity_id: line.party_id,
                buyer_id: line.party_id
            });
            journalLines.push({
                account_id: equityAccountId,
                debit: 0,
                credit: netAed,
                description: `Opening Balance - Customer ${line.party_id}`,
                entity_type: 'CUSTOMER',
                entity_id: line.party_id,
                buyer_id: line.party_id
            });
            totalDebits += netAed;
            totalCredits += netAed;
        } else {
            // Customer credit (we owe customer / customer has credit)
            // Dr Equity / Cr AR (keeps credit as negative/contra in AR)
            const absNet = Math.abs(netAed);
            journalLines.push({
                account_id: equityAccountId,
                debit: absNet,
                credit: 0,
                description: `Opening Balance - Customer ${line.party_id}`,
                entity_type: 'CUSTOMER',
                entity_id: line.party_id,
                buyer_id: line.party_id
            });
            journalLines.push({
                account_id: arAccountId,
                debit: 0,
                credit: absNet,
                description: `Opening Balance - Customer ${line.party_id}`,
                entity_type: 'CUSTOMER',
                entity_id: line.party_id,
                buyer_id: line.party_id
            });
            totalDebits += absNet;
            totalCredits += absNet;
        }
    }

    // Process supplier lines
    const supplierLines = lines.filter(l => l.party_type === 'SUPPLIER');
    for (const line of supplierLines) {
        const debitAed = parseFloat(line.debit_aed || 0);
        const creditAed = parseFloat(line.credit_aed || 0);
        const netAed = debitAed - creditAed;
        
        if (Math.abs(netAed) < 0.01) continue; // Skip zero lines

        if (netAed < 0) {
            // We owe supplier (typical payable, credit > debit)
            // Dr Equity / Cr AP
            const absNet = Math.abs(netAed);
            journalLines.push({
                account_id: equityAccountId,
                debit: absNet,
                credit: 0,
                description: `Opening Balance - Supplier ${line.party_id}`,
                entity_type: 'SUPPLIER',
                entity_id: line.party_id,
                buyer_id: line.party_id
            });
            journalLines.push({
                account_id: apAccountId,
                debit: 0,
                credit: absNet,
                description: `Opening Balance - Supplier ${line.party_id}`,
                entity_type: 'SUPPLIER',
                entity_id: line.party_id,
                buyer_id: line.party_id
            });
            totalDebits += absNet;
            totalCredits += absNet;
        } else {
            // Supplier debit/prepaid (supplier owes us)
            // Dr AP / Cr Equity (keeps debit as negative/contra in AP)
            journalLines.push({
                account_id: apAccountId,
                debit: netAed,
                credit: 0,
                description: `Opening Balance - Supplier ${line.party_id}`,
                entity_type: 'SUPPLIER',
                entity_id: line.party_id,
                buyer_id: line.party_id
            });
            journalLines.push({
                account_id: equityAccountId,
                debit: 0,
                credit: netAed,
                description: `Opening Balance - Supplier ${line.party_id}`,
                entity_type: 'SUPPLIER',
                entity_id: line.party_id,
                buyer_id: line.party_id
            });
            totalDebits += netAed;
            totalCredits += netAed;
        }
    }

    if (journalLines.length === 0) {
        throw new Error('No valid opening balance lines to post');
    }

    // Calculate total amount for journal header
    const journalTotalAmount = totalDebits; // Same as totalCredits (balanced)

    // Get default currency ID (AED)
    const [currencyRows] = await conn.query(`
        SELECT id FROM currency WHERE name = 'AED' LIMIT 1
    `);
    const defaultCurrencyId = currencyRows.length > 0 ? currencyRows[0].id : null;

    // Create GL journal
    const journalId = await glService.createJournal(conn, {
        source_type: 'OPENING_BALANCE',
        source_id: batchId,
        journal_date: batch.opening_date,
        memo: `Opening Balance Batch ${batch.batch_no}`,
        created_by: userId,
        source_name: batch.batch_no,
        source_date: batch.opening_date,
        currency_id: defaultCurrencyId, // Base currency (AED)
        exchange_rate: 1.0,
        foreign_amount: journalTotalAmount, // For base currency, foreign = total
        total_amount: journalTotalAmount,
        lines: journalLines
    });

    // Update batch with journal ID and status.
    // If this was an edit-approval flow, also reset edit_request_status back to 0 (no active edit request).
    await conn.query(`
        UPDATE opening_balance_batch 
        SET gl_journal_id = ?, status_id = 1, approved_by = ?, approved_at = NOW(), edit_request_status = 0
        WHERE id = ?
    `, [journalId, userId, batchId]);

    return journalId;
}

module.exports = {
    postOpeningBalance,
    getAccountByTypeId
};
