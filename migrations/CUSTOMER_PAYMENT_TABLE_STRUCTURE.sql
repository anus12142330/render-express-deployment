-- Customer Payment (INWARD) - Complete Table Structure Reference
-- This file shows the complete structure of tables used for customer payments
-- Run migrations in order before using this as reference

-- ============================================
-- tbl_payment Table Structure
-- ============================================
-- This table stores both INWARD (customer) and OUTWARD (supplier) payments
-- Filter by: direction = 'IN' AND party_type = 'CUSTOMER'

/*
CREATE TABLE `tbl_payment` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `payment_uniqid` VARCHAR(50) UNIQUE NOT NULL,
  `payment_number` VARCHAR(100) UNIQUE,
  `transaction_date` DATE NOT NULL,
  `payment_type` ENUM('CASH', 'CHEQUE', 'TT') NULL,
  `payment_type_id` INT NULL,
  `bank_account_id` INT NULL,
  `cash_account_id` INT NULL,
  `cheque_no` VARCHAR(200) NULL,
  `cheque_date` DATE NULL,
  `tt_ref_no` VARCHAR(200) NULL,
  `value_date` DATE NULL,
  `reference_no` VARCHAR(200) NULL,
  `direction` ENUM('IN', 'OUT') NOT NULL,
  `party_type` ENUM('CUSTOMER', 'SUPPLIER', 'OTHER') NOT NULL,
  `party_id` INT NOT NULL,
  `currency_id` INT NULL,
  `currency_code` VARCHAR(10) NOT NULL,
  `total_amount_bank` DECIMAL(18, 4) NOT NULL,
  `total_amount_base` DECIMAL(18, 4) NOT NULL,
  `fx_rate` DECIMAL(18, 6) NULL,
  `notes` TEXT NULL,
  `status` ENUM('DRAFT', 'POSTED', 'CANCELLED') DEFAULT 'DRAFT',
  `status_id` INT DEFAULT 3,
  `approved_by` INT NULL,
  `approved_at` DATETIME NULL,
  `edit_request_status` TINYINT(1) DEFAULT 0,
  `edit_requested_by` INT NULL,
  `edit_requested_at` DATETIME NULL,
  `edit_request_reason` TEXT NULL,
  `edit_approved_by` INT NULL,
  `edit_approved_at` DATETIME NULL,
  `edit_rejection_reason` TEXT NULL,
  `is_deleted` TINYINT(1) DEFAULT 0,
  `user_id` INT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `created_by` INT NULL,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `updated_by` INT NULL,
  `posted_at` DATETIME NULL,
  `posted_by` INT NULL,
  -- Foreign Keys
  CONSTRAINT `fk_payment_bank_account` FOREIGN KEY (`bank_account_id`) REFERENCES `acc_bank_details` (`id`),
  CONSTRAINT `fk_payment_cash_account` FOREIGN KEY (`cash_account_id`) REFERENCES `acc_bank_details` (`id`),
  CONSTRAINT `fk_payment_status` FOREIGN KEY (`status_id`) REFERENCES `status` (`id`),
  CONSTRAINT `fk_payment_currency` FOREIGN KEY (`currency_id`) REFERENCES `currency` (`id`),
  CONSTRAINT `fk_payment_payment_type` FOREIGN KEY (`payment_type_id`) REFERENCES `payment_type` (`id`),
  CONSTRAINT `fk_payment_approved_by` FOREIGN KEY (`approved_by`) REFERENCES `user` (`id`),
  CONSTRAINT `fk_payment_edit_requested_by` FOREIGN KEY (`edit_requested_by`) REFERENCES `user` (`id`),
  CONSTRAINT `fk_payment_edit_approved_by` FOREIGN KEY (`edit_approved_by`) REFERENCES `user` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
*/

-- ============================================
-- tbl_payment_allocation Table Structure
-- ============================================
-- This table stores payment allocations (links payments to invoices/bills/POs)

