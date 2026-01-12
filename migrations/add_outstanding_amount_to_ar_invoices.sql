-- Add outstanding_amount field to ar_invoices table
-- This field stores the calculated outstanding amount (invoice total - received amounts from approved payments)
-- Similar to open_balance in ap_bills table

ALTER TABLE `ar_invoices`
  ADD COLUMN `outstanding_amount` DECIMAL(18, 4) NULL DEFAULT NULL COMMENT 'Outstanding amount = total - received amounts from approved payments' AFTER `total`;

-- Create index for better query performance
CREATE INDEX IF NOT EXISTS `idx_ar_invoices_outstanding_amount` ON `ar_invoices` (`outstanding_amount`);
