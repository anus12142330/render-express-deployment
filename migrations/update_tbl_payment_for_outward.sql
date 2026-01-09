-- Update tbl_payment table for Supplier Payment (OUTWARD) requirements
-- This migration updates the existing table structure

-- Add new columns for payment type and payment-specific fields (check if exists first)
ALTER TABLE `tbl_payment`
  ADD COLUMN `payment_type` ENUM('CASH', 'CHEQUE', 'TT') NULL AFTER `transaction_date`,
  ADD COLUMN `cash_account_id` INT NULL AFTER `bank_account_id`,
  ADD COLUMN `cheque_no` VARCHAR(200) NULL AFTER `payment_type`,
  ADD COLUMN `cheque_date` DATE NULL AFTER `cheque_no`,
  ADD COLUMN `tt_ref_no` VARCHAR(200) NULL AFTER `cheque_date`,
  ADD COLUMN `value_date` DATE NULL AFTER `tt_ref_no`,
  ADD COLUMN `reference_no` VARCHAR(200) NULL AFTER `value_date`,
  ADD COLUMN `status_id` INT DEFAULT 3 AFTER `notes`,
  ADD COLUMN `approved_by` INT NULL AFTER `status_id`,
  ADD COLUMN `approved_at` DATETIME NULL AFTER `approved_by`;

-- Rename columns to match new naming convention
ALTER TABLE `tbl_payment`
  CHANGE COLUMN `total_amount` `total_amount_bank` DECIMAL(18, 4) NOT NULL COMMENT 'Amount in bank/cash currency',
  CHANGE COLUMN `total_amount_base` `total_amount_base` DECIMAL(18, 4) NOT NULL COMMENT 'Amount in base currency (AED)',
  CHANGE COLUMN `currency_code` `currency_code` VARCHAR(10) NOT NULL COMMENT 'Bank/Cash account currency';

-- Make bank_account_id nullable (required only for CHEQUE and TT)
ALTER TABLE `tbl_payment`
  MODIFY COLUMN `bank_account_id` INT NULL;

-- Update status column: remove ENUM, keep status_id
-- Note: Keep the old status column for backward compatibility, but use status_id as primary
ALTER TABLE `tbl_payment`
  MODIFY COLUMN `status` ENUM('DRAFT', 'POSTED', 'CANCELLED') DEFAULT 'DRAFT' COMMENT 'Legacy status field';

-- Add foreign key constraints
ALTER TABLE `tbl_payment`
  ADD CONSTRAINT `fk_payment_bank_account` FOREIGN KEY (`bank_account_id`) REFERENCES `acc_bank_details` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `fk_payment_cash_account` FOREIGN KEY (`cash_account_id`) REFERENCES `acc_bank_details` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `fk_payment_status` FOREIGN KEY (`status_id`) REFERENCES `status` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `fk_payment_approved_by` FOREIGN KEY (`approved_by`) REFERENCES `user` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Update tbl_payment_allocation table
ALTER TABLE `tbl_payment_allocation`
  CHANGE COLUMN `allocation_type` `alloc_type` VARCHAR(50) NOT NULL COMMENT 'e.g., bill, po, advance',
  ADD COLUMN `bill_id` INT NULL AFTER `payment_id`,
  ADD COLUMN `po_id` INT NULL AFTER `bill_id`,
  CHANGE COLUMN `reference_id` `reference_id` INT NULL COMMENT 'Generic reference (use bill_id or po_id instead)',
  CHANGE COLUMN `amount` `amount_bank` DECIMAL(18, 4) NOT NULL COMMENT 'Allocated amount in bank currency',
  CHANGE COLUMN `amount_base` `amount_base` DECIMAL(18, 4) NOT NULL COMMENT 'Allocated amount in base currency (AED)';

-- Add foreign keys for allocations
ALTER TABLE `tbl_payment_allocation`
  ADD CONSTRAINT `fk_allocation_bill` FOREIGN KEY (`bill_id`) REFERENCES `ap_bills` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Create index for payment number generation
CREATE INDEX IF NOT EXISTS `idx_payment_number` ON `tbl_payment` (`payment_number`);
CREATE INDEX IF NOT EXISTS `idx_payment_status_id` ON `tbl_payment` (`status_id`);

