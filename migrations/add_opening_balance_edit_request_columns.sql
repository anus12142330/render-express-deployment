-- Add edit request columns to opening_balance_batch table
ALTER TABLE `opening_balance_batch`
ADD COLUMN `edit_request_status` INT NULL COMMENT 'NULL=No request, 3=Pending, 1=Approved, 2=Rejected' AFTER `status_id`,
ADD COLUMN `edit_requested_by` INT NULL AFTER `edit_request_status`,
ADD COLUMN `edit_requested_at` DATETIME NULL AFTER `edit_requested_by`,
ADD COLUMN `edit_request_reason` TEXT NULL AFTER `edit_requested_at`,
ADD COLUMN `edit_approved_by` INT NULL AFTER `edit_request_reason`,
ADD COLUMN `edit_approved_at` DATETIME NULL AFTER `edit_approved_by`,
ADD COLUMN `edit_rejection_reason` TEXT NULL AFTER `edit_approved_at`,
ADD INDEX `idx_edit_request_status` (`edit_request_status`),
ADD FOREIGN KEY (`edit_requested_by`) REFERENCES `user` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
ADD FOREIGN KEY (`edit_approved_by`) REFERENCES `user` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;
