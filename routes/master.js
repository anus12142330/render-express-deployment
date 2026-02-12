// server/routes/lookups.js  (ESM)
import { Router } from 'express';
import db from '../db.js';
import multer from 'multer';

const upload = multer();
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
        listOrderBy: 'brand_name',
        inUseChecks: [
            { table: 'product_details', field: 'brand_id', message: 'in use by products' }
        ]
    },

    uom: {
        table: 'uom_master',
        id: 'id',
        fields: [
            { name: 'name', type: 'string', required: true },
            { name: 'acronyms', type: 'string', required: true }
        ],
        listOrderBy: 'name',
        inUseChecks: [
            { table: 'product_details', field: 'uom_id', message: 'in use by products' }
        ]
    },

    category: {
        table: 'categories',
        id: 'id',
        fields: [
            { name: 'name', type: 'string', required: true },
            { name: 'parent_id', type: 'number', lookup: 'category' }
        ],
        listSelect: `
            c.id, c.name, c.parent_id,
            p.name AS parent_name
        `,
        listFrom: `
            categories c
            LEFT JOIN categories p ON p.id = c.parent_id
        `,
        listSearchIn: ['c.name', 'p.name'],
        listOrderBy: 'c.name',
        inUseChecks: [
            { table: 'products', field: 'category_id', message: 'in use by products' },
            // { table: 'categories', field: 'parent_id', message: 'in use as a parent category' }
        ]
    },

    service_category: {
        table: 'service_categories',
        id: 'id',
        fields: [
            { name: 'name', type: 'string', required: true },
            { name: 'parent_id', type: 'number', lookup: 'service_category' }
        ],
        listSelect: `
            c.id, c.name, c.parent_id,
            p.name AS parent_name
        `,
        listFrom: `
            service_categories c
            LEFT JOIN service_categories p ON p.id = c.parent_id
        `,
        listSearchIn: ['c.name', 'p.name'],
        listOrderBy: 'c.name'
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
            { name: 'conversion_rate', type: 'number', default: 1 },
            { name: 'subunit_label', type: 'string' }
        ],
        listOrderBy: 'label'
    },

    payment_terms: {
        table: 'payment_terms',
        id: 'id',
        fields: [
            { name: 'terms', type: 'string', required: true },
            { name: 'description', type: 'string' },
            { name: 'payment_type', type: 'string' } // "Pre Payment" or "Post Payment"
        ],
        listOrderBy: 'terms'
    },

    delivery_place: {
        table: 'delivery_place',
        id: 'id',
        fields: [
            { name: 'name', type: 'string', required: true },
            { name: 'country_id', type: 'number', required: true, lookup: 'countries' },
            { name: 'port_code', type: 'string', required: false }
        ],
        listSelect: `
            dp.id, dp.name, dp.country_id, dp.port_code,
            c.name AS country_name
        `,
        listFrom: `
            delivery_place dp
            LEFT JOIN country c ON c.id = dp.country_id
        `,
        listSearchIn: ['dp.name', 'c.name', 'dp.port_code'],
        listOrderBy: 'dp.name'
    },
    mode_of_shipment: {
        table: 'mode_of_shipment',
        id: 'id',
        fields: [
            { name: 'name', type: 'string', required: true },
            { name: 'trade_type_id', type: 'number', lookup: 'trade_type' }
        ],
        listSelect: 'mos.id, mos.name, mos.trade_type_id, tt.name AS trade_type_name',
        listFrom: 'mode_of_shipment mos LEFT JOIN trade_type tt ON tt.id = mos.trade_type_id',
        listSearchIn: ['mos.name', 'tt.name'],
        listOrderBy: 'mos.name'
    },

    state: {
        table: 'state',
        id: 'id',
        fields: [
            { name: 'name', type: 'string', required: true },
            { name: 'country_id', type: 'number', required: true, lookup: 'countries' }
        ],
        listSelect: `
            s.id, s.name, s.country_id,
            c.name AS country_name
        `,
        listFrom: `
            state s
            LEFT JOIN country c ON c.id = s.country_id
        `,
        listSearchIn: ['s.name', 'c.name'],
        listOrderBy: 's.name'
    },
    country: {
        table: 'country',
        id: 'id',
        fields: [{ name: 'name', type: 'string', required: true }],
        listSearchIn: ['name'],
        listOrderBy: 'name'
    },
    trade_type: {
        table: 'trade_type',
        id: 'id',
        fields: [{ name: 'name', type: 'string', required: true }],
        listOrderBy: 'name'
    },
    inco_terms: {
        table: 'inco_terms',
        id: 'id',
        fields: [
            { name: 'name', type: 'string', required: true },
            { name: 'acronyms', type: 'string', required: true },
            { name: 'trade_type_id', type: 'number', lookup: 'trade_type' }
        ],
        listSelect: 'it.id, it.name, it.acronyms, it.trade_type_id, tt.name AS trade_type_name',
        listFrom: 'inco_terms it LEFT JOIN trade_type tt ON tt.id = it.trade_type_id',
        listSearchIn: ['it.name', 'it.acronyms', 'tt.name'],
        listOrderBy: 'it.name'
    },
    kyc_documents: {
        table: 'kyc_documents',
        id: 'id',
        fields: [
            { name: 'name', type: 'string', required: true },
            { name: 'has_expiry', type: 'boolean', default: false }
        ],
        listOrderBy: 'name',
        inUseChecks: [] // Add in-use checks later if needed
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

    payment_type: {
        table: 'payment_type',
        id: 'id',
        fields: [
            { name: 'name', type: 'string', required: true },
            { name: 'code', type: 'string', required: true },
            { name: 'description', type: 'string' },
            { name: 'is_active', type: 'boolean', default: true }
        ],
        listOrderBy: 'name'
    },

    /* ---------- CHART OF ACCOUNTS – DROPDOWN SOURCES ---------- */
    acc_type: {
        table: 'acc_type',
        id: 'id',
        fields: [{ name: 'acc_type', type: 'string', required: true }],
        listOrderBy: 'acc_type'
    },

    acc_detail_type: {
        table: 'acc_detail_type',
        id: 'id',
        fields: [
            { name: 'acc_type_id', type: 'number', required: true, lookup: 'acc_type' }, // FK -> acc_type.id
            { name: 'detail_type', type: 'string', required: true },
            { name: 'description', type: 'string' }
        ],
        // Show the parent type name in list view
        listSelect: `
    dt.id, dt.acc_type_id, dt.detail_type, dt.description,
    t.acc_type AS acc_type_name
  `,
        listFrom: `
    acc_detail_type dt
    LEFT JOIN acc_type t ON t.id = dt.acc_type_id
  `,
        listSearchIn: ['dt.detail_type', 't.acc_type'],
        listOrderBy: 'dt.detail_type'
    },

    /* ---------- CHART OF ACCOUNTS (main) ---------- */
    chart_of_accounts: {
        table: 'acc_chart_accounts',
        id: 'id',
        fields: [
            // keep both IDs separately as you requested
            { name: 'account_type_id', type: 'number', required: true, lookup: 'account_type' }, // header type -> account_type.id
            { name: 'acc_type_id', type: 'number', required: true, lookup: 'acc_type' }, // group type  -> acc_type.id
            { name: 'acc_detail_id', type: 'number', required: true, lookup: 'acc_detail_type' }, // -> acc_detail_type.id
            { name: 'name', type: 'string', required: true },
            { name: 'description', type: 'string', required: true },
            { name: 'sub_id', type: 'boolean', default: false }, // "Is sub-account"
            { name: 'parent_id', type: 'number', lookup: 'chart_of_accounts' },
            { name: 'vat_id', type: 'number', lookup: 'tax' },
            { name: 'balance', type: 'number' },
            { name: 'as_of', type: 'date' } // yyyy-mm-dd (let UI send a date string)
        ],
        // nice listing with joined names for your grid
        listSelect: `
    cca.id,
    cca.name,
    cca.description,
    cca.account_type_id,
    cca.acc_type_id,
    cca.acc_detail_id,
    cca.sub_id,
    cca.parent_id,
    cca.vat_id,
    cca.balance,
    cca.as_of,
    atH.type_name AS header_type_name,
    atG.acc_type AS group_type_name,
    dt.detail_type AS detail_type_name
  `,
        listFrom: `
    acc_chart_accounts cca
    LEFT JOIN account_type atH ON atH.id = cca.account_type_id
    LEFT JOIN acc_type atG ON atG.id = cca.acc_type_id
    LEFT JOIN acc_detail_type dt ON dt.id = cca.acc_detail_id
  `,
        listSearchIn: ['cca.name', 'cca.description', 'atH.type_name', 'atG.acc_type', 'dt.detail_type'],
        listOrderBy: 'cca.name'
    },

    /* ---------- INVENTORY ACCOUNT (accounts table) ---------- */
    inventory_account: {
        table: 'accounts',
        id: 'id',
        fields: [
            { name: 'account_name', type: 'string', required: true },
            { name: 'type_id', type: 'number', required: true, lookup: 'account_type' }
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
            { name: 'shipment_stage', type: 'number', required: true, lookup: 'shipment_stage' },   // FK → shipment_stage.id
            { name: 'document_type_id', type: 'number', required: true, lookup: 'document_type' }, // FK → document_type.id
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
                  LEFT JOIN document_type dt ON dt.id = sd.document_type_id`,
        listSearchIn: ['ss.name', 'dt.name'],
        listOrderBy: 'ss.name'
    },

    fiscal_year: {
        table: 'fiscal_years',
        id: 'id',
        fields: [{ name: 'name', type: 'string', required: true }],
        listOrderBy: 'id'
    },
    language: {
        table: 'languages',
        id: 'id',
        fields: [{ name: 'name', type: 'string', required: true }],
        listOrderBy: 'name'
    },
    time_zone: {
        table: 'time_zones',
        id: 'id',
        fields: [{ name: 'name', type: 'string', required: true }],
        listOrderBy: 'name'
    },
    date_format: {
        table: 'date_formats',
        id: 'id',
        fields: [
            { name: 'format', type: 'string', required: true },
            { name: 'example', type: 'string' }
        ],
        listOrderBy: 'id'
    },
    document_templates: {
        table: 'document_templates',
        id: 'id',
        fields: [
            { name: 'name', type: 'string', required: true },
            { name: 'content', type: 'string' },
            { name: 'company_ids', type: 'string' },
            { name: 'document_id', type: 'number' },
            { name: 'template_attachment_path', type: 'string' },
            { name: 'sign_path', type: 'string' },
            { name: 'stamp_path', type: 'string' },
            { name: 'updated_at', type: 'date' }
        ],
        listSelect: `
    dtmpl.*,
    dt.name AS document_name
  `,
        listFrom: `
    document_templates dtmpl
    LEFT JOIN document_type dt ON dt.id = dtmpl.document_id
  `,
        listSearchIn: ['dtmpl.name', 'dt.name'],
        listOrderBy: 'dtmpl.name'
    },
    'vehicle_type': { table: 'master_vehicle_type', idCol: 'id', nameCol: 'name' },
    available_time: {
        table: 'master_available_time',
        id: 'id',
        fields: [
            { name: 'name', type: 'string', required: true },
            { name: 'from_time', type: 'time' },
            { name: 'to_time', type: 'time' }
        ],
        listOrderBy: 'name'
    },

    shipment_calculator_master: {
        table: 'shipment_calculator_master',
        id: 'id',
        fields: [
            { name: 'location_code', type: 'string', required: true },
            { name: 'clearance_charges', type: 'number', required: true },
            { name: 'loading_charges', type: 'number', required: true },
            { name: 'transportation', type: 'number', required: true },
            { name: 'is_active', type: 'boolean', default: true }
        ],
        listOrderBy: 'location_code'
    },

    status: {
        table: 'status',
        id: 'id',
        fields: [
            { name: 'name', type: 'string', required: true },
            { name: 'bg_colour', type: 'string' },
            { name: 'colour', type: 'string' }
        ],
        listOrderBy: 'name'
    },

    defect_type: {
        table: 'qc_defect_types',
        id: 'id',
        fields: [
            { name: 'code', type: 'string', required: true },
            { name: 'name', type: 'string', required: true },
            { name: 'description', type: 'string' },
            { name: 'severity', type: 'string', required: true },
            { name: 'sort_order', type: 'number', default: 0 },
            { name: 'is_active', type: 'boolean', default: true }
        ],
        listOrderBy: 'sort_order, name'
    },

    system_settings: {
        table: 'system_settings',
        id: 'id',
        fields: [
            { name: 'setting_key', type: 'string', required: true },
            { name: 'setting_value', type: 'string', required: true },
            { name: 'setting_type', type: 'string', required: true },
            { name: 'description', type: 'string' }
        ],
        listOrderBy: 'setting_key'
    },

    company: {
        table: 'company_settings',
        id: 'id',
        fields: [
            { name: 'name', type: 'string', required: true },
            { name: 'company_prefix', type: 'string' }
        ],
        listOrderBy: 'name'
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
        case 'date':
            // The 'YYYY-MM-DD' string is parsed by new Date() as midnight UTC.
            // To prevent timezone issues where it might roll back to the previous day,
            // we set the time to noon UTC. This is a robust way to ensure the correct date is saved.
            const d = new Date(value);
            d.setUTCHours(12);
            return d;
        case 'time':
            // Ensure the time is in HH:mm:ss format for the database.
            // The input from the browser is 'HH:mm'. We append ':00'.
            if (typeof value === 'string' && /^\d{2}:\d{2}$/.test(value)) return `${value}:00`;
            return value; // Return as-is if already formatted or invalid
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
router.get('/:type', async (req, res, next) => {
    try {
        const type = req.params.type;
        const cfg = getCfg(type);

        const page = Math.max(parseInt(req.query.page || '1', 10), 1);
        const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '25', 10), 1), 200);
        const q = (req.query.search || req.query.q || '').trim();
        const all = req.query.all === '1';

        // Sorting parameters (added for consistency)
        const sortField = req.query.sort_field;
        const sortOrder = (req.query.sort_order || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';


        if (type === 'category' || type === 'service_category') {
            try {
                const table = type === 'service_category' ? 'service_categories' : 'categories';
                const [allCategories] = await db.promise().query(
                    `SELECT c.id, c.name, c.parent_id, p.name AS parent_name FROM ${table} c LEFT JOIN ${table} p ON p.id = c.parent_id ORDER BY c.name ASC`
                );
                const [usedCategories] = await db.promise().query(
                    `SELECT DISTINCT category_id FROM products WHERE category_id IS NOT NULL AND (${type === 'service_category' ? 'item_id = 1' : '(item_id IS NULL OR item_id = 0)'})`
                );
                const usedIds = new Set(usedCategories.map(c => c.category_id));

                const categoryMap = {};
                allCategories.forEach(c => {
                    categoryMap[c.id] = { ...c, children: [], in_use: false };
                });

                const checkInUseRecursive = (catId) => {
                    if (!catId || !categoryMap[catId] || categoryMap[catId].in_use) return;

                    categoryMap[catId].in_use = true;
                    if (categoryMap[catId].parent_id) {
                        checkInUseRecursive(categoryMap[catId].parent_id);
                    }
                };

                for (const catId of usedIds) {
                    checkInUseRecursive(catId);
                }

                const result = Object.values(categoryMap);
                return res.json(all ? result : { rows: result, total: result.length });

            } catch (dbErr) {
                return next(dbErr);
            }
        }

        // --- In-use check subquery ---
        const inUseChecks = cfg.inUseChecks || [];
        let inUseSubQuery = 'FALSE';
        if (inUseChecks.length > 0) {
            // Assuming the main table has an alias which is the first part of the first search column
            const mainTableAlias = cfg.listFrom ? (cfg.listSearchIn?.[0]?.split('.')[0] || 'c') : `\`${cfg.table}\``;
            const subQueries = inUseChecks.map(check =>
                `(EXISTS (SELECT 1 FROM \`${check.table}\` WHERE \`${check.field}\` = ${mainTableAlias}.\`${cfg.id}\`))`
            );
            inUseSubQuery = subQueries.join(' OR ');
        }
        const inUseSelect = `, (${inUseSubQuery}) AS in_use`;

        // JOIN-enabled path
        if (cfg.listFrom && cfg.listSelect) {
            // Use requested sort field if valid, otherwise fallback to config or default
            const defaultSortCol = cfg.listOrderBy || `${cfg.listSearchIn?.[0]?.split('.')[0] || 'c'}.${cfg.id}`;
            // Handle multiple columns in listOrderBy for JOIN queries
            let orderBy;
            if (sortField) {
                orderBy = `${sortField} ${sortOrder}`;
            } else if (defaultSortCol.includes(',')) {
                // For JOIN queries with multiple columns, use as-is (columns may have table aliases)
                orderBy = `${defaultSortCol} ASC`;
            } else {
                orderBy = `${defaultSortCol} DESC`;
            }

            // Ignore search query `q` when `all` is requested for dropdowns
            let { whereSql, params } = buildSearchClause(cfg.listSearchIn, q);

            // --- Generic Filtering (e.g. state?country_id=1) ---
            const filterClauses = [];
            const filterParams = [];

            // Get valid field names for this table
            const validFields = new Set(cfg.fields.map(f => f.name));
            if (cfg.id) validFields.add(cfg.id);

            // Determine main table alias correctly
            const mainTableAlias = cfg.listSearchIn?.[0]?.includes('.')
                ? cfg.listSearchIn[0].split('.')[0]
                : (cfg.table ? `\`${cfg.table}\`` : 'c');

            // Check req.query for matching fields
            Object.keys(req.query).forEach(key => {
                const val = req.query[key];
                if (validFields.has(key) && val !== undefined && val !== '' && val !== 'null' && val !== 'undefined') {
                    filterClauses.push(`${mainTableAlias}.${key} = ?`);
                    filterParams.push(val);
                }
            });

            if (filterClauses.length > 0) {
                const filterSql = filterClauses.join(' AND ');
                if (whereSql) {
                    whereSql += ` AND (${filterSql})`;
                } else {
                    whereSql = `WHERE ${filterSql}`;
                }
                params.push(...filterParams);
            }

            // For dropdowns, we don't need the in_use check.
            if (all) {
                // Dropdowns should still be sorted consistently
                const dropdownOrderBy = cfg.listOrderBy || cfg.listSearchIn?.[0] || cfg.id;
                const dataSql = `SELECT ${cfg.listSelect} FROM ${cfg.listFrom} ${whereSql} ORDER BY ${dropdownOrderBy} ASC`;
                db.query(dataSql, params, (err, rows) => {
                    if (err) return next(err);
                    // For `all=1`, we return a flat array, not the {rows, total} object
                    return res.json(rows);
                });
                return;
            }

            const countSql = `SELECT COUNT(*) AS cnt FROM ${cfg.listFrom} ${whereSql}`;
            db.query(countSql, params, (err, cntRows) => {
                if (err) return next(err);
                const total = cntRows?.[0]?.cnt || 0;

                const offset = (page - 1) * pageSize;
                const dataSql = `
          SELECT ${cfg.listSelect} ${inUseSelect}
          FROM ${cfg.listFrom}
          ${whereSql}
          ORDER BY ${orderBy}
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
        const defaultSortCol = cfg.listOrderBy || cfg.id || 'id';
        // Handle multiple columns in listOrderBy (e.g., 'sort_order, name')
        let orderByClause;
        if (defaultSortCol.includes(',')) {
            // Backtick each column individually
            const columns = defaultSortCol.split(',').map(col => `\`${col.trim()}\``).join(', ');
            orderByClause = `${columns} ASC`;
        } else {
            orderByClause = `\`${defaultSortCol}\` DESC`;
        }
        const orderBy = sortField ? `\`${sortField}\` ${sortOrder}` : orderByClause;

        const searchCols = cfg.fields?.map(f => `\`${f.name}\``) || ['`name`'];
        // Ignore search query `q` when `all` is requested for dropdowns
        const { whereSql, params } = buildSearchClause(searchCols, all ? '' : q);

        // For dropdowns, we don't need the in_use check.
        if (all) {
            const dropdownOrderBy = cfg.listOrderBy || cfg.fields?.[0]?.name || cfg.id || 'id';
            // Handle multiple columns in listOrderBy
            let orderByClause;
            if (dropdownOrderBy.includes(',')) {
                // Backtick each column individually
                const columns = dropdownOrderBy.split(',').map(col => `\`${col.trim()}\``).join(', ');
                orderByClause = `${columns} ASC`;
            } else {
                orderByClause = `\`${dropdownOrderBy}\` ASC`;
            }
            const dataSql = `SELECT * FROM \`${cfg.table}\` ${whereSql} ORDER BY ${orderByClause}`;
            db.query(dataSql, params, (err, rows) => {
                if (err) return next(err);
                return res.json(rows);
            });
            return;
        }

        db.query(`SELECT COUNT(*) AS cnt FROM \`${cfg.table}\` ${whereSql}`, params, (err, cntRows) => {
            if (err) return next(err);
            const total = cntRows?.[0]?.cnt || 0;

            const offset = (page - 1) * pageSize;
            db.query(
                `SELECT * ${inUseSelect} FROM \`${cfg.table}\` ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
                [...params, pageSize, offset],
                (err2, rows) => {
                    if (err2) return next(err2);
                    res.json({ rows, total });
                }
            );
        });
    } catch (e) { next(e); }
});

/* ----------------------------- GET ONE ---------------------------- */
// GET /api/master/:type/:id
router.get('/:type/:id', async (req, res, next) => {
    try {
        const { type, id } = req.params;
        const cfg = getCfg(type);

        // Use listSelect and listFrom if available for a richer object
        const selectClause = cfg.listSelect || '*';
        const fromClause = cfg.listFrom || `\`${cfg.table}\``;
        const idColumn = cfg.listFrom ? `${cfg.listSearchIn[0].split('.')[0]}.${cfg.id}` : `\`${cfg.id}\``;

        const [rows] = await db.promise().query(`SELECT ${selectClause} FROM ${fromClause} WHERE ${idColumn} = ?`, [id]);

        if (rows.length === 0) return res.status(404).json({ message: 'Record not found' });

        res.json(rows[0]);
    } catch (e) { next(e); }
});

/* ----------------------------- CREATE ----------------------------- */
// POST /api/master/:type
router.post('/:type', upload.none(), async (req, res, next) => {
    try {
        const cfg = getCfg(req.params.type);
        const type = req.params.type;

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

        const sql = `INSERT INTO \`${cfg.table}\` SET ?`;
        const params = [payload];

        db.query(sql, params, (err, result) => {
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
router.put('/:type/:id', upload.none(), async (req, res, next) => {
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
router.delete('/:type/:id', async (req, res, next) => {
    try {
        const cfg = getCfg(req.params.type);
        const { id } = req.params;

        // In-use checks
        if (Array.isArray(cfg.inUseChecks)) {
            for (const check of cfg.inUseChecks) {
                const { table, field, message } = check;
                // eslint-disable-next-line no-await-in-loop
                const [inUseRows] = await db.promise().query(
                    `SELECT \`${field}\` FROM \`${table}\` WHERE \`${field}\` = ? LIMIT 1`,
                    [id]
                );
                if (inUseRows.length > 0) {
                    const err = new Error(`Cannot delete. This record is ${message || 'in use'}.`);
                    err.status = 400;
                    throw err;
                }
            }
        }

        await db.promise().query(`DELETE FROM \`${cfg.table}\` WHERE \`${cfg.id}\`=?`, [id]);

        res.json({ success: true });
    } catch (e) { next(e); }
});

export default router;