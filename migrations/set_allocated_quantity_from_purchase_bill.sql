-- Set allocated_quantity = full quantity of purchase bill item
-- Run after: ALTER TABLE purchase_bill_items ADD COLUMN allocated_quantity DECIMAL(18,4) DEFAULT NULL;

-- purchase_bill_items: set allocated_quantity = quantity (full bill item qty)
UPDATE purchase_bill_items SET allocated_quantity = quantity;
