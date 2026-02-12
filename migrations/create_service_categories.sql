CREATE TABLE IF NOT EXISTS service_categories (
  id INT NOT NULL AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  parent_id INT DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_service_categories_parent_id (parent_id),
  CONSTRAINT fk_service_categories_parent
    FOREIGN KEY (parent_id) REFERENCES service_categories(id)
    ON DELETE SET NULL
);
