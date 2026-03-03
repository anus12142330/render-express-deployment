import db from '../db.js';
import fs from 'fs';
async function test() {
    const [rows] = await db.promise().query('SELECT id, sales_order_id, scope, file_name, created_at FROM sales_order_attachments ORDER BY id DESC LIMIT 5');
    fs.writeFileSync('att_out.txt', JSON.stringify(rows, null, 2));
    process.exit();
}
test();
