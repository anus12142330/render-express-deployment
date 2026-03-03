import db from './db.js';

async function run() {
    try {
        const [rows] = await db.promise().query('DESCRIBE sales_order_dispatches');
        console.log("sales_order_dispatches:", JSON.stringify(rows.map(r => r.Field)));

        const [rows2] = await db.promise().query('DESCRIBE ar_invoices');
        console.log("ar_invoices:", JSON.stringify(rows2.map(r => r.Field)));

        const [rows3] = await db.promise().query('DESCRIBE sales_orders');
        console.log("sales_orders:", JSON.stringify(rows3.map(r => r.Field)));
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
}

run();
