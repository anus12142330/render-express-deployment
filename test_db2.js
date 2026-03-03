import db from './db.js';

async function run() {
    try {
        const [inv] = await db.promise().query('SELECT id, invoice_number, sales_order_id, created_at FROM ar_invoices ORDER BY id DESC LIMIT 5');
        console.log("Invoices:", JSON.stringify(inv));

        const [att] = await db.promise().query('SELECT id, sales_order_id, scope, file_name FROM sales_order_attachments ORDER BY id DESC LIMIT 5');
        console.log("Attachments:", JSON.stringify(att));

        const [so] = await db.promise().query('SELECT id, status_id, completed_at FROM sales_orders ORDER BY updated_at DESC LIMIT 3');
        console.log("Latest SOs:", JSON.stringify(so));
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
}

run();
