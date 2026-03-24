
import { Router } from 'express';
import db from '../db.js';

const router = Router();

// Columns allowed for INSERT (must exist in business_terms table). Add/remove to match your schema.
const ALLOWED_COLUMNS = [
    'master_no', 'revision', 'definitions', 'remark',
    'delivery_terms', 'delivery_delay', 'payment', 'third_party_payment',
    'buyer_default', 'quality', 'third_party_inspection', 'inspection_goods',
    'insurance', 'retention_title', 'arbitration', 'cancellation_order',
    'termination', 'force_majeure', 'confidentiality', 'notices',
    'waiver', 'amendment', 'agreement', 'entry_user'
];

function pickPayload(body, extra = {}) {
    const out = { ...extra };
    ALLOWED_COLUMNS.forEach((key) => {
        if (key in extra) return; // server-controlled: master_no, revision, entry_user
        if (body[key] !== undefined && key !== 'id') out[key] = body[key];
    });
    delete out.id;
    delete out.created_by;
    delete out.updated_by;
    return out;
}

// GET /api/business-terms
// Returns the latest revision for each unique master_no
router.get('/', async (req, res, next) => {
    try {
        const { search = '' } = req.query;
        let whereClause = '';
        let params = [];

        if (search) {
            whereClause = `AND (master_no LIKE ? OR definitions LIKE ? OR remark LIKE ?)`;
            params = [`%${search}%`, `%${search}%`, `%${search}%`];
        }

        const sql = `
            SELECT bt1.* 
            FROM business_terms bt1
            JOIN (
                SELECT master_no, MAX(revision) as max_rev
                FROM business_terms
                GROUP BY master_no
            ) bt2 ON bt1.master_no = bt2.master_no AND bt1.revision = bt2.max_rev
            WHERE 1=1 ${whereClause}
            ORDER BY bt1.master_no ASC
        `;

        const [rows] = await db.promise().query(sql, params);
        res.json(rows);
    } catch (e) {
        next(e);
    }
});

// GET /api/business-terms/history/:master_no
// Returns all revisions for a specific master_no
router.get('/history/:master_no', async (req, res, next) => {
    try {
        const { master_no } = req.params;
        const [rows] = await db.promise().query(
            `SELECT * FROM business_terms WHERE master_no = ? ORDER BY revision DESC`,
            [master_no]
        );
        res.json(rows);
    } catch (e) {
        next(e);
    }
});

// POST /api/business-terms
// Creates a NEW logical business term (revision 1)
router.post('/', async (req, res, next) => {
    try {
        const body = req.body;
        const userId = req.session?.user?.id || 1;

        let master_no = body.master_no;
        if (!master_no) {
            const [[maxRow]] = await db.promise().query("SELECT MAX(id) as max_id FROM business_terms");
            const nextId = (maxRow?.max_id || 0) + 1;
            master_no = `BT-${String(nextId).padStart(4, '0')}`;
        }

        const payload = pickPayload(body, { master_no, revision: 1, entry_user: userId });

        const [result] = await db.promise().query("INSERT INTO business_terms SET ?", [payload]);
        res.status(201).json({ id: result.insertId, master_no, revision: 1 });
    } catch (e) {
        console.error('[business-terms] POST error:', e.message);
        res.status(500).json({ message: e.message || 'Failed to create business terms' });
    }
});

// PUT /api/business-terms/:id
// "Edit" an existing term - This actually creates a NEW revision
router.put('/:id', async (req, res, next) => {
    try {
        const { id } = req.params;
        const body = req.body;
        const userId = req.session?.user?.id || 1;

        const [[current]] = await db.promise().query("SELECT * FROM business_terms WHERE id = ?", [id]);
        if (!current) return res.status(404).json({ message: "Record not found" });

        const [[maxRev]] = await db.promise().query(
            "SELECT MAX(revision) as max_rev FROM business_terms WHERE master_no = ?",
            [current.master_no]
        );

        if (current.revision !== maxRev.max_rev) {
            return res.status(400).json({ message: "Only the latest revision can be edited." });
        }

        const payload = pickPayload(body, {
            master_no: current.master_no,
            revision: current.revision + 1,
            entry_user: userId
        });

        const [result] = await db.promise().query("INSERT INTO business_terms SET ?", [payload]);
        res.json({ id: result.insertId, master_no: current.master_no, revision: payload.revision });
    } catch (e) {
        console.error('[business-terms] PUT error:', e.message);
        res.status(500).json({ message: e.message || 'Failed to update business terms' });
    }
});

export default router;
