-- Dashboard widgets master (Super Admin config) + role mapping
-- Safe-ish to re-run.

CREATE TABLE IF NOT EXISTS dashboard_widgets (
  id INT NOT NULL AUTO_INCREMENT,
  widget_key VARCHAR(60) NOT NULL,
  title VARCHAR(120) NOT NULL,
  widget_type VARCHAR(20) NOT NULL DEFAULT 'link', -- 'link' | 'kpi' (extend later)
  route_path VARCHAR(255) NULL,
  api_path VARCHAR(255) NULL,
  module_key VARCHAR(60) NULL,
  action_key VARCHAR(30) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_dashboard_widgets_key (widget_key),
  KEY idx_dashboard_widgets_active (is_active),
  KEY idx_dashboard_widgets_sort (sort_order)
);

CREATE TABLE IF NOT EXISTS dashboard_widget_roles (
  widget_id INT NOT NULL,
  role_id INT NOT NULL,
  PRIMARY KEY (widget_id, role_id),
  KEY idx_dwr_role (role_id),
  CONSTRAINT fk_dwr_widget FOREIGN KEY (widget_id) REFERENCES dashboard_widgets(id) ON DELETE CASCADE,
  CONSTRAINT fk_dwr_role FOREIGN KEY (role_id) REFERENCES role(id) ON DELETE CASCADE
);

