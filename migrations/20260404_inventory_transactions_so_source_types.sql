-- Ensure sales-order approval rows can store txn_type/source_type text (e.g. SALES_ORDER_IN_TRANSIT, SALES_ORDER).
-- If columns are ENUMs that omit these values, MySQL may store NULL/blank on insert.

ALTER TABLE inventory_transactions
  MODIFY COLUMN txn_type VARCHAR(128) NULL,
  MODIFY COLUMN source_type VARCHAR(64) NULL;

-- Optional one-time repair for rows already saved with blank types (run once if needed):
-- UPDATE inventory_transactions it
-- INNER JOIN sales_order_items soi ON soi.id = it.source_line_id AND soi.sales_order_id = it.source_id
-- SET it.source_type = 'SALES_ORDER', it.txn_type = 'SALES_ORDER_IN_TRANSIT'
-- WHERE it.movement IN ('IN TRANSIT', 'IN_TRANSIT')
--   AND (it.source_type IS NULL OR it.source_type = '')
--   AND (it.txn_type IS NULL OR it.txn_type = '')
--   AND (it.is_deleted = 0 OR it.is_deleted IS NULL);
