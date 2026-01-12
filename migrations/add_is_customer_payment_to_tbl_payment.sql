-- Migration: Add is_customer_payment field to tbl_payment table
-- This field distinguishes between customer payments (INWARD) and supplier payments (OUTWARD)
-- 1 = Customer Payment (INWARD), 0 = Supplier Payment (OUTWARD)

SET @dbname = DATABASE();
SET @tablename = 'tbl_payment';
SET @columnname = 'is_customer_payment';

-- Add is_customer_payment column (if not exists)
SET @preparedStatement = (SELECT IF(
    (
        SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
        WHERE
            (TABLE_SCHEMA = @dbname)
            AND (TABLE_NAME = @tablename)
            AND (COLUMN_NAME = @columnname)
    ) > 0,
    'SELECT 1', -- Column exists, do nothing
    CONCAT('ALTER TABLE ', @tablename, ' ADD COLUMN ', @columnname, ' TINYINT(1) DEFAULT 0 COMMENT "1=Customer Payment (INWARD), 0=Supplier Payment (OUTWARD)" AFTER direction')
));
PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;

-- Update existing records based on direction
-- Set is_customer_payment = 1 for INWARD payments (customer payments)
UPDATE `tbl_payment` SET `is_customer_payment` = 1 WHERE `direction` = 'IN' AND (`is_customer_payment` IS NULL OR `is_customer_payment` = 0);

-- Set is_customer_payment = 0 for OUTWARD payments (supplier payments)
UPDATE `tbl_payment` SET `is_customer_payment` = 0 WHERE `direction` = 'OUT' AND (`is_customer_payment` IS NULL OR `is_customer_payment` = 1);

-- Create index for better query performance
CREATE INDEX IF NOT EXISTS `idx_payment_is_customer_payment` ON `tbl_payment` (`is_customer_payment`);
