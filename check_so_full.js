import db from './db.js';

async function run() {
    const [cols] = await db.promise().query('DESCRIBE sales_orders');
    console.log(JSON.stringify(cols.map(c => c.Field), null, 2));
    process.exit(0);
}

run();
