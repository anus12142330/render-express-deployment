import { Router } from 'express';
import db from '../db.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const router = Router();

// --- Multer setup for document_templates ---
const TEMPLATE_UPLOAD_DIR = path.resolve("uploads/signatures");
if (!fs.existsSync(TEMPLATE_UPLOAD_DIR)) {
    fs.mkdirSync(TEMPLATE_UPLOAD_DIR, { recursive: true });
}

const templateStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, TEMPLATE_UPLOAD_DIR),
    filename: (_req, file, cb) =>
        cb(null, crypto.randomBytes(16).toString("hex") + path.extname(file.originalname)),
});

const templateUpload = multer({ storage: templateStorage }).fields([
    { name: 'sign_file', maxCount: 1 },
    { name: 'stamp_file', maxCount: 1 },
    { name: 'template_attachment_file', maxCount: 1 },
]);

const relPath = (f) => (f ? `/uploads/signatures/${path.basename(f.path)}` : null);

const coerceField = (name, value) => {
    if (value === undefined || value === null || value === '') return null;
    if (name === 'document_id') return Number(value) || null;
    return String(value);
};


/* ----------------------------- LIST ----------------------------- */
router.get('/', async (req, res, next) => {
    try {
        const page = Math.max(parseInt(req.query.page || '1', 10), 1);
        const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '25', 10), 1), 200);
        const offset = (page - 1) * pageSize;

        const [rows] = await db.promise().query(`
            SELECT dtmpl.*, dt.name AS document_name
            FROM document_templates dtmpl
            LEFT JOIN document_type dt ON dt.id = dtmpl.document_id
            ORDER BY dtmpl.name ASC
            LIMIT ? OFFSET ?
        `, [pageSize, offset]);

        const [[{ total }]] = await db.promise().query('SELECT COUNT(*) as total FROM document_templates');

        res.json({ rows: rows || [], total: total || 0 });
    } catch (e) {
        next(e);
    }
});

/* ----------------------------- CREATE ----------------------------- */
router.post('/', templateUpload, async (req, res, next) => {
    try {
        const payload = {
            name: coerceField('name', req.body.name),
            content: coerceField('content', req.body.content),
            company_ids: coerceField('company_ids', req.body.company_ids),
            document_id: coerceField('document_id', req.body.document_id),
            updated_at: new Date(),
        };

        if (req.files?.sign_file?.[0]) {
            payload.sign_path = relPath(req.files.sign_file[0]);
        }
        if (req.files?.stamp_file?.[0]) {
            payload.stamp_path = relPath(req.files.stamp_file[0]);
        }
        if (req.files?.template_attachment_file?.[0]) {
            payload.template_attachment_path = relPath(req.files.template_attachment_file[0]);
        }

        if (!payload.name) {
            const err = new Error(`Missing required field "name"`);
            err.status = 400;
            throw err;
        }

        const [result] = await db.promise().query('INSERT INTO document_templates SET ?', [payload]);
        const [[newRecord]] = await db.promise().query('SELECT * FROM document_templates WHERE id=?', [result.insertId]);

        res.status(201).json(newRecord);

    } catch (e) {
        next(e);
    }
});

/* ----------------------------- UPDATE ----------------------------- */
router.put('/:id', templateUpload, async (req, res, next) => {
    try {
        const { id } = req.params;
        const updates = {};

        // Process text fields
        ['name', 'content', 'company_ids', 'document_id'].forEach(key => {
            if (Object.prototype.hasOwnProperty.call(req.body, key)) {
                updates[key] = coerceField(key, req.body[key]);
            }
        });

        // Process file fields
        if (req.files?.sign_file?.[0]) {
            updates.sign_path = relPath(req.files.sign_file[0]);
        } else if (req.body.sign_path !== undefined) {
            updates.sign_path = req.body.sign_path; // Allow clearing or keeping existing
        }

        if (req.files?.stamp_file?.[0]) {
            updates.stamp_path = relPath(req.files.stamp_file[0]);
        } else if (req.body.stamp_path !== undefined) {
            updates.stamp_path = req.body.stamp_path;
        }

        if (req.files?.template_attachment_file?.[0]) {
            updates.template_attachment_path = relPath(req.files.template_attachment_file[0]);
        } else if (req.body.template_attachment_path !== undefined) {
            updates.template_attachment_path = req.body.template_attachment_path;
        }

        updates.updated_at = new Date();

        if (!Object.keys(updates).length) {
            const err = new Error('No fields to update');
            err.status = 400;
            throw err;
        }

        await db.promise().query('UPDATE document_templates SET ? WHERE id=?', [updates, id]);
        const [[updatedRecord]] = await db.promise().query('SELECT * FROM document_templates WHERE id=?', [id]);

        if (!updatedRecord) return res.status(404).json({ message: 'Not found' });
        res.json(updatedRecord);

    } catch (e) {
        next(e);
    }
});

/* ----------------------------- DELETE ----------------------------- */
router.delete('/:id', async (req, res, next) => {
    try {
        const { id } = req.params;
        // Optional: Find file paths to delete from disk
        const [[record]] = await db.promise().query('SELECT sign_path, stamp_path, template_attachment_path FROM document_templates WHERE id = ?', [id]);

        await db.promise().query('DELETE FROM document_templates WHERE id=?', [id]);

        // Optional: Clean up files from disk
        if (record) {
            [record.sign_path, record.stamp_path, record.template_attachment_path].forEach(p => {
                if (p) {
                    const fullPath = path.resolve(p);
                    fs.unlink(fullPath, (err) => {
                        if (err) console.error(`Failed to delete file: ${fullPath}`, err);
                    });
                }
            });
        }

        res.json({ success: true });
    } catch (e) {
        next(e);
    }
});

export default router;
