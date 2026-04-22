-- Link dispatch (and other) inventory rows to the sales order for reporting and SO detail screens.
-- Run after 20260404_inventory_transactions_so_source_types.sql if you use that migration.
ALTER TABLE inventory_transactions
  ADD COLUMN sales_order_id INT NULL COMMENT 'sales_orders.id when row relates to a sales order' AFTER source_line_id;

-- Optional backfill for approval IN TRANSIT rows created before this column existed:
-- UPDATE inventory_transactions SET sales_order_id = source_id
-- WHERE source_type = 'SALES_ORDER' AND source_id IS NOT NULL AND sales_order_id IS NULL;
