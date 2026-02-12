// server/migrations/rebuild_entity_balances.cjs
// Script to rebuild entity ledger balances from gl_journal_lines
const { pool } = require('../src/db/tx.cjs');
const { rebuildEntityBalances } = require('../src/modules/gl/entityBalance.service.cjs');

async function rebuildBalances() {
    const conn = await pool.getConnection();
    
    try {
        const companyId = process.argv[2] ? parseInt(process.argv[2], 10) : 1;
        
        console.log(`Starting rebuild of entity ledger balances for company ${companyId}...\n`);
        
        await conn.beginTransaction();
        await rebuildEntityBalances(conn, companyId);
        await conn.commit();
        
        console.log(`✅ Entity ledger balances rebuilt successfully for company ${companyId}`);
        
        // Show summary
        const [summary] = await conn.query(`
            SELECT 
                entity_type,
                COUNT(*) as entity_count,
                SUM(balance) as total_balance
            FROM entity_ledger_balances
            WHERE company_id = ?
            GROUP BY entity_type
        `, [companyId]);
        
        console.log('\n📊 Summary:');
        summary.forEach(row => {
            console.log(`   ${row.entity_type}: ${row.entity_count} entities, Total Balance: ${parseFloat(row.total_balance || 0).toFixed(2)}`);
        });
        
    } catch (error) {
        await conn.rollback();
        console.error('\n❌ Rebuild failed:', error.message);
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
}

// Run if called directly
if (require.main === module) {
    rebuildBalances()
        .then(() => {
            console.log('\nRebuild script finished.');
            process.exit(0);
        })
        .catch((error) => {
            console.error('\nRebuild script failed:', error);
            process.exit(1);
        });
}

module.exports = { rebuildBalances };