/*
CREATE TABLE `tbl_payment_allocation` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `payment_id` INT NOT NULL,
  `alloc_type` VARCHAR(50) NOT NULL,
  `bill_id` INT NULL,
  `po_id` INT NULL,
  `invoice_id` INT NULL,
  `buyer_id` INT NULL,
  `supplier_id` INT NULL,
  `amount_bank` DECIMAL(18, 4) NOT NULL,
  `amount_base` DECIMAL(18, 4) NOT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `created_by` INT NULL,
  -- Foreign Keys
  CONSTRAINT `fk_allocation_payment` FOREIGN KEY (`payment_id`) REFERENCES `tbl_payment` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_allocation_bill` FOREIGN KEY (`bill_id`) REFERENCES `ap_bills` (`id`),
  CONSTRAINT `fk_allocation_invoice` FOREIGN KEY (`invoice_id`) REFERENCES `ar_invoices` (`id`),
  CONSTRAINT `fk_allocation_buyer` FOREIGN KEY (`buyer_id`) REFERENCES `vendor` (`id`),
  CONSTRAINT `fk_allocation_supplier` FOREIGN KEY (`supplier_id`) REFERENCES `vendor` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
*/

-- ============================================
-- tbl_payment_attachments Table Structure
-- ============================================
-- This table stores file attachments for payments

/*
CREATE TABLE `tbl_payment_attachments` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `payment_id` INT NOT NULL,
  `file_name` VARCHAR(255) NOT NULL,
  `file_path` VARCHAR(500) NOT NULL,
  `mime_type` VARCHAR(100) NULL,
  `size_bytes` BIGINT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `created_by` INT NULL,
  CONSTRAINT `fk_payment_attachment_payment` FOREIGN KEY (`payment_id`) REFERENCES `tbl_payment` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
*/

-- ============================================
-- ar_invoices Table (Modified)
-- ============================================
-- Added column: outstanding_amount

/*
ALTER TABLE `ar_invoices`
  ADD COLUMN `outstanding_amount` DECIMAL(18, 4) NULL DEFAULT NULL 
  COMMENT 'Outstanding amount = total - received amounts from approved payments' 
  AFTER `total`;
*/

-- ============================================
-- Sample Queries
-- ============================================

-- Get all customer payments
-- SELECT * FROM tbl_payment WHERE direction = 'IN' AND party_type = 'CUSTOMER' AND (is_deleted = 0 OR is_deleted IS NULL);

-- Get payment with allocations
-- SELECT p.*, pa.*, ai.invoice_number 
-- FROM tbl_payment p
-- LEFT JOIN tbl_payment_allocation pa ON pa.payment_id = p.id
-- LEFT JOIN ar_invoices ai ON ai.id = pa.invoice_id
-- WHERE p.id = ? AND p.direction = 'IN' AND p.party_type = 'CUSTOMER';

-- Get GL journal entries for payment
-- SELECT gj.*, gjl.*, acc.name as account_name
-- FROM gl_journals gj
-- INNER JOIN gl_journal_lines gjl ON gjl.journal_id = gj.id
-- LEFT JOIN acc_chart_accounts acc ON acc.id = gjl.account_id
-- WHERE gj.source_type = 'INWARD_PAYMENT' AND gj.source_id = ?;

-- Calculate invoice outstanding amount
-- SELECT 
--   ai.id,
--   ai.total,
--   COALESCE(SUM(
--     CASE 
--       WHEN p.currency_id = ai.currency_id THEN pa.amount_bank
--       ELSE pa.amount_base
--     END
--   ), 0) as received_amount,
--   (ai.total - COALESCE(SUM(
--     CASE 
--       WHEN p.currency_id = ai.currency_id THEN pa.amount_bank
--       ELSE pa.amount_base
--     END
--   ), 0)) as outstanding_amount
-- FROM ar_invoices ai
-- LEFT JOIN tbl_payment_allocation pa ON pa.invoice_id = ai.id
-- LEFT JOIN tbl_payment p ON p.id = pa.payment_id
-- WHERE ai.id = ? AND (p.is_deleted = 0 OR p.is_deleted IS NULL)
-- GROUP BY ai.id;
