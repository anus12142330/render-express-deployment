-- Add payment_type_id column to tbl_payment table
-- First, create payment_type master table if it doesn't exist
CREATE TABLE IF NOT EXISTS `payment_type` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(50) NOT NULL UNIQUE COMMENT 'Payment type name: CASH, CHEQUE, TT',
  `code` VARCHAR(10) NOT NULL UNIQUE COMMENT 'Payment type code',
  `description` VARCHAR(255) NULL,
  `is_active` TINYINT(1) DEFAULT 1,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_payment_type_code` (`code`),
  INDEX `idx_payment_type_active` (`is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert default payment types if they don't exist
INSERT IGNORE INTO `payment_type` (`name`, `code`, `description`) VALUES
('Cash', 'CASH', 'Cash payment'),
('Cheque', 'CHEQUE', 'Cheque payment'),
('TT', 'TT', 'Telegraphic Transfer');

-- Add payment_type_id column to tbl_payment
ALTER TABLE `tbl_payment`
  ADD COLUMN `payment_type_id` INT NULL AFTER `payment_type`,
  ADD CONSTRAINT `fk_payment_payment_type` FOREIGN KEY (`payment_type_id`) REFERENCES `payment_type` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Create index for payment_type_id
CREATE INDEX IF NOT EXISTS `idx_payment_type_id` ON `tbl_payment` (`payment_type_id`);

