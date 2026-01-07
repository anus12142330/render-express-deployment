// server/src/modules/ap/apBills.service.js
// AP Bills service - uses unified inventory_stock_batches and inventory_transactions

const { tx } = require('../../db/tx.cjs');
const glService = require('../gl/gl.service');
const inventoryService = require('../inventory/inventory.service');
const crypto = require('crypto');

/**
 * Post AP Bill - creates inventory transactions and GL journals
 */
async function postBill(conn, billId, userId) {
    // Get bill
    const [bills] = await conn.query(`
        SELECT * FROM ap_bills WHERE id = ? AND status = 'DRAFT'
    `, [billId]);

    if (bills.length === 0) {
        throw new Error('Bill not found or already posted');
    }

    const bill = bills[0];

    // Get bill lines
    const [lines] = await conn.query(`
        SELECT * FROM ap_bill_lines WHERE bill_id = ? ORDER BY line_no
    `, [billId]);

    let inventoryValue = 0;

    // Process each line with batch splits
    for (const line of lines) {
        if (!line.product_id) continue; // Skip non-inventory items

        const [batchSplits] = await conn.query(`
            SELECT * FROM ap_bill_line_batches WHERE bill_line_id = ?
        `, [line.id]);

        if (batchSplits.length === 0) {
            throw new Error(`Bill line ${line.id} has no batch splits`);
        }

        for (const split of batchSplits) {
            // Generate batch_no if not provided
            const batchNo = split.batch_no || `BATCH-${crypto.randomBytes(8).toString('hex')}`;
            
            // Upsert batch
            const batchId = await inventoryService.upsertBatch(
                conn,
                line.product_id,
                batchNo,
                split.mfg_date || null,
                split.exp_date || null,
                null
            );
            
            // Update batch_id in ap_bill_line_batches if it was null
            if (!split.batch_id) {
                await conn.query(`
                    UPDATE ap_bill_line_batches SET batch_id = ? WHERE id = ?
                `, [batchId, split.id]);
            }

            const qty = parseFloat(split.quantity);
            const unitCost = parseFloat(split.unit_cost);

            // Update inventory stock (IN movement, weighted average)
            await inventoryService.updateInventoryStock(
                conn,
                line.product_id,
                bill.warehouse_id,
                batchId,
                qty,
                unitCost,
                true // isIn = true
            );

            // Insert inventory transaction (unified table)
            await inventoryService.insertInventoryTransaction(conn, {
                txn_date: bill.bill_date,
                movement: 'IN',
                txn_type: 'PURCHASE_BILL_RECEIPT',
                source_type: 'AP_BILL',
                source_id: billId,
                source_line_id: line.id,
                product_id: line.product_id,
                warehouse_id: bill.warehouse_id,
                batch_id: batchId,
                qty: qty,
                unit_cost: unitCost
            });

            inventoryValue += qty * unitCost;
        }
    }

    // Get account IDs
    const inventoryAccountId = await glService.getAccountByCode(conn, '1000');
    const apAccountId = await glService.getAccountByCode(conn, '2000');
    const vatInputAccountId = await glService.getAccountByCode(conn, '1300');

    if (!inventoryAccountId || !apAccountId) {
        throw new Error('Required accounts not found in Chart of Accounts');
    }

    // Create GL journal
    const journalLines = [
        {
            account_id: inventoryAccountId,
            debit: inventoryValue,
            credit: 0,
            description: `Inventory from Bill ${bill.bill_number}`
        }
    ];

    if (vatInputAccountId && parseFloat(bill.tax_total) > 0) {
        journalLines.push({
            account_id: vatInputAccountId,
            debit: parseFloat(bill.tax_total),
            credit: 0,
            description: `VAT Input from Bill ${bill.bill_number}`
        });
    }

    journalLines.push({
        account_id: apAccountId,
        debit: 0,
        credit: parseFloat(bill.total),
        description: `Accounts Payable for Bill ${bill.bill_number}`
    });

    await glService.createJournal(conn, {
        source_type: 'AP_BILL',
        source_id: billId,
        journal_date: bill.bill_date,
        memo: `Post Bill ${bill.bill_number}`,
        created_by: userId,
        lines: journalLines
    });

    // Update bill status
    await conn.query(`
        UPDATE ap_bills 
        SET status = 'POSTED', posted_at = NOW(), posted_by = ?
        WHERE id = ?
    `, [userId, billId]);
}

/**
 * Cancel posted AP Bill - creates reversal transactions
 */
async function cancelBill(conn, billId, userId) {
    // Get bill
    const [bills] = await conn.query(`
        SELECT * FROM ap_bills WHERE id = ? AND status = 'POSTED'
    `, [billId]);

    if (bills.length === 0) {
        throw new Error('Bill not found or not posted');
    }

    const bill = bills[0];

    // Get inventory transactions for this bill
    const [txns] = await conn.query(`
        SELECT * FROM inventory_transactions 
        WHERE source_type = 'AP_BILL' AND source_id = ?
        AND txn_type = 'PURCHASE_BILL_RECEIPT'
    `, [billId]);

    // Reverse each transaction
    for (const txn of txns) {
        // Reverse stock (OUT movement to reduce stock)
        await inventoryService.updateInventoryStock(
            conn,
            txn.product_id,
            txn.warehouse_id,
            txn.batch_id,
            txn.qty,
            txn.unit_cost,
            false // isIn = false (OUT)
        );

        // Create reversal transaction
        await inventoryService.insertInventoryTransaction(conn, {
            txn_date: new Date(),
            movement: 'OUT',
            txn_type: 'REVERSAL_OUT',
            source_type: 'REVERSAL',
            source_id: billId,
            source_line_id: txn.source_line_id,
            product_id: txn.product_id,
            warehouse_id: txn.warehouse_id,
            batch_id: txn.batch_id,
            qty: txn.qty,
            unit_cost: txn.unit_cost
        });
    }

    // Get original journal and create reversal
    const [journals] = await conn.query(`
        SELECT id FROM gl_journals 
        WHERE source_type = 'AP_BILL' AND source_id = ?
        ORDER BY id DESC LIMIT 1
    `, [billId]);

    if (journals.length > 0) {
        await glService.createReversalJournal(conn, journals[0].id, userId);
    }

    // Update bill status
    await conn.query(`
        UPDATE ap_bills 
        SET status = 'CANCELLED', cancelled_at = NOW(), cancelled_by = ?
        WHERE id = ?
    `, [userId, billId]);
}

module.exports = {
    postBill,
    cancelBill
};

