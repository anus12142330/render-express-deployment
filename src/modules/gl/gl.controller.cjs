const glService = require('./gl.service.cjs');
const { pool } = require('../../db/tx.cjs');
const { getEntityBalance, rebuildEntityBalances } = require('./entityBalance.service.cjs');

/**
 * Get Trial Balance
 * Calculates debit and credit totals for each account from GL journals
 */
async function getTrialBalance(req, res, next) {
    try {
        const asOfDate = req.query.as_of || new Date().toISOString().split('T')[0];

        // Get all chart of accounts
        const [accounts] = await pool.query(`
            SELECT 
                id,
                name,
                account_type_id,
                acc_type_id,
                acc_detail_id
            FROM acc_chart_accounts
            ORDER BY name
        `);

        // Get all journal line balances up to the as_of date
        // Only include non-deleted journals
        // Use total_amount (default currency) if available, otherwise fall back to debit/credit
        const [journalLines] = await pool.query(`
            SELECT 
                gjl.account_id,
                SUM(
                    CASE 
                        WHEN gjl.debit > 0 THEN COALESCE(gjl.total_amount, gjl.debit)
                        ELSE 0
                    END
                ) as total_debit,
                SUM(
                    CASE 
                        WHEN gjl.credit > 0 THEN COALESCE(gjl.total_amount, gjl.credit)
                        ELSE 0
                    END
                ) as total_credit
            FROM gl_journal_lines gjl
            INNER JOIN gl_journals gj ON gj.id = gjl.journal_id
            WHERE gj.journal_date <= ?
            AND (gj.is_deleted = 0 OR gj.is_deleted IS NULL)
            GROUP BY gjl.account_id
        `, [asOfDate]);

        // Create a map of account balances
        const balanceMap = {};
        journalLines.forEach(line => {
            balanceMap[line.account_id] = {
                debit: parseFloat(line.total_debit || 0),
                credit: parseFloat(line.total_credit || 0)
            };
        });

        // Build trial balance array
        const trialBalance = accounts.map(account => {
            const balance = balanceMap[account.id] || { debit: 0, credit: 0 };
            // Calculate net balance (debit - credit)
            const netBalance = balance.debit - balance.credit;
            
            return {
                account_id: account.id,
                account_code: account.id, // You may want to add account_code field to the table
                account_name: account.name,
                account_type_id: account.account_type_id,
                acc_type_id: account.acc_type_id,
                acc_detail_id: account.acc_detail_id,
                debit: netBalance > 0 ? netBalance : 0,
                credit: netBalance < 0 ? Math.abs(netBalance) : 0
            };
        }).filter(row => row.debit > 0 || row.credit > 0); // Only show accounts with transactions

        res.json({
            success: true,
            data: trialBalance,
            as_of: asOfDate
        });
    } catch (error) {
        next(error);
    }
}

/**
 * Get Journal Entries for a specific account
 * Returns paginated list of journal entries for an account
 */
