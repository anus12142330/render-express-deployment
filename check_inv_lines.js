import db from './db.js';

async function run() {
    const [cols] = await db.promise().query('DESCRIBE ar_invoice_lines');
    console.log(cols.map(c => c.Field));
    process.exit(0);
}

run();
