-- Inventory adjustments: use global `status` table (same ids as AR / cargo returns).
-- 3 = Draft, 8 = Submitted for approval, 1 = Approved
-- Run after 20260414. Safe to re-run: remap runs only while `inventory_adjustment_statuses` exists.

INSERT INTO status (id, name, bg_colour, colour)
SELECT 3, 'Draft', '#FFF3E0', '#E65100'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM status WHERE id = 3);

INSERT INTO status (id, name, bg_colour, colour)
SELECT 8, 'Submitted for approval', '#E3F2FD', '#0288D1'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM status WHERE id = 8);

INSERT INTO status (id, name, bg_colour, colour)
SELECT 1, 'Approved', '#E8F5E9', '#2E7D32'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM status WHERE id = 1);

-- Legacy `inventory_adjustment_statuses`: 1 was draft, 2 was adjusted → map to global 3 and 1
UPDATE inventory_adjustments SET status_id = 3
WHERE status_id = 1
  AND EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = 'inventory_adjustment_statuses'
  );

UPDATE inventory_adjustments SET status_id = 1
WHERE status_id = 2
  AND EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = 'inventory_adjustment_statuses'
  );

ALTER TABLE inventory_adjustments DROP FOREIGN KEY fk_inv_adj_status;

DROP TABLE IF EXISTS inventory_adjustment_statuses;

ALTER TABLE inventory_adjustments
  ADD CONSTRAINT fk_ia_status_global FOREIGN KEY (status_id) REFERENCES `status` (id);
