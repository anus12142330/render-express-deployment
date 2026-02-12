// routes/documentType.js
import express from "express";
import db from "../db.js";

const router = express.Router();

// Helpers
const rowToDto = r => ({ id: r.id, code: r.code, name: r.name });
const like = s => `%${s || ""}%`;

/* -------- LIST (with optional search) -------- */
// list with pagination + search
router.get('/', async (req, res) => {
    try {
        const limit = Math.max(1, parseInt(req.query.limit || 25, 10));
        const offset = Math.max(0, parseInt(req.query.offset || 0, 10));
        const search = (req.query.search || '').trim();
        const like = `%${search}%`;

        const [rows] = await db.promise().query(
            `SELECT id, code, name
         FROM document_type
        WHERE (? = '' OR code LIKE ? OR name LIKE ?)
        ORDER BY id ASC
        LIMIT ? OFFSET ?`,
            [search, like, like, limit, offset]
        );

        const [[cnt]] = await db.promise().query(
            `SELECT COUNT(*) AS total
         FROM document_type
        WHERE (? = '' OR code LIKE ? OR name LIKE ?)`,
            [search, like, like]
        );

        res.json({ data: rows, total: cnt.total });
    } catch (e) {
        res.status(500).json({ error: e.message || 'Failed to load' });
    }
});

// create
router.post('/', async (req, res) => {
    try {
        const { code, name } = req.body || {};
        if (!code || !name) return res.status(400).json({ error: 'code and name are required' });

        const [dup] = await db.promise().query(
            'SELECT id FROM document_type WHERE code = ? LIMIT 1', [code]
        );
        if (dup.length) return res.status(409).json({ error: 'Code already exists' });

        const [ins] = await db.promise().query(
            'INSERT INTO document_type (code, name) VALUES (?, ?)', [code, name]
        );
        res.json({ id: ins.insertId });
    } catch (e) {
        res.status(500).json({ error: e.message || 'Insert failed' });
    }
});

// update
router.put('/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const { code, name } = req.body || {};
        if (!code || !name) return res.status(400).json({ error: 'code and name are required' });

        const [dup] = await db.promise().query(
            'SELECT id FROM document_type WHERE code = ? AND id <> ? LIMIT 1', [code, id]
        );
        if (dup.length) return res.status(409).json({ error: 'Code already exists' });

        await db.promise().query(
            'UPDATE document_type SET code = ?, name = ? WHERE id = ?', [code, name, id]
        );
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message || 'Update failed' });
    }
});

// delete
router.delete('/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        await db.promise().query('DELETE FROM document_type WHERE id = ?', [id]);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message || 'Delete failed' });
    }
});

export default router;
