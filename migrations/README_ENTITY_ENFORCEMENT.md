# Entity Enforcement Migration - Setup Instructions

This migration adds database triggers to enforce `entity_type` and `entity_id` requirements for AR/AP journal lines.

## Method 1: Run the Node.js Migration Script (Recommended)

```bash
cd c:\xampp\htdocs\portal
node server/migrations/run_entity_enforcement_migration.cjs
```

This script will:
- Drop existing triggers (if any) for idempotency
- Create the INSERT trigger
- Create the UPDATE trigger

## Method 2: Run SQL Directly in MySQL/phpMyAdmin

### Step 1: Drop existing triggers (if any)
```sql
DROP TRIGGER IF EXISTS trg_gl_journal_lines_validate_entity_insert;
DROP TRIGGER IF EXISTS trg_gl_journal_lines_validate_entity_update;
```

### Step 2: Create INSERT Trigger
```sql
CREATE TRIGGER trg_gl_journal_lines_validate_entity_insert
BEFORE INSERT ON gl_journal_lines
FOR EACH ROW
BEGIN
    DECLARE acc_type INT;

    SELECT account_type_id INTO acc_type
    FROM acc_chart_accounts
    WHERE id = NEW.account_id
    LIMIT 1;

    -- If account is AR (1) or AP (6), entity_type and entity_id are required
    IF acc_type IN (1, 6) THEN
        IF NEW.entity_type IS NULL OR NEW.entity_id IS NULL THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Entity is mandatory for AR/AP journal lines. entity_type and entity_id must be provided.';
        END IF;

        -- Validate entity_type value
        IF NEW.entity_type NOT IN ('CUSTOMER', 'SUPPLIER') THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Invalid entity_type. Must be "CUSTOMER" for AR accounts or "SUPPLIER" for AP accounts.';
        END IF;

        -- Validate entity_type matches account type
        IF acc_type = 1 AND NEW.entity_type != 'CUSTOMER' THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'AR accounts (account_type_id=1) must have entity_type="CUSTOMER"';
        END IF;

        IF acc_type = 6 AND NEW.entity_type != 'SUPPLIER' THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'AP accounts (account_type_id=6) must have entity_type="SUPPLIER"';
        END IF;
    END IF;
END;
```

### Step 3: Create UPDATE Trigger
```sql
CREATE TRIGGER trg_gl_journal_lines_validate_entity_update
BEFORE UPDATE ON gl_journal_lines
FOR EACH ROW
BEGIN
    DECLARE acc_type INT;

    SELECT account_type_id INTO acc_type
    FROM acc_chart_accounts
    WHERE id = NEW.account_id
    LIMIT 1;

    -- If account is AR (1) or AP (6), entity_type and entity_id are required
    IF acc_type IN (1, 6) THEN
        IF NEW.entity_type IS NULL OR NEW.entity_id IS NULL THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Entity is mandatory for AR/AP journal lines. entity_type and entity_id must be provided.';
        END IF;

        -- Validate entity_type value
        IF NEW.entity_type NOT IN ('CUSTOMER', 'SUPPLIER') THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Invalid entity_type. Must be "CUSTOMER" for AR accounts or "SUPPLIER" for AP accounts.';
        END IF;

        -- Validate entity_type matches account type
        IF acc_type = 1 AND NEW.entity_type != 'CUSTOMER' THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'AR accounts (account_type_id=1) must have entity_type="CUSTOMER"';
        END IF;

        IF acc_type = 6 AND NEW.entity_type != 'SUPPLIER' THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'AP accounts (account_type_id=6) must have entity_type="SUPPLIER"';
        END IF;
    END IF;
END;
```

## Method 3: Using MySQL Command Line

```bash
mysql -u root -p portal_db < server/migrations/enforce_entity_required_gl_journal_lines.sql
```

**Note:** The SQL file uses `DELIMITER $$` which may not work in command line. Use Method 1 or 2 instead.

## Verify Triggers Are Installed

Run this query to check if triggers exist:

```sql
SHOW TRIGGERS FROM portal_db WHERE `Trigger` LIKE 'trg_gl_journal_lines%';
```

Or:

```sql
SELECT 
    TRIGGER_NAME,
    EVENT_MANIPULATION,
    EVENT_OBJECT_TABLE,
    ACTION_STATEMENT
FROM information_schema.TRIGGERS
WHERE TRIGGER_SCHEMA = 'portal_db'
  AND TRIGGER_NAME LIKE 'trg_gl_journal_lines%';
```

## Test the Triggers

### Test 1: Try inserting AR line without entity (should fail)
```sql
INSERT INTO gl_journal_lines 
(journal_id, line_no, account_id, debit, credit, entity_type, entity_id)
VALUES 
(1, 1, 1, 100, 0, NULL, NULL);
-- Should fail with error about entity being mandatory
```

### Test 2: Try inserting AR line with wrong entity_type (should fail)
```sql
INSERT INTO gl_journal_lines 
(journal_id, line_no, account_id, debit, credit, entity_type, entity_id)
VALUES 
(1, 1, 1, 100, 0, 'SUPPLIER', 1);
-- Should fail: AR accounts must have entity_type="CUSTOMER"
```

### Test 3: Try inserting AR line correctly (should succeed)
```sql
INSERT INTO gl_journal_lines 
(journal_id, line_no, account_id, debit, credit, entity_type, entity_id)
VALUES 
(1, 1, 1, 100, 0, 'CUSTOMER', 1);
-- Should succeed
```

## Remove Triggers (if needed)

```sql
DROP TRIGGER IF EXISTS trg_gl_journal_lines_validate_entity_insert;
DROP TRIGGER IF EXISTS trg_gl_journal_lines_validate_entity_update;
```

## What the Triggers Do

1. **Before INSERT/UPDATE**: Check if the account is AR (type 1) or AP (type 6)
2. **If AR/AP**: Require `entity_type` and `entity_id` to be NOT NULL
3. **Validate**: `entity_type` must be 'CUSTOMER' for AR or 'SUPPLIER' for AP
4. **Error**: If validation fails, raise SQL error with descriptive message

## Production Deployment

For production servers:
1. Backup your database first
2. Run the migration script during maintenance window
3. Verify triggers are installed
4. Test with a sample transaction
5. Monitor application logs for any issues
