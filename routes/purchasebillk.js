import { Router } from 'express';
import db from '../db.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const router = Router();

// --- Multer setup for purchase bills ---
const BILL_UPLOAD_DIR = path.resolve("uploads/bills");
if (!fs.existsSync(BILL_UPLOAD_DIR)) {
    fs.mkdirSync(BILL_UPLOAD_DIR, { recursive: true });
}

const billStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, BILL_UPLOAD_DIR),
    filename: (_req, file, cb) =>
        cb(null, crypto.randomBytes(16).toString("hex") + path.extname(file.originalname)),
});

const billUpload = multer({ storage: billStorage }).array('attachments', 10); // 'attachments' is the field name

const relPath = (f) => (f ? `/uploads/bills/${path.basename(f.path)}` : null);

const toNumOrNull = (v) => {
    if (v === '' || v === undefined || v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

const fkOrNull = async (conn, table, id) => {
    const n = toNumOrNull(id);
    if (n == null) return null;
    const [[row]] = await conn.query(`SELECT id FROM ${conn.escapeId(table)} WHERE id=?`, [n]);
    return row ? n : null;
};

// Helper to add to history
const addHistory = async (conn, { module, moduleId, userId, action, details }) => {
    if (!module || !moduleId || !userId || !action) return;
    await conn.query(
        'INSERT INTO history (module, module_id, user_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
        [module, moduleId, userId, action, JSON.stringify(details || {})]
    );
};

/* ----------------------------- LIST ----------------------------- */
router.get('/', async (req, res, next) => {
    try {
        const page = Math.max(parseInt(req.query.page || "1", 10), 1);
        const per_page = Math.min(Math.max(parseInt(req.query.per_page || "25", 10), 1), 100);
        const offset = (page - 1) * per_page;
        const search = (req.query.search || "").trim();
        const vendorId = req.query.vendor_id ? parseInt(req.query.vendor_id, 10) : null;
        const userId = req.query.user_id;

        let whereClause = "WHERE 1=1";
        const params = [];

        if (vendorId && Number.isFinite(vendorId)) {
            whereClause += " AND pb.vendor_id = ?";
            params.push(vendorId);
        }
        if (userId) {
            whereClause += " AND pb.user_id = ?";
            params.push(userId);
        }

        const [countResult] = await db.promise().query(
            `SELECT COUNT(*) as total FROM ap_bills pb ${whereClause}`, params
        );
        const totalRows = countResult[0]?.total || 0;

        const [rows] = await db.promise().query(`
            SELECT 
                pb.id, pb.bill_uniqid, pb.bill_number, pb.bill_date, pb.total, pb.status_id, 
                s.name as status_name, v.display_name as vendor_name, c.name as currency_code,
                po.po_number as purchase_order_number,
                (SELECT COUNT(*) FROM ap_bill_attachments pba WHERE pba.bill_id = pb.id) as attachment_count
            FROM ap_bills pb
            LEFT JOIN vendor v ON v.id = pb.vendor_id
            LEFT JOIN currency c ON c.id = pb.currency_id
            LEFT JOIN status s ON s.id = pb.status_id
            LEFT JOIN purchase_orders po ON po.id = pb.purchase_order_id
            ${whereClause}
            ORDER BY pb.bill_date DESC, pb.id DESC
            LIMIT ? OFFSET ?`,
            [...params, per_page, offset]
        );

        res.json({ data: rows || [], totalRows });
    } catch (e) {
        next(e);
    }
});

/* ----------------------------- GET RECENT (for vendor page) ----------------------------- */
router.get('/recent', async (req, res, next) => {
    try {
        const page = Math.max(parseInt(req.query.page || "1", 10), 1);
        const per_page = Math.min(Math.max(parseInt(req.query.per_page || "5", 10), 1), 100);
        const offset = (page - 1) * per_page;
        const vendorId = req.query.vendor_id ? parseInt(req.query.vendor_id, 10) : null;

        if (!vendorId || !Number.isFinite(vendorId)) {
            return res.json({ data: [], totalRows: 0 });
        }

        const whereClause = "WHERE pb.vendor_id = ?";
        const params = [vendorId];

        const [countResult] = await db.promise().query(
            `SELECT COUNT(*) as total FROM purchase_bills pb ${whereClause}`, params
        );
        const totalRows = countResult[0]?.total || 0;

        const [rows] = await db.promise().query(`
            SELECT 
                pb.id, pb.bill_uniqid, pb.bill_number, pb.bill_date, pb.total, pb.status_id, 
                s.name as status, v.display_name as vendor_name, c.name as currency_name
            FROM purchase_bills pb
            LEFT JOIN vendor v ON v.id = pb.vendor_id
            LEFT JOIN currency c ON c.id = pb.currency_id
            LEFT JOIN status s ON s.id = pb.status_id
            ${whereClause}
            ORDER BY pb.bill_date DESC, pb.id DESC
            LIMIT ? OFFSET ?`, [...params, per_page, offset]);
        res.json({ data: rows || [], totalRows });
    } catch (e) { next(e); }
});

/* ----------------------------- GET NEXT BILL # -------------------- */
router.get('/next-bill-number', async (req, res, next) => {
    const { company_id } = req.query;
    const conn = await db.promise().getConnection();
    try {
        let prefix = 'INV'; // Default prefix
        if (company_id) {
            const [[company]] = await conn.query('SELECT company_prefix FROM company_settings WHERE id = ?', [company_id]);
            if (company?.company_prefix) prefix = `${company.company_prefix}INV`;
        } else {
            // Fallback: if no company_id, use the first company's prefix
            const [[firstCompany]] = await conn.query('SELECT company_prefix FROM company_settings ORDER BY id LIMIT 1');
            if (firstCompany?.company_prefix) prefix = `${firstCompany.company_prefix}INV`;
        }

        const now = new Date();
        const year = String(now.getFullYear()).slice(-2);
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const currentPrefix = `${prefix}-${year}-${month}`;

        const [[lastBill]] = await conn.query(
            "SELECT bill_number FROM purchase_bills WHERE bill_number LIKE ? ORDER BY id DESC LIMIT 1",
            [`${currentPrefix}%`]
        );

        let nextSeq = 1;
        if (lastBill?.bill_number) {
            const match = lastBill.bill_number.match(/(\d{3})$/);
            if (match) nextSeq = parseInt(match[1], 10) + 1;
        }

        const nextNumber = `${currentPrefix}${String(nextSeq).padStart(3, '0')}`;
        res.json({ bill_number: nextNumber });
    } catch (e) {
        next(e);
    } finally {
        conn.release();
    }
});

/* ----------------------------- GET SOURCE POs ------------------- */
router.get('/source-pos', async (req, res, next) => {
    try {
        const { vendor_id } = req.query;
        if (!vendor_id) return res.json([]);
        const [pos] = await db.promise().query(
            `SELECT po.id, po.po_number, po.po_uniqid, v.display_name as vendor_name
             FROM purchase_orders po
             JOIN vendor v ON v.id = po.vendor_id
             WHERE po.vendor_id = ? AND po.status_id IN (4, 5, 7, 8) -- 4:Issued, 5:Approved, 7:Confirmed, 8:Partially Received
             ORDER BY po.po_date DESC`,
            [vendor_id]
        );
        res.json(pos || []);
    } catch (e) {
        next(e);
    }
});

/* ----------------------------- GET ONE ---------------------------- */
router.get('/:id', async (req, res, next) => {
    try {
        const { id: identifier } = req.params;
        const isNumericId = /^\d+$/.test(identifier);
        const whereField = isNumericId ? 'pb.id' : 'pb.bill_uniqid';

        const [[bill]] = await db.promise().query(`
            SELECT 
                pb.*, 
                v.display_name as vendor_name,
                v.company_name as vendor_company,
                va.bill_address_1 as vendor_address_line1,
                va.bill_address_2 as vendor_address_line2,
                va.bill_city as vendor_city,
                vs.name as vendor_state,
                vc.name as vendor_country,
                va.bill_zip_code as vendor_postal_code,
                po.company_id as po_company_id,
                po.po_number as purchase_order_number
            FROM ap_bills pb
            LEFT JOIN vendor v ON v.id = pb.vendor_id
            LEFT JOIN vendor_address va ON va.vendor_id = v.id
            LEFT JOIN state vs ON vs.id = va.bill_state_id
            LEFT JOIN country vc ON vc.id = va.bill_country_id
            LEFT JOIN purchase_orders po ON po.id = pb.purchase_order_id
            WHERE ${whereField} = ?`, [identifier]);
        if (!bill) return res.status(404).json({ error: 'Bill not found' });

        const billId = bill.id; // Use the numeric ID for subsequent queries
        const [items] = await db.promise().query(`
            SELECT pbi.*, um.name as uom_name, um.acronyms as uom_acronyms,
                   (SELECT pi.thumbnail_path FROM product_images pi WHERE pi.product_id = pbi.product_id ORDER BY pi.is_primary DESC, pi.id ASC LIMIT 1) as thumbnail_url
            FROM purchase_bill_items pbi
            LEFT JOIN uom_master um ON um.id = pbi.uom_id            
            WHERE pbi.purchase_bill_id = ?
        `, [billId]);
        const [attachments] = await db.promise().query('SELECT * FROM ap_bill_attachments WHERE bill_id = ?', [billId]);

        const [history] = await db.promise().query(`
            SELECT h.action, h.details, h.created_at, u.name as user_name
            FROM history h
            LEFT JOIN user u ON u.id = h.user_id
            WHERE h.module = 'purchase_bill' AND h.module_id = ?
            ORDER BY h.created_at DESC
        `, [billId]);

        res.json({ ...bill, items: items || [], attachments: attachments || [], history: history || [] });
    } catch (e) {
        next(e);
    }
});

/* ----------------------------- GET DATA FROM PO ----------------- */
router.get('/from-po/:poId', async (req, res, next) => {
    try {
        const { poId } = req.params;
        const [[po]] = await db.promise().query('SELECT * FROM purchase_orders WHERE id = ?', [poId]);
        if (!po) return res.status(404).json({ error: 'Purchase Order not found' });

        const [items] = await db.promise().query(`
            SELECT 
                poi.*, 
                um.name as uom_name, 
                um.acronyms as uom_acronyms,
                (SELECT pi.thumbnail_path FROM product_images pi WHERE pi.product_id = poi.item_id ORDER BY pi.is_primary DESC, pi.id ASC LIMIT 1) as thumbnail_url
            FROM purchase_order_items poi
            LEFT JOIN uom_master um ON um.id = poi.uom_id
            WHERE poi.purchase_order_id = ?
        `, [poId]);

        res.json({ po, items: items || [] });
    } catch (e) {
        next(e);
    }
});

/* ----------------------------- GET DATA FROM SHIPMENT LOT ------- */
router.get('/from-shipment/:shipmentId', async (req, res, next) => {
    try {
        const { shipmentId } = req.params;
        const [[shipment]] = await db.promise().query(`
            SELECT s.*, v.display_name as vendor_name, po.po_number 
            FROM shipment s 
            LEFT JOIN vendor v ON v.id = s.vendor_id
            LEFT JOIN purchase_orders po ON po.id = s.po_id
            WHERE s.id = ? OR s.ship_uniqid = ?
        `, [shipmentId, shipmentId]);

        if (!shipment) return res.status(404).json({ error: 'Shipment not found' });

        // Get container numbers
        const [containers] = await db.promise().query(`SELECT container_no FROM shipment_container WHERE shipment_id = ?`, [shipment.id]);
        const container_nos = containers.map(c => c.container_no).filter(Boolean).join(', ');

        // Get items from containers (package count and package type)
        // Join with purchase_order_items to get rate and tax_id
        const [items] = await db.promise().query(`
            SELECT 
                sci.product_id,
                sci.product_name as item_name,
                SUM(sci.package_count) as quantity,
                MAX(sci.batch_no) as batch_no,
                sc.id as container_id,
                sc.container_no as container_no,
                sci.package_type as uom_name,
                (SELECT id FROM uom_master WHERE name = sci.package_type OR acronyms = sci.package_type LIMIT 1) as uom_id,
                poi.rate,
                poi.vat_id as tax_id,
                p.description as product_description,
                p.purchase_description,
                p.hscode as product_hscode,
                (SELECT pd.variety FROM product_details pd WHERE pd.product_id = p.id ORDER BY pd.id ASC LIMIT 1) as variety,
                (SELECT pd.grade_and_size_code FROM product_details pd WHERE pd.product_id = p.id ORDER BY pd.id ASC LIMIT 1) as grade,
                (SELECT co.name FROM product_details pd JOIN country co ON co.id = pd.origin_id WHERE pd.product_id = p.id ORDER BY pd.id ASC LIMIT 1) as origin,
                (SELECT pd.packing_text FROM product_details pd WHERE pd.product_id = p.id ORDER BY pd.id ASC LIMIT 1) as packing,
                COALESCE(
                    (SELECT pi.thumbnail_path FROM product_images pi WHERE pi.product_id = sci.product_id AND pi.is_primary = 1 LIMIT 1),
                    (SELECT pi.thumbnail_path FROM product_images pi WHERE pi.product_id = sci.product_id ORDER BY pi.id ASC LIMIT 1)
                ) as thumbnail_url
            FROM shipment_container_item sci
            JOIN shipment_container sc ON sc.id = sci.container_id
            LEFT JOIN shipment s ON s.id = sc.shipment_id
            LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = s.po_id AND poi.item_id = sci.product_id
            LEFT JOIN products p ON p.id = sci.product_id
            WHERE sc.shipment_id = ?
            GROUP BY sc.id, sc.container_no, sci.product_id, sci.product_name, sci.package_type, poi.rate, poi.vat_id, p.description, p.purchase_description, p.hscode
        `, [shipment.id]);

        res.json({ shipment, container_no: container_nos, items: items || [] });
    } catch (e) {
        next(e);
    }
});

/* ----------------------------- CREATE ----------------------------- */
router.post('/', billUpload, async (req, res, next) => {
    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();
        const p = req.body;
        const items = JSON.parse(p.items || '[]');
        const user_id = req.session?.user?.id;

        if (!user_id) {
            await conn.rollback();
            return res.status(401).json({ error: 'Unauthorized. User session not found.' });
        }

        const vendor_id = await fkOrNull(conn, 'vendor', p.vendor_id);
        if (!vendor_id) {
            throw new Error('The selected vendor is invalid or does not exist.');
        }

        const bill_uniqid = `pb_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

        const [result] = await conn.query('INSERT INTO purchase_bills SET ?', [{
            bill_uniqid: bill_uniqid,
            vendor_id: vendor_id,
            purchase_order_id: toNumOrNull(p.purchase_order_id),
            bill_number: p.bill_number,
            bill_date: p.bill_date || null,
            due_date: p.due_date || null,
            currency_id: toNumOrNull(p.currency_id),
            subtotal: toNumOrNull(p.subtotal),
            tax_total: toNumOrNull(p.tax_total),
            total: toNumOrNull(p.total),
            notes: p.notes,
            user_id: user_id,
            status_id: 3, // Assuming 3 is 'Draft'
        }]);
        const billId = result.insertId;

        if (items.length) {
            const itemValues = items.map(it => [billId, toNumOrNull(it.product_id), it.item_name, it.description, toNumOrNull(it.quantity), toNumOrNull(it.uom_id), toNumOrNull(it.rate), toNumOrNull(it.tax_id)]);
            await conn.query('INSERT INTO purchase_bill_items (purchase_bill_id, product_id, item_name, description, quantity, uom_id, rate, tax_id) VALUES ?', [itemValues]);
        }

        if (req.files && req.files.length) {
            const attachmentValues = req.files.map(f => [billId, f.originalname, relPath(f), f.mimetype, f.size]);
            await conn.query('INSERT INTO ap_bill_attachments (bill_id, file_name, file_path, mime_type, size_bytes) VALUES ?', [attachmentValues]);
        }

        await addHistory(conn, {
            module: 'purchase_bill',
            moduleId: billId,
            userId: user_id,
            action: 'CREATED',
            details: { bill_number: p.bill_number, total: p.total }
        });

        await conn.commit();
        const [[newBill]] = await conn.query('SELECT * FROM purchase_bills WHERE id = ?', [billId]);
        res.status(201).json(newBill);
    } catch (e) {
        await conn.rollback();
        next(e);
    } finally {
        conn.release();
    }
});

/* ----------------------------- UPDATE ----------------------------- */
router.put('/:id', billUpload, async (req, res, next) => {
    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();
        const { id: identifier } = req.params;
        const p = req.body;
        const items = JSON.parse(p.items || '[]');
        const updated_by_user_id = req.session?.user?.id; // Good practice to track who updated

        if (!updated_by_user_id) {
            await conn.rollback();
            return res.status(401).json({ error: 'Unauthorized. User session not found.' });
        }

        const vendor_id = await fkOrNull(conn, 'vendor', p.vendor_id);
        if (!vendor_id) {
            throw new Error('The selected vendor is invalid or does not exist.');
        }

        // Fetch old bill for history comparison
        const [[oldBill]] = await conn.query(`SELECT * FROM purchase_bills WHERE bill_uniqid = ?`, [identifier]);
        if (!oldBill) return res.status(404).json({ error: 'Bill not found' });

        const billId = oldBill.id; // Use numeric ID for all subsequent operations

        await conn.query('UPDATE purchase_bills SET ? WHERE id = ?', [{
            user_id: oldBill.user_id, // Preserve original creator
            vendor_id: vendor_id,
            purchase_order_id: toNumOrNull(p.purchase_order_id),
            bill_number: p.bill_number,
            bill_date: p.bill_date || null,
            due_date: p.due_date || null,
            currency_id: toNumOrNull(p.currency_id),
            subtotal: toNumOrNull(p.subtotal),
            tax_total: toNumOrNull(p.tax_total),
            total: toNumOrNull(p.total),
            notes: p.notes,
            status_id: toNumOrNull(p.status_id) ?? oldBill.status_id,
        }, billId]);

        await conn.query('DELETE FROM purchase_bill_items WHERE purchase_bill_id = ?', [billId]);
        if (items.length) {
            const itemValues = items.map(it => [billId, toNumOrNull(it.product_id), it.item_name, it.description, toNumOrNull(it.quantity), toNumOrNull(it.uom_id), toNumOrNull(it.rate), toNumOrNull(it.tax_id)]);
            await conn.query('INSERT INTO purchase_bill_items (purchase_bill_id, product_id, item_name, description, quantity, uom_id, rate, tax_id) VALUES ?', [itemValues]);
        }

        if (req.files && req.files.length) {
            const attachmentValues = req.files.map(f => [billId, f.originalname, relPath(f), f.mimetype, f.size]);
            await conn.query('INSERT INTO ap_bill_attachments (bill_id, file_name, file_path, mime_type, size_bytes) VALUES ?', [attachmentValues]);
        }

        // --- Create History Record for Update ---
        const changes = [];
        if (oldBill.bill_number !== p.bill_number) changes.push({ field: 'Bill Number', from: oldBill.bill_number, to: p.bill_number });
        if (oldBill.bill_date.toISOString().split('T')[0] !== p.bill_date) changes.push({ field: 'Bill Date', from: oldBill.bill_date.toISOString().split('T')[0], to: p.bill_date });
        if (String(oldBill.total) !== String(p.total)) changes.push({ field: 'Total', from: oldBill.total, to: p.total });
        if (String(oldBill.status_id) !== String(p.status_id)) changes.push({ field: 'Status ID', from: oldBill.status_id, to: p.status_id });
        if (oldBill.notes !== p.notes) changes.push({ field: 'Notes', from: '...', to: '...' });

        if (changes.length > 0) {
            await addHistory(conn, {
                module: 'purchase_bill',
                moduleId: billId,
                userId: updated_by_user_id,
                action: 'UPDATED',
                details: { changes }
            });
        }

        await conn.commit();
        const [[updatedBill]] = await conn.query('SELECT * FROM purchase_bills WHERE id = ?', [billId]);
        res.json(updatedBill);
    } catch (e) {
        await conn.rollback();
        next(e);
    } finally {
        conn.release();
    }
});

/* ----------------------------- ADD ATTACHMENTS ------------------ */
router.post('/:id/attachments', billUpload, async (req, res, next) => {
    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();
        const { id: identifier } = req.params;
        const user_id = req.session?.user?.id;

        if (!user_id) {
            await conn.rollback();
            return res.status(401).json({ error: 'Unauthorized. User session not found.' });
        }

        const [[bill]] = await conn.query('SELECT id FROM purchase_bills WHERE bill_uniqid = ?', [identifier]);
        if (!bill) {
            await conn.rollback();
            return res.status(404).json({ error: 'Bill not found' });
        }
        const billId = bill.id;

        if (req.files && req.files.length) {
            const attachmentValues = req.files.map(f => [billId, f.originalname, relPath(f), f.mimetype, f.size]);
            await conn.query('INSERT INTO ap_bill_attachments (bill_id, file_name, file_path, mime_type, size_bytes) VALUES ?', [attachmentValues]);
        } else {
            await conn.rollback();
            return res.status(400).json({ error: 'No files were uploaded.' });
        }

        await conn.commit();
        res.status(201).json({ success: true, message: 'Attachments added successfully.' });
    } catch (e) {
        await conn.rollback();
        next(e);
    } finally {
        conn.release();
    }
});

/* ----------------------------- DELETE ATTACHMENT ------------------ */
router.delete('/:billId/attachments/:attachmentId', async (req, res, next) => {
    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();
        const { billId, attachmentId } = req.params;
        const userId = req.session?.user?.id;

        const [[attachment]] = await conn.query(
            'SELECT * FROM ap_bill_attachments WHERE id = ? AND bill_id = ?',
            [attachmentId, billId]
        );

        if (!attachment) {
            await conn.rollback();
            return res.status(404).json({ error: 'Attachment not found' });
        }

        // Delete file from disk
        const diskPath = path.resolve(attachment.file_path.substring(1)); // remove leading '/'
        if (fs.existsSync(diskPath)) {
            fs.unlinkSync(diskPath);
        }

        // Delete record from database
        await conn.query('DELETE FROM ap_bill_attachments WHERE id = ?', [attachmentId]);

        await addHistory(conn, { module: 'purchase_bill', moduleId: billId, userId: userId, action: 'ATTACHMENT_DELETED', details: { file_name: attachment.file_name } });
        await conn.commit();
        res.json({ success: true, message: 'Attachment deleted successfully.' });
    } catch (e) {
        await conn.rollback();
        next(e);
    } finally {
        conn.release();
    }
});

export default router;