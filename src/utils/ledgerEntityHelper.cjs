// server/src/utils/ledgerEntityHelper.cjs
// Helper to determine if entity_type and entity_id are required for a journal line

/**
 * Check if entity_type and entity_id are required for a given account
 * @param {Object} conn - Database connection
 * @param {number} account_id - Chart of accounts ID
 * @param {string} source_module - Optional source module (e.g., 'AR_INVOICE', 'AP_BILL')
 * @returns {Promise<boolean>} - True if entity is required
 */
async function isEntityRequired(conn, account_id, source_module = null) {
    if (!account_id) {
        return false;
    }

    // Get account type
    const [accounts] = await conn.query(`
        SELECT account_type_id 
        FROM acc_chart_accounts 
        WHERE id = ?
    `, [account_id]);

    if (accounts.length === 0) {
        return false;
    }

    const accountTypeId = accounts[0].account_type_id;

    // Entity is REQUIRED for:
    // - Accounts Receivable (account_type_id = 1)
    // - Accounts Payable (account_type_id = 6)
    if (accountTypeId === 1 || accountTypeId === 6) {
        return true;
    }

    // Entity is NOT required for other account types
    // (Revenue, Tax, Inventory, Bank, Cash, Equity, etc.)
    return false;
}

/**
 * Validate that entity fields are present when required
 * @param {Object} conn - Database connection
 * @param {Object} line - Journal line object with account_id, entity_type, entity_id
 * @param {string} source_module - Optional source module
 * @throws {Error} - If entity is required but missing
 */
async function validateEntityRequired(conn, line, source_module = null) {
    const required = await isEntityRequired(conn, line.account_id, source_module);
    
    if (required) {
        if (!line.entity_type || !line.entity_id) {
            throw new Error(
                `Entity is mandatory for AR/AP ledger lines. ` +
                `Account ID: ${line.account_id}, ` +
                `Entity Type: ${line.entity_type || 'MISSING'}, ` +
                `Entity ID: ${line.entity_id || 'MISSING'}`
            );
        }

        // Validate entity_type value
        if (line.entity_type !== 'CUSTOMER' && line.entity_type !== 'SUPPLIER') {
            throw new Error(
                `Invalid entity_type: ${line.entity_type}. ` +
                `Must be 'CUSTOMER' or 'SUPPLIER' for AR/AP accounts.`
            );
        }
    }
}

/**
 * Get expected entity type for an account
 * @param {Object} conn - Database connection
 * @param {number} account_id - Chart of accounts ID
 * @returns {Promise<string|null>} - 'CUSTOMER', 'SUPPLIER', or null
 */
async function getExpectedEntityType(conn, account_id) {
    if (!account_id) {
        return null;
    }

    const [accounts] = await conn.query(`
        SELECT account_type_id 
        FROM acc_chart_accounts 
        WHERE id = ?
    `, [account_id]);

    if (accounts.length === 0) {
        return null;
    }

    const accountTypeId = accounts[0].account_type_id;

    if (accountTypeId === 1) {
        return 'CUSTOMER'; // Accounts Receivable
    }
    if (accountTypeId === 6) {
        return 'SUPPLIER'; // Accounts Payable
    }

    return null;
}

module.exports = {
    isEntityRequired,
    validateEntityRequired,
    getExpectedEntityType
};
