import db from './db.js';

async function run() {
    const [cols1] = await db.promise().query('DESCRIBE sales_order_dispatches');
    console.log('sales_order_dispatches:', cols1.map(c => c.Field));

    const [cols2] = await db.promise().query('DESCRIBE sales_order_dispatch_items');
    console.log('sales_order_dispatch_items:', cols2.map(c => c.Field));

    const [cols3] = await db.promise().query('DESCRIBE ar_invoices');
    console.log('ar_invoices:', cols3.map(c => c.Field));

    const [cols4] = await db.promise().query('DESCRIBE ar_invoice_lines');
    console.log('ar_invoice_lines:', cols4.map(c => c.Field));

    const [cols5] = await db.promise().query('DESCRIBE ar_invoice_line_batches');
    console.log('ar_invoice_line_batches:', cols5.map(c => c.Field));

    process.exit(0);
}

run();
