import db from './db.js';

async function run() {
    try {
        const [rows] = await db.promise().query('SELECT * FROM sales_order_attachments ORDER BY id DESC LIMIT 5');
        console.log("Latest attachments:", JSON.stringify(rows, null, 2));

        const [rows2] = await db.promise().query('SELECT * FROM ar_invoices ORDER BY id DESC LIMIT 5');
        console.log("Latest invoices:", JSON.stringify(rows2, null, 2));
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
}

run();
