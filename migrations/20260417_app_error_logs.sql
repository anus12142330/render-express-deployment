-- App error logs (web + mobile + server)
CREATE TABLE IF NOT EXISTS app_error_logs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  source ENUM('WEB','MOBILE','SERVER') NOT NULL,
  severity ENUM('ERROR','WARN') NOT NULL DEFAULT 'ERROR',

  message TEXT NOT NULL,
  stack LONGTEXT NULL,

  context_json JSON NULL,

  device_id VARCHAR(128) NULL,
  device_type ENUM('WEB','ANDROID','IOS','UNKNOWN') NOT NULL DEFAULT 'UNKNOWN',
  app_version VARCHAR(64) NULL,

  user_id BIGINT NULL,
  user_email VARCHAR(255) NULL,

  request_id VARCHAR(128) NULL,
  session_id VARCHAR(128) NULL,

  url VARCHAR(1024) NULL,
  api_path VARCHAR(512) NULL,

  PRIMARY KEY (id),
  KEY idx_app_error_logs_created_at (created_at),
  KEY idx_app_error_logs_source_created_at (source, created_at),
  KEY idx_app_error_logs_user_created_at (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

