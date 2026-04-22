-- Link cargo-return QC / dispatch-related inventory rows to sales_order_dispatches.id
ALTER TABLE inventory_transactions
  ADD COLUMN dispatch_id INT NULL COMMENT 'sales_order_dispatches.id when row relates to a dispatch'
  AFTER sales_order_id;
