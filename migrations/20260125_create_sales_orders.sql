CREATE TABLE IF NOT EXISTS sales_orders (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  client_id BIGINT NOT NULL,
  company_id BIGINT NOT NULL,
  customer_id BIGINT NOT NULL,
  customer_address TEXT NULL,
  tax_mode ENUM('EXCLUSIVE', 'INCLUSIVE') NOT NULL,
  order_no VARCHAR(50) NOT NULL,
  order_date DATE NOT NULL,
  status_id INT NOT NULL DEFAULT 3,
  subtotal DECIMAL(18, 2) NOT NULL DEFAULT 0,
  tax_total DECIMAL(18, 2) NOT NULL DEFAULT 0,
  grand_total DECIMAL(18, 2) NOT NULL DEFAULT 0,
  created_by BIGINT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by BIGINT NULL,
  updated_at DATETIME NULL,
  UNIQUE KEY uk_client_orderno (client_id, order_no),
  INDEX idx_client_status_date (client_id, status_id, order_date)
);

CREATE TABLE IF NOT EXISTS sales_order_items (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  client_id BIGINT NOT NULL,
  sales_order_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  description VARCHAR(255) NULL,
  quantity DECIMAL(18, 3) NOT NULL,
  uom_id BIGINT NOT NULL,
  unit_price DECIMAL(18, 2) NOT NULL,
  line_subtotal DECIMAL(18, 2) NOT NULL,
  tax_rate DECIMAL(9, 4) NULL,
  line_tax DECIMAL(18, 2) NOT NULL DEFAULT 0,
  line_total DECIMAL(18, 2) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL,
  INDEX idx_so_items (client_id, sales_order_id),
  CONSTRAINT fk_so_items_header FOREIGN KEY (sales_order_id)
    REFERENCES sales_orders (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sales_order_attachments (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  client_id BIGINT NOT NULL,
  sales_order_id BIGINT NOT NULL,
  attachment_scope ENUM('HEADER', 'DISPATCH', 'COMPLETION') NOT NULL DEFAULT 'HEADER',
  original_name VARCHAR(255) NOT NULL,
  stored_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NULL,
  file_size BIGINT NULL,
  file_path VARCHAR(500) NOT NULL,
  uploaded_by BIGINT NOT NULL,
  uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_so_attach (client_id, sales_order_id, attachment_scope),
  CONSTRAINT fk_so_attach_header FOREIGN KEY (sales_order_id)
    REFERENCES sales_orders (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sales_order_approvals (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  client_id BIGINT NOT NULL,
  sales_order_id BIGINT NOT NULL,
  submitted_by BIGINT NOT NULL,
  submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approval_status ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
  decided_by BIGINT NULL,
  decided_at DATETIME NULL,
  remarks TEXT NULL,
  INDEX idx_so_approvals (client_id, approval_status),
  CONSTRAINT fk_so_approvals_header FOREIGN KEY (sales_order_id)
    REFERENCES sales_orders (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sales_order_dispatch (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  client_id BIGINT NOT NULL,
  sales_order_id BIGINT NOT NULL,
  vehicle_no VARCHAR(50) NOT NULL,
  driver_name VARCHAR(100) NOT NULL,
  dispatched_by BIGINT NOT NULL,
  dispatched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_so_dispatch (client_id, sales_order_id),
  UNIQUE KEY uk_so_dispatch (client_id, sales_order_id),
  CONSTRAINT fk_so_dispatch_header FOREIGN KEY (sales_order_id)
    REFERENCES sales_orders (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sales_order_completion (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  client_id BIGINT NOT NULL,
  sales_order_id BIGINT NOT NULL,
  client_received_by VARCHAR(120) NULL,
  client_notes TEXT NULL,
  completed_by BIGINT NOT NULL,
  completed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_so_complete (client_id, sales_order_id),
  UNIQUE KEY uk_so_complete (client_id, sales_order_id),
  CONSTRAINT fk_so_complete_header FOREIGN KEY (sales_order_id)
    REFERENCES sales_orders (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sales_order_audit (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  client_id BIGINT NOT NULL,
  sales_order_id BIGINT NOT NULL,
  action VARCHAR(50) NOT NULL,
  old_status_id INT NULL,
  new_status_id INT NULL,
  payload_json JSON NULL,
  action_by BIGINT NOT NULL,
  action_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_so_audit (client_id, sales_order_id, action_at),
  CONSTRAINT fk_so_audit_header FOREIGN KEY (sales_order_id)
    REFERENCES sales_orders (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sales_order_sequences (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  client_id BIGINT NOT NULL,
  company_id BIGINT NOT NULL,
  yy SMALLINT NOT NULL,
  mm TINYINT NOT NULL,
  last_seq INT NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_so_seq (client_id, company_id, yy, mm)
);
