-- Inventory adjustments (Accounts module)
CREATE TABLE IF NOT EXISTS inventory_adjustments (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  adjustment_uniqid VARCHAR(36) NOT NULL,
  adjustment_no VARCHAR(64) NOT NULL,
  mode ENUM('quantity','value') NOT NULL DEFAULT 'quantity',
  reference_no VARCHAR(128) NULL,
  adjustment_date DATE NOT NULL,
  account_id INT NULL,
  reason VARCHAR(255) NULL,
  warehouse_id INT NULL,
  description VARCHAR(500) NULL,
  status ENUM('draft','adjusted') NOT NULL DEFAULT 'draft',
  lines_json JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by INT NULL,
  UNIQUE KEY uq_inv_adj_uniqid (adjustment_uniqid),
  KEY idx_inv_adj_no (adjustment_no),
  KEY idx_inv_adj_date (adjustment_date),
  KEY idx_inv_adj_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
