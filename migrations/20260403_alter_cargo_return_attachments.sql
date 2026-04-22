-- Ensure cargo_return_attachments matches expected schema.
-- Safe to run multiple times (uses information_schema guards where needed).

CREATE TABLE IF NOT EXISTS cargo_return_attachments (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  cargo_return_id INT NOT NULL,
  scope VARCHAR(32) NOT NULL DEFAULT 'RETURN',
  file_original_name VARCHAR(512) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_type VARCHAR(128) NULL,
  file_size BIGINT NULL,
  file_path VARCHAR(1024) NOT NULL,
  uploaded_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Column alignment (no-ops if already correct)
ALTER TABLE cargo_return_attachments
  ADD COLUMN IF NOT EXISTS scope VARCHAR(32) NOT NULL DEFAULT 'RETURN' AFTER cargo_return_id,
  MODIFY COLUMN file_original_name VARCHAR(512) NOT NULL,
  MODIFY COLUMN file_name VARCHAR(255) NOT NULL,
  MODIFY COLUMN file_type VARCHAR(128) NULL,
  MODIFY COLUMN file_size BIGINT NULL,
  MODIFY COLUMN file_path VARCHAR(1024) NOT NULL,
  MODIFY COLUMN uploaded_by INT NULL;

-- Add index if missing
SET @idx_exists := (
  SELECT COUNT(1)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'cargo_return_attachments'
    AND index_name = 'idx_cr_att_header'
);
SET @sql_idx := IF(@idx_exists = 0,
  'ALTER TABLE cargo_return_attachments ADD KEY idx_cr_att_header (cargo_return_id)',
  'SELECT 1'
);
PREPARE stmt FROM @sql_idx; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Add FK if missing
SET @fk_exists := (
  SELECT COUNT(1)
  FROM information_schema.referential_constraints
  WHERE constraint_schema = DATABASE()
    AND table_name = 'cargo_return_attachments'
    AND constraint_name = 'fk_cr_att_cargo'
);
SET @sql_fk := IF(@fk_exists = 0,
  'ALTER TABLE cargo_return_attachments ADD CONSTRAINT fk_cr_att_cargo FOREIGN KEY (cargo_return_id) REFERENCES cargo_returns (id) ON DELETE CASCADE',
  'SELECT 1'
);
PREPARE stmt2 FROM @sql_fk; EXECUTE stmt2; DEALLOCATE PREPARE stmt2;

