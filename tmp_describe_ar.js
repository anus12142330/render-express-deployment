import db from './db.js';
async function run() {
    const [cols] = await db.promise().query('SHOW FULL COLUMNS FROM sales_order_dispatches');
    cols.forEach(c => console.log(c.Field, c.Null, c.Key, c.Default, c.Extra));
    process.exit(0);
}
run();
