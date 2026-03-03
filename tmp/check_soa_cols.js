import db from '../db.js';
import fs from 'fs';
async function test() {
    const [rows] = await db.promise().query('DESCRIBE sales_order_attachments');
    fs.writeFileSync('soa_cols.txt', rows.map(r => r.Field).join(', '));
    process.exit();
}
test();
