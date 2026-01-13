-- Migration: Create entity_ledger_balances table for cached customer/supplier balances
-- This table stores pre-calculated ledger balances from gl_journal_lines

CREATE TABLE IF NOT EXISTS `entity_ledger_balances` (
  `company_id` INT NOT NULL DEFAULT 1 COMMENT 'Reference to company_settings.id (default 1 for single company)',
  `entity_type` VARCHAR(64) NOT NULL COMMENT 'CUSTOMER or SUPPLIER',
  `entity_id` INT NOT NULL COMMENT 'customer.id or vendor.id',
  `balance` DECIMAL(18,2) NOT NULL DEFAULT 0.00 COMMENT 'Base currency balance = SUM(debit) - SUM(credit)',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`company_id`, `entity_type`, `entity_id`),
  INDEX `idx_entity_lookup` (`entity_type`, `entity_id`),
  INDEX `idx_updated_at` (`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='Cached ledger balances for customers and suppliers calculated from gl_journal_lines';
