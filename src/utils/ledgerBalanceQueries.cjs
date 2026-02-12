// server/src/utils/ledgerBalanceQueries.cjs
// Helper functions to calculate customer and supplier ledger balances from gl_journal_lines

/**
 * Get customer ledger balance from gl_journal_lines
 * @param {Object} conn - Database connection
 * @param {number} customerId - Customer ID
 * @returns {Promise<number>} - Balance (positive = customer owes us, negative = we owe customer)
 */
async function getCustomerBalance(conn, customerId) {
    const [rows] = await conn.query(`
        SELECT 
            entity_id AS customer_id,
            SUM(debit) - SUM(credit) AS balance
        FROM gl_journal_lines gjl
        INNER JOIN gl_journals gj ON gj.id = gjl.journal_id
        WHERE gjl.entity_type = 'CUSTOMER'
          AND gjl.entity_id = ?
          AND (gj.is_deleted = 0 OR gj.is_deleted IS NULL)
        GROUP BY gjl.entity_id
    `, [customerId]);

    return rows.length > 0 ? parseFloat(rows[0].balance || 0) : 0;
}

/**
 * Get supplier ledger balance from gl_journal_lines
 * @param {Object} conn - Database connection
 * @param {number} supplierId - Supplier ID
 * @returns {Promise<number>} - Balance (positive = supplier owes us, negative = we owe supplier)
 */
async function getSupplierBalance(conn, supplierId) {
    const [rows] = await conn.query(`
        SELECT 
            entity_id AS supplier_id,
            SUM(debit) - SUM(credit) AS balance
        FROM gl_journal_lines gjl
        INNER JOIN gl_journals gj ON gj.id = gjl.journal_id
        WHERE gjl.entity_type = 'SUPPLIER'
          AND gjl.entity_id = ?
          AND (gj.is_deleted = 0 OR gj.is_deleted IS NULL)
        GROUP BY gjl.entity_id
    `, [supplierId]);

    return rows.length > 0 ? parseFloat(rows[0].balance || 0) : 0;
}

/**
 * Get customer outstanding (amount customer owes us)
 * @param {Object} conn - Database connection
 * @param {number} customerId - Customer ID
 * @returns {Promise<number>} - Outstanding amount (always >= 0)
 */
async function getCustomerOutstanding(conn, customerId) {
    const balance = await getCustomerBalance(conn, customerId);
    return Math.max(balance, 0);
}

/**
 * Get customer credit (amount we owe customer)
 * @param {Object} conn - Database connection
 * @param {number} customerId - Customer ID
 * @returns {Promise<number>} - Credit amount (always >= 0)
 */
async function getCustomerCredit(conn, customerId) {
    const balance = await getCustomerBalance(conn, customerId);
    return Math.max(-balance, 0);
}

/**
 * Get supplier payable (amount we owe supplier)
 * @param {Object} conn - Database connection
 * @param {number} supplierId - Supplier ID
 * @returns {Promise<number>} - Payable amount (always >= 0)
 */
async function getSupplierPayable(conn, supplierId) {
    const balance = await getSupplierBalance(conn, supplierId);
    return Math.max(-balance, 0);
}

/**
 * Get supplier debit (amount supplier owes us / prepaid)
 * @param {Object} conn - Database connection
 * @param {number} supplierId - Supplier ID
 * @returns {Promise<number>} - Debit amount (always >= 0)
 */
async function getSupplierDebit(conn, supplierId) {
    const balance = await getSupplierBalance(conn, supplierId);
    return Math.max(balance, 0);
}

/**
 * Get all customer balances (for reporting/aging)
 * @param {Object} conn - Database connection
 * @returns {Promise<Array>} - Array of {customer_id, balance, outstanding, credit}
 */
async function getAllCustomerBalances(conn) {
    const [rows] = await conn.query(`
        SELECT 
            gjl.entity_id AS customer_id,
            SUM(gjl.debit) - SUM(gjl.credit) AS balance
        FROM gl_journal_lines gjl
        INNER JOIN gl_journals gj ON gj.id = gjl.journal_id
        WHERE gjl.entity_type = 'CUSTOMER'
          AND (gj.is_deleted = 0 OR gj.is_deleted IS NULL)
        GROUP BY gjl.entity_id
        HAVING ABS(SUM(gjl.debit) - SUM(gjl.credit)) > 0.01
    `);

    return rows.map(row => ({
        customer_id: row.customer_id,
        balance: parseFloat(row.balance || 0),
        outstanding: Math.max(parseFloat(row.balance || 0), 0),
        credit: Math.max(-parseFloat(row.balance || 0), 0)
    }));
}

/**
 * Get all supplier balances (for reporting/aging)
 * @param {Object} conn - Database connection
 * @returns {Promise<Array>} - Array of {supplier_id, balance, payable, debit}
 */
async function getAllSupplierBalances(conn) {
    const [rows] = await conn.query(`
        SELECT 
            gjl.entity_id AS supplier_id,
            SUM(gjl.debit) - SUM(gjl.credit) AS balance
        FROM gl_journal_lines gjl
        INNER JOIN gl_journals gj ON gj.id = gjl.journal_id
        WHERE gjl.entity_type = 'SUPPLIER'
          AND (gj.is_deleted = 0 OR gj.is_deleted IS NULL)
        GROUP BY gjl.entity_id
        HAVING ABS(SUM(gjl.debit) - SUM(gjl.credit)) > 0.01
    `);

    return rows.map(row => ({
        supplier_id: row.supplier_id,
        balance: parseFloat(row.balance || 0),
        payable: Math.max(-parseFloat(row.balance || 0), 0),
        debit: Math.max(parseFloat(row.balance || 0), 0)
    }));
}

module.exports = {
    getCustomerBalance,
    getSupplierBalance,
    getCustomerOutstanding,
    getCustomerCredit,
    getSupplierPayable,
    getSupplierDebit,
    getAllCustomerBalances,
    getAllSupplierBalances
};
