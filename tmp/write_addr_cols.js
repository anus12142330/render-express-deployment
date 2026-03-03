import fs from 'fs';
import db from '../db.js';
async function test() {
    const [rows1] = await db.promise().query('DESCRIBE vendor_address');
    const [rows2] = await db.promise().query('DESCRIBE vendor_shipping_addresses');
    fs.writeFileSync('addr_cols.txt', "vendor_address:\n" + rows1.map(r => r.Field).join(', ') + "\n\nvendor_shipping_addresses:\n" + rows2.map(r => r.Field).join(', '));
    process.exit();
}
test();
