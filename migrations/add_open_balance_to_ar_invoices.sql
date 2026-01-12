-- Add open_balance field to ar_invoices table
-- This field stores the calculated open balance (invoice total - received amounts from approved payments)
-- Similar to open_balance in ap_bills table

ALTER TABLE `ar_invoices`
  ADD COLUMN `open_balance` DECIMAL(18, 4) NULL DEFAULT NULL COMMENT 'Open balance = total - received amounts from approved payments' AFTER `total`;

-- Create index for better query performance
CREATE INDEX IF NOT EXISTS `idx_ar_invoices_open_balance` ON `ar_invoices` (`open_balance`);
