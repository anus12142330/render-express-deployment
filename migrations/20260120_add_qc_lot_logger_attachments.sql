-- QC lot logger attachments (TDS file and photos)
CREATE TABLE IF NOT EXISTS qc_lot_logger_files (
  id INT AUTO_INCREMENT PRIMARY KEY,
  qc_lot_id INT NOT NULL,
  shipment_id INT NOT NULL,
  shipment_logger_id INT NULL,
  container_id INT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_path VARCHAR(500) NOT NULL,
  mime_type VARCHAR(100) NULL,
  size_bytes BIGINT NULL,
  created_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_qc_lot_logger_files_lot (qc_lot_id),
  INDEX idx_qc_lot_logger_files_shipment (shipment_id),
  INDEX idx_qc_lot_logger_files_logger (shipment_logger_id),
  CONSTRAINT fk_qc_lot_logger_files_lot
    FOREIGN KEY (qc_lot_id) REFERENCES qc_lots(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_qc_lot_logger_files_shipment
    FOREIGN KEY (shipment_id) REFERENCES shipment(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_qc_lot_logger_files_logger
    FOREIGN KEY (shipment_logger_id) REFERENCES shipment_temperature_loggers(id)
    ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS qc_lot_logger_photos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  qc_lot_id INT NOT NULL,
  shipment_id INT NOT NULL,
  shipment_logger_id INT NULL,
  container_id INT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_path VARCHAR(500) NOT NULL,
  mime_type VARCHAR(100) NULL,
  size_bytes BIGINT NULL,
  created_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_qc_lot_logger_photos_lot (qc_lot_id),
  INDEX idx_qc_lot_logger_photos_shipment (shipment_id),
  INDEX idx_qc_lot_logger_photos_logger (shipment_logger_id),
  CONSTRAINT fk_qc_lot_logger_photos_lot
    FOREIGN KEY (qc_lot_id) REFERENCES qc_lots(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_qc_lot_logger_photos_shipment
    FOREIGN KEY (shipment_id) REFERENCES shipment(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_qc_lot_logger_photos_logger
    FOREIGN KEY (shipment_logger_id) REFERENCES shipment_temperature_loggers(id)
    ON DELETE SET NULL
);
