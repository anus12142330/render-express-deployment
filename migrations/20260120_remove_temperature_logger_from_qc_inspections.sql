-- Remove temperature logger fields from qc_inspections table
ALTER TABLE qc_inspections
  DROP COLUMN IF EXISTS temperature_logger_received,
  DROP COLUMN IF EXISTS temperature_logger_file_path;
