import mysql from 'mysql2';
import dotenv from 'dotenv';
dotenv.config();

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'portal_db',
    dateStrings: true
});

async function debug() {
    try {
        const [lines] = await pool.promise().query(`
            SELECT id, invoice_id, product_id, item_name, quantity, line_no 
            FROM ar_invoice_lines 
            WHERE item_name LIKE '%Red Lady Papaya%' 
            OR id = 122
            ORDER BY id DESC LIMIT 5
        `);
        console.log('Invoice Lines:', JSON.stringify(lines, null, 2));

        if (lines.length > 0) {
            const invoiceLine = lines[0];
            const invoiceId = invoiceLine.invoice_id;
            const productId = invoiceLine.product_id;

            const [invoiceRow] = await pool.promise().query(`SELECT * FROM ar_invoices WHERE id = ?`, [invoiceId]);
            console.log('Invoice Details:', JSON.stringify(invoiceRow, null, 2));

            const soId = invoiceRow[0].sales_order_id;
            if (soId) {
                const [soHeader] = await pool.promise().query(`SELECT * FROM sales_orders WHERE id = ?`, [soId]);
                console.log('Sales Order Details:', JSON.stringify(soHeader, null, 2));

                const [dispatches] = await pool.promise().query(`SELECT * FROM sales_order_dispatches WHERE sales_order_id = ?`, [soId]);
                console.log('Dispatches:', JSON.stringify(dispatches, null, 2));

                for (const d of dispatches) {
                    const [dItems] = await pool.promise().query(`
                        SELECT di.*, p.product_name 
                        FROM sales_order_dispatch_items di
                        LEFT JOIN sales_order_items soi ON soi.id = di.sales_order_item_id
                        LEFT JOIN products p ON p.id = soi.product_id
                        WHERE di.dispatch_id = ?
                    `, [d.id]);
                    console.log(`Dispatch Items for Dispatch ${d.id}:`, JSON.stringify(dItems, null, 2));
                }
            }

            const [lineBatches] = await pool.promise().query(`SELECT * FROM ar_invoice_line_batches WHERE invoice_line_id = ?`, [invoiceLine.id]);
            console.log('Invoice Line Batches:', JSON.stringify(lineBatches, null, 2));

            const [stock] = await pool.promise().query(`
                SELECT * FROM inventory_stock_batches 
                WHERE product_id = ? AND warehouse_id = ?
            `, [productId, invoiceRow[0].warehouse_id]);
            console.log('Current Stock in Warehouse:', JSON.stringify(stock, null, 2));
        }

        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

debug();
