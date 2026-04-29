-- Add uniqid to sales_orders and backfill existing rows.
-- Intended for MySQL.
-- Run once on each DB.

SET @db = DATABASE();

-- 1) Add column (nullable first for safe backfill)
SET @col_exists = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'sales_orders'
    AND COLUMN_NAME = 'uniqid'
);

SET @sql = IF(
  @col_exists = 0,
  'ALTER TABLE sales_orders ADD COLUMN uniqid VARCHAR(32) NULL AFTER id',
  'SELECT ''sales_orders.uniqid already exists'' as info'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2) Backfill existing data
UPDATE sales_orders
SET uniqid = CONCAT('so_', SUBSTRING(REPLACE(UUID(), '-', ''), 1, 24))
WHERE uniqid IS NULL OR uniqid = '';

-- 3) Add UNIQUE index
SET @idx_exists = (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'sales_orders'
    AND INDEX_NAME = 'uq_sales_orders_uniqid'
);

SET @sql = IF(
  @idx_exists = 0,
  'ALTER TABLE sales_orders ADD UNIQUE KEY uq_sales_orders_uniqid (uniqid)',
  'SELECT ''uq_sales_orders_uniqid already exists'' as info'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 4) Enforce NOT NULL if everything is filled
SET @missing = (
  SELECT COUNT(*)
  FROM sales_orders
  WHERE uniqid IS NULL OR uniqid = ''
);

SET @sql = IF(
  @missing = 0,
  'ALTER TABLE sales_orders MODIFY uniqid VARCHAR(32) NOT NULL',
  'SELECT ''sales_orders.uniqid still has NULL/empty values'' as info'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