async function getAccountJournalEntries(req, res, next) {
    try {
        const accountId = req.query.account_id;
        const asOfDate = req.query.as_of || new Date().toISOString().split('T')[0];
        const page = Math.max(parseInt(req.query.page || '1', 10), 1);
        const perPage = Math.min(Math.max(parseInt(req.query.per_page || '10', 10), 1), 100);
        const offset = (page - 1) * perPage;
        const search = (req.query.search || '').trim();

        if (!accountId) {
            return res.status(400).json({ error: 'account_id is required' });
        }

        // Build WHERE clause
        let whereClause = `
            WHERE gjl.account_id = ?
            AND gj.journal_date <= ?
            AND (gj.is_deleted = 0 OR gj.is_deleted IS NULL)
        `;
        const params = [accountId, asOfDate];

        // Add search filter
        if (search) {
            whereClause += ` AND (
                gj.journal_number LIKE ? OR
                gj.memo LIKE ? OR
                gj.source_type LIKE ? OR
                CAST(gj.source_id AS CHAR) LIKE ?
            )`;
            const searchTerm = `%${search}%`;
            params.push(searchTerm, searchTerm, searchTerm, searchTerm);
        }

        // Get total count
        const countSql = `
            SELECT COUNT(*) as total
            FROM gl_journal_lines gjl
            INNER JOIN gl_journals gj ON gj.id = gjl.journal_id
            ${whereClause}
        `;
        const [countResult] = await pool.query(countSql, params);
        const total = countResult[0]?.total || 0;

        // Calculate totals for filtered results (all matching entries, not just current page)
        // Do this BEFORE adding LIMIT/OFFSET to params
        // Use total_amount (default currency) if available, otherwise fall back to debit/credit
        const totalsSql = `
            SELECT 
                SUM(
                    CASE 
                        WHEN gjl.debit > 0 THEN COALESCE(gjl.total_amount, gjl.debit)
                        ELSE 0
                    END
                ) as total_debit,
                SUM(
                    CASE 
                        WHEN gjl.credit > 0 THEN COALESCE(gjl.total_amount, gjl.credit)
                        ELSE 0
                    END
                ) as total_credit
            FROM gl_journal_lines gjl
            INNER JOIN gl_journals gj ON gj.id = gjl.journal_id
            ${whereClause}
        `;
        const [totalsResult] = await pool.query(totalsSql, params);

        // Get journal entries (with pagination)
        // Use total_amount (default currency) for display if available
        const entriesSql = `
            SELECT 
                gjl.id,
                CASE 
                    WHEN gjl.debit > 0 THEN COALESCE(gjl.total_amount, gjl.debit)
                    ELSE 0
                END as debit,
                CASE 
                    WHEN gjl.credit > 0 THEN COALESCE(gjl.total_amount, gjl.credit)
                    ELSE 0
                END as credit,
                gj.journal_date,
                gj.journal_number,
                gj.memo,
                gj.source_type,
                gj.source_id
            FROM gl_journal_lines gjl
            INNER JOIN gl_journals gj ON gj.id = gjl.journal_id
            ${whereClause}
            ORDER BY gj.journal_date DESC, gj.id DESC
            LIMIT ? OFFSET ?
        `;
        const entriesParams = [...params, perPage, offset];
        const [entries] = await pool.query(entriesSql, entriesParams);
        const totalDebit = totalsResult[0]?.total_debit ? parseFloat(totalsResult[0].total_debit) : 0;
        const totalCredit = totalsResult[0]?.total_credit ? parseFloat(totalsResult[0].total_credit) : 0;

        res.json({
            success: true,
            data: entries,
            total: total,
            page: page,
            per_page: perPage,
            totals: {
                debit: totalDebit,
                credit: totalCredit
            }
        });
    } catch (error) {
        next(error);
    }
}

/**
 * Get Account Info by ID
 */
async function getAccountInfo(req, res, next) {
    try {
        const accountId = req.query.account_id;

        if (!accountId) {
            return res.status(400).json({ error: 'account_id is required' });
        }

        const [accounts] = await pool.query(`
            SELECT 
                id,
                name,
                description,
                account_type_id,
                acc_type_id,
                acc_detail_id
            FROM acc_chart_accounts
            WHERE id = ?
            LIMIT 1
        `, [accountId]);

        if (accounts.length === 0) {
            return res.status(404).json({ error: 'Account not found' });
        }

        res.json({
            success: true,
            data: accounts[0]
        });
    } catch (error) {
        next(error);
    }
}

/**
 * Get Chart of Accounts with Balances
 * Returns all accounts with their debit, credit, and balance from GL journals
 */
