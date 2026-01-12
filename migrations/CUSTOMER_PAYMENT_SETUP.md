# Customer Payment (INWARD) Module - Database Structure

## Overview
This document describes the database structure for the Customer Payment (INWARD) module, which mirrors the Supplier Payment (OUTWARD) module structure.

## Database Tables

### 1. `tbl_payment`
Main payment table (shared by both INWARD and OUTWARD payments)

**Key Columns:**
- `id` - Primary key
- `payment_uniqid` - Unique identifier (format: `in_xxxxxxxxxxxxxxxx`)
- `payment_number` - Auto-generated number (format: `PAY-IN-000001`)
- `transaction_date` - Payment date
- `payment_type` - ENUM('CASH', 'CHEQUE', 'TT')
- `payment_type_id` - FK to `payment_type` table
- `bank_account_id` - FK to `acc_bank_details` (nullable for CASH)
- `cash_account_id` - FK to `acc_bank_details` (for CASH payments)
- `cheque_no` - Cheque number (for CHEQUE type)
- `cheque_date` - Cheque date (for CHEQUE type)
- `tt_ref_no` - TT reference number (for TT type)
- `value_date` - Value date (for TT type)
- `reference_no` - General reference number
- `direction` - ENUM('IN', 'OUT') - 'IN' for customer payments
- `party_type` - ENUM('CUSTOMER', 'SUPPLIER', 'OTHER') - 'CUSTOMER' for inward
- `party_id` - Customer ID (vendor.id where company_type_id = 2)
- `currency_id` - FK to `currency` table
- `currency_code` - Currency code (e.g., 'AED', 'USD')
- `total_amount_bank` - Amount in bank/cash currency
- `total_amount_base` - Amount in base currency (AED)
- `fx_rate` - Exchange rate used
- `notes` - Payment notes
- `status_id` - FK to `status` table (3=DRAFT, 8=SUBMITTED, 1=APPROVED, 2=REJECTED)
- `approved_by` - FK to `user` table
- `approved_at` - Approval timestamp
- `edit_request_status` - TINYINT (0=None, 1=Approved, 2=Rejected, 3=Pending)
- `edit_requested_by` - FK to `user` table
- `edit_requested_at` - Edit request timestamp
- `edit_request_reason` - Reason for edit request
- `edit_approved_by` - FK to `user` table
- `edit_approved_at` - Edit approval/rejection timestamp
- `edit_rejection_reason` - Reason for edit rejection
- `is_deleted` - Soft delete flag (0=Active, 1=Deleted)
- `created_by` - FK to `user` table
- `created_at` - Creation timestamp
- `updated_by` - FK to `user` table
- `updated_at` - Last update timestamp

### 2. `tbl_payment_allocation`
Payment allocation table (links payments to invoices/bills/POs)

**Key Columns:**
- `id` - Primary key
- `payment_id` - FK to `tbl_payment`
- `alloc_type` - VARCHAR(50) - 'invoice' for customer payments
- `bill_id` - FK to `ap_bills` (for supplier payments)
- `po_id` - FK to `purchase_orders` (for advance payments)
- `invoice_id` - FK to `ar_invoices` (for customer payments)
- `buyer_id` - FK to `vendor` table (customer ID for INWARD payments)
- `supplier_id` - FK to `vendor` table (supplier ID for OUTWARD payments)
- `amount_bank` - Allocated amount in bank currency
- `amount_base` - Allocated amount in base currency (AED)
- `created_by` - FK to `user` table
- `created_at` - Creation timestamp

### 3. `tbl_payment_attachments`
Payment file attachments

**Key Columns:**
- `id` - Primary key
- `payment_id` - FK to `tbl_payment`
- `file_name` - Original file name
- `file_path` - File path in uploads directory
- `mime_type` - MIME type
- `size_bytes` - File size in bytes
- `created_by` - FK to `user` table
- `created_at` - Creation timestamp

## Migration Files

