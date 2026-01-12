-- Create tbl_fund_transfer_attachments table for fund transfer file attachments
CREATE TABLE IF NOT EXISTS `tbl_fund_transfer_attachments` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `transfer_id` INT NOT NULL,
  `file_name` VARCHAR(255) NOT NULL,
  `file_path` VARCHAR(500) NOT NULL,
  `mime_type` VARCHAR(100) NULL,
  `size_bytes` BIGINT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `created_by` INT NULL,
  CONSTRAINT `fk_fund_transfer_attachment_transfer` FOREIGN KEY (`transfer_id`) REFERENCES `tbl_fund_transfer` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_fund_transfer_attachment_created_by` FOREIGN KEY (`created_by`) REFERENCES `user` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  INDEX `idx_fund_transfer_attachment_transfer` (`transfer_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
