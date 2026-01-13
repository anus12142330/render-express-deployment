# Entity Ledger Balances Implementation - Complete

## ✅ Status: IMPLEMENTED

Cached ledger balances for customers and suppliers are now automatically maintained in the `entity_ledger_balances` table.

## What Was Implemented

### 1. Database Table
- **Table:** `entity_ledger_balances`
- **Migration:** `server/migrations/create_entity_ledger_balances_table.sql`
- **Columns:**
  - `company_id` (INT) - Multi-company support
  - `entity_type` (VARCHAR) - 'CUSTOMER' or 'SUPPLIER'
  - `entity_id` (INT) - Customer or Supplier ID
  - `balance` (DECIMAL) - Cached balance = SUM(debit) - SUM(credit)
  - `updated_at` (DATETIME) - Auto-updated timestamp

### 2. Core Service
- **File:** `server/src/modules/gl/entityBalance.service.cjs`
- **Functions:**
  - `updateEntityBalances(conn, companyId, lines)` - Updates balances for journal lines
  - `getEntityBalance(conn, entityType, entityId, companyId)` - Gets cached balance
  - `rebuildEntityBalances(conn, companyId)` - Rebuilds all balances from GL

### 3. Automatic Balance Updates
- **File:** `server/src/modules/gl/gl.service.cjs`
- **Integration:** `createJournal()` now automatically updates entity balances
- **Process:**
  1. Insert `gl_journals` → get `journal_id`
  2. Insert `gl_journal_lines`
  3. **Automatically update `entity_ledger_balances`** for lines with `entity_type` and `entity_id`
  4. Uses `INSERT ... ON DUPLICATE KEY UPDATE` for atomic updates

### 4. API Endpoints

#### Get Entity Balance
```
GET /api/gl/entities/:type/:id/balance?company_id=1
```
- **type:** 'CUSTOMER' or 'SUPPLIER'
- **id:** Customer or Supplier ID
- **Returns:**
  ```json
  {
    "success": true,
    "data": {
      "entity_type": "CUSTOMER",
      "entity_id": 1,
      "balance": 1000.00,
      "outstanding": 1000.00,      // max(balance, 0) for customers
      "credit_balance": 0.00,      // max(-balance, 0) for customers
      "payable": 0.00,              // max(-balance, 0) for suppliers
      "supplier_debit": 0.00        // max(balance, 0) for suppliers
    }
  }
  ```

#### Rebuild Balances (Admin)
```
POST /api/gl/admin/rebuild-entity-balances
Body: { "company_id": 1 }
```
- Rebuilds all cached balances from `gl_journal_lines`
- Use when balances are out of sync

### 5. Rebuild Script
- **File:** `server/migrations/rebuild_entity_balances.cjs`
- **Usage:**
  ```bash
  node server/migrations/rebuild_entity_balances.cjs [company_id]
  ```
- Recalculates all balances from GL (useful for initial setup or fixing inconsistencies)

## How It Works

### Automatic Updates
When any posting service calls `glService.createJournal()`:
1. Journal and lines are inserted
2. **Balance service automatically:**
   - Finds all lines with `entity_type` and `entity_id`
   - Calculates delta = `debit - credit` for each line
   - Updates `entity_ledger_balances` using `INSERT ... ON DUPLICATE KEY UPDATE`
   - All within the same transaction

### Reversals
When a journal is reversed:
- `createReversalJournal()` swaps debits/credits
- Entity fields (`entity_type`, `entity_id`) are preserved
- Balance updates automatically apply negative deltas
- **No special handling needed!**

### Multi-Company Support
- Default `company_id = 1` if not specified
- All services can pass `company_id` in `createJournal()` params
- Balances are stored per company

## Services That Auto-Update Balances

All these services now automatically update balances:
- ✅ `arInvoices.service.cjs` - AR Invoice posting
- ✅ `apBills.service.cjs` - AP Bill posting
- ✅ `arReceipts.service.cjs` - Customer receipt posting
- ✅ `apPayments.service.cjs` - Supplier payment posting
- ✅ `openingBalance.service.cjs` - Opening balance posting
- ✅ `outwardPayments.js` - Outward payment posting

