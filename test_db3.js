import db from './db.js';
import fs from 'fs';

async function run() {
    try {
        const out = {};
        const [inv] = await db.promise().query('SELECT id, invoice_number, sales_order_id, created_at FROM ar_invoices ORDER BY id DESC LIMIT 5');
        out.Invoices = inv;

        const [att] = await db.promise().query('SELECT id, sales_order_id, scope, file_name FROM sales_order_attachments ORDER BY id DESC LIMIT 5');
        out.Attachments = att;

        const [so] = await db.promise().query('SELECT id, status_id, completed_at, payment_term_id, due_date FROM sales_orders ORDER BY updated_at DESC LIMIT 3');
        out.LatestSOs = so;

        fs.writeFileSync('oututf8.json', JSON.stringify(out, null, 2), 'utf8');
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
}

run();
