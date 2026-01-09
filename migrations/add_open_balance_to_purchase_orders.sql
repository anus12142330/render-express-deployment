-- Add open_balance field to purchase_orders table
-- This field stores the calculated open balance (PO total - allocated advance amounts from approved payments)

ALTER TABLE `purchase_orders`
  ADD COLUMN `open_balance` DECIMAL(18, 4) NULL DEFAULT NULL COMMENT 'Open balance = total - allocated advance amounts from approved payments' AFTER `total`;

-- Create index for better query performance
CREATE INDEX IF NOT EXISTS `idx_purchase_orders_open_balance` ON `purchase_orders` (`open_balance`);
