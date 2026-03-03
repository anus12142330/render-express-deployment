import db from './db.js';

async function run() {
    try {
        const id = 29;
        const [header] = await db.promise().query('SELECT * FROM sales_orders WHERE id = ?', [id]);
        console.log("SO Header:", JSON.stringify(header[0], null, 2));

        const [items] = await db.promise().query('SELECT * FROM sales_order_items WHERE sales_order_id = ?', [id]);
        console.log("SO Items:", JSON.stringify(items, null, 2));

        const [dispatches] = await db.promise().query('SELECT * FROM sales_order_dispatches WHERE sales_order_id = ?', [id]);
        console.log("Dispatches:", JSON.stringify(dispatches, null, 2));

        const [invoices] = await db.promise().query('SELECT * FROM ar_invoices WHERE sales_order_id = ?', [id]);
        console.log("Invoices for this SO:", JSON.stringify(invoices, null, 2));
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
}

run();
