import db from './db.js';

async function run() {
    const [inv] = await db.promise().query('SELECT * FROM ar_invoices ORDER BY id DESC LIMIT 5');
    console.log("Invoices:", inv);

    const [att] = await db.promise().query('SELECT * FROM sales_order_attachments ORDER BY id DESC LIMIT 5');
    console.log("Attachments:", att);

    const [dis] = await db.promise().query('SELECT * FROM sales_orders ORDER BY updated_at DESC LIMIT 1');
    console.log("Latest SO:", dis);

    process.exit(0);
}

run();
