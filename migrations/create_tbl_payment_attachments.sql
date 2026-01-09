-- Create tbl_payment_attachments table for payment file attachments
CREATE TABLE IF NOT EXISTS `tbl_payment_attachments` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `payment_id` INT NOT NULL,
  `file_name` VARCHAR(255) NOT NULL,
  `file_path` VARCHAR(500) NOT NULL,
  `mime_type` VARCHAR(100) NULL,
  `size_bytes` BIGINT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `created_by` INT NULL,
  CONSTRAINT `fk_payment_attachment_payment` FOREIGN KEY (`payment_id`) REFERENCES `tbl_payment` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_payment_attachment_created_by` FOREIGN KEY (`created_by`) REFERENCES `user` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  INDEX `idx_payment_attachment_payment` (`payment_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

