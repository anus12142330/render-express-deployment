// server/src/modules/ap/apBills.service.js
// AP Bills service - uses unified inventory_stock_batches and inventory_transactions

const { tx } = require('../../db/tx.cjs');
const glService = require('../gl/gl.service.cjs');
const inventoryService = require('../inventory/inventory.service.cjs');
const { isInventoryMovementEnabled } = require('../../utils/inventoryHelper.cjs');
const crypto = require('crypto');

/**
 * Post AP Bill - creates inventory transactions and GL journals
 */
async function postBill(conn, billId, userId) {
    // Check if inventory movement is enabled
    const movementEnabled = await isInventoryMovementEnabled();
    if (!movementEnabled) {
        console.log('[AP Bill] Inventory movement is disabled. Skipping inventory operations but allowing bill posting.');
    }

    // Get bill - allow posting from SUBMITTED_FOR_APPROVAL (8) or DRAFT (3) status
    const [bills] = await conn.query(`
        SELECT * FROM ap_bills WHERE id = ? AND status_id IN (3, 8)
    `, [billId]);

    if (bills.length === 0) {
        throw new Error('Bill not found or not in a postable status (must be DRAFT or SUBMITTED_FOR_APPROVAL)');
    }

    const bill = bills[0];
    const isServiceBill = bill.is_service === 1 || bill.is_service === true;

    // Validate required bill data
    if (!isServiceBill && !bill.warehouse_id) {
        throw new Error('Bill must have a warehouse assigned');
    }
    if (!bill.bill_date) {
        throw new Error('Bill must have a bill date');
    }
    if (!bill.total || parseFloat(bill.total) <= 0) {
        throw new Error('Bill must have a valid total amount');
    }

    // Get currency exchange rate if currency_id exists
    let exchangeRate = null;
    if (bill.currency_id) {
        const [currencyRows] = await conn.query(`
            SELECT conversion_rate FROM currency WHERE id = ?
        `, [bill.currency_id]);
        if (currencyRows.length > 0) {
            exchangeRate = parseFloat(currencyRows[0].conversion_rate) || 1;
        }
    }

    // Check if bill already has inventory transactions (already posted)
    // If so, reverse the stock and mark them as deleted (soft delete) before inserting new ones
    const [existingTxns] = await conn.query(`
        SELECT * FROM inventory_transactions 
        WHERE source_type = 'AP_BILL' AND source_id = ? 
        AND txn_type = 'PURCHASE_BILL_RECEIPT'
        AND (is_deleted = 0 OR is_deleted IS NULL)
    `, [billId]);

    if (existingTxns.length > 0 && movementEnabled) {
        // Reverse stock from existing transactions (OUT movement to reduce stock)
        // Only reverse stock for transactions that actually affected inventory_stock_batches
        // IN_TRANSIT (movement_type_id = 3) and TRANSIT_OUT (movement_type_id = 4) don't affect stock
        for (const txn of existingTxns) {
            // Check movement field first - if 'IN TRANSIT', skip reversal (no stock was added)
            if (txn.movement === 'IN TRANSIT') {
                // Skip reversal for IN TRANSIT - stock was never added to inventory_stock_batches
                continue;
            }
            
            // Only reverse stock if movement_type_id affects stock on hand (REGULAR_IN = 1, DISCARD = 5)
            // Skip IN_TRANSIT (3) and TRANSIT_OUT (4) as they don't affect inventory_stock_batches
            const movementTypeId = txn.movement_type_id;
            const affectsStock = movementTypeId === 1 || movementTypeId === 5; // REGULAR_IN or DISCARD
            
            if (movementTypeId !== null && !affectsStock) {
                // Skip reversal for IN_TRANSIT (3) and TRANSIT_OUT (4) - they don't affect stock
                continue;
            }
            
            // For old transactions (movement_type_id is NULL), check if stock record exists before reversing
            if (movementTypeId === null || movementTypeId === undefined) {
                // Check if stock record exists before attempting reversal
                const [stockCheck] = await conn.query(`
                    SELECT id, qty_on_hand 
                    FROM inventory_stock_batches 
                    WHERE product_id = ? AND warehouse_id = ? AND batch_id = ?
                `, [txn.product_id, txn.warehouse_id, txn.batch_id]);
                
                if (stockCheck.length === 0) {
                    // No stock record exists - likely was IN TRANSIT, skip reversal
                    console.warn(`Warning: Stock record not found for transaction ${txn.id} (movement: ${txn.movement}) - skipping reversal`);
                    continue;
                }
            }
            
            try {
                await inventoryService.updateInventoryStock(
                    conn,
                    txn.product_id,
                    txn.warehouse_id,
                    txn.batch_id,
                    txn.qty,
                    txn.unit_cost,
                    false // isIn = false (OUT) to reverse the stock
                );
            } catch (error) {
                // If stock is insufficient, try to reverse only what's available
                if (error.message && error.message.includes('Insufficient stock')) {
                    // Get current stock level
                    const [stock] = await conn.query(`
                        SELECT qty_on_hand 
                        FROM inventory_stock_batches 
                        WHERE product_id = ? AND warehouse_id = ? AND batch_id = ?
                    `, [txn.product_id, txn.warehouse_id, txn.batch_id]);
                    
                    if (stock.length > 0 && parseFloat(stock[0].qty_on_hand) > 0) {
                        // Reverse only what's available
                        const availableQty = parseFloat(stock[0].qty_on_hand);
                        await inventoryService.updateInventoryStock(
                            conn,
                            txn.product_id,
                            txn.warehouse_id,
                            txn.batch_id,
                            availableQty,
                            txn.unit_cost,
                            false // isIn = false (OUT) to reverse the stock
                        );
                        // Log warning but continue - some stock was consumed
                        console.warn(`Warning: Reversed only ${availableQty} of ${txn.qty} units for transaction ${txn.id} (stock was partially consumed)`);
                    } else {
                        // No stock available to reverse, skip this transaction
                        console.warn(`Warning: No stock available to reverse for transaction ${txn.id}`);
                    }
                } else if (error.message && error.message.includes('Stock record not found')) {
                    // Stock record doesn't exist - this is OK for IN_TRANSIT transactions that were never posted to stock
                    // Just log and continue
                    console.warn(`Warning: Stock record not found for transaction ${txn.id} (movement: ${txn.movement}, movement_type_id: ${txn.movement_type_id}) - skipping reversal`);
                } else {
                    // Re-throw other errors
                    throw error;
                }
            }
        }

        // Soft delete existing inventory transactions
        if (movementEnabled) {
        await conn.query(`
            UPDATE inventory_transactions 
            SET is_deleted = 1 
            WHERE source_type = 'AP_BILL' AND source_id = ? 
            AND txn_type = 'PURCHASE_BILL_RECEIPT'
            AND (is_deleted = 0 OR is_deleted IS NULL)
        `, [billId]);
        }
    }

    // Check if bill already has GL journals (already posted)
    // If so, mark them as deleted (soft delete) instead of throwing an error
    const [existingJournals] = await conn.query(`
        SELECT id FROM gl_journals 
        WHERE source_type = 'AP_BILL' AND source_id = ?
        AND (is_deleted = 0 OR is_deleted IS NULL)
    `, [billId]);

    if (existingJournals.length > 0) {
        // Soft delete existing GL journals
        await conn.query(`
            UPDATE gl_journals 
            SET is_deleted = 1 
            WHERE source_type = 'AP_BILL' AND source_id = ?
            AND (is_deleted = 0 OR is_deleted IS NULL)
        `, [billId]);
    }

    // Get bill lines
    const [lines] = await conn.query(`
        SELECT abl.*, p.item_type, p.item_id
        FROM ap_bill_lines abl
        LEFT JOIN products p ON p.id = abl.product_id
        WHERE abl.bill_id = ? ORDER BY abl.line_no
    `, [billId]);

    if (lines.length === 0) {
        throw new Error('Bill must have at least one line item');
    }

    let inventoryValue = 0;

    // Process each line with batch splits
    for (const line of lines) {
        if (!line.product_id) continue; // Skip non-inventory items
        if (String(line.item_type || '').toLowerCase() === 'service' || Number(line.item_id) === 1) {
            continue; // Skip service lines for inventory transactions
        }

        const [batchSplits] = await conn.query(`
            SELECT * FROM ap_bill_line_batches WHERE bill_line_id = ?
        `, [line.id]);

        if (batchSplits.length === 0) {
            throw new Error(`Bill line ${line.line_no} (product: ${line.item_name || line.id}) has no batch splits. All inventory items must have batch information.`);
        }

        // Validate batch splits total matches line quantity
        const totalBatchQty = batchSplits.reduce((sum, split) => sum + parseFloat(split.quantity || 0), 0);
        const lineQty = parseFloat(line.quantity || 0);
        if (Math.abs(totalBatchQty - lineQty) > 0.01) {
            throw new Error(`Bill line ${line.line_no} batch quantity (${totalBatchQty}) does not match line quantity (${lineQty})`);
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

            // Validate quantity and cost
            if (isNaN(qty) || qty <= 0) {
                throw new Error(`Invalid quantity for batch ${batchNo} on line ${line.line_no}`);
            }
            if (isNaN(unitCost) || unitCost < 0) {
                throw new Error(`Invalid unit cost for batch ${batchNo} on line ${line.line_no}`);
            }

            // Calculate amounts
            const amount = qty * unitCost; // Transaction currency amount
            const aedAmount = exchangeRate && exchangeRate > 0 ? amount * exchangeRate : amount; // AED converted amount

            // ============================================================
            // PURCHASE BILL APPROVAL FLOW:
            // 1. Create inventory transaction with movement = 'IN TRANSIT' and movement_type_id = 3
            // 2. DO NOT update inventory_stock_batches - stock stays in transit
            // 3. After QC check, transactions will be updated to:
            //    - ACCEPT: movement = 'IN', movement_type_id = 1 (regular stock) + update inventory_stock_batches
            //    - REJECT: movement = 'DISCARD', movement_type_id = 5 (discard) + update inventory_stock_batches
            // ============================================================
            
            // Insert inventory transaction with movement_type_id = 3 (IN TRANSIT)
            // Stock remains in transit until QC decision moves it to regular stock (IN) or discard
            // Use movement = 'IN TRANSIT' (enum value) - stock is not yet available for sale
            if (movementEnabled) {
            await inventoryService.insertInventoryTransaction(conn, {
                txn_date: bill.bill_date,
                movement: 'IN TRANSIT', // Enum value - stock is in transit, not yet available
                txn_type: 'PURCHASE_BILL_RECEIPT',
                source_type: 'AP_BILL',
                source_id: billId,
                source_line_id: line.id,
                product_id: line.product_id,
                warehouse_id: bill.warehouse_id,
                batch_id: batchId,
                qty: qty,
                unit_cost: unitCost,
                currency_id: bill.currency_id || null,
                exchange_rate: exchangeRate,
                foreign_amount: amount, // Transaction currency amount
                total_amount: aedAmount, // AED converted amount
                uom_id: line.uom_id || null,
                movement_type_id: 3 // IN_TRANSIT (movement_types.id = 3) - will be moved to regular stock (1) or discard (5) based on QC decision
            });
            }

            inventoryValue += qty * unitCost;
        }
    }

    // Get Accounts Payable account ID (should be account ID 6 based on your data)
    const apAccountId = await glService.getAccountByCode(conn, '6'); // Accounts Payable (A/P)
    if (!apAccountId) {
        throw new Error('Accounts Payable account not found in Chart of Accounts. Please ensure account ID 6 exists.');
    }

    // Get bill lines with product account IDs
    // Use inventory_account_id for goods and purchase_account_id for services
    const [linesWithAccounts] = await conn.query(`
        SELECT 
            abl.*,
            p.inventory_account_id,
            p.purchase_account_id,
            p.item_type,
            p.item_id,
            COALESCE(abl.line_total, (abl.quantity * abl.rate)) as line_total_amount
        FROM ap_bill_lines abl
        LEFT JOIN products p ON p.id = abl.product_id
        WHERE abl.bill_id = ?
    `, [billId]);

    // Calculate GL journal amounts
    const billSubtotal = parseFloat(bill.subtotal || 0);
    const billTaxTotal = parseFloat(bill.tax_total || 0);
    const billTotal = parseFloat(bill.total || 0);

    // Group lines by account_id and product_id to track individual products
    // We'll create journal lines per product to track product_id
    const accountTotals = {};
    const accountNames = {};
    const productLines = []; // Store individual product lines for journal entries
    let calculatedSubtotal = 0;

    // Track lines without required account to adjust subtotal validation
    let subtotalWithoutInventoryAccount = 0;
    const productsWithoutInventoryAccount = []; // Track products missing required account for error message

    for (const line of linesWithAccounts) {
        const isServiceLine = String(line.item_type || '').toLowerCase() === 'service' || Number(line.item_id) === 1;
        const accountId = isServiceLine ? line.purchase_account_id : line.inventory_account_id;
        const lineTotal = parseFloat(line.line_total_amount || 0);
        const productId = line.product_id;
        
        // Skip products without required account from GL journal entries
        // These products will still have inventory stock updated (done earlier), but no GL journal entry
        // Note: This may cause accounting imbalance - inventory stock increases but no corresponding GL debit
        if (!accountId) {
            productsWithoutInventoryAccount.push({
                name: line.item_name || 'Unknown',
                lineNo: line.line_no || 'N/A'
            });
            subtotalWithoutInventoryAccount += lineTotal; // Track excluded amount for validation
            continue; // Skip this line from GL journal processing
        }

        if (!accountTotals[accountId]) {
            accountTotals[accountId] = 0;
            // Get account name for description
            const [accountRows] = await conn.query(`
                SELECT name FROM acc_chart_accounts WHERE id = ?
            `, [accountId]);
            accountNames[accountId] = accountRows.length > 0 ? accountRows[0].name : `Account ${accountId}`;
        }

        accountTotals[accountId] += lineTotal;
        calculatedSubtotal += lineTotal;

        // Store product line for journal entry
        if (productId && lineTotal > 0) {
            productLines.push({
                account_id: accountId,
                product_id: productId,
                amount: lineTotal,
                item_name: line.item_name
            });
        }
    }

    // Validate that calculated subtotal matches bill subtotal (with tolerance for rounding)
    // Note: If products without required account were skipped, subtract them from billSubtotal for comparison
    const expectedSubtotal = billSubtotal - subtotalWithoutInventoryAccount;
    if (Math.abs(calculatedSubtotal - expectedSubtotal) > 0.01) {
        throw new Error(`Line totals (${calculatedSubtotal}) do not match bill subtotal (${billSubtotal}${subtotalWithoutInventoryAccount > 0 ? `, excluding ${subtotalWithoutInventoryAccount} from products without required accounts` : ''}). Please verify bill line amounts.`);
    }

    // Validate that subtotal + tax_total = total (with small tolerance for rounding)
    if (Math.abs((billSubtotal + billTaxTotal) - billTotal) > 0.01) {
        throw new Error(`Bill totals do not balance. Subtotal (${billSubtotal}) + Tax (${billTaxTotal}) should equal Total (${billTotal})`);
    }

    // Create GL journal lines - Debit lines for each product (to track product_id)
    const journalLines = [];
    const supplierId = bill.supplier_id; // supplier_id from ap_bills table saved to buyer_id
    
    // Check if we have any products with required accounts
    if (productLines.length === 0) {
        const productList = productsWithoutInventoryAccount.length > 0
            ? productsWithoutInventoryAccount.map(p => `"${p.name}" (Line ${p.lineNo})`).join(', ')
            : 'All products';
        throw new Error(
            `Cannot approve purchase bill: No products have a required account configured.\n\n` +
            `Products missing required account:\n${productList}\n\n` +
            `Please set the inventory account for goods or purchase account for services in the Product Master before approving the bill.`
        );
    }
    
    // If some products are missing required accounts, show warning but continue
    if (productsWithoutInventoryAccount.length > 0) {
        const productList = productsWithoutInventoryAccount.map(p => `"${p.name}" (Line ${p.lineNo})`).join(', ');
        console.warn(`Warning: The following products do not have required accounts and will be excluded from GL journal entries: ${productList}`);
    }
    
    // Add debit lines for each product
    for (const productLine of productLines) {
            journalLines.push({
            account_id: productLine.account_id,
            debit: productLine.amount,
            credit: 0,
            description: `${productLine.item_name} from Bill ${bill.bill_number}`,
            entity_type: 'SUPPLIER',
            entity_id: supplierId,
            buyer_id: supplierId,
            product_id: productLine.product_id,
            invoice_id: billId
            });
    }

    // Check if this is a reverse tax bill
    const isReverseTax = bill.is_reverse_tax === 1 || bill.is_reverse_tax === true;
    
    // Add VAT line if tax exists
    if (billTaxTotal > 0) {
        if (isReverseTax) {
            // Reverse tax: Buyer records both RC Input (debit) and RC Output (credit)
            // RC Input (account ID 20): Buyer records input tax (debit)
            const rcInputAccountId = await glService.getAccountByCode(conn, '20'); // RC Input (Reverse tax input)
            if (!rcInputAccountId) {
                throw new Error('RC Input account (account ID 20) not found. Please ensure the account exists for reverse tax bills.');
            }
            journalLines.push({
                account_id: rcInputAccountId,
                debit: billTaxTotal,
                credit: 0,
                description: `RC Input (Reverse Tax) from Bill ${bill.bill_number}`,
                entity_type: 'SUPPLIER',
                entity_id: supplierId,
                buyer_id: supplierId,
                invoice_id: billId
            });
            
            // RC Output (account ID 21): Buyer pays output tax (credit)
            const rcOutputAccountId = await glService.getAccountByCode(conn, '21'); // RC Output (Reverse Tax)
            if (!rcOutputAccountId) {
                throw new Error('RC Output account (account ID 21) not found. Please ensure the account exists for reverse tax bills.');
            }
            journalLines.push({
                account_id: rcOutputAccountId,
                debit: 0,
                credit: billTaxTotal,
                description: `RC Output (Reverse Tax) from Bill ${bill.bill_number}`,
                entity_type: 'SUPPLIER',
                entity_id: supplierId,
                buyer_id: supplierId,
                invoice_id: billId
            });
        } else {
            // Normal tax: Buyer receives input tax, debits Taxes account (account ID 7)
            const taxAccountId = await glService.getAccountByCode(conn, '7'); // Taxes (account ID 7)
            if (!taxAccountId) {
                throw new Error('Taxes account (account ID 7) not found. Please ensure the account exists.');
            }
            journalLines.push({
                account_id: taxAccountId,
                debit: billTaxTotal,
                credit: 0,
                description: `Tax Input from Bill ${bill.bill_number}`,
                entity_type: 'SUPPLIER',
                entity_id: supplierId,
                buyer_id: supplierId,
                invoice_id: billId
            });
        }
    }

    // Add Accounts Payable credit line
    // For reverse tax: Credit AP with subtotal (without tax)
    // For normal tax: Credit AP with total (subtotal + tax)
    const apCreditAmount = isReverseTax ? billSubtotal : billTotal;
    journalLines.push({
        account_id: apAccountId,
        debit: 0,
        credit: apCreditAmount,
        description: `Accounts Payable for Bill ${bill.bill_number}`,
        entity_type: 'SUPPLIER',
        entity_id: supplierId,
        buyer_id: supplierId,
        invoice_id: billId
    });

    // Verify journal balances (double-entry accounting)
    const totalDebits = journalLines.reduce((sum, line) => sum + parseFloat(line.debit || 0), 0);
    const totalCredits = journalLines.reduce((sum, line) => sum + parseFloat(line.credit || 0), 0);
    
    if (Math.abs(totalDebits - totalCredits) > 0.01) {
        throw new Error(`GL Journal is not balanced. Debits: ${totalDebits}, Credits: ${totalCredits}`);
    }

      // Calculate journal totals for currency fields
      // foreign_amount = bill total in bill's currency (e.g., USD)
      // exchange_rate = conversion rate from foreign currency to default currency
      // total_amount = foreign_amount * exchange_rate (converted to default currency)
      const journalForeignAmount = billTotal; // Bill total in bill's currency
      const journalTotalAmount = exchangeRate && exchangeRate > 0 
          ? journalForeignAmount * exchangeRate 
          : journalForeignAmount; // If no exchange rate, assume same currency

    await glService.createJournal(conn, {
        source_type: 'AP_BILL',
        source_id: billId,
        journal_date: bill.bill_date,
        memo: `Post Bill ${bill.bill_number}`,
        created_by: userId,
          currency_id: bill.currency_id || null,
          exchange_rate: exchangeRate,
          foreign_amount: journalForeignAmount,
          total_amount: journalTotalAmount,
          source_name: bill.bill_number,
          source_date: bill.bill_date,
          is_deleted: 0,
        lines: journalLines
    });

    // Note: Status update to APPROVED (1) is handled by the caller (approveBill function)
    // This ensures the status is only updated after all transactions are successfully created
    // and prevents duplicate postings
}

