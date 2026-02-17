const mysql = require('mysql2/promise');
const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'portal_db'
});

async function run() {
    try {
        const [rows] = await pool.query(`
            SELECT 
                p.id, p.status, p.status_id, p.direction, pa.reference_id, ai.sales_order_id, ai.invoice_number
            FROM tbl_payment p 
            INNER JOIN tbl_payment_allocation pa ON pa.payment_id = p.id AND pa.alloc_type = 'invoice' 
            INNER JOIN ar_invoices ai ON ai.id = pa.reference_id 
            WHERE ai.sales_order_id IS NOT NULL
        `);
        console.log(JSON.stringify(rows, null, 2));
        await pool.end();
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}
run();
