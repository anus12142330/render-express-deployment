// server/migrations/backfill_entity_fields.cjs
// Script to backfill entity_type and entity_id for existing gl_journal_lines
const { pool } = require('../src/db/tx.cjs');

async function backfillEntityFields() {
    const conn = await pool.getConnection();
    
    try {
        console.log('Starting backfill of entity_type and entity_id for gl_journal_lines...\n');
        
        // Step 1: Find AR account lines missing entity fields
        console.log('Step 1: Finding AR account lines missing entity fields...');
        const [arLinesMissing] = await conn.query(`
            SELECT 
                gjl.id,
                gjl.journal_id,
                gjl.account_id,
                gjl.entity_type,
                gjl.entity_id,
                gjl.buyer_id,
                gj.source_type,
                gj.source_id
            FROM gl_journal_lines gjl
            INNER JOIN gl_journals gj ON gj.id = gjl.journal_id
            INNER JOIN acc_chart_accounts acc ON acc.id = gjl.account_id
            WHERE acc.account_type_id = 1  -- AR accounts
              AND (gjl.entity_type IS NULL OR gjl.entity_id IS NULL)
              AND (gj.is_deleted = 0 OR gj.is_deleted IS NULL)
        `);
        
        console.log(`Found ${arLinesMissing.length} AR lines missing entity fields\n`);
        
        let arUpdated = 0;
        for (const line of arLinesMissing) {
            let entityId = line.entity_id || line.buyer_id;
            
            // If still no entity_id, try to get from source document
            if (!entityId) {
                if (line.source_type === 'AR_INVOICE') {
                    const [invoices] = await conn.query(`
                        SELECT customer_id FROM ar_invoices WHERE id = ? LIMIT 1
                    `, [line.source_id]);
                    if (invoices.length > 0) {
                        entityId = invoices[0].customer_id;
                    }
                } else if (line.source_type === 'AR_RECEIPT') {
                    // Get from receipt allocations
                    const [receipts] = await conn.query(`
                        SELECT ra.invoice_id 
                        FROM ar_receipt_allocations ra
                        WHERE ra.receipt_id = ?
                        LIMIT 1
                    `, [line.source_id]);
                    if (receipts.length > 0 && receipts[0].invoice_id) {
                        const [invoices] = await conn.query(`
                            SELECT customer_id FROM ar_invoices WHERE id = ? LIMIT 1
                        `, [receipts[0].invoice_id]);
                        if (invoices.length > 0) {
                            entityId = invoices[0].customer_id;
                        }
                    }
                } else if (line.source_type === 'OPENING_BALANCE') {
                    // Opening balance - buyer_id should be set
                    entityId = line.buyer_id;
                }
            }
            
            if (entityId) {
                await conn.query(`
                    UPDATE gl_journal_lines
                    SET entity_type = 'CUSTOMER',
                        entity_id = ?
                    WHERE id = ?
                `, [entityId, line.id]);
                arUpdated++;
            } else {
                console.log(`⚠️  Warning: Could not determine customer_id for line ${line.id} (journal ${line.journal_id}, source: ${line.source_type}:${line.source_id})`);
            }
        }
        
        console.log(`✅ Updated ${arUpdated} AR lines with entity_type='CUSTOMER' and entity_id\n`);
        
        // Step 2: Find AP account lines missing entity fields
        console.log('Step 2: Finding AP account lines missing entity fields...');
        const [apLinesMissing] = await conn.query(`
            SELECT 
                gjl.id,
                gjl.journal_id,
                gjl.account_id,
                gjl.entity_type,
                gjl.entity_id,
                gjl.buyer_id,
                gjl.supplier_id,
                gj.source_type,
                gj.source_id
            FROM gl_journal_lines gjl
            INNER JOIN gl_journals gj ON gj.id = gjl.journal_id
            INNER JOIN acc_chart_accounts acc ON acc.id = gjl.account_id
            WHERE acc.account_type_id = 6  -- AP accounts
              AND (gjl.entity_type IS NULL OR gjl.entity_id IS NULL)
              AND (gj.is_deleted = 0 OR gj.is_deleted IS NULL)
        `);
        
        console.log(`Found ${apLinesMissing.length} AP lines missing entity fields\n`);
        
        let apUpdated = 0;
        for (const line of apLinesMissing) {
            let entityId = line.entity_id || line.buyer_id || line.supplier_id;
            
            // If still no entity_id, try to get from source document
            if (!entityId) {
                if (line.source_type === 'AP_BILL') {
                    const [bills] = await conn.query(`
                        SELECT supplier_id FROM ap_bills WHERE id = ? LIMIT 1
                    `, [line.source_id]);
                    if (bills.length > 0) {
                        entityId = bills[0].supplier_id;
                    }
                } else if (line.source_type === 'AP_PAYMENT') {
                    const [payments] = await conn.query(`
                        SELECT supplier_id FROM ap_payments WHERE id = ? LIMIT 1
                    `, [line.source_id]);
                    if (payments.length > 0) {
                        entityId = payments[0].supplier_id;
                    }
                } else if (line.source_type === 'OUTWARD_PAYMENT') {
                    // Get from payment party_id
                    const [payments] = await conn.query(`
                        SELECT party_id FROM tbl_payment WHERE id = ? LIMIT 1
                    `, [line.source_id]);
                    if (payments.length > 0) {
                        entityId = payments[0].party_id;
                    }
                } else if (line.source_type === 'OPENING_BALANCE') {
                    // Opening balance - buyer_id should be set
                    entityId = line.buyer_id;
                }
            }
            
            if (entityId) {
                await conn.query(`
                    UPDATE gl_journal_lines
                    SET entity_type = 'SUPPLIER',
                        entity_id = ?
                    WHERE id = ?
                `, [entityId, line.id]);
                apUpdated++;
            } else {
                console.log(`⚠️  Warning: Could not determine supplier_id for line ${line.id} (journal ${line.journal_id}, source: ${line.source_type}:${line.source_id})`);
            }
        }
        
        console.log(`✅ Updated ${apUpdated} AP lines with entity_type='SUPPLIER' and entity_id\n`);
        
        // Step 3: Update ALL lines in AR/AP transactions (not just AR/AP account lines)
        console.log('Step 3: Updating all lines in AR transactions...');
        const [arJournals] = await conn.query(`
            SELECT DISTINCT gj.id, gj.source_type, gj.source_id
            FROM gl_journals gj
            INNER JOIN gl_journal_lines gjl ON gjl.journal_id = gj.id
            INNER JOIN acc_chart_accounts acc ON acc.id = gjl.account_id
            WHERE acc.account_type_id = 1  -- AR accounts
              AND (gj.is_deleted = 0 OR gj.is_deleted IS NULL)
        `);
        
        let arTransactionLinesUpdated = 0;
        for (const journal of arJournals) {
            // Get entity_id from the AR line in this journal
            const [arLine] = await conn.query(`
                SELECT gjl.entity_id, gjl.entity_type
                FROM gl_journal_lines gjl
                INNER JOIN acc_chart_accounts acc ON acc.id = gjl.account_id
                WHERE gjl.journal_id = ?
                  AND acc.account_type_id = 1
                LIMIT 1
            `, [journal.id]);
            
            if (arLine.length > 0 && arLine[0].entity_id) {
                const entityId = arLine[0].entity_id;
                // Update all lines in this journal that don't have entity fields
                const [result] = await conn.query(`
                    UPDATE gl_journal_lines
                    SET entity_type = 'CUSTOMER',
                        entity_id = ?
                    WHERE journal_id = ?
                      AND (entity_type IS NULL OR entity_id IS NULL)
                `, [entityId, journal.id]);
                arTransactionLinesUpdated += result.affectedRows;
            }
        }
        console.log(`✅ Updated ${arTransactionLinesUpdated} additional lines in AR transactions\n`);
        
        // Step 4: Update ALL lines in AP transactions
        console.log('Step 4: Updating all lines in AP transactions...');
        const [apJournals] = await conn.query(`
            SELECT DISTINCT gj.id, gj.source_type, gj.source_id
            FROM gl_journals gj
            INNER JOIN gl_journal_lines gjl ON gjl.journal_id = gj.id
            INNER JOIN acc_chart_accounts acc ON acc.id = gjl.account_id
            WHERE acc.account_type_id = 6  -- AP accounts
              AND (gj.is_deleted = 0 OR gj.is_deleted IS NULL)
        `);
        
        let apTransactionLinesUpdated = 0;
        for (const journal of apJournals) {
            // Get entity_id from the AP line in this journal
            const [apLine] = await conn.query(`
                SELECT gjl.entity_id, gjl.entity_type
                FROM gl_journal_lines gjl
                INNER JOIN acc_chart_accounts acc ON acc.id = gjl.account_id
                WHERE gjl.journal_id = ?
                  AND acc.account_type_id = 6
                LIMIT 1
            `, [journal.id]);
            
            if (apLine.length > 0 && apLine[0].entity_id) {
                const entityId = apLine[0].entity_id;
                // Update all lines in this journal that don't have entity fields
                const [result] = await conn.query(`
                    UPDATE gl_journal_lines
                    SET entity_type = 'SUPPLIER',
                        entity_id = ?
                    WHERE journal_id = ?
                      AND (entity_type IS NULL OR entity_id IS NULL)
                `, [entityId, journal.id]);
                apTransactionLinesUpdated += result.affectedRows;
            }
        }
        console.log(`✅ Updated ${apTransactionLinesUpdated} additional lines in AP transactions\n`);
        
        // Step 5: Verify and report
        console.log('Step 3: Verifying results...');
        const [arStillMissing] = await conn.query(`
            SELECT COUNT(*) as count
            FROM gl_journal_lines gjl
            INNER JOIN gl_journals gj ON gj.id = gjl.journal_id
            INNER JOIN acc_chart_accounts acc ON acc.id = gjl.account_id
            WHERE acc.account_type_id = 1
              AND (gjl.entity_type IS NULL OR gjl.entity_id IS NULL)
              AND (gj.is_deleted = 0 OR gj.is_deleted IS NULL)
        `);
        
        const [apStillMissing] = await conn.query(`
            SELECT COUNT(*) as count
            FROM gl_journal_lines gjl
            INNER JOIN gl_journals gj ON gj.id = gjl.journal_id
            INNER JOIN acc_chart_accounts acc ON acc.id = gjl.account_id
            WHERE acc.account_type_id = 6
              AND (gjl.entity_type IS NULL OR gjl.entity_id IS NULL)
              AND (gj.is_deleted = 0 OR gj.is_deleted IS NULL)
        `);
        
        // Also check for any lines in AR/AP transactions that are still missing
        const [arTransactionLinesMissing] = await conn.query(`
            SELECT COUNT(*) as count
            FROM gl_journal_lines gjl
            INNER JOIN gl_journals gj ON gj.id = gjl.journal_id
            INNER JOIN gl_journal_lines ar_line ON ar_line.journal_id = gj.id
            INNER JOIN acc_chart_accounts ar_acc ON ar_acc.id = ar_line.account_id
            WHERE ar_acc.account_type_id = 1
              AND (gjl.entity_type IS NULL OR gjl.entity_id IS NULL)
              AND (gj.is_deleted = 0 OR gj.is_deleted IS NULL)
        `);
        
        const [apTransactionLinesMissing] = await conn.query(`
            SELECT COUNT(*) as count
            FROM gl_journal_lines gjl
            INNER JOIN gl_journals gj ON gj.id = gjl.journal_id
            INNER JOIN gl_journal_lines ap_line ON ap_line.journal_id = gj.id
            INNER JOIN acc_chart_accounts ap_acc ON ap_acc.id = ap_line.account_id
            WHERE ap_acc.account_type_id = 6
              AND (gjl.entity_type IS NULL OR gjl.entity_id IS NULL)
              AND (gj.is_deleted = 0 OR gj.is_deleted IS NULL)
        `);
        
        console.log(`\n📊 Summary:`);
        console.log(`   AR account lines updated: ${arUpdated}`);
        console.log(`   AP account lines updated: ${apUpdated}`);
        console.log(`   Additional AR transaction lines updated: ${arTransactionLinesUpdated}`);
        console.log(`   Additional AP transaction lines updated: ${apTransactionLinesUpdated}`);
        console.log(`   AR account lines still missing: ${arStillMissing[0].count}`);
        console.log(`   AP account lines still missing: ${apStillMissing[0].count}`);
        console.log(`   AR transaction lines still missing: ${arTransactionLinesMissing[0].count}`);
        console.log(`   AP transaction lines still missing: ${apTransactionLinesMissing[0].count}`);
        
        const totalMissing = arStillMissing[0].count + apStillMissing[0].count + 
                            arTransactionLinesMissing[0].count + apTransactionLinesMissing[0].count;
        
        if (totalMissing > 0) {
            console.log(`\n⚠️  Warning: Some lines could not be updated. They may need manual review.`);
        } else {
            console.log(`\n✅ All AR/AP journal lines (including all transaction lines) now have entity_type and entity_id set!`);
        }
        
    } catch (error) {
        console.error('\n❌ Backfill failed:', error.message);
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
}

// Run if called directly
if (require.main === module) {
    backfillEntityFields()
        .then(() => {
            console.log('\nBackfill script finished.');
            process.exit(0);
        })
        .catch((error) => {
            console.error('\nBackfill script failed:', error);
            process.exit(1);
        });
}

module.exports = { backfillEntityFields };
