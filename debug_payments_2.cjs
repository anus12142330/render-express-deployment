const mysql = require('mysql2/promise');
const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'portal_db'
});

async function run() {
    try {
        console.log("Checking tbl_payment status counts:");
        const [pStats] = await pool.query(`SELECT status, status_id, count(*) as count FROM tbl_payment GROUP BY status, status_id`);
        console.log(JSON.stringify(pStats, null, 2));

        console.log("\nChecking ar_receipts status counts:");
        const [rStats] = await pool.query(`SELECT status, count(*) as count FROM ar_receipts GROUP BY status`);
        console.log(JSON.stringify(rStats, null, 2));

        const [rows] = await pool.query(`
            SELECT 
                ai.sales_order_id,
                ai.invoice_number,
                p.id as payment_id,
                p.payment_number,
                p.status as payment_status,
                p.status_id as payment_status_id,
                pa.alloc_type
            FROM ar_invoices ai 
            INNER JOIN tbl_payment_allocation pa ON pa.reference_id = ai.id AND pa.alloc_type = 'invoice'
            INNER JOIN tbl_payment p ON p.id = pa.payment_id
            WHERE ai.sales_order_id IS NOT NULL
        `);
        console.log("\nPayments found for SO invoices:");
        console.log(JSON.stringify(rows, null, 2));

        await pool.end();
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}
run();
