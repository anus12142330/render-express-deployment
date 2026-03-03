import fs from 'fs';
import db from '../db.js';
async function test() {
    const [rows] = await db.promise().query('SHOW TABLES');
    fs.writeFileSync('tables.txt', rows.map(r => Object.values(r)[0]).join('\n'));
    process.exit();
}
test();
