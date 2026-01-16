CREATE TABLE IF NOT EXISTS shipment_calculator_master (
  id INT NOT NULL AUTO_INCREMENT,
  location_code VARCHAR(10) NOT NULL, -- 'Dubai' | 'AUH'
  clearance_charges DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  loading_charges DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  transportation DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_shipment_calc_location (location_code)
);
