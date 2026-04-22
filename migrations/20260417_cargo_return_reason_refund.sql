-- Cargo return: return reason + store return + refund metadata (UI-driven fields)

CREATE TABLE IF NOT EXISTS cargo_return_reasons (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_crr_active (is_active),
  KEY idx_crr_sort (sort_order, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE cargo_returns
  ADD COLUMN return_source VARCHAR(32) NULL AFTER notes,
  ADD COLUMN ar_invoice_id INT NULL AFTER return_source,
  ADD COLUMN return_reason_id INT NULL AFTER ar_invoice_id,
  ADD COLUMN return_to_store TINYINT(1) NOT NULL DEFAULT 0 AFTER return_reason_id,
  ADD COLUMN return_to_store_date DATE NULL AFTER return_to_store,
  ADD COLUMN refund_type VARCHAR(16) NULL AFTER return_to_store_date;

ALTER TABLE cargo_returns
  ADD KEY idx_cr_reason (return_reason_id),
  ADD KEY idx_cr_invoice (ar_invoice_id),
  ADD CONSTRAINT fk_cr_return_reason FOREIGN KEY (return_reason_id) REFERENCES cargo_return_reasons (id);

