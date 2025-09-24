import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/authz.js';

const q = async (sql, p = []) => (await db.promise().query(sql, p))[0];

function pad(n, width = 3) {
    const s = String(n);
    return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

async function getNextBillNumber(conn) {
    const queryRunner = conn || db.promise();

    // 1. Get company prefix
    const [[settings]] = await queryRunner.query("SELECT company_prefix FROM company_settings LIMIT 1");
    const prefix = settings?.company_prefix ? `${settings.company_prefix}` : '';

    // 2. Prepare date parts
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const numberPrefix = `${prefix}INV-${yy}-${mm}`; // e.g., AGINV-24-07-

    // 3. Find the last bill number for the current month
    const [[lastBill]] = await queryRunner.query(
        `SELECT bill_number FROM purchase_bills WHERE bill_number LIKE ? ORDER BY bill_number DESC LIMIT 1 ${conn ? 'FOR UPDATE' : ''}`,
        [`${numberPrefix}%`]
    );

    let lastSeq = 0;
    if (lastBill && lastBill.bill_number) {
        const match = lastBill.bill_number.match(/(\d{3})$/);
        if (match) {
            lastSeq = parseInt(match[1], 10);
        }
    }

    // 4. Format the new number
    return `${numberPrefix}${pad(lastSeq + 1, 3)}`;
}

const router = Router();

// GET all purchase bills
router.get('/', requireAuth, async (req, res) => {
  try {
    // This is a placeholder query. You will need to adjust the table and column names
    // to match your actual database schema for purchase bills.
    const sql = `
      SELECT 
        pb.id, 
        pb.bill_number, 
        v.display_name as vendor_name, 
        pb.bill_date, 
        pb.total,
        pb.status
      FROM purchase_bills pb
      LEFT JOIN vendor v ON v.id = pb.vendor_id
      ORDER BY pb.bill_date DESC, pb.id DESC
    `;
    const [bills] = await db.promise().query(sql);
    res.json(bills);
  } catch (err) {
    // If the table doesn't exist, send an empty array instead of crashing
    if (err.code === 'ER_NO_SUCH_TABLE') {
        console.warn("Warning: 'purchase_bills' table not found. Returning empty array.");
        return res.json([]);
    }
    console.error('Error fetching purchase bills:', err);
    res.status(500).json({ error: 'Failed to fetch purchase bills' });
  }
});

// GET Billable Purchase Orders (for dropdown)
router.get('/source-pos', requireAuth, async (req, res) => {
    try {
        const { vendor_id } = req.query;

        // If no vendor is selected, return an empty list.
        // A bill can be created without a PO, so we don't want to show all POs.
        if (!vendor_id) {
            return res.json([]);
        }

        const pos = await q(`
            SELECT po.id, po.po_number, v.display_name as vendor_name
            FROM purchase_orders po
            LEFT JOIN vendor v ON v.id = po.vendor_id
            WHERE po.vendor_id = ?
            ORDER BY po.po_date DESC
        `, [vendor_id]);
        res.json(pos);
    } catch (err) {
        console.error('Error fetching source POs:', err);
        res.status(500).json({ error: 'Failed to fetch source purchase orders' });
    }
});

// GET next bill number for UI
router.get('/next-bill-number', requireAuth, async (req, res) => {
    try {
        const billNumber = await getNextBillNumber();
        res.json({ bill_number: billNumber });
    } catch (err) {
        console.error('Error getting next bill number:', err);
        res.status(500).json({ error: 'Failed to generate next bill number' });
    }
});

// GET payment terms
router.get('/payment-terms', requireAuth, async (req, res) => {
    try {
        // Assuming a table named 'payment_terms' exists
        const [terms] = await db.promise().query('SELECT id, name FROM payment_terms ORDER BY name');
        res.json(terms);
    } catch (err) {
        console.error('Error fetching payment terms:', err);
        res.status(500).json({ error: 'Failed to fetch payment terms' });
    }
});

// GET pre-filled bill data from a specific Purchase Order
router.get('/from-po/:poId', requireAuth, async (req, res) => {
    const { poId } = req.params;
    try {
        const [po] = await q(`
            SELECT po.*, v.display_name as vendor_name 
            FROM purchase_orders po 
            JOIN vendor v ON v.id = po.vendor_id 
            WHERE po.id = ?`, [poId]);

        if (!po) return res.status(404).json({ error: 'Purchase Order not found' });

        const items = await q(`
            SELECT 
                poi.item_id as product_id,
                p.product_name as description,
                p.hscode,
                poi.packing_label as packing,
                poi.quantity,
                poi.uom_id as uom,
                poi.origin,
                poi.rate as unit_price,
                poi.vat_id,
                poi.vat_amount as tax_amount,
                poi.amount_net as line_total,
                (
                    SELECT pi.file_path
                    FROM product_images pi
                    WHERE pi.product_id = poi.item_id
                    ORDER BY pi.is_primary DESC, pi.id ASC
                    LIMIT 1
                ) as image_url
            FROM purchase_order_items poi
            JOIN products p ON p.id = poi.item_id
            WHERE poi.purchase_order_id = ?
        `, [poId]);

        // Add the current date as the default bill_date
        const today = new Date().toISOString().slice(0, 10);
        po.bill_date = today;

        res.json({ po, items });
    } catch (err) {
        console.error(`Error fetching data from PO ${poId}:`, err);
        res.status(500).json({ error: 'Failed to fetch data from Purchase Order' });
    }
});

// POST a new purchase bill
router.post('/', requireAuth, async (req, res) => {
    const { vendor_id, purchase_order_id, bill_date, due_date, billing_address, shipping_address, notes, items, sub_total, total_tax, total } = req.body;
    const conn = await db.promise().getConnection();

    try {
        await conn.beginTransaction();

        const bill_number = await getNextBillNumber(conn);

        const billResult = await conn.query(
            `INSERT INTO purchase_bills (purchase_order_id, vendor_id, bill_number, bill_date, due_date, billing_address, shipping_address, notes, sub_total, total_tax, total, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Open')`,
            [purchase_order_id, vendor_id, bill_number, bill_date, due_date, billing_address, shipping_address, notes, sub_total, total_tax, total]
        );
        const billId = billResult[0].insertId;

        const itemValues = items.map(item => [billId, item.product_id, item.description, item.hscode, item.packing, item.quantity, item.uom, item.origin, item.unit_price, item.tax_amount, item.line_total]);
        await conn.query(`INSERT INTO purchase_bill_items (purchase_bill_id, product_id, description, hscode, packing, quantity, uom, origin, unit_price, tax_amount, line_total) VALUES ?`, [itemValues]);

        await conn.commit();
        res.status(201).json({ id: billId, bill_number, message: 'Purchase Bill created successfully' });
    } catch (err) {
        await conn.rollback();
        console.error('Error creating purchase bill:', err);
        res.status(500).json({ error: 'Failed to create purchase bill' });
    } finally {
        conn.release();
    }
});

export default router;