// server/src/modules/gl/entityBalance.service.cjs
// Entity Ledger Balance service - handles cached balance updates

/**
 * Update entity ledger balances for journal lines
 * This should be called within the same transaction that creates gl_journal_lines
 * @param {Object} conn - Database connection (must be in transaction)
 * @param {number} companyId - Company ID (defaults to 1)
 * @param {Array} lines - Array of journal lines with entity_type, entity_id, debit, credit
 */
async function updateEntityBalances(conn, companyId, lines) {
    if (!lines || lines.length === 0) {
        return;
    }

    // Filter lines that have entity_type and entity_id
    const entityLines = lines.filter(line => 
        line.entity_type && 
        (line.entity_type === 'CUSTOMER' || line.entity_type === 'SUPPLIER') &&
        line.entity_id
    );

    if (entityLines.length === 0) {
        return;
    }

    // Group by entity_type and entity_id, sum deltas
    const balanceUpdates = {};
    for (const line of entityLines) {
        const key = `${line.entity_type}:${line.entity_id}`;
        const delta = parseFloat(line.debit || 0) - parseFloat(line.credit || 0);
        
        if (!balanceUpdates[key]) {
            balanceUpdates[key] = {
                entity_type: line.entity_type,
                entity_id: line.entity_id,
                delta: 0
            };
        }
        balanceUpdates[key].delta += delta;
    }

    // Update balances using INSERT ... ON DUPLICATE KEY UPDATE
    for (const key in balanceUpdates) {
        const update = balanceUpdates[key];
        if (Math.abs(update.delta) > 0.0001) { // Only update if delta is significant
            await conn.query(`
                INSERT INTO entity_ledger_balances 
                (company_id, entity_type, entity_id, balance)
                VALUES (?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE 
                    balance = balance + VALUES(balance),
                    updated_at = CURRENT_TIMESTAMP
            `, [companyId || 1, update.entity_type, update.entity_id, update.delta]);
        }
    }
}

/**
 * Get entity ledger balance
 * @param {Object} conn - Database connection
 * @param {string} entityType - 'CUSTOMER' or 'SUPPLIER'
 * @param {number} entityId - Customer or Supplier ID
 * @param {number} companyId - Company ID (defaults to 1)
 * @returns {Promise<number>} - Balance (positive = entity owes us, negative = we owe entity)
 */
async function getEntityBalance(conn, entityType, entityId, companyId = 1) {
    const [rows] = await conn.query(`
        SELECT balance 
        FROM entity_ledger_balances
        WHERE company_id = ? AND entity_type = ? AND entity_id = ?
    `, [companyId, entityType, entityId]);

    return rows.length > 0 ? parseFloat(rows[0].balance || 0) : 0;
}

/**
 * Rebuild all entity balances from gl_journal_lines
 * @param {Object} conn - Database connection
 * @param {number} companyId - Company ID (defaults to 1)
 */
async function rebuildEntityBalances(conn, companyId = 1) {
    // Delete existing balances for this company
    await conn.query(`
        DELETE FROM entity_ledger_balances WHERE company_id = ?
    `, [companyId]);

    // Recalculate from gl_journal_lines
    await conn.query(`
        INSERT INTO entity_ledger_balances (company_id, entity_type, entity_id, balance)
        SELECT
            ? as company_id,
            jl.entity_type,
            jl.entity_id,
            SUM(jl.debit) - SUM(jl.credit) AS balance
        FROM gl_journal_lines jl
        INNER JOIN gl_journals j ON j.id = jl.journal_id
        WHERE jl.entity_type IN ('CUSTOMER', 'SUPPLIER')
          AND jl.entity_id IS NOT NULL
          AND (j.is_deleted = 0 OR j.is_deleted IS NULL)
        GROUP BY jl.entity_type, jl.entity_id
        HAVING ABS(SUM(jl.debit) - SUM(jl.credit)) > 0.0001
    `, [companyId]);
}

module.exports = {
    updateEntityBalances,
    getEntityBalance,
    rebuildEntityBalances
};
