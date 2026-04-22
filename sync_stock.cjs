const { pool } = require('./src/db/tx.cjs');

async function syncStock() {
    console.log('Starting Stock Synchronization...');
    try {
        const sql = `
            UPDATE inventory_stock_batches isb 
            SET qty_on_hand = COALESCE((
                SELECT 
                    SUM(CASE 
                        WHEN movement = 'IN' THEN qty 
                        WHEN movement = 'OUT' THEN -qty 
                        WHEN movement = 'DISCARD' THEN -qty 
                        ELSE 0 
                    END) 
                FROM inventory_transactions 
                WHERE product_id = isb.product_id 
                  AND warehouse_id = isb.warehouse_id 
                  AND batch_id = isb.batch_id
                  AND (is_deleted = 0 OR is_deleted IS NULL)
            ), 0)
        `;
        
        const [result] = await pool.query(sql);
        console.log(`✅ Success! Synchronized ${result.affectedRows} rows.`);
        process.exit(0);
    } catch (error) {
        console.error('❌ Sync failed:', error);
        process.exit(1);
    }
}

syncStock();