**No code changes needed** - they all use `glService.createJournal()` which now handles balance updates.

## Balance Calculation

### For Customers (AR):
- **Balance** = SUM(debit) - SUM(credit) from `gl_journal_lines` where `entity_type='CUSTOMER'`
- **Outstanding** = max(balance, 0) - Amount customer owes us
- **Credit Balance** = max(-balance, 0) - Amount we owe customer

### For Suppliers (AP):
- **Balance** = SUM(debit) - SUM(credit) from `gl_journal_lines` where `entity_type='SUPPLIER'`
- **Payable** = max(-balance, 0) - Amount we owe supplier
- **Supplier Debit** = max(balance, 0) - Prepaid/advance amount

## Database Migration

Run the migration to create the table:
```sql
-- Run: server/migrations/create_entity_ledger_balances_table.sql
```

Or use the Node.js script:
```bash
node server/migrations/rebuild_entity_balances.cjs
```

## Initial Setup

1. **Create the table:**
   ```bash
   mysql -u root -p portal_db < server/migrations/create_entity_ledger_balances_table.sql
   ```

2. **Rebuild initial balances:**
   ```bash
   node server/migrations/rebuild_entity_balances.cjs
   ```

3. **Verify:**
   ```sql
   SELECT * FROM entity_ledger_balances;
   ```

## Frontend Integration

### Customer Profile
```javascript
// Get customer balance
const response = await fetch(`/api/gl/entities/CUSTOMER/${customerId}/balance`);
const { data } = await response.json();

// Display:
// Outstanding: data.outstanding AED
// Credit Balance: data.credit_balance AED
```

### Supplier Profile
```javascript
// Get supplier balance
const response = await fetch(`/api/gl/entities/SUPPLIER/${supplierId}/balance`);
const { data } = await response.json();

// Display:
// Payable: data.payable AED
// Supplier Debit: data.supplier_debit AED
```

## Performance Benefits

- **Fast Lookups:** O(1) balance retrieval from cached table
- **No Complex Queries:** No need to SUM gl_journal_lines on every request
- **Scalable:** Works efficiently even with millions of journal lines
- **Transactional:** Updates are atomic and consistent with GL

## Consistency Guarantees

- ✅ Balances updated in same transaction as GL posting
- ✅ Reversals automatically adjust balances
- ✅ No manual balance updates needed
- ✅ Rebuild script available for fixing inconsistencies

## Testing

### Test Balance Update
1. Post an invoice/bill
2. Check balance immediately:
   ```sql
   SELECT * FROM entity_ledger_balances WHERE entity_id = ?;
   ```
3. Verify balance matches GL calculation

### Test Reversal
1. Reverse a journal
2. Verify balance is adjusted correctly
3. Balance should return to previous state

## Troubleshooting

### Balances Out of Sync?
Run rebuild:
```bash
node server/migrations/rebuild_entity_balances.cjs
```

### Missing Balances?
- Check that `entity_type` and `entity_id` are set on journal lines
- Verify entity enforcement is working (triggers/validation)

### Performance Issues?
- Ensure indexes exist on `entity_ledger_balances`
- Check that `updated_at` index is being used

## Next Steps

1. ✅ Database table created
2. ✅ Balance service implemented
3. ✅ Auto-updates integrated
4. ✅ API endpoints created
5. ✅ Rebuild script ready
6. ⏳ Frontend integration (pending)

## Files Created/Modified

### New Files:
- `server/migrations/create_entity_ledger_balances_table.sql`
- `server/src/modules/gl/entityBalance.service.cjs`
- `server/migrations/rebuild_entity_balances.cjs`
- `server/migrations/ENTITY_LEDGER_BALANCES_IMPLEMENTATION.md`

### Modified Files:
- `server/src/modules/gl/gl.service.cjs` - Added balance updates
- `server/src/modules/gl/gl.controller.cjs` - Added balance endpoints
- `server/src/modules/gl/gl.routes.cjs` - Added balance routes

## Summary

✅ **Entity ledger balances are now fully implemented and automatically maintained!**

All posting services automatically update cached balances, and the system provides fast, consistent balance lookups for customers and suppliers.
