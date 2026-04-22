-- Inventory adjustment: rejected status + approval audit columns + GL link
-- Safe to re-run.

-- In this project global `status.id = 2` is Rejected.
INSERT INTO status (id, name, bg_colour, colour)
SELECT 2, 'Rejected', '#FFEBEE', '#C62828'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM status WHERE id = 2);

SET @c := (
  SELECT COUNT(1) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'inventory_adjustments' AND column_name = 'approval_comment'
);
SET @sql := IF(@c = 0,
  'ALTER TABLE inventory_adjustments
     ADD COLUMN approval_comment VARCHAR(500) NULL AFTER description,
     ADD COLUMN approved_by INT NULL,
     ADD COLUMN approved_at DATETIME NULL,
     ADD COLUMN rejection_reason VARCHAR(500) NULL,
     ADD COLUMN rejected_by INT NULL,
     ADD COLUMN rejected_at DATETIME NULL,
     ADD COLUMN gl_journal_id INT NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