/**
 * Reverse posted AP Bill transactions (inventory and GL) - used for editing approved bills
 * This reverses transactions without changing the bill status
 */
async function reverseBillTransactions(conn, billId, userId) {
    // Get bill
    const [bills] = await conn.query(`
        SELECT * FROM ap_bills WHERE id = ?
    `, [billId]);

    if (bills.length === 0) {
        throw new Error('Bill not found');
    }

    const bill = bills[0];
    const isServiceBill = bill.is_service === 1 || bill.is_service === true;

    if (!isServiceBill) {
        // Get inventory transactions for this bill (only non-deleted)
        const [txns] = await conn.query(`
            SELECT * FROM inventory_transactions 
            WHERE source_type = 'AP_BILL' AND source_id = ?
            AND txn_type = 'PURCHASE_BILL_RECEIPT'
            AND (is_deleted = 0 OR is_deleted IS NULL)
        `, [billId]);

        // Reverse each transaction
        for (const txn of txns) {
            // Reverse stock (OUT movement to reduce stock)
            // Note: For reversals, we don't update currency_id/uom_id as stock already has it
            await inventoryService.updateInventoryStock(
                conn,
                txn.product_id,
                txn.warehouse_id,
                txn.batch_id,
                txn.qty,
                txn.unit_cost,
                false // isIn = false (OUT)
            );

            // Calculate reversal amounts
            const amount = parseFloat(txn.qty || 0) * parseFloat(txn.unit_cost || 0); // Transaction currency amount
            const aedAmount = txn.exchange_rate && parseFloat(txn.exchange_rate) > 0 
                ? amount * parseFloat(txn.exchange_rate)
                : amount; // AED converted amount

            // Create reversal transaction (preserve currency and exchange rate from original)
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
                unit_cost: txn.unit_cost,
                currency_id: txn.currency_id || null,
                exchange_rate: txn.exchange_rate || null,
                foreign_amount: amount, // Transaction currency amount
                total_amount: aedAmount, // AED converted amount
                uom_id: txn.uom_id || null
            });
        }
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
}

/**
 * Cancel posted AP Bill - creates reversal transactions and updates status
 */
async function cancelBill(conn, billId, userId) {
    // Reverse transactions first
    await reverseBillTransactions(conn, billId, userId);

    // Update bill status to REJECTED (2)
    await conn.query(`
        UPDATE ap_bills 
        SET status_id = 2, cancelled_at = NOW(), cancelled_by = ?
        WHERE id = ?
    `, [userId, billId]);
}

module.exports = {
    postBill,
    cancelBill,
    reverseBillTransactions
};

