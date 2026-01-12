-- Add edit request fields to tbl_fund_transfer
ALTER TABLE `tbl_fund_transfer`
ADD COLUMN `edit_request_status` TINYINT(1) DEFAULT 0 COMMENT '0=None, 1=Approved, 2=Rejected, 3=Pending' AFTER `status_id`,
ADD COLUMN `edit_requested_by` INT NULL AFTER `edit_request_status`,
ADD COLUMN `edit_requested_at` DATETIME NULL AFTER `edit_requested_by`,
ADD COLUMN `edit_request_reason` TEXT NULL AFTER `edit_requested_at`,
ADD COLUMN `edit_approved_by` INT NULL AFTER `edit_request_reason`,
ADD COLUMN `edit_approved_at` DATETIME NULL AFTER `edit_approved_by`,
ADD COLUMN `edit_rejection_reason` TEXT NULL AFTER `edit_approved_at`,
ADD FOREIGN KEY (`edit_requested_by`) REFERENCES `user` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
ADD FOREIGN KEY (`edit_approved_by`) REFERENCES `user` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;
