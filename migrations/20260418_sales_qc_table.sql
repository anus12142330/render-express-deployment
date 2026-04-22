-- Separate Sales QC tracking from cargo_returns (1 row per cargo return)

CREATE TABLE IF NOT EXISTS sales_qc (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  cargo_return_id INT NOT NULL,
  client_id INT NOT NULL DEFAULT 1,
  qc_status_id INT NULL,
  qc_decision VARCHAR(16) NULL,
  qc_comment TEXT NULL,
  qc_manager_id INT NULL,
  qc_inventory_pending TINYINT(1) NOT NULL DEFAULT 0,
  manager_approval_comment TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sales_qc_return (cargo_return_id),
  KEY idx_sales_qc_status (qc_status_id),
  CONSTRAINT fk_sales_qc_cr FOREIGN KEY (cargo_return_id) REFERENCES cargo_returns (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