async function getChartOfAccounts(req, res, next) {
    try {
        const asOfDate = req.query.as_of || new Date().toISOString().split('T')[0];
        const page = Math.max(parseInt(req.query.page || '1', 10), 1);
        const perPage = Math.min(Math.max(parseInt(req.query.per_page || '10', 10), 1), 100);
        const offset = (page - 1) * perPage;
        const search = (req.query.search || '').trim();
        const accountTypeId = req.query.account_type_id;

        // Build WHERE clause for account filtering
        let accountWhere = 'WHERE 1=1';
        const accountParams = [];

        if (search) {
            accountWhere += ` AND (
                cca.name LIKE ? OR
                cca.description LIKE ? OR
                atH.type_name LIKE ? OR
                atG.acc_type LIKE ? OR
                dt.detail_type LIKE ?
            )`;
            const searchTerm = `%${search}%`;
            accountParams.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
        }

        if (accountTypeId) {
            accountWhere += ' AND cca.account_type_id = ?';
            accountParams.push(accountTypeId);
        }

        // Get all chart of accounts with joins
        const accountsSql = `
            SELECT 
                cca.id,
                cca.name,
                cca.description,
                cca.account_type_id,
                cca.acc_type_id,
                cca.acc_detail_id,
                atH.type_name AS header_type_name,
                atG.acc_type AS group_type_name,
                dt.detail_type AS detail_type_name
            FROM acc_chart_accounts cca
            LEFT JOIN account_type atH ON atH.id = cca.account_type_id
            LEFT JOIN acc_type atG ON atG.id = cca.acc_type_id
            LEFT JOIN acc_detail_type dt ON dt.id = cca.acc_detail_id
            ${accountWhere}
            ORDER BY cca.name
            LIMIT ? OFFSET ?
        `;
        const accountsParams = [...accountParams, perPage, offset];
        const [accounts] = await pool.query(accountsSql, accountsParams);

        // Get total count
        const countSql = `
            SELECT COUNT(*) as total
            FROM acc_chart_accounts cca
            LEFT JOIN account_type atH ON atH.id = cca.account_type_id
            LEFT JOIN acc_type atG ON atG.id = cca.acc_type_id
            LEFT JOIN acc_detail_type dt ON dt.id = cca.acc_detail_id
            ${accountWhere}
        `;
        const [countResult] = await pool.query(countSql, accountParams);
        const total = countResult[0]?.total || 0;

        // Get journal line balances for all accounts up to as_of date
        // Use total_amount (default currency) if available, otherwise fall back to debit/credit
        const [journalLines] = await pool.query(`
            SELECT 
                gjl.account_id,
                SUM(
                    CASE 
                        WHEN gjl.debit > 0 THEN COALESCE(gjl.total_amount, gjl.debit)
                        ELSE 0
                    END
                ) as total_debit,
                SUM(
                    CASE 
                        WHEN gjl.credit > 0 THEN COALESCE(gjl.total_amount, gjl.credit)
                        ELSE 0
                    END
                ) as total_credit
            FROM gl_journal_lines gjl
            INNER JOIN gl_journals gj ON gj.id = gjl.journal_id
            WHERE gj.journal_date <= ?
            AND (gj.is_deleted = 0 OR gj.is_deleted IS NULL)
            GROUP BY gjl.account_id
        `, [asOfDate]);

        // Create a map of account balances
        const balanceMap = {};
        journalLines.forEach(line => {
            balanceMap[line.account_id] = {
                debit: parseFloat(line.total_debit || 0),
                credit: parseFloat(line.total_credit || 0)
            };
        });

        // Combine accounts with their balances
        const accountsWithBalances = accounts.map(account => {
            const balance = balanceMap[account.id] || { debit: 0, credit: 0 };
            const netBalance = balance.debit - balance.credit;
            
            return {
                ...account,
                debit: balance.debit,
                credit: balance.credit,
                balance: netBalance
            };
        });

        res.json({
            success: true,
            data: accountsWithBalances,
            total: total,
            page: page,
            per_page: perPage,
            as_of: asOfDate
        });
    } catch (error) {
        next(error);
    }
}

/**
 * Get Profit and Loss Statement
 * Returns revenue and expense accounts with their transaction totals for a date range
 */
