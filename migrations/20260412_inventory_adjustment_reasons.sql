-- Lookup reasons for inventory adjustments (dropdown in UI)
CREATE TABLE IF NOT EXISTS inventory_adjustment_reasons (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_inv_adj_reason_name (name),
  KEY idx_inv_adj_reason_sort (sort_order, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO inventory_adjustment_reasons (name, sort_order) VALUES
  ('Damaged goods', 10),
  ('Expired stock', 20),
  ('Lost / missing', 30),
  ('Found stock', 40),
  ('Stock count correction', 50),
  ('Revaluation', 60),
  ('Other', 70);
