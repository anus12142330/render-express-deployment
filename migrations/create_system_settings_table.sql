-- Create system_settings table if it doesn't exist
CREATE TABLE IF NOT EXISTS `system_settings` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `setting_key` VARCHAR(100) NOT NULL UNIQUE COMMENT 'Unique key for the setting',
  `setting_value` TEXT NULL COMMENT 'Value of the setting (can be JSON, boolean, string, etc.)',
  `setting_type` VARCHAR(50) NOT NULL DEFAULT 'boolean' COMMENT 'Type: boolean, string, number, json',
  `description` TEXT NULL COMMENT 'Description of what this setting does',
  `created_by` INT NULL COMMENT 'FK to user table',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_by` INT NULL COMMENT 'FK to user table',
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_setting_key` (`setting_key`),
  FOREIGN KEY (`created_by`) REFERENCES `user` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  FOREIGN KEY (`updated_by`) REFERENCES `user` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert default inventory_movement_enabled setting (default: yes/1)
INSERT INTO `system_settings` (`setting_key`, `setting_value`, `setting_type`, `description`)
VALUES ('inventory_movement_enabled', '1', 'boolean', 'Enable/disable all inventory movements. When disabled, no data will be entered into inventory_transactions or inventory_stock_batches tables for Purchase, Customer, or QC operations.')
ON DUPLICATE KEY UPDATE 
  `setting_value` = `setting_value`,
  `description` = VALUES(`description`);

