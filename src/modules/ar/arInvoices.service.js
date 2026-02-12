// server/src/modules/ar/arInvoices.service.js
// AR Invoices service - uses unified inventory_stock_batches and inventory_transactions

const { tx } = require('../../db/tx.cjs');
const glService = require('../gl/gl.service');
const inventoryService = require('../inventory/inventory.service');

/**
 * Post AR Invoice - creates inventory transactions and GL journals
 */
async function postInvoice(conn, invoiceId, userId) {
    const [invoices] = await conn.query(`
        SELECT * FROM ar_invoices WHERE id = ? AND status = 'DRAFT'
    `, [invoiceId]);

    if (invoices.length === 0) {
        throw new Error('Invoice not found or already posted');
    }

    const invoice = invoices[0];
    const [lines] = await conn.query(`
        SELECT * FROM ar_invoice_lines WHERE invoice_id = ? ORDER BY line_no
    `, [invoiceId]);

    let totalCOGS = 0;

    for (const line of lines) {
        if (!line.product_id) continue;

        const [batchAllocs] = await conn.query(`
            SELECT * FROM ar_invoice_line_batches WHERE invoice_line_id = ?
        `, [line.id]);

        if (batchAllocs.length === 0) {
            throw new Error(`Invoice line ${line.id} has no batch allocations`);
        }

        const totalAllocatedQty = batchAllocs.reduce((sum, a) => sum + parseFloat(a.quantity), 0);
        if (Math.abs(totalAllocatedQty - parseFloat(line.quantity)) > 0.01) {
            throw new Error(`Batch allocation quantity ${totalAllocatedQty} doesn't match line quantity ${line.quantity}`);
        }

        await inventoryService.validateBatchStock(conn, batchAllocs.map(a => ({
            batch_id: a.batch_id,
            quantity: a.quantity,
            product_id: line.product_id
        })), invoice.warehouse_id);

        for (const alloc of batchAllocs) {
            const [stockRows] = await conn.query(`
                SELECT qty_on_hand, unit_cost 
                FROM inventory_stock_batches 
                WHERE batch_id = ? AND warehouse_id = ? AND product_id = ?
            `, [alloc.batch_id, invoice.warehouse_id, line.product_id]);

            if (stockRows.length === 0) {
                throw new Error(`Batch ${alloc.batch_id} not found in warehouse ${invoice.warehouse_id}`);
            }

            const stock = stockRows[0];
            const qtyOut = parseFloat(alloc.quantity);
            const unitCost = parseFloat(alloc.unit_cost || stock.unit_cost);

            await inventoryService.updateInventoryStock(
                conn,
                line.product_id,
                invoice.warehouse_id,
                alloc.batch_id,
                qtyOut,
                unitCost,
                false // isIn = false (OUT)
            );

            await inventoryService.insertInventoryTransaction(conn, {
                txn_date: invoice.invoice_date,
                movement: 'OUT',
                txn_type: 'SALES_INVOICE_ISSUE',
                source_type: 'AR_INVOICE',
                source_id: invoiceId,
                source_line_id: line.id,
                product_id: line.product_id,
                warehouse_id: invoice.warehouse_id,
                batch_id: alloc.batch_id,
                qty: qtyOut,
                unit_cost: unitCost
            });

            totalCOGS += qtyOut * unitCost;

            await conn.query(`
                UPDATE ar_invoice_line_batches 
                SET unit_cost = ? 
                WHERE id = ?
            `, [unitCost, alloc.id]);
        }
    }

    const arAccountId = await glService.getAccountByCode(conn, '1200');
    const salesAccountId = await glService.getAccountByCode(conn, '4000');
    const cogsAccountId = await glService.getAccountByCode(conn, '5000');
    const inventoryAccountId = await glService.getAccountByCode(conn, '1000');
    const vatOutputAccountId = await glService.getAccountByCode(conn, '2100');

    if (!arAccountId || !salesAccountId || !cogsAccountId || !inventoryAccountId) {
        throw new Error('Required accounts not found in Chart of Accounts');
    }

    const journalLines = [
        {
            account_id: arAccountId,
            debit: parseFloat(invoice.total),
            credit: 0,
            description: `Accounts Receivable for Invoice ${invoice.invoice_number}`
        },
        {
            account_id: salesAccountId,
            debit: 0,
            credit: parseFloat(invoice.subtotal),
            description: `Sales Revenue from Invoice ${invoice.invoice_number}`
        }
    ];

    if (vatOutputAccountId && parseFloat(invoice.tax_total) > 0) {
        journalLines.push({
            account_id: vatOutputAccountId,
            debit: 0,
            credit: parseFloat(invoice.tax_total),
            description: `VAT Output from Invoice ${invoice.invoice_number}`
        });
    }

    if (totalCOGS > 0) {
        journalLines.push({
            account_id: cogsAccountId,
            debit: totalCOGS,
            credit: 0,
            description: `COGS for Invoice ${invoice.invoice_number}`
        });
        journalLines.push({
            account_id: inventoryAccountId,
            debit: 0,
            credit: totalCOGS,
            description: `Inventory reduction for Invoice ${invoice.invoice_number}`
        });
    }

    await glService.createJournal(conn, {
        source_type: 'AR_INVOICE',
        source_id: invoiceId,
        journal_date: invoice.invoice_date,
        memo: `Post Invoice ${invoice.invoice_number}`,
        created_by: userId,
        lines: journalLines
    });

    await conn.query(`
        UPDATE ar_invoices 
        SET status = 'POSTED', posted_at = NOW(), posted_by = ?
        WHERE id = ?
    `, [userId, invoiceId]);
}

