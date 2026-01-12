-- Add proforma_id column to tbl_payment_allocation table
-- This column stores the proforma invoice ID for advance payment allocations

SET @dbname = DATABASE();
SET @tablename = 'tbl_payment_allocation';
SET @columnname = 'proforma_id';

SET @preparedStatement = (SELECT IF(
    (
        SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
        WHERE
            (TABLE_SCHEMA = @dbname)
            AND (TABLE_NAME = @tablename)
            AND (COLUMN_NAME = @columnname)
    ) > 0,
    'SELECT 1', -- Column exists, do nothing
    CONCAT('ALTER TABLE ', @tablename, ' ADD COLUMN ', @columnname, ' INT NULL COMMENT "Proforma invoice ID (for advance payments)" AFTER invoice_id')
));
PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;

-- Add foreign key for proforma_id if it doesn't exist
SET @fkname = 'fk_allocation_proforma';
SET @preparedStatement = (SELECT IF(
    (
        SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
        WHERE
            (TABLE_SCHEMA = @dbname)
            AND (TABLE_NAME = @tablename)
            AND (CONSTRAINT_NAME = @fkname)
    ) > 0,
    'SELECT 1', -- Foreign key exists, do nothing
    CONCAT('ALTER TABLE ', @tablename, ' ADD CONSTRAINT ', @fkname, ' FOREIGN KEY (proforma_id) REFERENCES proforma_invoice (id) ON DELETE RESTRICT ON UPDATE CASCADE')
));
PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;

-- Create index for better query performance
CREATE INDEX IF NOT EXISTS `idx_allocation_proforma_id` ON `tbl_payment_allocation` (`proforma_id`);
