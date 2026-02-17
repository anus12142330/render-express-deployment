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
                ai.id as invoice_id, 
                ai.invoice_number,
                pa.payment_id,
                p.payment_number,
                p.status_id as payment_status_id,
                ara.receipt_id,
                r.receipt_number,
                r.status as receipt_status
            FROM ar_invoices ai 
            LEFT JOIN tbl_payment_allocation pa ON pa.reference_id = ai.id AND pa.alloc_type = 'invoice'
            LEFT JOIN tbl_payment p ON p.id = pa.payment_id
            LEFT JOIN ar_receipt_allocations ara ON ara.invoice_id = ai.id
            LEFT JOIN ar_receipts r ON r.id = ara.receipt_id
            WHERE ai.sales_order_id IS NOT NULL 
            LIMIT 20
        `);
        console.log(JSON.stringify(rows, null, 2));
        await pool.end();
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}
run();
