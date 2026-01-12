-- Add reconcile_date and reconcile_number fields to tbl_payment table
-- These fields are mandatory when approving customer receipts

SET @dbname = DATABASE();
SET @tablename = 'tbl_payment';
SET @column1 = 'reconcile_date';
SET @column2 = 'reconcile_number';

-- Add reconcile_date column (if not exists)
SET @preparedStatement = (SELECT IF(
    (
        SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
        WHERE
            (TABLE_SCHEMA = @dbname)
            AND (TABLE_NAME = @tablename)
            AND (COLUMN_NAME = @column1)
    ) > 0,
    'SELECT 1', -- Column exists, do nothing
    CONCAT('ALTER TABLE ', @tablename, ' ADD COLUMN ', @column1, ' DATE NULL COMMENT "Reconciliation date - mandatory on approval" AFTER approved_at')
));
PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;

-- Add reconcile_number column (if not exists)
SET @preparedStatement = (SELECT IF(
    (
        SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
        WHERE
            (TABLE_SCHEMA = @dbname)
            AND (TABLE_NAME = @tablename)
            AND (COLUMN_NAME = @column2)
    ) > 0,
    'SELECT 1', -- Column exists, do nothing
    CONCAT('ALTER TABLE ', @tablename, ' ADD COLUMN ', @column2, ' VARCHAR(200) NULL COMMENT "Reconciliation number - mandatory on approval" AFTER reconcile_date')
));
PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;

-- Create index for reconcile_number
CREATE INDEX IF NOT EXISTS `idx_payment_reconcile_number` ON `tbl_payment` (`reconcile_number`);
