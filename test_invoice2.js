import db from './db.js';
import crypto from 'crypto';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { generateARInvoiceNumber } = require('./src/utils/docNo.cjs');

async function run() {
    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        const id = 29;
        const [headerRows] = await conn.query('SELECT * FROM sales_orders WHERE id = ?', [id]);
        const header = headerRows[0];

        const [items] = await conn.query('SELECT * FROM sales_order_items WHERE sales_order_id = ?', [id]);
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

            invoiceLines.push({ ...item, qty, rate, lineSubtotal, lineTax, lineTotal });
        }

        if (invoiceLines.length > 0) {
            const year = new Date().getFullYear();
            const invoiceNumber = await generateARInvoiceNumber(conn, year);
            const invoiceUniqid = `ari_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

            const [dispatchWh] = await conn.query(`
                SELECT ab.warehouse_id 
                FROM sales_order_dispatch_items di
                JOIN ap_bill_lines abl ON di.ap_bill_line_id = abl.id
                JOIN ap_bills ab ON abl.bill_id = ab.id
                JOIN sales_order_dispatches d ON di.dispatch_id = d.id
                WHERE d.sales_order_id = ? LIMIT 1
            `, [id]);
            const finalWarehouseId = dispatchWh[0]?.warehouse_id || header.warehouse_id;

            console.log("Inserting Invoice...", { finalWarehouseId, invSubtotal });

            const due_date = null;
            const payment_term_id = null;
            const client_notes = "test notes";
            const userId = 8;

            // Try actual insert
            const [invoiceResult] = await conn.query(`
                INSERT INTO ar_invoices 
                (invoice_uniqid, invoice_number, invoice_date, due_date, payment_terms_id, 
                 customer_id, company_id, warehouse_id, currency_id, subtotal, 
                 discount_type, discount_amount, tax_total, total, notes, 
                 sales_order_id, sales_order_number, user_id, status_id)
                VALUES (?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 8)
            `, [
                invoiceUniqid, invoiceNumber, due_date, payment_term_id,
                header.customer_id, header.company_id, finalWarehouseId, header.currency_id,
                invSubtotal, 'fixed', 0, invTaxTotal, invGrandTotal, client_notes,
                id, header.order_no, userId
            ]);
            console.log("INSERT AR_INVOICES SUCCESS:", invoiceResult.insertId);

            // Now lines
            const invoiceId = invoiceResult.insertId;
            for (let i = 0; i < invoiceLines.length; i++) {
                const line = invoiceLines[i];
                const [lineResult] = await conn.query(`
                    INSERT INTO ar_invoice_lines 
                    (invoice_id, line_no, product_id, item_name, description, quantity, uom_id, rate, tax_id, tax_rate, line_total)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [invoiceId, i + 1, line.product_id, line.product_name, line.description, line.qty, line.uom_id, line.rate, line.tax_id, line.tax_rate, line.lineTotal]);
                console.log("Line insert success:", lineResult.insertId);
            }
        }
        await conn.rollback();
        console.log("ROLLBACK SUCCESS");
    } catch (e) {
        console.error("Error generating invoice:", e);
        await conn.rollback();
    } finally {
        conn.release();
    }
    process.exit(0);
}

run();
