const { tx, pool } = require('../../db/tx.cjs');
const crypto = require('crypto');
const path = require('path');
const arCreditNotesService = require('./arCreditNotes.service.cjs');

function parseCreditNoteBody(req) {
    const body =
        req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) && !Array.isArray(req.body) ? req.body : {};
    let raw = body.payload;
    if (Array.isArray(raw)) raw = raw.length ? raw[0] : undefined;
    if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
    if (raw != null && raw !== '') {
        try {
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch (_e) {
            /* fall through to plain body */
        }
    }
    const { payload: _p, ...rest } = body;
    return rest && typeof rest === 'object' ? rest : {};
}

const APPROVED_INVOICE_STATUS = 1;

async function addHistory(conn, { module, moduleId, userId, action, details }) {
    if (!module || !moduleId || !userId || !action) return;
    await conn.query(
        'INSERT INTO history (module, module_id, user_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
        [module, moduleId, userId, action, JSON.stringify(details || {})]
    );
}

async function resolveAuthAndViewAll(authUserId) {
    if (!authUserId) return { canViewAll: false };
    const [adm] = await pool.query(
        `SELECT 1 FROM user_role ur JOIN role r ON r.id = ur.role_id
         WHERE ur.user_id=? AND r.name='Super Admin' LIMIT 1`,
        [authUserId]
    );
    if (adm.length > 0) return { canViewAll: true };
    const [ok] = await pool.query(
        `SELECT 1 FROM user_role ur
         JOIN role_permission rp ON rp.role_id = ur.role_id AND rp.allowed=1
         JOIN menu_module m ON m.id = rp.module_id
         JOIN permission_action a ON a.id = rp.action_id
         WHERE ur.user_id=? AND m.key_name='Invoices' AND a.key_name='view_all' LIMIT 1`,
        [authUserId]
    );
    return { canViewAll: ok.length > 0 };
}

async function getNextCreditNoteNumber(conn) {
    const [rows] = await conn.query(`SELECT id FROM ar_credit_notes ORDER BY id DESC LIMIT 1`);
    const next = (rows[0]?.id || 0) + 1;
    return `CN-${String(next).padStart(5, '0')}`;
}

async function getNextCreditNoteNumberHandler(req, res, next) {
    try {
        const authUserId = req.user?.id || req.session?.user?.id;
        if (!authUserId) return res.status(401).json({ error: 'Unauthorized' });
        await tx(async (conn) => {
            const num = await getNextCreditNoteNumber(conn);
            res.json({ credit_note_number: num });
        });
    } catch (e) {
        next(e);
    }
}

