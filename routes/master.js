// server/routes/lookups.js  (ESM)
import { Router } from 'express';
import db from '../db.js';

const router = Router();

/**
 * Config supports:
 * - table, id
 * - fields: [{ name, type: 'string'|'number'|'boolean', required?, default? }]
 * - listOrderBy (used if no join is specified)
 * - listSelect, listFrom, listSearchIn (JOIN-enabled listing)
 */
const MASTER_CONFIG = {
    brand: {
        table: 'brands',
        id: 'id',
        fields: [
            { name: 'brand_name', type: 'string', required: true },
            { name: 'manufacture_name', type: 'string' }
        ],
        listOrderBy: 'brand_name'
    },

    tax_treatment: {
        table: 'tax_treatment',
        id: 'id',
        fields: [
            { name: 'name', type: 'string', required: true },
            { name: 'tax_number_required', type: 'boolean', default: false }
        ],
        listOrderBy: 'name'
    },

    source_of_supply: {
        table: 'source_supply',
        id: 'id',
        fields: [{ name: 'source', type: 'string', required: true }],
        listOrderBy: 'source'
    },

    currency: {
        table: 'currency',
        id: 'id',
        fields: [
            { name: 'label', type: 'string', required: true },
            { name: 'name', type: 'string', required: true },
            { name: 'currency_fullname', type: 'string' },
            { name: 'conversion_rate', type: 'number', default: 1 }
        ],
        listOrderBy: 'label'
    },

    payment_terms: {
        table: 'payment_terms',
        id: 'id',
        fields: [{ name: 'terms', type: 'string', required: true }],
        listOrderBy: 'terms'
    },

    tax: {
        table: 'taxes',
        id: 'id',
        fields: [
            { name: 'tax_name', type: 'string', required: true },
            { name: 'rate', type: 'number', required: true },
            { name: 'percent', type: 'string', required: true }
        ],
        listOrderBy: 'tax_name'
    },

    /* ---------- DROPDOWN SOURCE ---------- */
    account_type: {
        table: 'account_type',
        id: 'id',
        fields: [{ name: 'type_name', type: 'string', required: true }],
        listOrderBy: 'type_name'
    },

    /* ---------- INVENTORY ACCOUNT (accounts table) ---------- */
    inventory_account: {
        table: 'accounts',
        id: 'id',
        fields: [
            { name: 'account_name', type: 'string', required: true },
            { name: 'type_id', type: 'number', required: true }
        ],
        // JOIN-enabled listing to show type_name in the grid
        listSelect: 'a.id, a.account_name, a.type_id, at.type_name',
        listFrom: 'accounts a JOIN account_type at ON at.id = a.type_id',
        listSearchIn: ['a.account_name', 'at.type_name'],
        listOrderBy: 'a.account_name'
    },

    inventory_valuation_method: {
        table: 'valuation_methods',
        id: 'id',
        fields: [
            { name: 'code', type: 'string', required: true },
            { name: 'method_name', type: 'string' },
            { name: 'sort_order', type: 'number' }
        ],
        listOrderBy: 'method_name'
    },
    shipment_stage: {
        table: 'shipment_stage',
        id: 'id',
        fields: [{ name: 'name', type: 'string', required: true }],
       listOrderBy: 'sort_order'
  },

    document_type: {
        table: 'document_type',
        id: 'id',
        fields: [
            { name: 'name', type: 'string', required: true },
            { name: 'code', type: 'string', required: true }
        ],
        listOrderBy: 'name'
    },

    shipment_document: {
        table: 'shipment_document',
        id: 'id',
            fields: [
                    { name: 'shipment_stage', type: 'number', required: true },   // FK → shipment_stage.id
                    { name: 'document_type_id', type: 'number', required: true }, // FK → document_type.id
                    { name: 'is_required', type: 'boolean', default: false }
                  ],
          listSelect: `
                 sd.id,
                 sd.shipment_stage,
                 sd.document_type_id,
                 sd.is_required,
                 ss.name AS shipment_stage_name,
                 dt.name AS document_type_name
              `,
                  listFrom: `
                 shipment_document sd
                 LEFT JOIN shipment_stage ss ON ss.id = sd.shipment_stage
                 LEFT JOIN document_type dt ON dt.id = sd.document_type_id
               `,
                   listSearchIn: ['ss.name', 'dt.name'],
                   listOrderBy: 'ss.name'
            }
        };

function getCfg(type) {
    const cfg = MASTER_CONFIG[type];
    if (!cfg) {
        const err = new Error(`Unknown master type: ${type}`);
        err.status = 400;
        throw err;
    }
    return cfg;
}

function coerceField(field, value) {
    if (value === undefined || value === null) return value;
    switch (field.type) {
        case 'number': return value === '' ? null : Number(value);
        case 'boolean': return value === true || value === 'true' || value === 1 || value === '1';
        default: return String(value);
    }
}

function buildSearchClause(cols, q) {
    if (!q || !cols?.length) return { whereSql: '', params: [] };
    const like = `%${q}%`;
    const params = [];
    const parts = cols.map(c => { params.push(like); return `${c} LIKE ?`; });
    return { whereSql: `WHERE ${parts.join(' OR ')}`, params };
}

