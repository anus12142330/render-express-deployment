// server/src/modules/ar/arReceipts.service.js
const glService = require('../gl/gl.service.cjs');

async function postReceipt(conn, receiptId, userId) {
    const [receipts] = await conn.query(`SELECT * FROM ar_receipts WHERE id = ? AND status = 'DRAFT'`, [receiptId]);
    if (receipts.length === 0) throw new Error('Receipt not found or already posted');

    const receipt = receipts[0];
    const [allocations] = await conn.query(`SELECT * FROM ar_receipt_allocations WHERE receipt_id = ?`, [receiptId]);

    const totalAllocated = allocations.reduce((sum, a) => sum + parseFloat(a.allocated_amount), 0);
    if (Math.abs(totalAllocated - parseFloat(receipt.total_amount)) > 0.01) {
        throw new Error(`Allocation mismatch. Receipt: ${receipt.total_amount}, Allocated: ${totalAllocated}`);
    }

    for (const alloc of allocations) {
        const [invoices] = await conn.query(`
            SELECT ai.total, COALESCE(SUM(ra.allocated_amount), 0) as received_amount
            FROM ar_invoices ai
            LEFT JOIN ar_receipt_allocations ra ON ra.invoice_id = ai.id
            WHERE ai.id = ?
            GROUP BY ai.id
        `, [alloc.invoice_id]);

        if (invoices.length === 0) throw new Error(`Invoice ${alloc.invoice_id} not found`);

        const invoice = invoices[0];
        const outstanding = parseFloat(invoice.total) - parseFloat(invoice.received_amount);
        const allocated = parseFloat(alloc.allocated_amount);

        if (allocated > outstanding) {
            throw new Error(`Allocation ${allocated} exceeds outstanding ${outstanding} for invoice ${alloc.invoice_id}`);
        }
    }

    const arAccountId = await glService.getAccountByCode(conn, '1200');
    const bankAccountId = await glService.getAccountByCode(conn, '1100');

    if (!arAccountId || !bankAccountId) {
        throw new Error('Required accounts not found in Chart of Accounts');
    }

    // Get customer_id from the first invoice allocation (buyer_id for AR receipts)
    let buyerId = null;
    if (allocations.length > 0 && allocations[0].invoice_id) {
        const [invoiceRows] = await conn.query(`
            SELECT customer_id FROM ar_invoices WHERE id = ? LIMIT 1
        `, [allocations[0].invoice_id]);
        if (invoiceRows.length > 0) {
            buyerId = invoiceRows[0].customer_id;
        }
    }

    await glService.createJournal(conn, {
        source_type: 'AR_RECEIPT',
        source_id: receiptId,
        journal_date: receipt.receipt_date,
        memo: `Receipt ${receipt.receipt_number}`,
        created_by: userId,
        source_name: receipt.receipt_number,
        source_date: receipt.receipt_date,
        lines: [
            {
                account_id: bankAccountId,
                debit: parseFloat(receipt.total_amount),
                credit: 0,
                description: `Bank receipt ${receipt.receipt_number}`,
                entity_type: 'CUSTOMER',
                entity_id: buyerId,
                buyer_id: buyerId
            },
            {
                account_id: arAccountId,
                debit: 0,
                credit: parseFloat(receipt.total_amount),
                description: `Accounts Receivable receipt ${receipt.receipt_number}`,
                entity_type: 'CUSTOMER',
                entity_id: buyerId,
                buyer_id: buyerId
            }
        ]
    });

    await conn.query(`UPDATE ar_receipts SET status = 'POSTED', posted_at = NOW(), posted_by = ? WHERE id = ?`, [userId, receiptId]);
}

async function cancelReceipt(conn, receiptId, userId) {
    const [receipts] = await conn.query(`SELECT * FROM ar_receipts WHERE id = ? AND status = 'POSTED'`, [receiptId]);
    if (receipts.length === 0) throw new Error('Receipt not found or not posted');

    const [journals] = await conn.query(`SELECT id FROM gl_journals WHERE source_type = 'AR_RECEIPT' AND source_id = ? ORDER BY id DESC LIMIT 1`, [receiptId]);
    if (journals.length > 0) {
        await glService.createReversalJournal(conn, journals[0].id, userId);
    }

    await conn.query(`UPDATE ar_receipts SET status = 'CANCELLED', cancelled_at = NOW(), cancelled_by = ? WHERE id = ?`, [userId, receiptId]);
}

module.exports = { postReceipt, cancelReceipt };

