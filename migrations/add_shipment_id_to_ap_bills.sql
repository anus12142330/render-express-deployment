ALTER TABLE ap_bills
ADD COLUMN shipment_id INT NULL AFTER purchase_order_id,
ADD INDEX idx_ap_bills_shipment_id (shipment_id);

-- Optional FK (enable if shipment table exists and you want strict integrity)
-- ALTER TABLE ap_bills
-- ADD CONSTRAINT fk_ap_bills_shipment_id
-- FOREIGN KEY (shipment_id) REFERENCES shipment(id)
-- ON DELETE SET NULL;