async function getProfitAndLoss(req, res, next) {
    try {
        const fromDate = req.query.from_date || new Date().toISOString().split('T')[0];
        const toDate = req.query.to_date || new Date().toISOString().split('T')[0];

        // Get Revenue accounts (account_type_id = 1) and Expense accounts (account_type_id = 2)
        const [accounts] = await pool.query(`
            SELECT 
                id,
                name,
                account_type_id,
                acc_type_id,
                acc_detail_id
            FROM acc_chart_accounts
            WHERE account_type_id IN (1, 2)  -- 1 = Revenue, 2 = Expense
            ORDER BY account_type_id, name
        `);

        // Get journal line totals for the date range
        // For Revenue accounts: sum credits (revenue increases with credits)
        // For Expense accounts: sum debits (expenses increase with debits)
        const [journalLines] = await pool.query(`
            SELECT 
                gjl.account_id,
                cca.account_type_id,
                SUM(
                    CASE 
                        WHEN cca.account_type_id = 1 THEN  -- Revenue: sum credits
                            CASE WHEN gjl.credit > 0 THEN COALESCE(gjl.total_amount, gjl.credit) ELSE 0 END
                        WHEN cca.account_type_id = 2 THEN  -- Expense: sum debits
                            CASE WHEN gjl.debit > 0 THEN COALESCE(gjl.total_amount, gjl.debit) ELSE 0 END
                        ELSE 0
                    END
                ) as amount
            FROM gl_journal_lines gjl
            INNER JOIN gl_journals gj ON gj.id = gjl.journal_id
            INNER JOIN acc_chart_accounts cca ON cca.id = gjl.account_id
            WHERE gj.journal_date >= ?
            AND gj.journal_date <= ?
            AND cca.account_type_id IN (1, 2)
            AND (gj.is_deleted = 0 OR gj.is_deleted IS NULL)
            GROUP BY gjl.account_id, cca.account_type_id
        `, [fromDate, toDate]);

        // Create a map of account amounts
        const amountMap = {};
        journalLines.forEach(line => {
            amountMap[line.account_id] = parseFloat(line.amount || 0);
        });

        // Build profit and loss array
        const profitLoss = accounts.map(account => {
            const amount = amountMap[account.id] || 0;
            
            return {
                account_id: account.id,
                account_code: account.id.toString(), // You may want to add account_code field
                account_name: account.name,
                category: account.account_type_id === 1 ? 'Revenue' : 'Expense',
                type: account.account_type_id === 1 ? 'Revenue' : 'Expense',
                amount: amount
            };
        }).filter(row => row.amount > 0); // Only show accounts with transactions

        res.json({
            success: true,
            data: profitLoss,
            from_date: fromDate,
            to_date: toDate
        });
    } catch (error) {
        next(error);
    }
}

/**
 * Get Detailed Profit and Loss Statement
 * Returns revenue and expense accounts with individual transaction details
 */
async function getProfitAndLossDetailed(req, res, next) {
    try {
        const fromDate = req.query.from_date || new Date().toISOString().split('T')[0];
        const toDate = req.query.to_date || new Date().toISOString().split('T')[0];

        // Get Revenue accounts (account_type_id = 1) and Expense accounts (account_type_id = 2)
        const [accounts] = await pool.query(`
            SELECT 
                id,
                name,
                account_type_id,
                acc_type_id,
                acc_detail_id
            FROM acc_chart_accounts
            WHERE account_type_id IN (1, 2)  -- 1 = Revenue, 2 = Expense
            ORDER BY account_type_id, name
        `);

        // Get detailed journal line entries for the date range
        const [journalLines] = await pool.query(`
            SELECT 
                gjl.id,
                gjl.account_id,
                cca.account_type_id,
                cca.name as account_name,
                CASE 
                    WHEN cca.account_type_id = 1 THEN  -- Revenue: use credit
                        CASE WHEN gjl.credit > 0 THEN COALESCE(gjl.total_amount, gjl.credit) ELSE 0 END
                    WHEN cca.account_type_id = 2 THEN  -- Expense: use debit
                        CASE WHEN gjl.debit > 0 THEN COALESCE(gjl.total_amount, gjl.debit) ELSE 0 END
                    ELSE 0
                END as amount,
                gj.journal_date,
                gj.journal_number,
                gj.memo,
                gj.source_type,
                gj.source_id,
                gjl.description as line_description
            FROM gl_journal_lines gjl
            INNER JOIN gl_journals gj ON gj.id = gjl.journal_id
            INNER JOIN acc_chart_accounts cca ON cca.id = gjl.account_id
            WHERE gj.journal_date >= ?
            AND gj.journal_date <= ?
            AND cca.account_type_id IN (1, 2)
            AND (gj.is_deleted = 0 OR gj.is_deleted IS NULL)
            AND (
                (cca.account_type_id = 1 AND gjl.credit > 0) OR  -- Revenue: only credits
                (cca.account_type_id = 2 AND gjl.debit > 0)       -- Expense: only debits
            )
            ORDER BY cca.account_type_id, cca.name, gj.journal_date DESC, gj.id DESC
        `, [fromDate, toDate]);

        // Group transactions by account
        const accountMap = {};
        accounts.forEach(account => {
            accountMap[account.id] = {
                account_id: account.id,
                account_code: account.id.toString(),
                account_name: account.name,
                category: account.account_type_id === 1 ? 'Revenue' : 'Expense',
                type: account.account_type_id === 1 ? 'Revenue' : 'Expense',
                transactions: [],
                total_amount: 0
            };
        });

        // Add transactions to accounts
        journalLines.forEach(line => {
            if (accountMap[line.account_id]) {
                accountMap[line.account_id].transactions.push({
                    id: line.id,
                    journal_date: line.journal_date,
                    journal_number: line.journal_number,
                    memo: line.memo,
                    source_type: line.source_type,
                    source_id: line.source_id,
                    description: line.line_description,
                    amount: parseFloat(line.amount || 0)
                });
                accountMap[line.account_id].total_amount += parseFloat(line.amount || 0);
            }
        });

        // Convert to array and filter out accounts with no transactions
        const profitLoss = Object.values(accountMap)
            .filter(account => account.transactions.length > 0)
            .map(account => ({
                ...account,
                amount: account.total_amount
            }));

        res.json({
            success: true,
            data: profitLoss,
            from_date: fromDate,
            to_date: toDate
        });
    } catch (error) {
        next(error);
    }
}

