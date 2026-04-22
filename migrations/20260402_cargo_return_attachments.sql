-- Attachments for cargo return documents (draft uploads; deleted with header via CASCADE)
CREATE TABLE IF NOT EXISTS cargo_return_attachments (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  cargo_return_id INT NOT NULL,
  file_original_name VARCHAR(512) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_type VARCHAR(128) NULL,
  file_size INT NULL,
  file_path VARCHAR(1024) NOT NULL,
  uploaded_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_cr_att_header (cargo_return_id),
  CONSTRAINT fk_cr_att_cargo FOREIGN KEY (cargo_return_id) REFERENCES cargo_returns (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
