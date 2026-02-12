CREATE TABLE IF NOT EXISTS operation_stage_transitions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  operationdetails_id INT NOT NULL,
  from_stage VARCHAR(50) NOT NULL,
  to_stage VARCHAR(50) NOT NULL,
  supplier_logger_installed ENUM('YES','NO') NOT NULL,
  logger_count INT NOT NULL DEFAULT 0,
  created_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_operation_stage_transitions_operation (operationdetails_id),
  CONSTRAINT fk_operation_stage_transitions_operation
    FOREIGN KEY (operationdetails_id) REFERENCES operation_details(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS operation_temperature_loggers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  transition_id INT NOT NULL,
  serial_no VARCHAR(100) NOT NULL,
  installation_place VARCHAR(255) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_operation_temperature_loggers_transition (transition_id),
  CONSTRAINT fk_operation_temperature_loggers_transition
    FOREIGN KEY (transition_id) REFERENCES operation_stage_transitions(id)
    ON DELETE CASCADE
);
