-- Create tbl_payment table for generic payment transactions (both IN and OUT)
CREATE TABLE IF NOT EXISTS `tbl_payment` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `payment_uniqid` VARCHAR(50) UNIQUE NOT NULL,
  `payment_number` VARCHAR(100) UNIQUE,
  `transaction_date` DATE NOT NULL,
  `bank_account_id` INT NOT NULL,
  `transaction_type` VARCHAR(50) NULL COMMENT 'e.g., CHEQUE, TRANSFER, CASH, etc.',
  `ref_chq_no` VARCHAR(200) NULL COMMENT 'Reference/Cheque Number',
  `direction` ENUM('IN', 'OUT') NOT NULL COMMENT 'IN for receipts, OUT for payments',
  `party_type` ENUM('CUSTOMER', 'SUPPLIER', 'OTHER') NOT NULL,
  `party_id` INT NOT NULL COMMENT 'vendor_id or customer_id based on party_type',
  `currency_code` VARCHAR(10) NOT NULL COMMENT 'Bank currency',
  `total_amount` DECIMAL(18, 6) NOT NULL COMMENT 'Amount in bank currency',
  `total_amount_base` DECIMAL(18, 6) NOT NULL COMMENT 'Amount in base currency (AED)',
  `fx_rate` DECIMAL(18, 6) NULL COMMENT 'Exchange rate used (bank currency to AED)',
  `notes` TEXT NULL,
  `status` ENUM('DRAFT', 'POSTED', 'CANCELLED') DEFAULT 'DRAFT',
  `user_id` INT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `created_by` INT NULL,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `updated_by` INT NULL,
  `posted_at` DATETIME NULL,
  `posted_by` INT NULL,
  CONSTRAINT `fk_payment_bank_account` FOREIGN KEY (`bank_account_id`) REFERENCES `acc_bank_details` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_payment_user` FOREIGN KEY (`user_id`) REFERENCES `user` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_payment_created_by` FOREIGN KEY (`created_by`) REFERENCES `user` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_payment_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_payment_posted_by` FOREIGN KEY (`posted_by`) REFERENCES `user` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  INDEX `idx_payment_date` (`transaction_date`),
  INDEX `idx_payment_direction` (`direction`),
  INDEX `idx_payment_party` (`party_type`, `party_id`),
  INDEX `idx_payment_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Create tbl_payment_allocation table for payment allocations
CREATE TABLE IF NOT EXISTS `tbl_payment_allocation` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `payment_id` INT NOT NULL,
  `allocation_type` VARCHAR(50) NOT NULL COMMENT 'e.g., BILL, PO, INVOICE, ADVANCE',
  `reference_id` INT NOT NULL COMMENT 'bill_id, po_id, invoice_id, etc.',
  `reference_number` VARCHAR(200) NULL COMMENT 'Bill/PO/Invoice number for display',
  `amount` DECIMAL(18, 6) NOT NULL COMMENT 'Allocated amount in bank currency',
  `amount_base` DECIMAL(18, 6) NOT NULL COMMENT 'Allocated amount in base currency (AED)',
  `fx_rate` DECIMAL(18, 6) NULL COMMENT 'Exchange rate used for this allocation',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `created_by` INT NULL,
  CONSTRAINT `fk_allocation_payment` FOREIGN KEY (`payment_id`) REFERENCES `tbl_payment` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_allocation_created_by` FOREIGN KEY (`created_by`) REFERENCES `user` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  INDEX `idx_allocation_payment` (`payment_id`),
  INDEX `idx_allocation_reference` (`allocation_type`, `reference_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

