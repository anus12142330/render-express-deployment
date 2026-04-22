-- Cargo return QC: record decision first (no inventory), then approve to post inventory.
-- Safe to run multiple times.

SET @crl_pending_acc := (
  SELECT COUNT(1) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'cargo_return_lines' AND column_name = 'pending_accepted_qty'
);
SET @sql_crlacc := IF(@crl_pending_acc = 0,
  'ALTER TABLE cargo_return_lines ADD COLUMN pending_accepted_qty DECIMAL(18,4) NULL DEFAULT NULL AFTER rejected_qty',
  'SELECT 1');
PREPARE stmt FROM @sql_crlacc; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @crl_pending_rej := (
  SELECT COUNT(1) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'cargo_return_lines' AND column_name = 'pending_rejected_qty'
);
SET @sql_crlrej := IF(@crl_pending_rej = 0,
  'ALTER TABLE cargo_return_lines ADD COLUMN pending_rejected_qty DECIMAL(18,4) NULL DEFAULT NULL AFTER pending_accepted_qty',
  'SELECT 1');
PREPARE stmt FROM @sql_crlrej; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @cr_qc_inv := (
  SELECT COUNT(1) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'cargo_returns' AND column_name = 'qc_inventory_pending'
);
SET @sql_crinv := IF(@cr_qc_inv = 0,
  'ALTER TABLE cargo_returns ADD COLUMN qc_inventory_pending TINYINT(1) NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt FROM @sql_crinv; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- QC status: QC decision recorded; awaiting approval to post inventory (id 26 — avoid low ids used elsewhere)
INSERT INTO status (id, name, bg_colour, colour)
SELECT 26, 'Cargo return — pending inventory approval', '#FFF3E0', '#E65100'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM status WHERE id = 26);
