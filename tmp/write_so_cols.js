import fs from 'fs';
import db from '../db.js';
async function test() {
    const [rows] = await db.promise().query('DESCRIBE sales_orders');
    fs.writeFileSync('so_cols.txt', rows.map(r => r.Field).join(', '));
    process.exit();
}
test();
