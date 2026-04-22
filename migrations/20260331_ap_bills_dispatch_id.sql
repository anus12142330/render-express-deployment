-- Link draft AP bill to the sales order dispatch row
ALTER TABLE ap_bills
  ADD COLUMN dispatch_id INT NULL DEFAULT NULL COMMENT 'sales_order_dispatches.id when bill created from dispatch'
  AFTER sales_order_id;
