-- Dispatch vehicle/driver pairs (separate from fleet/driver masters).
-- One row per (client, vehicle_name, driver_name) ever used; drivers are linked to vehicle.
-- Run this once to create the table.

CREATE TABLE IF NOT EXISTS sales_dispatch_vehicle_driver (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_id INT NOT NULL,
  vehicle_name VARCHAR(255) NOT NULL,
  driver_name VARCHAR(255) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_client_vehicle_driver (client_id, vehicle_name, driver_name),
  KEY idx_client (client_id),
  KEY idx_client_vehicle (client_id, vehicle_name)
);
