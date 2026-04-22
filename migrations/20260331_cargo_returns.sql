-- Cargo return documents (header + lines) — list shows these, not raw delivered SOs
CREATE TABLE IF NOT EXISTS cargo_returns (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  client_id INT NOT NULL DEFAULT 1,
  sales_order_id INT NOT NULL,
  return_no VARCHAR(64) NULL,
  document_date DATE NULL,
  status_id INT NOT NULL DEFAULT 3 COMMENT 'status.id; e.g. 3 Draft, 8 Submitted for approval',
  notes TEXT NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_cr_client (client_id),
  KEY idx_cr_so (sales_order_id),
  KEY idx_cr_created (created_by),
  KEY idx_cr_return_status (status_id),
  CONSTRAINT fk_cr_sales_order FOREIGN KEY (sales_order_id) REFERENCES sales_orders (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cargo_return_lines (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  cargo_return_id INT NOT NULL,
  dispatch_id INT NULL,
  dispatch_item_id INT NULL,
  sales_order_item_id INT NULL,
  product_name VARCHAR(512) NULL,
  dispatched_qty DECIMAL(18,4) NOT NULL DEFAULT 0,
  return_qty DECIMAL(18,4) NOT NULL DEFAULT 0,
  line_no INT NOT NULL DEFAULT 0,
  KEY idx_crl_header (cargo_return_id),
  CONSTRAINT fk_crl_cargo_return FOREIGN KEY (cargo_return_id) REFERENCES cargo_returns (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
