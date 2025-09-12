// server/routes/warehouses.js
import { Router } from 'express';
import db from '../db.js';

const router = Router();

const pick = (obj = {}, fields = []) =>
    fields.reduce((acc, k) => (obj[k] !== undefined ? (acc[k] = obj[k], acc) : acc), {});

// GET /api/warehouses?company_id=#
router.get('/', async (req, res) => {
    try {
        const { company_id } = req.query;
        let sql =
            'SELECT id, company_id, warehouse_name AS name, code, address, is_inactive, created_at, updated_at FROM warehouses';
        const params = [];

        if (company_id) {
            sql += ' WHERE company_id = ?';
            params.push(company_id);
        }

        sql += ' ORDER BY is_inactive ASC, name ASC';
        const [rows] = await db.promise().query(sql, params);
        res.json(rows);
    } catch (err) {
        console.error('GET /api/warehouses error ->', err);
        res.status(500).json({ error: 'Failed to fetch warehouses', detail: String(err?.message || err) });
    }
});

// POST /api/warehouses
router.post('/', async (req, res) => {
    try {
        const { name, code, address, company_id } = req.body || {};
        if (!name?.trim()) return res.status(400).json({ error: 'Warehouse name is required' });

        const payload = {
            warehouse_name: name.trim(),            // <-- map to DB column
            code: code || null,
            address: address || null,
            is_inactive: 0,
            ...(company_id ? { company_id: Number(company_id) } : {})
        };

        const [result] = await db.promise().query('INSERT INTO warehouses SET ?', payload);
        const [[row]] = await db.promise().query(
            'SELECT id, company_id, warehouse_name AS name, code, address, is_inactive, created_at, updated_at FROM warehouses WHERE id = ?',
            [result.insertId]
        );

        res.json({ message: 'Warehouse added.', ...row });
    } catch (err) {
        console.error('POST /api/warehouses error ->', err);
        res.status(500).json({ error: 'Failed to create warehouse', detail: String(err?.message || err) });
    }
});

// PUT /api/warehouses/:id
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const body = req.body || {};

        const [[exists]] = await db.promise().query('SELECT id FROM warehouses WHERE id = ?', [id]);
        if (!exists) return res.status(404).json({ error: 'Warehouse not found' });

        const allowed = pick(body, ['name', 'code', 'address', 'is_inactive', 'company_id']);

        // build update payload converting "name" -> "warehouse_name"
        const updatePayload = {};
        if (allowed.name !== undefined) {
            const n = String(allowed.name);
            if (!n.trim()) return res.status(400).json({ error: 'Warehouse name cannot be empty' });
            updatePayload.warehouse_name = n.trim();
        }
        if (allowed.code !== undefined) updatePayload.code = allowed.code || null;
        if (allowed.address !== undefined) updatePayload.address = allowed.address || null;
        if (allowed.is_inactive !== undefined) updatePayload.is_inactive = Number(allowed.is_inactive) ? 1 : 0;
        if (allowed.company_id !== undefined) updatePayload.company_id = allowed.company_id ? Number(allowed.company_id) : null;

        if (Object.keys(updatePayload).length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        await db.promise().query('UPDATE warehouses SET ? WHERE id = ?', [updatePayload, id]);

        const [[row]] = await db.promise().query(
            'SELECT id, company_id, warehouse_name AS name, code, address, is_inactive, created_at, updated_at FROM warehouses WHERE id = ?',
            [id]
        );

        const msg = Number(allowed.is_inactive) === 1 ? 'Warehouse marked inactive.' : 'Warehouse updated.';
        res.json({ message: msg, ...row });
    } catch (err) {
        console.error('PUT /api/warehouses/:id error ->', err);
        res.status(500).json({ error: 'Failed to update warehouse', detail: String(err?.message || err) });
    }
});

// DELETE /api/warehouses/:id  (soft delete)
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const [[exists]] = await db.promise().query('SELECT id FROM warehouses WHERE id = ?', [id]);
        if (!exists) return res.status(404).json({ error: 'Warehouse not found' });

        await db.promise().query('UPDATE warehouses SET is_inactive = 1 WHERE id = ?', [id]);

        const [[row]] = await db.promise().query(
            'SELECT id, company_id, warehouse_name AS name, code, address, is_inactive, created_at, updated_at FROM warehouses WHERE id = ?',
            [id]
        );

        res.json({ message: 'Warehouse marked inactive.', ...row });
    } catch (err) {
        console.error('DELETE /api/warehouses/:id error ->', err);
        res.status(500).json({ error: 'Failed to delete warehouse', detail: String(err?.message || err) });
    }
});

export default router;
