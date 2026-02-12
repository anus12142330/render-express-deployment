// server/src/modules/ar/arInvoices.service.js
// AR Invoices service - uses unified inventory_stock_batches and inventory_transactions

const { tx } = require('../../db/tx.cjs');
const glService = require('../gl/gl.service.cjs');
const inventoryService = require('../inventory/inventory.service.cjs');
const { isInventoryMovementEnabled } = require('../../utils/inventoryHelper.cjs');

/**
 * Post AR Invoice - creates inventory transactions and GL journals
 */
async function postInvoice(conn, invoiceId, userId) {
    // Check if inventory movement is enabled
    const movementEnabled = await isInventoryMovementEnabled();
    if (!movementEnabled) {
        console.log('[AR Invoice] Inventory movement is disabled. Skipping inventory operations but allowing invoice posting.');
    }

    const [invoices] = await conn.query(`
        SELECT * FROM ar_invoices WHERE id = ? AND (status_id = 3 OR status_id = 8)
    `, [invoiceId]);

    if (invoices.length === 0) {
        throw new Error('Invoice not found or already posted');
    }

    const invoice = invoices[0];

    // Check if invoice was already posted before (has existing GL journals or inventory transactions)
    const [existingJournals] = await conn.query(`
        SELECT id FROM gl_journals 
        WHERE source_type = 'AR_INVOICE' AND source_id = ? 
        AND (is_deleted = 0 OR is_deleted IS NULL)
        LIMIT 1
    `, [invoiceId]);

    const [existingInventoryTxns] = await conn.query(`
        SELECT id FROM inventory_transactions 
        WHERE source_type = 'AR_INVOICE' AND source_id = ? 
        AND (is_deleted = 0 OR is_deleted IS NULL)
        LIMIT 1
    `, [invoiceId]);

    const wasAlreadyPosted = existingJournals.length > 0 || existingInventoryTxns.length > 0;

    // If invoice was already posted, reverse old entries
    if (wasAlreadyPosted && movementEnabled) {
        // 1. Get all old inventory transactions for this invoice
        const [oldInventoryTxns] = await conn.query(`
            SELECT * FROM inventory_transactions 
            WHERE source_type = 'AR_INVOICE' AND source_id = ? 
            AND (is_deleted = 0 OR is_deleted IS NULL)
        `, [invoiceId]);

        // 2. Reverse inventory stock changes (add back quantities)
        for (const oldTxn of oldInventoryTxns) {
            // Reverse the movement: if it was OUT, add back (isIn = true)
            const reverseIsIn = oldTxn.movement === 'OUT';
            if (reverseIsIn) {
                await inventoryService.updateInventoryStock(
                    conn,
                    oldTxn.product_id,
                    oldTxn.warehouse_id,
                    oldTxn.batch_id,
                    oldTxn.qty,
                    oldTxn.unit_cost,
                    true, // isIn = true (add back stock)
                    oldTxn.currency_id,
                    oldTxn.uom_id
                );
            }
        }

        // 3. Mark old inventory transactions as deleted
        await conn.query(`
            UPDATE inventory_transactions 
            SET is_deleted = 1 
            WHERE source_type = 'AR_INVOICE' AND source_id = ? 
            AND (is_deleted = 0 OR is_deleted IS NULL)
        `, [invoiceId]);

        // 4. Mark old GL journal entries as deleted
        await conn.query(`
            UPDATE gl_journals 
            SET is_deleted = 1 
            WHERE source_type = 'AR_INVOICE' AND source_id = ? 
            AND (is_deleted = 0 OR is_deleted IS NULL)
        `, [invoiceId]);
    }
    // Get invoice lines with product account information
    const [lines] = await conn.query(`
        SELECT 
            ail.*,
            p.sales_account_id,
            p.purchase_account_id,
            p.inventory_account_id,
            p.item_type,
            p.item_id
        FROM ar_invoice_lines ail
        LEFT JOIN products p ON p.id = ail.product_id
        WHERE ail.invoice_id = ? 
        ORDER BY ail.line_no
    `, [invoiceId]);

    // Get currency exchange rate if currency_id exists (check if ar_invoices has currency_id)
    let exchangeRate = null;
    let invoiceCurrencyId = null;
    if (invoice.currency_id) {
        invoiceCurrencyId = invoice.currency_id;
        const [currencyRows] = await conn.query(`
            SELECT conversion_rate FROM currency WHERE id = ?
        `, [invoice.currency_id]);
        if (currencyRows.length > 0) {
            exchangeRate = parseFloat(currencyRows[0].conversion_rate) || 1;
        }
    }

    let totalCOGS = 0;
    // Store product COGS and account information for GL journal lines
    const productCOGS = {};
    const productSalesAccounts = {}; // Track sales accounts per product
    const productInventoryAccounts = {}; // Track inventory accounts per product
    const productPurchaseAccounts = {}; // Track purchase/COGS accounts per product

    for (const line of lines) {
        if (!line.product_id) continue;
        const isServiceLine = String(line.item_type || '').toLowerCase() === 'service' || Number(line.item_id) === 1;

        // Validate that product has required accounts
        if (!line.sales_account_id) {
            throw new Error(`Product "${line.item_name}" (Line ${line.line_no}) does not have a sales_account_id. Please set the sales account for this product.`);
        }
        if (!isServiceLine) {
            if (!line.inventory_account_id) {
                throw new Error(`Product "${line.item_name}" (Line ${line.line_no}) does not have an inventory_account_id. Please set the inventory account for this product.`);
            }
            if (!line.purchase_account_id) {
                throw new Error(`Product "${line.item_name}" (Line ${line.line_no}) does not have a purchase_account_id. Please set the purchase account for this product.`);
            }
        }

        if (isServiceLine) {
            continue;
        }

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

        // Only validate batch stock if inventory movement is enabled
        if (movementEnabled) {
            await inventoryService.validateBatchStock(conn, batchAllocs.map(a => ({
                batch_id: a.batch_id,
                quantity: a.quantity,
                product_id: line.product_id
            })), invoice.warehouse_id);
        }

        // Initialize product COGS and account tracking
        if (!productCOGS[line.product_id]) {
            productCOGS[line.product_id] = { amount: 0, item_name: line.item_name };
            productSalesAccounts[line.product_id] = line.sales_account_id;
            productInventoryAccounts[line.product_id] = line.inventory_account_id;
            productPurchaseAccounts[line.product_id] = line.purchase_account_id;
        }

        for (const alloc of batchAllocs) {
            // Only check stock if inventory movement is enabled
            let stock = null;
            if (movementEnabled) {
                const [stockRows] = await conn.query(`
                    SELECT qty_on_hand, unit_cost, currency_id, uom_id
                    FROM inventory_stock_batches 
                    WHERE batch_id = ? AND warehouse_id = ? AND product_id = ?
                `, [alloc.batch_id, invoice.warehouse_id, line.product_id]);

                if (stockRows.length === 0) {
                    throw new Error(`Batch ${alloc.batch_id} not found in warehouse ${invoice.warehouse_id}`);
                }

                stock = stockRows[0];
            } else {
                // If inventory is disabled, use default values from allocation
                stock = {
                    qty_on_hand: 0,
                    unit_cost: parseFloat(alloc.unit_cost || 0),
                    currency_id: invoiceCurrencyId || null,
                    uom_id: line.uom_id || null
                };
            }
            const qtyOut = parseFloat(alloc.quantity);
            // Purchase unit cost for inventory stock updates and COGS calculations
            const purchaseUnitCost = parseFloat(alloc.unit_cost || stock.unit_cost);
            // Sales unit price from invoice line (for inventory_transactions table)
            const salesUnitPrice = parseFloat(line.rate || 0);
            
            // Use invoice currency if available, otherwise use stock currency
            const txnCurrencyId = invoiceCurrencyId || stock.currency_id;
            // Use line uom_id if available, otherwise use stock uom_id
            const txnUomId = line.uom_id || stock.uom_id;
            
            // Calculate COGS amount using purchase cost
            const cogsAmount = qtyOut * purchaseUnitCost;
            
            // Calculate sales amount using sales price (for transaction record)
            const salesAmount = qtyOut * salesUnitPrice; // Transaction currency amount
            const salesAedAmount = exchangeRate && exchangeRate > 0 ? salesAmount * exchangeRate : salesAmount; // AED converted amount

            // Only update inventory if movement is enabled
            if (movementEnabled) {
                await inventoryService.updateInventoryStock(
                    conn,
                    line.product_id,
                    invoice.warehouse_id,
                    alloc.batch_id,
                    qtyOut,
                    purchaseUnitCost, // Use purchase cost for inventory stock
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
                    unit_cost: salesUnitPrice, // Save sales unit price in inventory_transactions
                    currency_id: txnCurrencyId,
                    exchange_rate: exchangeRate,
                    foreign_amount: salesAmount, // Transaction currency amount
                    total_amount: salesAedAmount, // AED converted amount
                    uom_id: txnUomId
                });
            }

            // COGS uses purchase cost (always calculate for GL, even if inventory is disabled)
            totalCOGS += cogsAmount;
            productCOGS[line.product_id].amount += cogsAmount;

            await conn.query(`
                UPDATE ar_invoice_line_batches 
                SET unit_cost = ? 
                WHERE id = ?
            `, [purchaseUnitCost, alloc.id]); // Keep purchase cost in batch allocation
        }
    }

    // Get Accounts Receivable account ID (should be account ID 1 based on your data)
    const arAccountId = await glService.getAccountByCode(conn, '1'); // Accounts Receivable (A/R)
    if (!arAccountId) {
        throw new Error('Accounts Receivable account not found in Chart of Accounts. Please ensure account ID 1 exists.');
    }

    // Get VAT Output account ID (should be account ID 7 based on your data)
    const vatOutputAccountId = await glService.getAccountByCode(conn, '7'); // Taxes Payable (VAT/GST)
    
    // Get Discount account ID (account ID 19 based on your data)
    const discountAccountId = await glService.getAccountByCode(conn, '19'); // Sales Discount
    
    const customerId = invoice.customer_id; // customer_id saved to buyer_id
    
    // Group sales revenue by product's sales_account_id
    const salesAccountTotals = {};
    const salesAccountNames = {};
    let totalLineTotals = 0;
    
    // Calculate sales revenue per product line and sum total
    for (const line of lines) {
        if (!line.product_id || !line.sales_account_id) continue;
        
        const lineTotal = parseFloat(line.line_total || 0);
        if (lineTotal <= 0) continue;
        
        totalLineTotals += lineTotal;
        
        if (!salesAccountTotals[line.sales_account_id]) {
            salesAccountTotals[line.sales_account_id] = 0;
            // Get account name for description
            const [accountRows] = await conn.query(`
                SELECT name FROM acc_chart_accounts WHERE id = ?
            `, [line.sales_account_id]);
            salesAccountNames[line.sales_account_id] = accountRows.length > 0 ? accountRows[0].name : `Account ${line.sales_account_id}`;
        }
        
        salesAccountTotals[line.sales_account_id] += lineTotal;
    }
    
    // Use invoice subtotal instead of sum of line totals to avoid rounding issues
    // Distribute the invoice subtotal proportionally across sales accounts
    const invoiceSubtotal = parseFloat(invoice.subtotal || 0);
    if (totalLineTotals > 0 && invoiceSubtotal > 0 && Math.abs(totalLineTotals - invoiceSubtotal) > 0.01) {
        // There's a rounding difference - distribute invoice subtotal proportionally
        const adjustmentRatio = invoiceSubtotal / totalLineTotals;
        let adjustedTotal = 0;
        const accountIds = Object.keys(salesAccountTotals);
        
        // Adjust each account proportionally, except the last one
        for (let i = 0; i < accountIds.length - 1; i++) {
            const accountId = accountIds[i];
            const adjustedAmount = salesAccountTotals[accountId] * adjustmentRatio;
            salesAccountTotals[accountId] = Math.round(adjustedAmount * 100) / 100; // Round to 2 decimals
            adjustedTotal += salesAccountTotals[accountId];
        }
        
        // Last account gets the remainder to ensure exact match with invoice subtotal
        if (accountIds.length > 0) {
            const lastAccountId = accountIds[accountIds.length - 1];
            salesAccountTotals[lastAccountId] = Math.round((invoiceSubtotal - adjustedTotal) * 100) / 100;
        }
    }
    // If totals match (within tolerance), use the calculated totals as-is
    
    const invoiceTotal = parseFloat(invoice.total);
    const invoiceTaxTotal = parseFloat(invoice.tax_total || 0);
    
    const journalLines = [
        {
            account_id: arAccountId,
            debit: invoiceTotal, // Total amount customer owes (subtotal + tax)
            credit: 0,
            description: `Accounts Receivable for Invoice ${invoice.invoice_number}`,
            entity_type: 'CUSTOMER',
            entity_id: customerId,
            buyer_id: customerId,
            invoice_id: invoiceId
        }
    ];

    // Add sales revenue lines per product's sales_account_id
    let totalSalesRevenue = 0;
    for (const [accountId, amount] of Object.entries(salesAccountTotals)) {
        if (amount > 0) {
            const roundedAmount = Math.round(amount * 100) / 100; // Round to 2 decimals
            totalSalesRevenue += roundedAmount;
            journalLines.push({
                account_id: parseInt(accountId),
                debit: 0,
                credit: roundedAmount,
                description: `Sales Revenue (${salesAccountNames[accountId]}) from Invoice ${invoice.invoice_number}`,
                entity_type: 'CUSTOMER',
                entity_id: customerId,
                buyer_id: customerId,
                invoice_id: invoiceId
            });
        }
    }
    
    // Ensure sales revenue matches invoice subtotal exactly (handle rounding differences)
    const difference = Math.round((invoiceSubtotal - totalSalesRevenue) * 100) / 100;
    if (Math.abs(difference) > 0.01) {
        // There's a rounding difference - adjust the largest sales account
        const accountIds = Object.keys(salesAccountTotals);
        if (accountIds.length > 0) {
            // Find the largest account and adjust it
            let largestAccountId = accountIds[0];
            let largestAmount = salesAccountTotals[accountIds[0]];
            for (const accountId of accountIds) {
                if (salesAccountTotals[accountId] > largestAmount) {
                    largestAmount = salesAccountTotals[accountId];
                    largestAccountId = accountId;
                }
            }
            
            // Update the last journal line (which should be the largest account) with adjusted amount
            const lastLineIndex = journalLines.length - 1;
            if (lastLineIndex >= 0 && journalLines[lastLineIndex].account_id === parseInt(largestAccountId)) {
                journalLines[lastLineIndex].credit = Math.round((journalLines[lastLineIndex].credit + difference) * 100) / 100;
            }
        }
    }

    // Add Discount line if discount exists
    const discountAmount = parseFloat(invoice.discount_amount || 0);
    if (discountAmount > 0 && discountAccountId) {
        journalLines.push({
            account_id: discountAccountId,
            debit: discountAmount,
            credit: 0,
            description: `Sales Discount from Invoice ${invoice.invoice_number}`,
            entity_type: 'CUSTOMER',
            entity_id: customerId,
            buyer_id: customerId,
            invoice_id: invoiceId
        });
    }

    // Add VAT line if tax exists (always VAT Output for customer invoices)
    if (invoiceTaxTotal > 0) {
        if (!vatOutputAccountId) {
            throw new Error('VAT Output account (account code 7) not found. Please ensure the account exists.');
        }
        journalLines.push({
            account_id: vatOutputAccountId,
            debit: 0,
            credit: invoiceTaxTotal,
            description: `VAT Output from Invoice ${invoice.invoice_number}`,
            entity_type: 'CUSTOMER',
            entity_id: customerId,
            buyer_id: customerId,
            invoice_id: invoiceId
        });
    }

    // Create COGS and Inventory reduction lines per product using product's purchase_account_id and inventory_account_id
    if (totalCOGS > 0) {
        // Create journal lines per product (using productCOGS calculated above)
        for (const [productId, cogsData] of Object.entries(productCOGS)) {
            if (cogsData.amount > 0) {
                const purchaseAccountId = productPurchaseAccounts[productId];
                const inventoryAccountId = productInventoryAccounts[productId];
                
                if (!purchaseAccountId) {
                    throw new Error(`Product "${cogsData.item_name}" does not have a purchase_account_id. Cannot post COGS.`);
                }
                if (!inventoryAccountId) {
                    throw new Error(`Product "${cogsData.item_name}" does not have an inventory_account_id. Cannot post inventory reduction.`);
                }
                
                journalLines.push({
                    account_id: purchaseAccountId,
                    debit: cogsData.amount,
                    credit: 0,
                    description: `COGS for ${cogsData.item_name} from Invoice ${invoice.invoice_number}`,
                    entity_type: 'CUSTOMER',
                    entity_id: customerId,
                    buyer_id: customerId,
                    product_id: parseInt(productId),
                    invoice_id: invoiceId
                });
                journalLines.push({
                    account_id: inventoryAccountId,
                    debit: 0,
                    credit: cogsData.amount,
                    description: `Inventory reduction for ${cogsData.item_name} from Invoice ${invoice.invoice_number}`,
                    entity_type: 'CUSTOMER',
                    entity_id: customerId,
                    buyer_id: customerId,
                    product_id: parseInt(productId),
                    invoice_id: invoiceId
                });
            }
        }
    }

     // Calculate journal totals for currency fields
     const journalTotalDebits = journalLines.reduce((sum, line) => sum + parseFloat(line.debit || 0), 0);
     const journalTotalAmount = journalTotalDebits; // Use debits as total (should equal credits)
     const journalForeignAmount = exchangeRate && exchangeRate > 0 ? journalTotalAmount / exchangeRate : null;

    await glService.createJournal(conn, {
        source_type: 'AR_INVOICE',
        source_id: invoiceId,
        journal_date: invoice.invoice_date,
        memo: `Post Invoice ${invoice.invoice_number}`,
        created_by: userId,
         currency_id: invoiceCurrencyId || null,
         exchange_rate: exchangeRate,
         foreign_amount: journalForeignAmount,
         total_amount: journalTotalAmount,
         source_name: invoice.invoice_number,
         source_date: invoice.invoice_date,
         is_deleted: 0,
        lines: journalLines
    });

    // Note: Status update to APPROVED (1) is handled by the caller (approveInvoice function)
    // This ensures the status is only updated after all transactions are successfully created
    // and prevents duplicate postings
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
        AND (is_deleted = 0 OR is_deleted IS NULL)
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

        // Calculate reversal amounts
        const amount = parseFloat(txn.qty || 0) * parseFloat(txn.unit_cost || 0); // Transaction currency amount
        const aedAmount = txn.exchange_rate && parseFloat(txn.exchange_rate) > 0 
            ? amount * parseFloat(txn.exchange_rate)
            : amount; // AED converted amount

        // Create reversal transaction (preserve currency and exchange rate from original)
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
            unit_cost: txn.unit_cost,
            currency_id: txn.currency_id || null,
            exchange_rate: txn.exchange_rate || null,
            foreign_amount: amount, // Transaction currency amount
            total_amount: aedAmount, // AED converted amount
            uom_id: txn.uom_id || null
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