### Required Migrations (in order):
1. `create_tbl_payment_tables.sql` - Creates base payment tables
2. `update_tbl_payment_for_outward.sql` - Adds payment type fields, status_id, etc.
3. `add_payment_type_id_to_tbl_payment.sql` - Adds payment_type_id and creates payment_type table
4. `add_reconcile_fields_to_tbl_payment.sql` - Adds invoice_id to allocations and reconcile fields
5. `create_tbl_payment_attachments.sql` - Creates attachments table
6. `add_customer_payment_fields.sql` - Adds edit request fields, currency_id, is_deleted, buyer_id, supplier_id
7. `add_outstanding_amount_to_ar_invoices.sql` - Adds outstanding_amount column to ar_invoices table
8. `add_open_balance_to_ar_invoices.sql` - Adds open_balance column to ar_invoices table
9. `add_open_balance_to_proforma_invoice.sql` - Adds open_balance column to proforma_invoice table
10. `add_proforma_id_to_payment_allocation.sql` - Adds proforma_id column to tbl_payment_allocation table

## GL Journal Integration

### Journal Entry Structure:
- **Source Type**: `INWARD_PAYMENT`
- **Source ID**: `tbl_payment.id`
- **Journal Lines** (per allocation):
  - **Debit**: Bank Account (from `acc_bank_details.coa_id`)
  - **Credit**: Accounts Receivable (id: 1, name: "Accounts Receivable (A/R)")
  - **Description**: "Invoice payment {invoice_number} - {payment_number}"
  - **buyer_id**: Customer ID
  - **invoice_id**: Invoice ID

## Chart of Accounts Used

- **Accounts Receivable (A/R)**: ID 1 (from `acc_chart_accounts`)
- **Bank Accounts**: From `acc_bank_details.coa_id` (e.g., "Mashreq Bank - AED" = ID 4)
- **Cash**: ID 3 (from `acc_chart_accounts`)

## Status Flow

1. **DRAFT** (status_id = 3) - Initial state when payment is created
2. **SUBMITTED FOR APPROVAL** (status_id = 8) - User submits for approval
3. **APPROVED** (status_id = 1) - Approved, GL journal created
4. **REJECTED** (status_id = 2) - Rejected by approver

## Edit Request Flow

1. User requests edit on approved payment → `edit_request_status = 3`
2. Approver approves edit request → `edit_request_status = 1` (payment becomes editable)
3. Approver rejects edit request → `edit_request_status = 2`

## Outstanding Amount Calculation

For customer invoices:
```sql
outstanding_amount = invoice.total - SUM(
  CASE 
    WHEN payment.currency_id = invoice.currency_id THEN allocation.amount_bank
    ELSE allocation.amount_base
  END
)
WHERE payment.is_deleted = 0
```

## File Structure

### Backend Files:
- `server/routes/inwardPayments.js` - All API routes
- `server/server.js` - Route registration

### Frontend Files:
- `src/views/sales/CustomerInwardPaymentModal.jsx` - Payment form modal
- `src/views/sales/CustomerPayments.jsx` - Payment list page
- `src/views/sales/CustomerPaymentDetailView.jsx` - Payment detail view
- `src/views/sales/CustomerPaymentApprovalView.jsx` - Approval view
- `src/views/approvals/CustomerPaymentApprovalList.jsx` - Approval list
- `src/routes/MainRoutes.jsx` - Route definitions

## API Endpoints

### Customer Payment APIs:
- `GET /api/payments/customers/search?q=` - Search customers
- `GET /api/payments/customer/:id/open-invoices?currency_id=` - Get open invoices
- `GET /api/payments/inward` - List payments
- `GET /api/payments/inward/:id` - Get payment
- `POST /api/payments/inward` - Create payment
- `PUT /api/payments/inward/:id` - Update payment
- `POST /api/payments/inward/:id/approve` - Approve payment
- `PUT /api/payments/inward/:id/status` - Update status
- `POST /api/payments/inward/:id/request-edit` - Request edit
- `POST /api/payments/inward/:id/decide-edit-request` - Approve/reject edit request
- `GET /api/payments/inward/:id/attachments` - Get attachments
- `POST /api/payments/inward/:id/attachments` - Add attachments
- `DELETE /api/payments/inward/:id/attachments/:attachmentId` - Delete attachment
- `GET /api/payments/inward/:id/journal-entries` - Get GL journal entries
- `GET /api/payments/inward/:id/history` - Get payment history
- `DELETE /api/payments/inward/:id` - Delete payment

## Permissions Required

- `Sales` module - For create/edit/delete operations
- `CUSTOMER_PAYMENT` module with `approve` action - For approval operations
