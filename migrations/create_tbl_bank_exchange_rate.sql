-- Create tbl_bank_exchange_rate table for managing exchange rates per bank account
CREATE TABLE IF NOT EXISTS `tbl_bank_exchange_rate` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `bank_account_id` INT(200) NOT NULL,
  `effective_from` DATE NOT NULL,
  `rate_to_aed` DECIMAL(18, 6) NOT NULL COMMENT '1 currency = ? AED',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `created_by` INT NULL,
  FOREIGN KEY (`bank_account_id`) REFERENCES `acc_bank_details` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  UNIQUE KEY `unique_bank_date` (`bank_account_id`, `effective_from`),
  INDEX `idx_bank_account` (`bank_account_id`),
  INDEX `idx_effective_from` (`effective_from`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

