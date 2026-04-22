-- Link draft AP purchase bill (Nuragro / Bynur Agro) created from dispatch confirmation
ALTER TABLE sales_order_dispatches
  ADD COLUMN ap_bill_id INT NULL DEFAULT NULL COMMENT 'Draft AP bill linked to this dispatch'
  AFTER sales_order_id;
