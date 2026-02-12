-- Create sales_order_sequences if missing (e.g. when sales_orders was created without this table)
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
