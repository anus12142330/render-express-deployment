import db from './db.js';
import crypto from 'crypto';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { generateARInvoiceNumber } = require('./src/utils/docNo.cjs');

async function run() {
    const conn = await db.promise().getConnection();
    try {
        const id = 29;
        const [headerRows] = await conn.query('SELECT * FROM sales_orders WHERE id = ?', [id]);
        const header = headerRows[0];

        const [items] = await conn.query('SELECT * FROM sales_order_items WHERE sales_order_id = ?', [id]);
        console.log("Items:", items.map(i => ({ id: i.id, disp_qty: i.dispatched_quantity })));

        let invSubtotal = 0;
        let invTaxTotal = 0;
        let invGrandTotal = 0;
        const invoiceLines = [];

        for (const item of items) {
            const qty = Number(item.dispatched_quantity || 0);
            if (qty <= 0) continue;

            const rate = Number(item.unit_price || 0);
            const lineSubtotal = qty * rate;
            const taxRate = Number(item.tax_rate || 0);
            const lineTax = lineSubtotal * (taxRate / 100);
            const lineTotal = lineSubtotal + lineTax;

            invSubtotal += lineSubtotal;
            invTaxTotal += lineTax;
            invGrandTotal += lineTotal;

            invoiceLines.push({
                ...item,
                qty,
                rate,
                lineSubtotal,
                lineTax,
                lineTotal
            });
        }
        console.log("InvoiceLines count:", invoiceLines.length);

        if (invoiceLines.length > 0) {
            const year = new Date().getFullYear();
            const invoiceNumber = await generateARInvoiceNumber(conn, year);
            console.log("InvoiceNumber:", invoiceNumber);

            const [dispatchWh] = await conn.query(`
                SELECT ab.warehouse_id 
                FROM sales_order_dispatch_items di
                JOIN ap_bill_lines abl ON di.ap_bill_line_id = abl.id
                JOIN ap_bills ab ON abl.bill_id = ab.id
                JOIN sales_order_dispatches d ON di.dispatch_id = d.id
                WHERE d.sales_order_id = ? LIMIT 1
            `, [id]);
            const finalWarehouseId = dispatchWh[0]?.warehouse_id || header.warehouse_id;
            console.log("finalWarehouseId:", finalWarehouseId);

            console.log("Ready to insert", {
                header_customer_id: header.customer_id,
                company_id: header.company_id,
                currency_id: header.currency_id,
                order_no: header.order_no,
                invSubtotal, invTaxTotal, invGrandTotal
            });

            // we won't insert to avoid messing db if it throws
            console.log("Dry run success");
        }
    } catch (e) {
        console.error("Error generating invoice:", e);
    } finally {
        conn.release();
    }
    process.exit(0);
}

run();
