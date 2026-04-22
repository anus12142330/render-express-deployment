-- Inventory adjustment: lines table + status_id / reason_id (replaces lines_json, status enum, reason varchar)
-- Requires MySQL 8+ (JSON_TABLE). Run after 20260409 and 20260412. Intended to run once.

-- 1) Status lookup (draft / adjusted)
CREATE TABLE IF NOT EXISTS inventory_adjustment_statuses (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  code VARCHAR(32) NOT NULL,
  name VARCHAR(64) NOT NULL,
  UNIQUE KEY uq_inv_adj_st_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO inventory_adjustment_statuses (id, code, name) VALUES
  (1, 'draft', 'Draft'),
  (2, 'adjusted', 'Adjusted');

-- 2) Line items (replaces JSON blob)
CREATE TABLE IF NOT EXISTS inventory_adjustment_lines (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  inventory_adjustment_id INT UNSIGNED NOT NULL,
  line_no INT UNSIGNED NOT NULL DEFAULT 0,
  product_id INT UNSIGNED NULL,
  product_name VARCHAR(512) NULL,
  batch_id INT UNSIGNED NULL,
  batch_no VARCHAR(128) NULL,
  qty_available DECIMAL(18,6) NULL,
  qty_adjusted DECIMAL(18,6) NULL,
  new_qty_on_hand DECIMAL(18,6) NULL,
  value_available DECIMAL(18,6) NULL,
  value_adjusted DECIMAL(18,6) NULL,
  new_value_on_hand DECIMAL(18,6) NULL,
  KEY idx_ial_adj (inventory_adjustment_id),
  CONSTRAINT fk_ial_adjustment FOREIGN KEY (inventory_adjustment_id) REFERENCES inventory_adjustments (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3) New header columns (skip if already migrated)
ALTER TABLE inventory_adjustments
  ADD COLUMN reason_id INT UNSIGNED NULL AFTER account_id;
ALTER TABLE inventory_adjustments
  ADD COLUMN status_id TINYINT UNSIGNED NULL AFTER description;

-- 4) Backfill status_id from legacy ENUM column
UPDATE inventory_adjustments
SET status_id = CASE `status`
    WHEN 'draft' THEN 1
    WHEN 'adjusted' THEN 2
    ELSE 1
  END
WHERE status_id IS NULL;

-- 5) Backfill reason_id from free-text reason → lookup name
UPDATE inventory_adjustments ia
INNER JOIN inventory_adjustment_reasons r ON r.name = ia.reason
SET ia.reason_id = r.id
WHERE ia.reason IS NOT NULL AND TRIM(ia.reason) <> '' AND ia.reason_id IS NULL;

-- 6) Migrate lines from lines_json into inventory_adjustment_lines (MySQL 8+ JSON_TABLE)
INSERT INTO inventory_adjustment_lines (
  inventory_adjustment_id, line_no, product_id, product_name, batch_id, batch_no,
  qty_available, qty_adjusted, new_qty_on_hand, value_available, value_adjusted, new_value_on_hand
)
SELECT
  ia.id,
  jt.ord,
  jt.product_id,
  jt.product_name,
  jt.batch_id,
  jt.batch_no,
  jt.qty_available,
  jt.qty_adjusted,
  jt.new_qty_on_hand,
  jt.value_available,
  jt.value_adjusted,
  jt.new_value_on_hand
FROM inventory_adjustments ia
JOIN JSON_TABLE(
  IF(
    JSON_TYPE(ia.lines_json) = 'ARRAY',
    ia.lines_json,
    IFNULL(JSON_EXTRACT(ia.lines_json, '$.lines'), JSON_ARRAY())
  ),
  '$[*]' COLUMNS (
    ord FOR ORDINALITY,
    product_id INT PATH '$.product_id' NULL ON EMPTY NULL ON ERROR,
    product_name VARCHAR(512) PATH '$.product_name' NULL ON EMPTY NULL ON ERROR,
    batch_id INT PATH '$.batch_id' NULL ON EMPTY NULL ON ERROR,
    batch_no VARCHAR(128) PATH '$.batch_no' NULL ON EMPTY NULL ON ERROR,
    qty_available DECIMAL(18,6) PATH '$.qty_available' NULL ON EMPTY NULL ON ERROR,
    qty_adjusted DECIMAL(18,6) PATH '$.qty_adjusted' NULL ON EMPTY NULL ON ERROR,
    new_qty_on_hand DECIMAL(18,6) PATH '$.new_qty_on_hand' NULL ON EMPTY NULL ON ERROR,
    value_available DECIMAL(18,6) PATH '$.value_available' NULL ON EMPTY NULL ON ERROR,
    value_adjusted DECIMAL(18,6) PATH '$.value_adjusted' NULL ON EMPTY NULL ON ERROR,
    new_value_on_hand DECIMAL(18,6) PATH '$.new_value_on_hand' NULL ON EMPTY NULL ON ERROR
  )
) AS jt
WHERE ia.lines_json IS NOT NULL
  AND JSON_VALID(ia.lines_json)
  AND NOT EXISTS (
    SELECT 1 FROM inventory_adjustment_lines x WHERE x.inventory_adjustment_id = ia.id LIMIT 1
  );

-- 7) Drop legacy columns
ALTER TABLE inventory_adjustments
  DROP COLUMN `status`,
  DROP COLUMN reason,
  DROP COLUMN lines_json;

-- 8) Enforce status_id
ALTER TABLE inventory_adjustments
  MODIFY COLUMN status_id TINYINT UNSIGNED NOT NULL DEFAULT 1;

-- 9) Foreign keys
ALTER TABLE inventory_adjustments
  ADD CONSTRAINT fk_inv_adj_status FOREIGN KEY (status_id) REFERENCES inventory_adjustment_statuses (id),
  ADD CONSTRAINT fk_inv_adj_reason FOREIGN KEY (reason_id) REFERENCES inventory_adjustment_reasons (id);
