import db from '../db.js';

async function checkSchema() {
    try {
        const [rows] = await db.promise().query('DESCRIBE sales_order_dispatch_items');
        console.log('TABLE: sales_order_dispatch_items');
        console.table(rows);
    } catch (err) {
        process.exit(1);
    } finally {
        process.exit();
    }
}

checkSchema();
