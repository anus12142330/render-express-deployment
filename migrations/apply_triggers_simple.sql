-- Simple SQL file to apply entity enforcement triggers
-- Run this in phpMyAdmin or MySQL command line
-- Note: Remove DELIMITER statements if running in phpMyAdmin

-- Step 1: Drop existing triggers (if any)
DROP TRIGGER IF EXISTS trg_gl_journal_lines_validate_entity_insert;
DROP TRIGGER IF EXISTS trg_gl_journal_lines_validate_entity_update;

-- Step 2: Create INSERT Trigger
CREATE TRIGGER trg_gl_journal_lines_validate_entity_insert
BEFORE INSERT ON gl_journal_lines
FOR EACH ROW
BEGIN
    DECLARE acc_type INT;

    SELECT account_type_id INTO acc_type
    FROM acc_chart_accounts
    WHERE id = NEW.account_id
    LIMIT 1;

    IF acc_type IN (1, 6) THEN
        IF NEW.entity_type IS NULL OR NEW.entity_id IS NULL THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Entity is mandatory for AR/AP journal lines. entity_type and entity_id must be provided.';
        END IF;

        IF NEW.entity_type NOT IN ('CUSTOMER', 'SUPPLIER') THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Invalid entity_type. Must be "CUSTOMER" for AR accounts or "SUPPLIER" for AP accounts.';
        END IF;

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

-- Step 3: Create UPDATE Trigger
CREATE TRIGGER trg_gl_journal_lines_validate_entity_update
BEFORE UPDATE ON gl_journal_lines
FOR EACH ROW
BEGIN
    DECLARE acc_type INT;

    SELECT account_type_id INTO acc_type
    FROM acc_chart_accounts
    WHERE id = NEW.account_id
    LIMIT 1;

    IF acc_type IN (1, 6) THEN
        IF NEW.entity_type IS NULL OR NEW.entity_id IS NULL THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Entity is mandatory for AR/AP journal lines. entity_type and entity_id must be provided.';
        END IF;

        IF NEW.entity_type NOT IN ('CUSTOMER', 'SUPPLIER') THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Invalid entity_type. Must be "CUSTOMER" for AR accounts or "SUPPLIER" for AP accounts.';
        END IF;

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
