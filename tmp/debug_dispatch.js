import db from '../db.js';
import fs from 'fs';
async function test() {
    const [dispatches] = await db.promise().query('SELECT * FROM sales_order_dispatches ORDER BY id DESC LIMIT 5');
    const [attachments] = await db.promise().query('SELECT * FROM sales_order_attachments ORDER BY id DESC LIMIT 10');
    fs.writeFileSync('debug_out.txt', JSON.stringify({ dispatches, attachments }, null, 2));
    process.exit();
}
test();
