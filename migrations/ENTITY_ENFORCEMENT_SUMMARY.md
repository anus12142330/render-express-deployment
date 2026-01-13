# Entity Enforcement - Complete Summary

## ✅ Status: COMPLETE

All AR/AP journal lines now have `entity_type` and `entity_id` properly set.

## What Was Done

### 1. Application-Level Enforcement
All posting services now set `entity_type` and `entity_id` correctly:

#### AR (Accounts Receivable) Services:
- **AR Invoices** (`arInvoices.service.cjs`)
  - `entity_type: 'CUSTOMER'`
  - `entity_id: customerId`
  
- **AR Receipts** (`arReceipts.service.cjs`)
  - `entity_type: 'CUSTOMER'`
  - `entity_id: buyerId` (from invoice customer_id)

#### AP (Accounts Payable) Services:
- **AP Bills** (`apBills.service.cjs`)
  - `entity_type: 'SUPPLIER'`
  - `entity_id: supplierId`
  
- **AP Payments** (`apPayments.service.cjs`)
  - `entity_type: 'SUPPLIER'`
  - `entity_id: supplierId`
  
- **Outward Payments** (`outwardPayments.js`)
  - `entity_type: 'SUPPLIER'`
  - `entity_id: payment.party_id`

#### Opening Balance:
- Customer lines: `entity_type: 'CUSTOMER'`, `entity_id: line.party_id`
- Supplier lines: `entity_type: 'SUPPLIER'`, `entity_id: line.party_id`

### 2. Database-Level Enforcement
- **Triggers Created:**
  - `trg_gl_journal_lines_validate_entity_insert` - Validates on INSERT
  - `trg_gl_journal_lines_validate_entity_update` - Validates on UPDATE

- **Validation Rules:**
  - AR accounts (account_type_id=1) → Must have `entity_type='CUSTOMER'` and `entity_id`
  - AP accounts (account_type_id=6) → Must have `entity_type='SUPPLIER'` and `entity_id`
  - Rejects invalid or missing entity fields with clear error messages

### 3. Historical Data Backfill
- **Backfill Script:** `backfill_entity_fields.cjs`
- **Results:** Updated 2 AR lines that were missing entity fields
- **Status:** All existing AR/AP journal lines now have entity fields set

## Entity Field Mapping

### For AR (Accounts Receivable):
```
entity_type = 'CUSTOMER'
entity_id = customer_id (from ar_invoices.customer_id)
```

### For AP (Accounts Payable):
```
entity_type = 'SUPPLIER'
entity_id = supplier_id (from ap_bills.supplier_id or ap_payments.supplier_id)
```

## Validation Flow

1. **Application Layer** (`gl.service.cjs`):
   - Validates entity requirements before inserting journal lines
   - Uses `ledgerEntityHelper.validateEntityRequired()`

2. **Database Layer** (Triggers):
   - Validates entity requirements on INSERT/UPDATE
   - Prevents invalid data even if application validation is bypassed

## Helper Functions

### `ledgerEntityHelper.cjs`:
- `isEntityRequired(conn, account_id)` - Check if account requires entity
- `validateEntityRequired(conn, line)` - Validate entity fields
- `getExpectedEntityType(conn, account_id)` - Get expected entity type

### `ledgerBalanceQueries.cjs`:
- `getCustomerBalance(conn, customerId)` - Get customer ledger balance
- `getSupplierBalance(conn, supplierId)` - Get supplier ledger balance
- `getCustomerOutstanding(conn, customerId)` - Customer outstanding amount
- `getSupplierPayable(conn, supplierId)` - Supplier payable amount

## Testing

### Test Entity Enforcement:
```sql
-- This should FAIL (AR account without entity)
INSERT INTO gl_journal_lines 
(journal_id, line_no, account_id, debit, credit, entity_type, entity_id)
VALUES 
(999, 1, 1, 100, 0, NULL, NULL);
```

### Verify Triggers:
```sql
SHOW TRIGGERS FROM portal_db WHERE `Trigger` LIKE 'trg_gl_journal_lines%';
```

### Check Entity Fields:
```sql
-- Find AR lines missing entity
SELECT gjl.* 
FROM gl_journal_lines gjl
INNER JOIN acc_chart_accounts acc ON acc.id = gjl.account_id
WHERE acc.account_type_id = 1
  AND (gjl.entity_type IS NULL OR gjl.entity_id IS NULL);

-- Find AP lines missing entity
SELECT gjl.* 
FROM gl_journal_lines gjl
INNER JOIN acc_chart_accounts acc ON acc.id = gjl.account_id
WHERE acc.account_type_id = 6
  AND (gjl.entity_type IS NULL OR gjl.entity_id IS NULL);
```

## Files Modified

### Services:
- `server/src/modules/gl/gl.service.cjs` - Added entity validation
- `server/src/modules/ar/arInvoices.service.cjs` - Added entity fields
- `server/src/modules/ar/arReceipts.service.cjs` - Added entity fields
- `server/src/modules/ap/apBills.service.cjs` - Added entity fields
- `server/src/modules/ap/apPayments.service.cjs` - Added entity fields
- `server/routes/outwardPayments.js` - Added entity fields
- `server/src/modules/openingBalance/openingBalance.service.cjs` - Already correct

### Utilities:
- `server/src/utils/ledgerEntityHelper.cjs` - NEW - Entity validation helpers
- `server/src/utils/ledgerBalanceQueries.cjs` - NEW - Ledger balance queries

### Migrations:
- `server/migrations/enforce_entity_required_gl_journal_lines.sql` - Trigger SQL
- `server/migrations/apply_triggers_simple.sql` - Simple trigger SQL
- `server/migrations/run_entity_enforcement_migration.cjs` - Migration script
- `server/migrations/backfill_entity_fields.cjs` - Backfill script

## Next Steps

1. ✅ All posting services updated
2. ✅ Database triggers installed
3. ✅ Historical data backfilled
4. ✅ Validation working at both layers

**System is now fully compliant with entity enforcement requirements!**