async function listCreditNotes(req, res, next) {
    try {
        const page = Math.max(parseInt(req.query.page || '1', 10), 1);
        const perPage = Math.min(Math.max(parseInt(req.query.per_page || '25', 10), 1), 100);
        const offset = (page - 1) * perPage;
        const search = (req.query.search || '').trim();
        const customerId = req.query.customer_id ? parseInt(req.query.customer_id, 10) : null;
        const createdBy = req.query.created_by ? parseInt(req.query.created_by, 10) : null;
        const statusIdRaw = req.query.status_id || null;

        const authUserId = req.user?.id || req.session?.user?.id;
        if (!authUserId) return res.status(401).json({ error: 'Unauthorized' });
        const { canViewAll } = await resolveAuthAndViewAll(authUserId);

        let whereClause = 'WHERE 1=1';
        const params = [];

        if (!canViewAll) {
            whereClause += ' AND cn.user_id = ?';
            params.push(authUserId);
        } else if (createdBy) {
            whereClause += ' AND cn.user_id = ?';
            params.push(createdBy);
        }

        if (customerId) {
            whereClause += ' AND cn.customer_id = ?';
            params.push(customerId);
        }
        if (search) {
            whereClause += ' AND (cn.credit_note_number LIKE ? OR v.display_name LIKE ? OR ai.invoice_number LIKE ?)';
            const p = `%${search}%`;
            params.push(p, p, p);
        }
        if (statusIdRaw) {
            const statusStr = String(statusIdRaw);
            if (statusStr.includes(',')) {
                const ids = statusStr.split(',').map(s => s.trim()).filter(Boolean);
                if (ids.length > 0) {
                    whereClause += ` AND cn.status_id IN (${ids.map(() => '?').join(',')})`;
                    params.push(...ids);
                }
            } else {
                whereClause += ' AND cn.status_id = ?';
                params.push(statusStr);
            }
        }

        const [countRows] = await pool.query(
            `SELECT COUNT(*) as total
             FROM ar_credit_notes cn
             LEFT JOIN vendor v ON v.id = cn.customer_id
             LEFT JOIN ar_invoices ai ON ai.id = cn.ar_invoice_id
             ${whereClause}`,
            params
        );
        const total = countRows[0].total;

        const [rows] = await pool.query(
            `SELECT cn.*,
                    COALESCE(NULLIF(v.company_name, ''), v.display_name) AS customer_name,
                    c.name AS currency_code,
                    s.name AS status_name,
                    s.colour AS status_colour,
                    s.bg_colour AS status_bg_colour,
                    ai.invoice_number AS source_invoice_number,
                    ai.sales_order_number AS sales_order_number,
                    u.name AS created_by_name
             FROM ar_credit_notes cn
             LEFT JOIN vendor v ON v.id = cn.customer_id
             LEFT JOIN currency c ON c.id = cn.currency_id
             LEFT JOIN status s ON s.id = cn.status_id
             LEFT JOIN ar_invoices ai ON ai.id = cn.ar_invoice_id
             LEFT JOIN user u ON u.id = cn.user_id
             ${whereClause}
             ORDER BY cn.credit_note_date DESC, cn.id DESC
             LIMIT ? OFFSET ?`,
            [...params, perPage, offset]
        );

        res.json({ data: rows, total, page, perPage });
    } catch (e) {
        next(e);
    }
}

