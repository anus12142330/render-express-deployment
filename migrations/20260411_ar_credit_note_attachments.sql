-- Supporting documents for customer credit notes (draft/edit flow)

CREATE TABLE IF NOT EXISTS ar_credit_notes_attachments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  credit_note_id INT NOT NULL,
  file_name VARCHAR(512) NOT NULL,
  file_path VARCHAR(1024) NOT NULL,
  mime_type VARCHAR(128) NULL,
  size_bytes INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ar_cna_cn (credit_note_id),
  CONSTRAINT fk_ar_cna_cn FOREIGN KEY (credit_note_id) REFERENCES ar_credit_notes (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