/**
 * Auto-allocate batches using FIFO or FEFO
 */
async function autoAllocateBatches(conn, invoiceId, mode = 'FIFO') {
    const [invoices] = await conn.query(`
        SELECT * FROM ar_invoices WHERE id = ? AND status = 'DRAFT'
    `, [invoiceId]);

    if (invoices.length === 0) {
        throw new Error('Invoice not found or already posted');
    }

    const invoice = invoices[0];
    const [lines] = await conn.query(`
        SELECT * FROM ar_invoice_lines WHERE invoice_id = ? ORDER BY line_no
    `, [invoiceId]);

    await conn.query(`
        DELETE FROM ar_invoice_line_batches 
        WHERE invoice_line_id IN (SELECT id FROM ar_invoice_lines WHERE invoice_id = ?)
    `, [invoiceId]);

    for (const line of lines) {
        if (!line.product_id) continue;

        let allocations;
        if (mode === 'FIFO') {
            allocations = await inventoryService.allocateFIFO(
                conn,
                line.product_id,
                invoice.warehouse_id,
                line.quantity
            );
        } else if (mode === 'FEFO') {
            allocations = await inventoryService.allocateFEFO(
                conn,
                line.product_id,
                invoice.warehouse_id,
                line.quantity
            );
        } else {
            throw new Error(`Invalid allocation mode: ${mode}`);
        }

        for (const alloc of allocations) {
            await conn.query(`
                INSERT INTO ar_invoice_line_batches 
                (invoice_line_id, batch_id, quantity, unit_cost)
                VALUES (?, ?, ?, ?)
            `, [line.id, alloc.batch_id, alloc.quantity, alloc.unit_cost]);
        }
    }

    return { success: true, message: `Batches allocated using ${mode}` };
}

/**
 * Cancel posted AR Invoice
 */
async function cancelInvoice(conn, invoiceId, userId) {
    const [invoices] = await conn.query(`
        SELECT * FROM ar_invoices WHERE id = ? AND status = 'POSTED'
    `, [invoiceId]);

    if (invoices.length === 0) {
        throw new Error('Invoice not found or not posted');
    }

    const invoice = invoices[0];
    const [txns] = await conn.query(`
        SELECT * FROM inventory_transactions 
        WHERE source_type = 'AR_INVOICE' AND source_id = ?
        AND txn_type = 'SALES_INVOICE_ISSUE'
    `, [invoiceId]);

    for (const txn of txns) {
        await inventoryService.updateInventoryStock(
            conn,
            txn.product_id,
            txn.warehouse_id,
            txn.batch_id,
            txn.qty,
            txn.unit_cost,
            true // isIn = true (add back stock)
        );

        await inventoryService.insertInventoryTransaction(conn, {
            txn_date: new Date(),
            movement: 'IN',
            txn_type: 'REVERSAL_IN',
            source_type: 'REVERSAL',
            source_id: invoiceId,
            source_line_id: txn.source_line_id,
            product_id: txn.product_id,
            warehouse_id: txn.warehouse_id,
            batch_id: txn.batch_id,
            qty: txn.qty,
            unit_cost: txn.unit_cost
        });
    }

    const [journals] = await conn.query(`
        SELECT id FROM gl_journals 
        WHERE source_type = 'AR_INVOICE' AND source_id = ?
        ORDER BY id DESC LIMIT 1
    `, [invoiceId]);

    if (journals.length > 0) {
        await glService.createReversalJournal(conn, journals[0].id, userId);
    }

    await conn.query(`
        UPDATE ar_invoices 
        SET status = 'CANCELLED', cancelled_at = NOW(), cancelled_by = ?
        WHERE id = ?
    `, [userId, invoiceId]);
}

module.exports = {
    postInvoice,
    autoAllocateBatches,
    cancelInvoice
};

