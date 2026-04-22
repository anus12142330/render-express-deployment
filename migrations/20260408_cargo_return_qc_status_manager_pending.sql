-- Align legacy qc_status_id 26 (pending inventory approval) with 8 (submitted for manager approval).
UPDATE cargo_returns
SET qc_status_id = 8
WHERE qc_status_id = 26 AND qc_inventory_pending = 1;
