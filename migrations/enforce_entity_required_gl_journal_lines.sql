-- Migration: Enforce entity_type and entity_id for AR/AP journal lines
-- This migration adds triggers to ensure AR/AP accounts have entity fields populated
-- Note: CHECK constraints with subqueries are not supported in MySQL, so we use triggers instead.

-- Step 1: Drop existing triggers if they exist (for idempotency)
DROP TRIGGER IF EXISTS trg_gl_journal_lines_validate_entity_insert;
DROP TRIGGER IF EXISTS trg_gl_journal_lines_validate_entity_update;

-- Step 2: Create trigger for MySQL versions that don't enforce CHECK constraints
-- This trigger validates entity requirements before INSERT
DELIMITER $$

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
END$$

-- Trigger for UPDATE
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
END$$

DELIMITER ;
