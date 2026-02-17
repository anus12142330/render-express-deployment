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
            SELECT id, invoice_number, sales_order_id, status_id FROM ar_invoices WHERE invoice_number = 'ARI-2026-0002'
        `);
        console.log(JSON.stringify(rows, null, 2));
        await pool.end();
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}
run();
