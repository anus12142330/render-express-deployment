// server/src/utils/docNo.cjs
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
    const opts = (typeof year === 'object' && year !== null)
        ? year
        : { year };
    const docYear = Number(opts.year || new Date().getFullYear());
    const companyId = opts.companyId || opts.company_id || null;
    const baseDate = opts.date ? new Date(opts.date) : new Date();
    const yy = String(baseDate.getFullYear()).slice(-2);
    const yyyy = String(baseDate.getFullYear());
    const mm = String(baseDate.getMonth() + 1).padStart(2, '0');

    // Optional company-specific format (same style as Sales Order)
    const resolveCompanyInvoiceFormat = async () => {
        if (!companyId) return { prefix: 'ARI', format: null };
        try {
            const [rows] = await conn.query(
                `SELECT company_prefix, customer_invoice_no_format
                 FROM company_settings
                 WHERE id = ?
                 LIMIT 1`,
                [companyId]
            );
            const row = rows?.[0] || {};
            return {
                prefix: row.company_prefix || 'ARI',
                format: (row.customer_invoice_no_format || '').trim() || null
            };
        } catch {
            return { prefix: 'ARI', format: null };
        }
    };

    const { prefix, format } = await resolveCompanyInvoiceFormat();
    const seqMatch = String(format || '').match(/\{seq(?::(\d+)|(\d+))?\}/i);
    const seqWidth = Number(seqMatch?.[1] || seqMatch?.[2] || 4);
    const safeSeqWidth = Number.isFinite(seqWidth) && seqWidth > 0 ? seqWidth : 4;

    if (!format) {
        const effectivePrefix = `${prefix || ''}ARI`;
        return generateNextDocNumber(conn, effectivePrefix, {
            table: 'ar_invoices',
            column: 'invoice_number',
            year: docYear,
            width: safeSeqWidth
        });
    }

    const seqToken = '__SEQ_TOKEN__';
    const base = format
        .replace(/\{prefix\}/gi, prefix)
        .replace(/\{YYYY\}/g, yyyy)
        .replace(/\{YY\}/g, yy)
        .replace(/\{MM\}/g, mm)
        .replace(/\{seq(?::\d+|\d+)?\}/gi, seqToken);
    const noSeqBase = base.replace(seqToken, '');

    // Escape regex special characters
    const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const seqRegex = new RegExp(`^${esc(noSeqBase)}(\\d+)$`);

    const [rows] = await conn.query(
        `SELECT invoice_number
         FROM ar_invoices
         WHERE invoice_number LIKE ?
         ORDER BY id DESC
         LIMIT 200`,
        [`${noSeqBase}%`]
    );

    let maxSeq = 0;
    for (const r of rows || []) {
        const val = String(r.invoice_number || '');
        const m = val.match(seqRegex);
        if (!m) continue;
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
    }

    const nextSeq = String(maxSeq + 1).padStart(safeSeqWidth, '0');
    return noSeqBase + nextSeq;
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

async function generateOpeningBalanceBatchNumber(conn, year = new Date().getFullYear()) {
    return generateNextDocNumber(conn, 'OB', {
        table: 'opening_balance_batch',
        column: 'batch_no',
        year,
        width: 6
    });
}

module.exports = {
    generateNextDocNumber,
    generateAPBillNumber,
    generateAPPaymentNumber,
    generateARInvoiceNumber,
    generateARReceiptNumber,
    generateGLJournalNumber,
    generateOpeningBalanceBatchNumber
};

