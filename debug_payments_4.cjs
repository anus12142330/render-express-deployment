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
            SELECT count(*) as count FROM tbl_payment WHERE party_type = 'CUSTOMER'
        `);
        console.log("Customer payments count in tbl_payment:", rows[0].count);

        const [rows2] = await pool.query(`
            SELECT p.id, p.payment_number, p.status, p.status_id, ai.sales_order_id, ai.invoice_number
            FROM tbl_payment p
            LEFT JOIN tbl_payment_allocation pa ON pa.payment_id = p.id
            LEFT JOIN ar_invoices ai ON ai.id = pa.reference_id
            WHERE p.party_type = 'CUSTOMER'
            LIMIT 10
        `);
        console.log(JSON.stringify(rows2, null, 2));

        await pool.end();
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}
run();
