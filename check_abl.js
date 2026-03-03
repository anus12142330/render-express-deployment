import db from './db.js';

async function run() {
    try {
        const [rows] = await db.promise().query('DESCRIBE ap_bill_lines');
        console.log(rows.map(r => r.Field).join(', '));
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
}

run();
