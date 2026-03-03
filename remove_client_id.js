import db from './db.js';

async function removeClientId() {
    console.log('Starting client_id removal...');
    try {
        await db.promise().query('ALTER TABLE sales_order_attachments DROP COLUMN client_id');
        console.log('✅ Successfully dropped client_id from sales_order_attachments');
    } catch (e) {
        console.error('❌ Error on sales_order_attachments:', e.message);
    }

    try {
        await db.promise().query('ALTER TABLE sales_orders DROP COLUMN client_id');
        console.log('✅ Successfully dropped client_id from sales_orders');
    } catch (e) {
        console.error('❌ Error on sales_orders:', e.message);
    }

    // You might also want to remove it from other related tables if you don't use it at all
    // like sales_order_items, sales_order_dispatches, sales_order_dispatch_items
    const childTables = ['sales_order_items', 'sales_order_dispatches', 'sales_order_dispatch_items'];
    for (const table of childTables) {
        try {
            await db.promise().query(`ALTER TABLE ${table} DROP COLUMN client_id`);
            console.log(`✅ Successfully dropped client_id from ${table}`);
        } catch (e) {
            console.error(`❌ Error on ${table}:`, e.message);
        }
    }

    process.exit();
}

removeClientId();
