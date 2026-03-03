import db from './db.js';

async function run() {
    const [cols] = await db.promise().query('DESCRIBE sales_order_dispatches');
    console.log(cols.map(c => c.Field));
    process.exit(0);
}

run();
