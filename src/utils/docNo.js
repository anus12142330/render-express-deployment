// server/src/utils/docNo.js
// Document number generation utility

/**
 * Generate next document number with pattern: PREFIX-YYYY-XXXX
 */
async function generateNextDocNumber(conn, prefix, options = {}) {
    const {
        width = 4,
        table,
        column = 'bill_number',
        year = new Date().getFullYear()
    } = options;

    if (!table) {
        throw new Error('Table name is required');
    }

    const yearStr = String(year);
    const pattern = `${prefix}-${yearStr}-%`;

    const [rows] = await conn.query(
        `SELECT ${column} FROM ${table} WHERE ${column} LIKE ? ORDER BY id DESC LIMIT 1`,
        [pattern]
    );

    let nextSeq = 1;
    if (rows.length > 0) {
        const lastNumber = rows[0][column];
        const match = lastNumber.match(new RegExp(`${prefix}-${yearStr}-(\\d+)$`));
        if (match) {
            nextSeq = parseInt(match[1], 10) + 1;
        }
    }

    const seqStr = String(nextSeq).padStart(width, '0');
    return `${prefix}-${yearStr}-${seqStr}`;
}

async function generateAPBillNumber(conn, year = new Date().getFullYear()) {
    return generateNextDocNumber(conn, 'APB', {
        table: 'ap_bills',
        column: 'bill_number',
        year,
        width: 4
    });
}

async function generateAPPaymentNumber(conn, year = new Date().getFullYear()) {
    return generateNextDocNumber(conn, 'APP', {
        table: 'ap_payments',
        column: 'payment_number',
        year,
        width: 4
    });
}

async function generateARInvoiceNumber(conn, year = new Date().getFullYear()) {
    return generateNextDocNumber(conn, 'ARI', {
        table: 'ar_invoices',
        column: 'invoice_number',
        year,
        width: 4
    });
}

async function generateARReceiptNumber(conn, year = new Date().getFullYear()) {
    return generateNextDocNumber(conn, 'ARR', {
        table: 'ar_receipts',
        column: 'receipt_number',
        year,
        width: 4
    });
}

async function generateGLJournalNumber(conn, year = new Date().getFullYear()) {
    return generateNextDocNumber(conn, 'GLJ', {
        table: 'gl_journals',
        column: 'journal_number',
        year,
        width: 4
    });
}

module.exports = {
    generateNextDocNumber,
    generateAPBillNumber,
    generateAPPaymentNumber,
    generateARInvoiceNumber,
    generateARReceiptNumber,
    generateGLJournalNumber
};

