-- Add tax_mode to ar_invoices (Customer Invoice) to preserve inclusive/exclusive mode.
-- Run once on each DB.

SET @db := DATABASE();

SET @exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'ar_invoices'
    AND COLUMN_NAME = 'tax_mode'
);

SET @sql := IF(
  @exists = 0,
  'ALTER TABLE ar_invoices ADD COLUMN tax_mode VARCHAR(20) NULL DEFAULT ''EXCLUSIVE'' AFTER currency_id',
  'SELECT ''tax_mode already exists'' as info'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

