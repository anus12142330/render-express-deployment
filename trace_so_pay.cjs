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
                so.id as so_id, 
                so.order_no,
                inv.id as inv_id,
                inv.invoice_number,
                p.id as pay_id,
                p.payment_number,
                p.status as pay_status,
                p.status_id as pay_status_id
            FROM sales_orders so
            INNER JOIN ar_invoices inv ON inv.sales_order_id = so.id
            INNER JOIN tbl_payment_allocation pa ON pa.reference_id = inv.id AND pa.alloc_type = 'invoice'
            INNER JOIN tbl_payment p ON p.id = pa.payment_id
        `);
        console.log("Joined SO -> Invoice -> Payment results:");
        console.log(JSON.stringify(rows, null, 2));

        const [rows2] = await pool.query(`
            SELECT 
                so.id as so_id, 
                so.order_no,
                inv.id as inv_id,
                inv.invoice_number,
                ara.receipt_id,
                r.receipt_number,
                r.status as receipt_status
            FROM sales_orders so
            INNER JOIN ar_invoices inv ON inv.sales_order_id = so.id
            INNER JOIN ar_receipt_allocations ara ON ara.invoice_id = inv.id
            INNER JOIN ar_receipts r ON r.id = ara.receipt_id
        `);
        console.log("\nJoined SO -> Invoice -> Receipt results:");
        console.log(JSON.stringify(rows2, null, 2));

        await pool.end();
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}
run();
