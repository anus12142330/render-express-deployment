// server/src/modules/ap/apPayments.service.js
const glService = require('../gl/gl.service.js');

async function postPayment(conn, paymentId, userId) {
    const [payments] = await conn.query(`
        SELECT * FROM ap_payments WHERE id = ? AND status = 'DRAFT'
    `, [paymentId]);

    if (payments.length === 0) {
        throw new Error('Payment not found or already posted');
    }

    const payment = payments[0];
    const [allocations] = await conn.query(`
        SELECT * FROM ap_payment_allocations WHERE payment_id = ?
    `, [paymentId]);

    const totalAllocated = allocations.reduce((sum, a) => sum + parseFloat(a.allocated_amount), 0);
    if (Math.abs(totalAllocated - parseFloat(payment.total_amount)) > 0.01) {
        throw new Error(`Allocation mismatch. Payment: ${payment.total_amount}, Allocated: ${totalAllocated}`);
    }

    for (const alloc of allocations) {
        const [bills] = await conn.query(`
            SELECT 
                ab.total,
                COALESCE(SUM(pa.allocated_amount), 0) as paid_amount
            FROM ap_bills ab
            LEFT JOIN ap_payment_allocations pa ON pa.bill_id = ab.id
            WHERE ab.id = ?
            GROUP BY ab.id
        `, [alloc.bill_id]);

        if (bills.length === 0) {
            throw new Error(`Bill ${alloc.bill_id} not found`);
        }

        const bill = bills[0];
        const outstanding = parseFloat(bill.total) - parseFloat(bill.paid_amount);
        const allocated = parseFloat(alloc.allocated_amount);

        if (allocated > outstanding) {
            throw new Error(`Allocation ${allocated} exceeds outstanding ${outstanding} for bill ${alloc.bill_id}`);
        }
    }

    const apAccountId = await glService.getAccountByCode(conn, '2000');
    const bankAccountId = await glService.getAccountByCode(conn, '1100');

    if (!apAccountId || !bankAccountId) {
        throw new Error('Required accounts not found in Chart of Accounts');
    }

    await glService.createJournal(conn, {
        source_type: 'AP_PAYMENT',
        source_id: paymentId,
        journal_date: payment.payment_date,
        memo: `Payment ${payment.payment_number}`,
        created_by: userId,
        lines: [
            {
                account_id: apAccountId,
                debit: parseFloat(payment.total_amount),
                credit: 0,
                description: `Accounts Payable payment ${payment.payment_number}`
            },
            {
                account_id: bankAccountId,
                debit: 0,
                credit: parseFloat(payment.total_amount),
                description: `Bank payment ${payment.payment_number}`
            }
        ]
    });

    await conn.query(`
        UPDATE ap_payments 
        SET status = 'POSTED', posted_at = NOW(), posted_by = ?
        WHERE id = ?
    `, [userId, paymentId]);
}

async function cancelPayment(conn, paymentId, userId) {
    const [payments] = await conn.query(`
        SELECT * FROM ap_payments WHERE id = ? AND status = 'POSTED'
    `, [paymentId]);

    if (payments.length === 0) {
        throw new Error('Payment not found or not posted');
    }

    const [journals] = await conn.query(`
        SELECT id FROM gl_journals 
        WHERE source_type = 'AP_PAYMENT' AND source_id = ?
        ORDER BY id DESC LIMIT 1
    `, [paymentId]);

    if (journals.length > 0) {
        await glService.createReversalJournal(conn, journals[0].id, userId);
    }

    await conn.query(`
        UPDATE ap_payments 
        SET status = 'CANCELLED', cancelled_at = NOW(), cancelled_by = ?
        WHERE id = ?
    `, [userId, paymentId]);
}

module.exports = { postPayment, cancelPayment };

