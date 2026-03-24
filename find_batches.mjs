import mysql from 'mysql2';
import dotenv from 'dotenv';
dotenv.config();

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'portal_db',
    dateStrings: true
});

async function findProductBatches() {
    try {
        const [lines] = await pool.promise().query(`
            SELECT p.id, p.product_name FROM products p WHERE p.product_name LIKE '%Red Lady Papaya%' LIMIT 1
        `);
        if (lines.length === 0) { console.log('Product not found'); process.exit(0); }
        const pId = lines[0].id;
        console.log(`Searching for product ID: ${pId} (${lines[0].product_name})`);

        const [isb] = await pool.promise().query(`
            SELECT isb.*, w.warehouse_name 
            FROM inventory_stock_batches isb
            JOIN warehouses w ON w.id = isb.warehouse_id
            WHERE isb.product_id = ?
        `, [pId]);
        console.log('Stock in inventory_stock_batches:', JSON.stringify(isb, null, 2));

        const [txns] = await pool.promise().query(`
             SELECT DISTINCT it.batch_id, ib.batch_no, it.warehouse_id 
             FROM inventory_transactions it
             LEFT JOIN inventory_batches ib ON ib.id = it.batch_id
             WHERE it.product_id = ?
        `, [pId]);
        console.log('Distinct batches from transactions:', JSON.stringify(txns, null, 2));

        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

findProductBatches();