async function getCreditNote(req, res, next) {
    try {
        const { id } = req.params;
        const isNumeric = /^\d+$/.test(id);
        const whereField = isNumeric ? 'cn.id' : 'cn.credit_note_uniqid';

        const authUserId = req.user?.id || req.session?.user?.id;
        if (!authUserId) return res.status(401).json({ error: 'Unauthorized' });
        const { canViewAll } = await resolveAuthAndViewAll(authUserId);

        const [notes] = await pool.query(
            `SELECT cn.*,
                    COALESCE(NULLIF(v.company_name, ''), v.display_name) AS customer_name,
                    c.name AS currency_code,
                    s.name AS status_name,
                    s.colour AS status_colour,
                    s.bg_colour AS status_bg_colour,
                    ai.invoice_number AS source_invoice_number,
                    ai.invoice_uniqid AS source_invoice_uniqid
             FROM ar_credit_notes cn
             LEFT JOIN vendor v ON v.id = cn.customer_id
             LEFT JOIN currency c ON c.id = cn.currency_id
             LEFT JOIN status s ON s.id = cn.status_id
             LEFT JOIN ar_invoices ai ON ai.id = cn.ar_invoice_id
             WHERE ${whereField} = ?`,
            [id]
        );
        if (notes.length === 0) return res.status(404).json({ error: 'Credit note not found' });
        const note = notes[0];
        if (!canViewAll && Number(note.user_id) !== Number(authUserId)) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const [lines] = await pool.query(
            `SELECT
                cnl.*,
                um.name AS uom_name,
                t.tax_name,
                pd.packing_alias AS packing_alias
             FROM ar_credit_note_lines cnl
             LEFT JOIN uom_master um ON um.id = cnl.uom_id
             LEFT JOIN taxes t ON t.id = cnl.tax_id
             LEFT JOIN product_details pd ON pd.id = (
                SELECT id FROM product_details pd2
                WHERE pd2.product_id = cnl.product_id
                ORDER BY pd2.id ASC
                LIMIT 1
             )
             WHERE cnl.credit_note_id = ?
             ORDER BY cnl.line_no`,
            [note.id]
        );
        // Enrich lines with batch/container info (if available) from invoice allocations.
        const invLineIds = (lines || [])
            .map((l) => (l?.ar_invoice_line_id != null ? Number(l.ar_invoice_line_id) : NaN))
            .filter((n) => Number.isFinite(n));

        const allocByInvLine = new Map();
        if (invLineIds.length) {
            const uniqIds = Array.from(new Set(invLineIds));
            const placeholders = uniqIds.map(() => '?').join(',');
            // Try to include container no if such a column exists; fall back otherwise.
            let allocRows = [];
            try {
                const [rows] = await pool.query(
                    `SELECT
                        a.invoice_line_id,
                        GROUP_CONCAT(DISTINCT ib.batch_no ORDER BY ib.batch_no SEPARATOR ', ') AS batch_nos,
                        GROUP_CONCAT(DISTINCT NULLIF(TRIM(a.container_no), '') ORDER BY a.container_no SEPARATOR ', ') AS container_nos
                     FROM ar_invoice_line_batches a
                     LEFT JOIN inventory_batches ib ON ib.id = a.batch_id
                     WHERE a.invoice_line_id IN (${placeholders})
                     GROUP BY a.invoice_line_id`,
                    uniqIds
                );
                allocRows = rows || [];
            } catch (_e) {
                const [rows] = await pool.query(
                    `SELECT
                        a.invoice_line_id,
                        GROUP_CONCAT(DISTINCT ib.batch_no ORDER BY ib.batch_no SEPARATOR ', ') AS batch_nos
                     FROM ar_invoice_line_batches a
                     LEFT JOIN inventory_batches ib ON ib.id = a.batch_id
                     WHERE a.invoice_line_id IN (${placeholders})
                     GROUP BY a.invoice_line_id`,
                    uniqIds
                );
                allocRows = rows || [];
            }

            for (const r of allocRows) {
                const k = Number(r.invoice_line_id);
                if (!Number.isFinite(k)) continue;
                allocByInvLine.set(k, {
                    batch_nos: r.batch_nos || null,
                    container_nos: r.container_nos || null
                });
            }
        }

        note.lines = (lines || []).map((l) => {
            const idNum = l?.ar_invoice_line_id != null ? Number(l.ar_invoice_line_id) : null;
            const alloc = idNum != null && Number.isFinite(idNum) ? allocByInvLine.get(idNum) : null;
            return {
                ...l,
                batch_nos: alloc?.batch_nos || null,
                container_nos: alloc?.container_nos || null
            };
        });

        const [attachments] = await pool.query(
            `SELECT id, file_name, file_path, mime_type, size_bytes, created_at
             FROM ar_credit_notes_attachments
             WHERE credit_note_id = ?
             ORDER BY created_at ASC`,
            [note.id]
        );
        note.attachments = attachments || [];

        const [history] = await pool.query(
            `SELECT h.id, h.action, h.details, h.created_at, u.name AS user_name
             FROM history h
             LEFT JOIN user u ON u.id = h.user_id
             WHERE h.module = 'ar_credit_note' AND h.module_id = ?
             ORDER BY h.created_at DESC`,
            [note.id]
        );
        note.history = history || [];

        res.json(note);
    } catch (e) {
        next(e);
    }
}

