-- Add temperature logger fields to qc_inspections table
ALTER TABLE qc_inspections
ADD COLUMN IF NOT EXISTS temperature_logger_received TINYINT(1) NULL DEFAULT NULL COMMENT '1 = Yes, 0 = No, NULL = Not answered',
ADD COLUMN IF NOT EXISTS temperature_logger_file_path VARCHAR(500) NULL DEFAULT NULL COMMENT 'Path to uploaded temperature logger file';
