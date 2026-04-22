-- File attachments for inventory adjustments (served under /uploads/inventory_adjustments/files/)
CREATE TABLE IF NOT EXISTS inventory_adjustment_attachments (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  inventory_adjustment_id INT UNSIGNED NOT NULL,
  file_original_name VARCHAR(512) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_type VARCHAR(128) NULL,
  file_size INT NULL,
  file_path VARCHAR(1024) NOT NULL,
  uploaded_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ia_att_header (inventory_adjustment_id),
  CONSTRAINT fk_ia_att_adjustment FOREIGN KEY (inventory_adjustment_id) REFERENCES inventory_adjustments (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
