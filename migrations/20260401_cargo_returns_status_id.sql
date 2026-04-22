-- Replace cargo_returns.status (varchar) with status_id → status table.
-- Draft = 3, Submitted for approval = 8 (must exist in your `status` master).
-- For DBs created from 20260331 with column `status`. Run once.

ALTER TABLE cargo_returns
  ADD COLUMN status_id INT NULL AFTER document_date;

UPDATE cargo_returns SET status_id = 8
WHERE LOWER(COALESCE(status, '')) LIKE '%submit%';

UPDATE cargo_returns SET status_id = 3 WHERE status_id IS NULL;

ALTER TABLE cargo_returns
  MODIFY COLUMN status_id INT NOT NULL DEFAULT 3;

ALTER TABLE cargo_returns DROP COLUMN status;

ALTER TABLE cargo_returns ADD KEY idx_cr_return_status (status_id);