/**
 * Get Entity Ledger Balance
 * GET /api/gl/entities/:type/:id/balance
 * Returns the cached ledger balance for a customer or supplier
 */
async function getEntityBalanceEndpoint(req, res, next) {
    try {
        const { type, id } = req.params;
        const companyId = parseInt(req.query.company_id || '1', 10);

        if (!type || !id) {
            return res.status(400).json({ error: 'Entity type and ID are required' });
        }

        if (type !== 'CUSTOMER' && type !== 'SUPPLIER') {
            return res.status(400).json({ error: 'Entity type must be CUSTOMER or SUPPLIER' });
        }

        const balance = await getEntityBalance(pool, type.toUpperCase(), parseInt(id, 10), companyId);

        // Calculate derived values
        let outstanding = 0;
        let credit = 0;
        let payable = 0;
        let debit = 0;

        if (type === 'CUSTOMER') {
            outstanding = Math.max(balance, 0);
            credit = Math.max(-balance, 0);
        } else {
            payable = Math.max(-balance, 0);
            debit = Math.max(balance, 0);
        }

        res.json({
            success: true,
            data: {
                entity_type: type.toUpperCase(),
                entity_id: parseInt(id, 10),
                balance: balance,
                outstanding: outstanding,
                credit_balance: credit,
                payable: payable,
                supplier_debit: debit
            }
        });
    } catch (error) {
        next(error);
    }
}

/**
 * Rebuild Entity Ledger Balances
 * POST /api/admin/rebuild-entity-balances
 * Admin endpoint to rebuild all cached balances from gl_journal_lines
 */
async function rebuildEntityBalancesEndpoint(req, res, next) {
    try {
        // TODO: Add admin permission check here
        // if (!req.user || !req.user.permissions.includes('admin')) {
        //     return res.status(403).json({ error: 'Admin access required' });
        // }

        const companyId = parseInt(req.body.company_id || '1', 10);
        const conn = await pool.getConnection();

        try {
            await conn.beginTransaction();
            await rebuildEntityBalances(conn, companyId);
            await conn.commit();

            res.json({
                success: true,
                message: `Entity ledger balances rebuilt successfully for company ${companyId}`
            });
        } catch (error) {
            await conn.rollback();
            throw error;
        } finally {
            conn.release();
        }
    } catch (error) {
        next(error);
    }
}

module.exports = {
    getTrialBalance,
    getAccountJournalEntries,
    getAccountInfo,
    getChartOfAccounts,
    getProfitAndLoss,
    getProfitAndLossDetailed,
    getEntityBalanceEndpoint,
    rebuildEntityBalancesEndpoint
};