async function createCreditNote(req, res, next) {
    await tx(async (conn) => {
        const userId = req.session?.user?.id || req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });

        const body = parseCreditNoteBody(req);
        const {
            credit_note_number,
            credit_note_date,
            reference_no,
            subject,
            customer_id,
            ar_invoice_id,
            company_id,
            warehouse_id,
            currency_id,
            customer_notes,
            discount_type,
            discount_amount,
            subtotal,
            tax_total,
            total,
            lines = []
        } = body;

        const customerIdNum =
            customer_id != null && customer_id !== '' && !Number.isNaN(Number(customer_id)) ? Number(customer_id) : NaN;
        const invIdNum =
            ar_invoice_id != null && ar_invoice_id !== '' && !Number.isNaN(Number(ar_invoice_id))
                ? Number(ar_invoice_id)
                : NaN;
        if (!Number.isFinite(customerIdNum) || !Number.isFinite(invIdNum) || customerIdNum < 1 || invIdNum < 1) {
            return res.status(400).json({ error: 'customer_id and ar_invoice_id are required' });
        }
        if (!Array.isArray(lines) || lines.length === 0) {
            return res.status(400).json({ error: 'At least one line item is required' });
        }

        const [invRows] = await conn.query(
            `SELECT id, customer_id, status_id, company_id, warehouse_id, currency_id
             FROM ar_invoices WHERE id = ?`,
            [invIdNum]
        );
        if (invRows.length === 0) return res.status(404).json({ error: 'Customer invoice not found' });
        const inv = invRows[0];
        if (Number(inv.status_id) !== APPROVED_INVOICE_STATUS) {
            return res.status(400).json({ error: 'Only approved customer invoices can be credited' });
        }
        if (Number(inv.customer_id) !== customerIdNum) {
            return res.status(400).json({ error: 'Selected invoice does not belong to this customer' });
        }

        let finalNumber = credit_note_number?.trim();
        if (!finalNumber) finalNumber = await getNextCreditNoteNumber(conn);
        const [dup] = await conn.query(`SELECT id FROM ar_credit_notes WHERE credit_note_number = ?`, [finalNumber]);
        if (dup.length > 0) return res.status(409).json({ error: 'Credit note number already exists' });

        const uniqid = `arcn_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

        const [ins] = await conn.query(
            `INSERT INTO ar_credit_notes
             (credit_note_uniqid, credit_note_number, credit_note_date, reference_no, subject,
              customer_id, ar_invoice_id, company_id, warehouse_id, currency_id, customer_notes,
              discount_type, discount_amount, subtotal, tax_total, total, status_id, user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 3, ?)`,
            [
                uniqid,
                finalNumber,
                credit_note_date || new Date().toISOString().slice(0, 10),
                reference_no || null,
                subject || null,
                customerIdNum,
                invIdNum,
                company_id ?? inv.company_id ?? null,
                warehouse_id ?? inv.warehouse_id ?? null,
                currency_id ?? inv.currency_id ?? null,
                customer_notes || null,
                discount_type || 'fixed',
                Number(discount_amount) || 0,
                Number(subtotal) || 0,
                Number(tax_total) || 0,
                Number(total) || 0,
                userId
            ]
        );
        const cnId = ins.insertId;

        for (let i = 0; i < lines.length; i++) {
            const L = lines[i];
            await conn.query(
                `INSERT INTO ar_credit_note_lines
                 (credit_note_id, line_no, ar_invoice_line_id, product_id, item_name, description,
                  quantity, uom_id, rate, tax_id, tax_rate, line_total, account_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    cnId,
                    i + 1,
                    L.ar_invoice_line_id || null,
                    L.product_id || null,
                    L.item_name || null,
                    L.description || null,
                    Number(L.quantity) || 0,
                    L.uom_id || null,
                    Number(L.rate) || 0,
                    L.tax_id || null,
                    Number(L.tax_rate) || 0,
                    Number(L.line_total) || 0,
                    L.account_id || null
                ]
            );
        }

        if (req.files && req.files.length > 0) {
            const relPath = (f) => {
                if (!f || !f.path) return null;
                const basename = path.basename(f.path);
                return `uploads/ar_credit_notes/${basename}`;
            };
            const attachmentValues = req.files.map((f) => [
                cnId,
                f.originalname,
                relPath(f),
                f.mimetype || null,
                f.size || null,
                new Date()
            ]);
            await conn.query(
                `INSERT INTO ar_credit_notes_attachments
                 (credit_note_id, file_name, file_path, mime_type, size_bytes, created_at)
                 VALUES ?`,
                [attachmentValues]
            );
        }

        await addHistory(conn, {
            module: 'ar_credit_note',
            moduleId: cnId,
            userId,
            action: 'CREATED',
            details: { credit_note_number: finalNumber, ar_invoice_id: invIdNum, customer_id: customerIdNum }
        });

        const [[row]] = await conn.query(`SELECT * FROM ar_credit_notes WHERE id = ?`, [cnId]);
        res.status(201).json(row);
    }).catch(next);
}

