-- Add open_balance field to proforma_invoice table
-- This field stores the calculated open balance (proforma total - advance payments received)
-- For proforma invoices, open_balance represents remaining amount after advance payments

ALTER TABLE `proforma_invoice`
  ADD COLUMN `open_balance` DECIMAL(18, 4) NULL DEFAULT NULL COMMENT 'Open balance = grand_total - advance payments received' AFTER `grand_total`;

-- Create index for better query performance
CREATE INDEX IF NOT EXISTS `idx_proforma_invoice_open_balance` ON `proforma_invoice` (`open_balance`);
