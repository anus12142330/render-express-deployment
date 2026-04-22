/**
 * Post approved AR credit note: inventory returns (IN) + GL journal (reversal pattern vs invoice).
 */
const glService = require('../gl/gl.service.cjs');
const inventoryService = require('../inventory/inventory.service.cjs');
const { isInventoryMovementEnabled } = require('../../utils/inventoryHelper.cjs');

async function postCreditNote(conn, creditNoteId, userId) {
    const movementEnabledFlag = await isInventoryMovementEnabled();

    const [cnRows] = await conn.query(`SELECT * FROM ar_credit_notes WHERE id = ?`, [creditNoteId]);
    const cn = cnRows[0];
    if (!cn) {
        throw new Error('Credit note not found');
    }

    // Credit notes generated from Cargo Returns should NOT post inventory here.
    // Inventory is handled by the Cargo Return flow (QC finalize / discard path),
    // and posting again here would duplicate inventory transactions.
    const isCargoReturnCreditNote = String(cn.subject || '').toLowerCase().includes('cargo return');
    const movementEnabled = movementEnabledFlag && !isCargoReturnCreditNote;

    const [existingJournals] = await conn.query(
        `SELECT id FROM gl_journals
         WHERE source_type = 'AR_CREDIT_NOTE' AND source_id = ?
         AND (is_deleted = 0 OR is_deleted IS NULL)
         LIMIT 1`,
        [creditNoteId]
    );
    if (existingJournals.length > 0) {
        throw new Error('Credit note already posted');
    }

    const [lines] = await conn.query(
        `SELECT cnl.*,
                p.sales_account_id,
                p.purchase_account_id,
                p.inventory_account_id,
                p.item_type,
                p.item_id
         FROM ar_credit_note_lines cnl
         LEFT JOIN products p ON p.id = cnl.product_id
         WHERE cnl.credit_note_id = ?
         ORDER BY cnl.line_no`,
        [creditNoteId]
    );

    let exchangeRate = 1;
    let invoiceCurrencyId = null;
    if (cn.currency_id) {
        invoiceCurrencyId = cn.currency_id;
        const [currencyRows] = await conn.query(`SELECT conversion_rate FROM currency WHERE id = ?`, [cn.currency_id]);
        if (currencyRows.length > 0) {
            exchangeRate = parseFloat(currencyRows[0].conversion_rate) || 1;
        }
    }

    const productCOGS = {};
    const productPurchaseAccounts = {};
    const productInventoryAccounts = {};
    const customerId = cn.customer_id;
    const warehouseId = cn.warehouse_id;

    const needsInventoryReturn = lines.some((line) => {
        if (!line.product_id) return false;
        const isServiceLine =
            String(line.item_type || '').toLowerCase() === 'service' || Number(line.item_id) === 1;
        return !isServiceLine;
    });
    if (movementEnabled && needsInventoryReturn && !warehouseId) {
        throw new Error('Credit note must have warehouse_id to return inventory for product lines');
    }

    for (const line of lines) {
        if (!line.product_id) continue;
        const isServiceLine =
            String(line.item_type || '').toLowerCase() === 'service' || Number(line.item_id) === 1;
        if (isServiceLine) continue;

        if (movementEnabled && !line.ar_invoice_line_id) {
            throw new Error(
                `Line "${line.item_name || line.line_no}" has no linked invoice line; cannot return stock.`
            );
        }

        if (!movementEnabled) {
            // Skip inventory posting; GL posting still happens below.
            if (!line.sales_account_id) {
                throw new Error(`Product "${line.item_name}" has no sales_account_id.`);
            }
            if (!productCOGS[line.product_id]) {
                productCOGS[line.product_id] = { amount: 0, item_name: line.item_name };
                productPurchaseAccounts[line.product_id] = line.purchase_account_id;
                productInventoryAccounts[line.product_id] = line.inventory_account_id;
            }
            continue;
        }

        const [invLineRows] = await conn.query(`SELECT id, quantity FROM ar_invoice_lines WHERE id = ?`, [
            line.ar_invoice_line_id
        ]);
        const invLine = invLineRows[0];
        if (!invLine) {
            throw new Error(`Invoice line ${line.ar_invoice_line_id} not found for credit note line.`);
        }

        const invQty = parseFloat(invLine.quantity) || 0;
        const cnQty = parseFloat(line.quantity) || 0;
        if (invQty <= 0 || cnQty <= 0) continue;

        const factor = Math.min(1, cnQty / invQty);

        const [batchAllocs] = await conn.query(`SELECT * FROM ar_invoice_line_batches WHERE invoice_line_id = ?`, [
            line.ar_invoice_line_id
        ]);
        if (!batchAllocs || batchAllocs.length === 0) {
            throw new Error(
                `No batch allocations on source invoice line for "${line.item_name}". Post the source invoice first.`
            );
        }

        if (!line.sales_account_id) {
            throw new Error(`Product "${line.item_name}" has no sales_account_id.`);
        }
        if (!line.inventory_account_id || !line.purchase_account_id) {
            throw new Error(`Product "${line.item_name}" needs inventory and purchase (COGS) accounts.`);
        }

        if (!productCOGS[line.product_id]) {
            productCOGS[line.product_id] = { amount: 0, item_name: line.item_name };
            productPurchaseAccounts[line.product_id] = line.purchase_account_id;
            productInventoryAccounts[line.product_id] = line.inventory_account_id;
        }

        for (const alloc of batchAllocs) {
            const returnQty = Math.round(parseFloat(alloc.quantity) * factor * 10000) / 10000;
            if (returnQty <= 0) continue;

            const purchaseUnitCost = parseFloat(alloc.unit_cost || 0);
            const salesUnitPrice = parseFloat(line.rate || 0);
            const salesAmount = returnQty * salesUnitPrice;
            const salesAedAmount =
                exchangeRate && exchangeRate > 0 ? salesAmount * exchangeRate : salesAmount;
            const cogsAmount = returnQty * purchaseUnitCost;

            if (movementEnabled) {
                await inventoryService.updateInventoryStock(
                    conn,
                    line.product_id,
                    warehouseId,
                    alloc.batch_id,
                    returnQty,
                    purchaseUnitCost,
                    true,
                    invoiceCurrencyId,
                    line.uom_id || null
                );
            }

            await inventoryService.insertInventoryTransaction(conn, {
                txn_date: cn.credit_note_date,
                movement: 'IN',
                txn_type: 'AR_CREDIT_NOTE_RETURN',
                source_type: 'AR_CREDIT_NOTE',
                source_id: creditNoteId,
                source_line_id: line.id,
                product_id: line.product_id,
                warehouse_id: warehouseId,
                batch_id: alloc.batch_id,
                qty: returnQty,
                unit_cost: salesUnitPrice,
                currency_id: invoiceCurrencyId,
                exchange_rate: exchangeRate,
                foreign_amount: salesAmount,
                total_amount: salesAedAmount,
                uom_id: line.uom_id || null,
                movement_type_id: 1
            });

            productCOGS[line.product_id].amount += cogsAmount;
        }
    }

    const arAccountId = await glService.getAccountByCode(conn, '1');
    if (!arAccountId) {
        throw new Error('Accounts Receivable account (code 1) not found.');
    }
    const vatOutputAccountId = await glService.getAccountByCode(conn, '7');
    const discountAccountId = await glService.getAccountByCode(conn, '19');

    const salesAccountTotals = {};
    const salesAccountNames = {};
    let totalLineTotals = 0;

    for (const line of lines) {
        if (!line.sales_account_id) continue;
        const lineTotal = parseFloat(line.line_total || 0);
        if (lineTotal <= 0) continue;
        totalLineTotals += lineTotal;
        const sa = line.sales_account_id;
        if (!salesAccountTotals[sa]) {
            salesAccountTotals[sa] = 0;
            const [accountRows] = await conn.query(`SELECT name FROM acc_chart_accounts WHERE id = ?`, [sa]);
            salesAccountNames[sa] = accountRows.length ? accountRows[0].name : `Account ${sa}`;
        }
        salesAccountTotals[sa] += lineTotal;
    }

    const invoiceTotal = parseFloat(cn.total);
    const invoiceTaxTotal = parseFloat(cn.tax_total || 0);
    const discountAmount = parseFloat(cn.discount_amount || 0);
    const targetRevenue = Math.round((invoiceTotal + discountAmount - invoiceTaxTotal) * 100) / 100;

    if (targetRevenue > 0.01 && Object.keys(salesAccountTotals).length === 0) {
        throw new Error('Cannot post credit note: lines need sales_account_id on products (or service items) for GL revenue.');
    }

    if (totalLineTotals > 0 && targetRevenue > 0 && Math.abs(totalLineTotals - targetRevenue) > 0.01) {
        const adjustmentRatio = targetRevenue / totalLineTotals;
        let adjustedTotal = 0;
        const accountIds = Object.keys(salesAccountTotals);
        for (let i = 0; i < accountIds.length - 1; i++) {
            const accountId = accountIds[i];
            const adjustedAmount = salesAccountTotals[accountId] * adjustmentRatio;
            salesAccountTotals[accountId] = Math.round(adjustedAmount * 100) / 100;
            adjustedTotal += salesAccountTotals[accountId];
        }
        if (accountIds.length > 0) {
            const lastAccountId = accountIds[accountIds.length - 1];
            salesAccountTotals[lastAccountId] = Math.round((targetRevenue - adjustedTotal) * 100) / 100;
        }
    }

    const journalLines = [
        {
            account_id: arAccountId,
            debit: 0,
            credit: invoiceTotal,
            description: `A/R — Credit note ${cn.credit_note_number}`,
            entity_type: 'CUSTOMER',
            entity_id: customerId,
            buyer_id: customerId,
            invoice_id: cn.ar_invoice_id || null
        }
    ];

    let totalSalesRevenue = 0;
    for (const [accountId, amount] of Object.entries(salesAccountTotals)) {
        if (amount > 0) {
            const roundedAmount = Math.round(amount * 100) / 100;
            totalSalesRevenue += roundedAmount;
            journalLines.push({
                account_id: parseInt(accountId, 10),
                debit: roundedAmount,
                credit: 0,
                description: `Sales reversal — CN ${cn.credit_note_number} (${salesAccountNames[accountId]})`,
                entity_type: 'CUSTOMER',
                entity_id: customerId,
                buyer_id: customerId,
                invoice_id: cn.ar_invoice_id || null
            });
        }
    }

    const difference = Math.round((targetRevenue - totalSalesRevenue) * 100) / 100;
    if (Math.abs(difference) > 0.01 && journalLines.length > 1) {
        const accountIds = Object.keys(salesAccountTotals);
        if (accountIds.length > 0) {
            let largestAccountId = accountIds[0];
            let largestAmount = salesAccountTotals[accountIds[0]];
            for (const accountId of accountIds) {
                if (salesAccountTotals[accountId] > largestAmount) {
                    largestAmount = salesAccountTotals[accountId];
                    largestAccountId = accountId;
                }
            }
            const idx = journalLines.findIndex((l) => l.account_id === parseInt(largestAccountId, 10) && l.debit > 0);
            if (idx >= 0) {
                journalLines[idx].debit = Math.round((journalLines[idx].debit + difference) * 100) / 100;
            }
        }
    }

    if (discountAmount > 0) {
        if (!discountAccountId) {
            throw new Error('Sales Discount account (code 19) not found.');
        }
        journalLines.push({
            account_id: discountAccountId,
            debit: 0,
            credit: discountAmount,
            description: `Discount reversal — CN ${cn.credit_note_number}`,
            entity_type: 'CUSTOMER',
            entity_id: customerId,
            buyer_id: customerId,
            invoice_id: cn.ar_invoice_id || null
        });
    }

    if (invoiceTaxTotal > 0) {
        if (!vatOutputAccountId) {
            throw new Error('VAT Output account (code 7) not found.');
        }
        journalLines.push({
            account_id: vatOutputAccountId,
            debit: invoiceTaxTotal,
            credit: 0,
            description: `VAT output reversal — CN ${cn.credit_note_number}`,
            entity_type: 'CUSTOMER',
            entity_id: customerId,
            buyer_id: customerId,
            invoice_id: cn.ar_invoice_id || null
        });
    }

    for (const [productId, cogsData] of Object.entries(productCOGS)) {
        if (cogsData.amount > 0) {
            const purchaseAccountId = productPurchaseAccounts[productId];
            const inventoryAccountId = productInventoryAccounts[productId];
            const amt = Math.round(cogsData.amount * 100) / 100;
            journalLines.push({
                account_id: inventoryAccountId,
                debit: amt,
                credit: 0,
                description: `Inventory return — ${cogsData.item_name} (CN ${cn.credit_note_number})`,
                entity_type: 'CUSTOMER',
                entity_id: customerId,
                buyer_id: customerId,
                product_id: parseInt(productId, 10),
                invoice_id: cn.ar_invoice_id || null
            });
            journalLines.push({
                account_id: purchaseAccountId,
                debit: 0,
                credit: amt,
                description: `COGS reversal — ${cogsData.item_name} (CN ${cn.credit_note_number})`,
                entity_type: 'CUSTOMER',
                entity_id: customerId,
                buyer_id: customerId,
                product_id: parseInt(productId, 10),
                invoice_id: cn.ar_invoice_id || null
            });
        }
    }

    const journalTotalDebits = journalLines.reduce((sum, line) => sum + parseFloat(line.debit || 0), 0);
    const journalTotalCredits = journalLines.reduce((sum, line) => sum + parseFloat(line.credit || 0), 0);
    if (Math.abs(journalTotalDebits - journalTotalCredits) > 0.05) {
        throw new Error(
            `Credit note journal not balanced (Dr ${journalTotalDebits.toFixed(2)} vs Cr ${journalTotalCredits.toFixed(2)}).`
        );
    }

    const journalForeignAmount =
        exchangeRate && exchangeRate > 0 ? journalTotalDebits / exchangeRate : journalTotalDebits;

    await glService.createJournal(conn, {
        source_type: 'AR_CREDIT_NOTE',
        source_id: creditNoteId,
        journal_date: cn.credit_note_date,
        memo: `Post credit note ${cn.credit_note_number}`,
        created_by: userId,
        currency_id: invoiceCurrencyId || null,
        exchange_rate: exchangeRate,
        foreign_amount: journalForeignAmount,
        total_amount: journalTotalDebits,
        source_name: cn.credit_note_number,
        source_date: cn.credit_note_date,
        is_deleted: 0,
        lines: journalLines
    });
}

module.exports = { postCreditNote };
