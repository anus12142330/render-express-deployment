import db from './db.js';

async function run() {
    try {
        const [cols] = await db.promise().query('DESCRIBE inventory_batches');
        console.log('inventory_batches:', cols.map(c => c.Field));
    } catch (e) {
        console.log('inventory_batches error:', e.message);
    }

    try {
        const [cols] = await db.promise().query('DESCRIBE ap_bill_lines');
        console.log('ap_bill_lines:', cols.map(c => c.Field));
    } catch (e) {
        console.log('ap_bill_lines error:', e.message);
    }

    try {
        const [cols] = await db.promise().query('DESCRIBE sales_order_dispatch_items');
        console.log('sales_order_dispatch_items:', cols.map(c => c.Field));
    } catch (e) {
        console.log('sales_order_dispatch_items error:', e.message);
    }

    process.exit(0);
}

run();
