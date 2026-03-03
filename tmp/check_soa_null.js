import db from '../db.js';
import fs from 'fs';
async function test() {
    const [cols] = await db.promise().query('SHOW COLUMNS FROM sales_order_attachments');
    fs.writeFileSync('soa_schema.txt', JSON.stringify(cols, null, 2));
    process.exit();
}
test();
