import fs from 'fs';
import db from '../db.js';
async function test() {
    const [rows] = await db.promise().query('DESCRIBE vendor');
    fs.writeFileSync('vendor_cols.txt', rows.map(r => r.Field).join('\n'));
    process.exit();
}
test();
