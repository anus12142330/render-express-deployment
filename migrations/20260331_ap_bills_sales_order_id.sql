-- Link draft AP bills created from dispatch to the sales order (for reporting / traceability)
ALTER TABLE ap_bills
  ADD COLUMN sales_order_id INT NULL DEFAULT NULL COMMENT 'Sales order when bill was created from dispatch'
  AFTER purchase_order_id;
