-- Add open_balance field to ap_bills table
-- This field stores the calculated open balance (bill total - allocated amounts from approved payments)

ALTER TABLE `ap_bills`
  ADD COLUMN `open_balance` DECIMAL(18, 4) NULL DEFAULT NULL COMMENT 'Open balance = total - allocated amounts from approved payments' AFTER `total`;

-- Create index for better query performance
CREATE INDEX IF NOT EXISTS `idx_ap_bills_open_balance` ON `ap_bills` (`open_balance`);
