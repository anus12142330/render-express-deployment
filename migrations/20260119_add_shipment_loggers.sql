ALTER TABLE shipment
ADD COLUMN supplier_logger_installed ENUM('YES','NO') NULL AFTER purchase_bill_id,
ADD COLUMN logger_count INT NOT NULL DEFAULT 0 AFTER supplier_logger_installed;

CREATE TABLE IF NOT EXISTS shipment_temperature_loggers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  shipment_id INT NOT NULL,
  serial_no VARCHAR(100) NOT NULL,
  installation_place VARCHAR(255) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_shipment_temperature_loggers_shipment (shipment_id),
  CONSTRAINT fk_shipment_temperature_loggers_shipment
    FOREIGN KEY (shipment_id) REFERENCES shipment(id)
    ON DELETE CASCADE
);
