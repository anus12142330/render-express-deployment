-- Create opening_balance_batch table
CREATE TABLE IF NOT EXISTS `opening_balance_batch` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `company_id` INT NULL COMMENT 'Reference to company_settings.id',
  `batch_no` VARCHAR(50) NOT NULL UNIQUE COMMENT 'Auto-generated: OB-000001',
  `opening_date` DATE NOT NULL COMMENT 'Cut-off date for opening balances',
  `notes` TEXT NULL,
  `status_id` INT DEFAULT 3 COMMENT '3=Draft, 1=Approved, 2=Rejected',
  `gl_journal_id` INT NULL COMMENT 'Reference to gl_journals.id once posted',
  `created_by` INT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  `updated_by` INT NULL,
  `approved_by` INT NULL,
  `approved_at` DATETIME NULL,
  INDEX `idx_batch_no` (`batch_no`),
  INDEX `idx_opening_date` (`opening_date`),
  INDEX `idx_status` (`status_id`),
  INDEX `idx_company` (`company_id`),
  FOREIGN KEY (`status_id`) REFERENCES `status` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY (`gl_journal_id`) REFERENCES `gl_journals` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  FOREIGN KEY (`created_by`) REFERENCES `user` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  FOREIGN KEY (`approved_by`) REFERENCES `user` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Create opening_balance_lines table
CREATE TABLE IF NOT EXISTS `opening_balance_lines` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `batch_id` INT NOT NULL,
  `party_type` ENUM('CUSTOMER','SUPPLIER') NOT NULL,
  `party_id` INT NOT NULL COMMENT 'customer.id or vendor.id',
  `currency_code` VARCHAR(10) DEFAULT 'AED',
  `fx_rate_to_aed` DECIMAL(18, 6) DEFAULT 1.000000 COMMENT 'Exchange rate: 1 currency = ? AED',
  `debit_foreign` DECIMAL(18, 4) DEFAULT 0 COMMENT 'Debit amount in foreign currency',
  `credit_foreign` DECIMAL(18, 4) DEFAULT 0 COMMENT 'Credit amount in foreign currency',
  `debit_aed` DECIMAL(18, 4) DEFAULT 0 COMMENT 'Debit amount in AED (base currency)',
  `credit_aed` DECIMAL(18, 4) DEFAULT 0 COMMENT 'Credit amount in AED (base currency)',
  `notes` VARCHAR(255) NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_batch_id` (`batch_id`),
  INDEX `idx_party` (`party_type`, `party_id`),
  FOREIGN KEY (`batch_id`) REFERENCES `opening_balance_batch` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