async function updateCreditNote(req, res, next) {
    await tx(async (conn) => {
        const userId = req.session?.user?.id || req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });

        const { id } = req.params;
        const isNumeric = /^\d+$/.test(id);
        const whereField = isNumeric ? 'id' : 'credit_note_uniqid';

        const [existing] = await conn.query(`SELECT * FROM ar_credit_notes WHERE ${whereField} = ?`, [id]);
        if (existing.length === 0) return res.status(404).json({ error: 'Credit note not found' });
        const note = existing[0];
        if (Number(note.status_id) !== 3) {
            return res.status(400).json({ error: 'Only draft credit notes can be updated' });
        }

        const { canViewAll } = await resolveAuthAndViewAll(userId);
        if (!canViewAll && Number(note.user_id) !== Number(userId)) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const body = parseCreditNoteBody(req);
        const {
            credit_note_number,
            credit_note_date,
            reference_no,
            subject,
            customer_id,
            ar_invoice_id,
            company_id,
            warehouse_id,
            currency_id,
            customer_notes,
            discount_type,
            discount_amount,
            subtotal,
            tax_total,
            total,
            lines = [],
            deleted_attachment_ids
        } = body;

        if (ar_invoice_id && customer_id) {
            const [invRows] = await conn.query(
                `SELECT id, customer_id, status_id FROM ar_invoices WHERE id = ?`,
                [ar_invoice_id]
            );
            if (invRows.length === 0) return res.status(404).json({ error: 'Customer invoice not found' });
            const inv = invRows[0];
            if (Number(inv.status_id) !== APPROVED_INVOICE_STATUS) {
                return res.status(400).json({ error: 'Only approved customer invoices can be linked' });
            }
            if (Number(inv.customer_id) !== Number(customer_id)) {
                return res.status(400).json({ error: 'Selected invoice does not belong to this customer' });
            }
        }

        if (!Array.isArray(lines) || lines.length === 0) {
            return res.status(400).json({ error: 'At least one line item is required' });
        }

        const num = credit_note_number?.trim() || note.credit_note_number;
        if (num !== note.credit_note_number) {
            const [dup] = await conn.query(`SELECT id FROM ar_credit_notes WHERE credit_note_number = ? AND id <> ?`, [
                num,
                note.id
            ]);
            if (dup.length > 0) return res.status(409).json({ error: 'Credit note number already exists' });
        }

        const pickNum = (v, fallback) =>
            v !== undefined && v !== null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : fallback;

        await conn.query(
            `UPDATE ar_credit_notes SET
             credit_note_number = ?, credit_note_date = ?, reference_no = ?, subject = ?,
             customer_id = ?, ar_invoice_id = ?, company_id = ?, warehouse_id = ?, currency_id = ?,
             customer_notes = ?, discount_type = ?, discount_amount = ?, subtotal = ?, tax_total = ?, total = ?
             WHERE id = ?`,
            [
                num,
                credit_note_date || note.credit_note_date,
                reference_no !== undefined ? reference_no : note.reference_no,
                subject !== undefined ? subject : note.subject,
                customer_id ?? note.customer_id,
                ar_invoice_id ?? note.ar_invoice_id,
                company_id !== undefined ? company_id : note.company_id,
                warehouse_id !== undefined ? warehouse_id : note.warehouse_id,
                currency_id !== undefined ? currency_id : note.currency_id,
                customer_notes !== undefined ? customer_notes : note.customer_notes,
                discount_type || note.discount_type || 'fixed',
                pickNum(discount_amount, note.discount_amount),
                pickNum(subtotal, note.subtotal),
                pickNum(tax_total, note.tax_total),
                pickNum(total, note.total),
                note.id
            ]
        );

        await conn.query(`DELETE FROM ar_credit_note_lines WHERE credit_note_id = ?`, [note.id]);
        for (let i = 0; i < lines.length; i++) {
            const L = lines[i];
            await conn.query(
                `INSERT INTO ar_credit_note_lines
                 (credit_note_id, line_no, ar_invoice_line_id, product_id, item_name, description,
                  quantity, uom_id, rate, tax_id, tax_rate, line_total, account_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    note.id,
                    i + 1,
                    L.ar_invoice_line_id || null,
                    L.product_id || null,
                    L.item_name || null,
                    L.description || null,
                    Number(L.quantity) || 0,
                    L.uom_id || null,
                    Number(L.rate) || 0,
                    L.tax_id || null,
                    Number(L.tax_rate) || 0,
                    Number(L.line_total) || 0,
                    L.account_id || null
                ]
            );
        }

        if (deleted_attachment_ids) {
            let deletedIds = [];
            try {
                deletedIds = Array.isArray(deleted_attachment_ids)
                    ? deleted_attachment_ids
                    : JSON.parse(deleted_attachment_ids);
            } catch (_e) {
                deletedIds = [];
            }
            if (deletedIds.length > 0) {
                const fs = require('fs');
                const [filesToDelete] = await conn.query(
                    `SELECT id, file_path FROM ar_credit_notes_attachments WHERE id IN (?) AND credit_note_id = ?`,
                    [deletedIds, note.id]
                );
                for (const file of filesToDelete) {
                    if (file.file_path) {
                        const fullPath = path.join(__dirname, '../../..', file.file_path);
                        await fs.promises.unlink(fullPath).catch((e) => console.warn(`Failed to delete file: ${fullPath}`, e));
                    }
                }
                await conn.query(`DELETE FROM ar_credit_notes_attachments WHERE id IN (?) AND credit_note_id = ?`, [
                    deletedIds,
                    note.id
                ]);
            }
        }

        if (req.files && req.files.length > 0) {
            const relPath = (f) => {
                if (!f || !f.path) return null;
                const basename = path.basename(f.path);
                return `uploads/ar_credit_notes/${basename}`;
            };
            const attachmentValues = req.files.map((f) => [
                note.id,
                f.originalname,
                relPath(f),
                f.mimetype || null,
                f.size || null,
                new Date()
            ]);
            await conn.query(
                `INSERT INTO ar_credit_notes_attachments
                 (credit_note_id, file_name, file_path, mime_type, size_bytes, created_at)
                 VALUES ?`,
                [attachmentValues]
            );
        }

        await addHistory(conn, {
            module: 'ar_credit_note',
            moduleId: note.id,
            userId,
            action: 'UPDATED',
            details: { credit_note_number: num }
        });

        const [[row]] = await conn.query(`SELECT * FROM ar_credit_notes WHERE id = ?`, [note.id]);
        res.json(row);
    }).catch(next);
}

async function changeCreditNoteStatus(req, res, next) {
    try {
        const { id } = req.params;
        const rawStatusId = req.body?.status_id;
        const userId = req.user?.id ?? req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });
        if (rawStatusId === undefined || rawStatusId === null || rawStatusId === '') {
            return res.status(400).json({ error: 'status_id is required' });
        }
        const status_id = parseInt(rawStatusId, 10);
        if (Number.isNaN(status_id)) {
            return res.status(400).json({ error: 'status_id must be a number' });
        }

        const isNumeric = /^\d+$/.test(String(id).trim());
        const whereField = isNumeric ? 'id' : 'credit_note_uniqid';

        const [notes] = await pool.query(
            `SELECT id, status_id, user_id FROM ar_credit_notes WHERE ${whereField} = ?`,
            [id]
        );
        if (notes.length === 0) return res.status(404).json({ error: 'Credit note not found' });

        const note = notes[0];
        const { canViewAll } = await resolveAuthAndViewAll(userId);
        if (!canViewAll && Number(note.user_id) !== Number(userId)) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const oldStatusId = Number(note.status_id);
        if (oldStatusId !== 3) {
            return res.status(400).json({ error: 'Only draft credit notes can be submitted for approval' });
        }
        if (status_id !== 8) {
            return res.status(400).json({ error: 'Invalid status transition' });
        }

        await pool.query('UPDATE ar_credit_notes SET status_id = ? WHERE id = ?', [status_id, note.id]);

        const [oldStatus] = await pool.query('SELECT name, colour, bg_colour FROM status WHERE id = ?', [oldStatusId]);
        const [newStatus] = await pool.query('SELECT name, colour, bg_colour FROM status WHERE id = ?', [status_id]);

        await pool.query(
            `INSERT INTO history (module, module_id, user_id, action, details, created_at)
             VALUES (?, ?, ?, ?, ?, NOW())`,
            [
                'ar_credit_note',
                note.id,
                userId,
                'STATUS_CHANGED',
                JSON.stringify({
                    from_status_id: oldStatusId,
                    from_status_name: oldStatus[0]?.name || 'N/A',
                    to_status_id: status_id,
                    to_status_name: newStatus[0]?.name || 'N/A'
                })
            ]
        );

        res.json({
            status_id,
            status_name: newStatus[0]?.name || 'N/A',
            status_colour: newStatus[0]?.colour || '#fff',
            status_bg_colour: newStatus[0]?.bg_colour || '#9e9e9e'
        });
    } catch (e) {
        next(e);
    }
}

async function addCreditNoteAttachment(req, res, next) {
    await tx(async (conn) => {
        const { id } = req.params;
        const userId = req.session?.user?.id || req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });

        const isNumeric = /^\d+$/.test(String(id).trim());
        const whereField = isNumeric ? 'id' : 'credit_note_uniqid';

        const [rows] = await conn.query(`SELECT id, status_id, user_id FROM ar_credit_notes WHERE ${whereField} = ?`, [id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Credit note not found' });
        const note = rows[0];
        if (Number(note.status_id) !== 3) {
            return res.status(400).json({ error: 'Only draft credit notes can be modified' });
        }
        const { canViewAll } = await resolveAuthAndViewAll(userId);
        if (!canViewAll && Number(note.user_id) !== Number(userId)) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No files were uploaded' });
        }

        const relPath = (f) => {
            if (!f || !f.path) return null;
            const basename = path.basename(f.path);
            return `uploads/ar_credit_notes/${basename}`;
        };

        const attachmentValues = req.files.map((f) => [
            note.id,
            f.originalname,
            relPath(f),
            f.mimetype || null,
            f.size || null,
            new Date()
        ]);

        await conn.query(
            `INSERT INTO ar_credit_notes_attachments
             (credit_note_id, file_name, file_path, mime_type, size_bytes, created_at)
             VALUES ?`,
            [attachmentValues]
        );

        await addHistory(conn, {
            module: 'ar_credit_note',
            moduleId: note.id,
            userId,
            action: 'ATTACHMENT_ADDED',
            details: {
                file_count: req.files.length,
                file_names: req.files.map((f) => f.originalname)
            }
        });

        res.json({ success: true, message: 'Attachments uploaded successfully' });
    }).catch(next);
}

async function deleteCreditNoteAttachment(req, res, next) {
    try {
        const { id, attachmentId } = req.params;
        const userId = req.session?.user?.id || req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });

        const isNumeric = /^\d+$/.test(String(id).trim());
        const whereField = isNumeric ? 'id' : 'credit_note_uniqid';

        const [notes] = await pool.query(`SELECT id, status_id, user_id FROM ar_credit_notes WHERE ${whereField} = ?`, [id]);
        if (notes.length === 0) return res.status(404).json({ error: 'Credit note not found' });
        const note = notes[0];
        if (Number(note.status_id) !== 3) {
            return res.status(400).json({ error: 'Only draft credit notes can be modified' });
        }
        const { canViewAll } = await resolveAuthAndViewAll(userId);
        if (!canViewAll && Number(note.user_id) !== Number(userId)) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const [attachments] = await pool.query(
            `SELECT * FROM ar_credit_notes_attachments WHERE id = ? AND credit_note_id = ?`,
            [attachmentId, note.id]
        );
        if (attachments.length === 0) return res.status(404).json({ error: 'Attachment not found' });

        const attachment = attachments[0];
        if (attachment.file_path) {
            const fs = require('fs');
            const fp = attachment.file_path.startsWith('/') ? attachment.file_path.slice(1) : attachment.file_path;
            const abs = path.resolve(fp);
            try {
                if (fs.existsSync(abs)) fs.unlinkSync(abs);
            } catch (err) {
                console.error('Error deleting credit note attachment file:', err);
            }
        }

        await pool.query(`DELETE FROM ar_credit_notes_attachments WHERE id = ?`, [attachmentId]);
        res.json({ success: true });
    } catch (e) {
        next(e);
    }
}

async function approveCreditNote(req, res, next) {
    try {
        const userId = req.user?.id ?? req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const comment = req.body?.comment;
        if (!comment || !String(comment).trim()) {
            return res.status(400).json({ error: 'Approval comment is required' });
        }
        const { id } = req.params;
        const isNumeric = /^\d+$/.test(String(id).trim());
        const whereField = isNumeric ? 'id' : 'credit_note_uniqid';

        await tx(async (conn) => {
            const [rows] = await conn.query(
                `SELECT id, status_id, credit_note_number FROM ar_credit_notes WHERE ${whereField} = ?`,
                [id]
            );
            if (rows.length === 0) {
                const err = new Error('Credit note not found');
                err.statusCode = 404;
                throw err;
            }
            const note = rows[0];
            if (Number(note.status_id) !== 8) {
                const err = new Error('Only credit notes submitted for approval can be approved');
                err.statusCode = 400;
                throw err;
            }

            await arCreditNotesService.postCreditNote(conn, note.id, userId);

            await conn.query(`UPDATE ar_credit_notes SET status_id = 1 WHERE id = ?`, [note.id]);

            await addHistory(conn, {
                module: 'ar_credit_note',
                moduleId: note.id,
                userId,
                action: 'APPROVED',
                details: { comment: String(comment).trim(), credit_note_number: note.credit_note_number }
            });
        });

        res.json({ success: true, message: 'Credit note approved and posted' });
    } catch (e) {
        if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
        next(e);
    }
}

async function rejectCreditNote(req, res, next) {
    try {
        const userId = req.user?.id ?? req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const comment = req.body?.comment;
        if (!comment || !String(comment).trim()) {
            return res.status(400).json({ error: 'Rejection reason is required' });
        }
        const { id } = req.params;
        const isNumeric = /^\d+$/.test(String(id).trim());
        const whereField = isNumeric ? 'id' : 'credit_note_uniqid';

        await tx(async (conn) => {
            const [rows] = await conn.query(`SELECT id, status_id FROM ar_credit_notes WHERE ${whereField} = ?`, [id]);
            if (rows.length === 0) {
                const err = new Error('Credit note not found');
                err.statusCode = 404;
                throw err;
            }
            const note = rows[0];
            if (Number(note.status_id) !== 8) {
                const err = new Error('Only credit notes submitted for approval can be rejected');
                err.statusCode = 400;
                throw err;
            }

            const oldStatusId = note.status_id;
            const [fromStatusRows] = await conn.query(`SELECT name FROM status WHERE id = ? LIMIT 1`, [oldStatusId]);
            const [toStatusRows] = await conn.query(`SELECT name FROM status WHERE id = ? LIMIT 1`, [2]);

            await conn.query(`UPDATE ar_credit_notes SET status_id = 2 WHERE id = ?`, [note.id]);

            await addHistory(conn, {
                module: 'ar_credit_note',
                moduleId: note.id,
                userId,
                action: 'STATUS_CHANGED',
                details: {
                    from_status_id: oldStatusId,
                    from_status_name: fromStatusRows[0]?.name || 'N/A',
                    to_status_id: 2,
                    to_status_name: toStatusRows[0]?.name || 'Rejected',
                    comment: String(comment).trim()
                }
            });
        });

        res.json({ success: true, message: 'Credit note rejected' });
    } catch (e) {
        if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
        next(e);
    }
}

module.exports = {
    getNextCreditNoteNumber: getNextCreditNoteNumberHandler,
    listCreditNotes,
    getCreditNote,
    createCreditNote,
    updateCreditNote,
    changeCreditNoteStatus,
    addCreditNoteAttachment,
    deleteCreditNoteAttachment,
    approveCreditNote,
    rejectCreditNote
};