/* ----------------------------- LIST ----------------------------- */
// GET /api/master/:type  (pagination + search; JOIN-aware)
router.get('/:type', (req, res, next) => {
    try {
        const type = req.params.type;
        const cfg = getCfg(type);

        const page = Math.max(parseInt(req.query.page || '1', 10), 1);
        const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '25', 10), 1), 200);
        const q = (req.query.q || '').trim();

        // JOIN-enabled path
        if (cfg.listFrom && cfg.listSelect) {
            const orderBy = cfg.listOrderBy || cfg.id;
            const { whereSql, params } = buildSearchClause(cfg.listSearchIn, q);

            const countSql = `SELECT COUNT(*) AS cnt FROM ${cfg.listFrom} ${whereSql}`;
            db.query(countSql, params, (err, cntRows) => {
                if (err) return next(err);
                const total = cntRows?.[0]?.cnt || 0;

                const offset = (page - 1) * pageSize;
                const dataSql = `
          SELECT ${cfg.listSelect}
          FROM ${cfg.listFrom}
          ${whereSql}
          ORDER BY ${orderBy} ASC
          LIMIT ? OFFSET ?
        `;
                db.query(dataSql, [...params, pageSize, offset], (err2, rows) => {
                    if (err2) return next(err2);
                    return res.json({ rows, total });
                });
            });
            return;
        }

        // Simple table path
        const orderBy = cfg.listOrderBy || cfg.id;
        const searchCols = cfg.fields?.map(f => `\`${f.name}\``) || ['`name`'];
        const { whereSql, params } = buildSearchClause(searchCols, q);

        db.query(`SELECT COUNT(*) AS cnt FROM \`${cfg.table}\` ${whereSql}`, params, (err, cntRows) => {
            if (err) return next(err);
            const total = cntRows?.[0]?.cnt || 0;

            const offset = (page - 1) * pageSize;
            db.query(
                `SELECT * FROM \`${cfg.table}\` ${whereSql} ORDER BY \`${orderBy}\` ASC LIMIT ? OFFSET ?`,
                [...params, pageSize, offset],
                (err2, rows) => {
                    if (err2) return next(err2);
                    res.json({ rows, total });
                }
            );
        });
    } catch (e) { next(e); }
});

/* ----------------------------- CREATE ----------------------------- */
// POST /api/master/:type
router.post('/:type', (req, res, next) => {
    try {
        const cfg = getCfg(req.params.type);

        // Build insert payload from cfg.fields only
        const payload = {};
        for (const f of cfg.fields) {
            const has = Object.prototype.hasOwnProperty.call(req.body, f.name);
            const raw = has ? req.body[f.name] : (f.default !== undefined ? f.default : undefined);

            if ((raw === undefined || raw === null || raw === '') && f.required) {
                const err = new Error(`Missing required field "${f.name}"`);
                err.status = 400; throw err;
            }
            if (raw !== undefined) payload[f.name] = coerceField(f, raw);
        }

        db.query(`INSERT INTO \`${cfg.table}\` SET ?`, [payload], (err, result) => {
            if (err) return next(err);
            const newId = result?.insertId;
            db.query(`SELECT * FROM \`${cfg.table}\` WHERE \`${cfg.id}\`=?`, [newId], (err2, rows) => {
                if (err2) return next(err2);
                res.status(201).json(rows?.[0] || { [cfg.id]: newId, ...payload });
            });
        });
    } catch (e) { next(e); }
});

/* ----------------------------- UPDATE ----------------------------- */
// PUT /api/master/:type/:id
router.put('/:type/:id', (req, res, next) => {
    try {
        const cfg = getCfg(req.params.type);
        const updates = {};
        for (const f of cfg.fields) {
            if (Object.prototype.hasOwnProperty.call(req.body, f.name)) {
                updates[f.name] = coerceField(f, req.body[f.name]);
            }
        }
        if (!Object.keys(updates).length) {
            const err = new Error('No fields to update');
            err.status = 400; throw err;
        }
        db.query(
            `UPDATE \`${cfg.table}\` SET ? WHERE \`${cfg.id}\`=?`,
            [updates, req.params.id],
            (err) => {
                if (err) return next(err);
                db.query(`SELECT * FROM \`${cfg.table}\` WHERE \`${cfg.id}\`=?`, [req.params.id], (err2, rows) => {
                    if (err2) return next(err2);
                    if (!rows.length) return res.status(404).json({ message: 'Not found' });
                    res.json(rows[0]);
                });
            }
        );
    } catch (e) { next(e); }
});

/* ----------------------------- DELETE ----------------------------- */
// DELETE /api/master/:type/:id
router.delete('/:type/:id', (req, res, next) => {
    try {
        const cfg = getCfg(req.params.type);
        db.query(`DELETE FROM \`${cfg.table}\` WHERE \`${cfg.id}\`=?`, [req.params.id], (err) => {
            if (err) return next(err);
            res.json({ success: true });
        });
    } catch (e) { next(e); }
});

export default router;
