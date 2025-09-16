// routes/products.js
import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import db from '../db.js';

const router = Router();

// ---------- uploads/product (multer) ----------
const ensureDir = (p) => { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); };
const UP_DIR = path.join(process.cwd(), 'uploads', 'product');
ensureDir(UP_DIR);

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UP_DIR),
    filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        const name = crypto.randomBytes(16).toString('hex') + ext;
        cb(null, name);
    }
});

// Accept both "images" and "new_images[]" to avoid MulterError: Unexpected field
const uploadFields = multer({ storage }).fields([
    { name: 'images', maxCount: 15 },
    { name: 'new_images[]', maxCount: 15 },
    { name: 'row_images[]', maxCount: 100 }        // <-- ADD THIS
]);

// ---------- helpers ----------
const q = async (sql, params = []) => (await db.promise().query(sql, params))[0];

const read = (b, keys, def = '') => { for (const k of keys) if (b[k] !== undefined) return b[k]; return def; };
const readNum = (b, keys, def = 0) => { const v = read(b, keys, def); const n = Number(v); return Number.isFinite(n) ? n : def; };
const readBool01 = (b, keys) => { const v = read(b, keys, 0); return (v === 1 || v === '1' || v === true || v === 'true') ? 1 : 0; };
const relPath = (full) => `/uploads/product/${path.basename(full)}`;

// ==================================================
// GET /api/products  (list with search/sort/pager)
// ==================================================
router.get('/', async (req, res) => {
    try {
        const search = String(req.query.search || '').trim();
        const inStockOnly = ['1', 'true', 1, true].includes(req.query.in_stock_only);

        const asInt = (v, def, min = 0, max = 1000000000) => {
            const n = Number.parseInt(v, 10);
            return Number.isFinite(n) && n >= min ? Math.min(n, max) : def;
        };

        let limit = asInt(req.query.limit, 50, 1, 1000);
        let offset = asInt(req.query.offset, 0, 0);
        if (req.query.limit === undefined && (req.query.page !== undefined || req.query.per_page !== undefined)) {
            const perPage = asInt(req.query.per_page, 50, 1, 1000);
            const page = asInt(req.query.page, 1, 1);
            limit = perPage;
            offset = (page - 1) * perPage;
        }

        const conds = [];
        const params = [];

        if (search) {
            conds.push(`(
        COALESCE(p.product_name, '') LIKE ? OR
        COALESCE(p.sku, '')          LIKE ? OR
        COALESCE(p.hscode, '')       LIKE ?
      )`);
            const s = `%${search}%`;
            params.push(s, s, s);
        }

        if (inStockOnly) {
            conds.push(`EXISTS (
        SELECT 1
        FROM product_opening_stock s
        WHERE s.product_id = p.id
          AND COALESCE(s.qty, 0) > 0
      )`);
        }

        const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

        const rows = await q(
            `
                SELECT
                    p.id,
                    p.pdt_uniqid AS uniqid,
                    COALESCE(p.product_name, '') AS name,
                    p.sku,
                    p.reorder_point,
                    COALESCE(p.hscode, '') AS hscode,
                    0 AS unit_price,
                    COALESCE((
                                 SELECT SUM(s2.qty)
                                 FROM product_opening_stock s2
                                 WHERE s2.product_id = p.id
                             ), 0) AS stock,
                    (
                        SELECT i.file_path
                        FROM product_images i
                        WHERE i.product_id = p.id
                        ORDER BY i.is_primary DESC, i.id ASC
                        LIMIT 1
                    ) AS image_url
 -- pk.name AS packing_name
                FROM products p
                  --  LEFT JOIN packing pk ON pk.id = p.packing_id
                    ${whereSql}        -- <- WHERE should come AFTER joins
                ORDER BY name ASC
                    LIMIT ? OFFSET ?
      `,
            [...params, limit, offset]
        );

        const totalRows = (await q(`SELECT COUNT(*) AS c FROM products p ${whereSql}`, params))[0]?.c || 0;

        res.json({
            data: rows.map(r => ({
                id: r.id,
                uniqid: r.uniqid || null,
                name: r.name,
                sku: r.sku,
                reorder_point: r.reorder_point,
                hscode: r.hscode || '',
                unit_price: 0,
                stock: Number(r.stock || 0),
                image_url: r.image_url || null
            })),
            totalRows
        });
    } catch (e) {
        console.error('GET /api/products error:', e);
        res.status(500).json({ error: 'Failed to load products', details: e.message });
    }
});

// ==================================================
// GET /api/products/:id (details + images + opening)
// ==================================================
// ==================================================
// GET /api/products/:id (details + images + opening + dimension_rows + origins array)
// ==================================================
router.get('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // 1) main product
        const rows = await q(
            `
      SELECT
        p.*
      FROM products p
      WHERE p.id = ?
      `,
            [id]
        );
        if (!rows.length) return res.status(404).json({ error: 'Not found' });
        const product = rows[0];

        // 2) images (unchanged)
        const images = (await q(
            `SELECT id, file_path, is_primary
       FROM product_images
       WHERE product_id=?
       ORDER BY is_primary DESC, id ASC`,
            [id]
        )).map(r => ({ ...r, file_path: r.file_path }));

        // 3) opening stocks (unchanged)
        const opening = await q(
            `SELECT w.id AS warehouse_id, w.warehouse_name,
              IFNULL(s.qty,0) AS qty,
              IFNULL(s.unit_cost_per_unit,0) AS unit_cost_per_unit,
              0 AS committed_qty
       FROM warehouses w
       LEFT JOIN product_opening_stock s
         ON s.warehouse_id=w.id AND s.product_id=?
       ORDER BY w.warehouse_name`,
            [id]
        );

        // 4) dimension rows  (JOIN packing IF available; otherwise drop the join)
        // If you don't have a "packing" table, comment the join and packing_name selection.
        const details = await q(
            `
      SELECT
        d.id,
        d.origin_id,
        d.packing_text,
        d.dimensions,
        d.dim_unit,
        d.net_wt,
        d.gross_wt,
        d.wt_unit,
        d.brand_id,
       -- d.manufacturer_id,
        d.mpn,
        d.isbn,
        d.upc,
        d.ean,
        d.uom_id,
        d.pack_image_path
        --  pk.name AS packing_name
      FROM product_details d
      -- LEFT JOIN packing pk ON pk.id = d.packing_id
      WHERE d.product_id=?
      ORDER BY d.id ASC
      `,
            [id]
        );

        // 5) normalize for frontend (keep field names the UI expects)
        const dimension_rows = details.map(r => ({
            origin_country_id: r.origin_id ?? '',
            // UI shows packing as TEXT (textbox). Prefer name, fall back to id, then empty string.
            packing: r.packing_text || null,
            packing_id: r.packing_text || '',
            dimensions: r.dimensions || '',
            dim_unit: r.dim_unit || 'cm',
            net_weight: r.net_wt != null ? r.net_wt.toString() : '',
            gross_weight: r.gross_wt != null ? r.gross_wt.toString() : '',
            weight_unit: r.wt_unit || 'kg',
            mpn: r.mpn || '',
            isbn: r.isbn || '',
            upc: r.upc || '',
            ean: r.ean || '',
            uom_id: r.uom_id != null ? r.uom_id.toString() : '',
            brand_id: r.brand_id != null ? r.brand_id.toString() : '',
           // manufacturer_id: r.manufacturer_id != null ? r.manufacturer_id.toString() : '',
            pack_image_url: r.pack_image_path || ''
        }));

        // 6) expand origin_ids CSV -> array (so UI can hydrate)
        const origin_ids = product.origin_ids || '';
        const origins = origin_ids
            ? origin_ids.split(',').map(s => s.trim()).filter(Boolean)
            : [];

        // 7) respond with everything the UI needs
        res.json({
            ...product,
            images,
            opening_stocks: opening,
            warehouses: opening,       // (kept for UI compatibility)
            origin_ids,                // CSV, unchanged
            origins,                   // array for easy hydration
            dimension_rows,            // fully hydrated packing/origin rows
        });
    } catch (e) {
        console.error('GET /api/products/:id error:', e);
        res.status(500).json({ error: e.message });
    }
});


// put near top of products.js
const toNumOrNull = (v) => {
    if (v === '' || v === undefined || v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

const numOrNull = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

async function fkOrNull(conn, table, id) {
    const n = toNumOrNull(id);
    if (n == null) return null;
    const [[row]] = await conn.query(`SELECT id FROM ${table} WHERE id=?`, [n]);
    return row ? n : null;
}

// safely parse JSON from body (form-data comes as string)
const parseJSON = (obj, key, def = []) => {
    try {
        const val = obj[key];
        if (!val) return def;
        if (typeof val === 'string') return JSON.parse(val);
        if (typeof val === 'object') return val; // already parsed
        return def;
    } catch (e) {
        console.warn(`Failed to parse JSON for key=${key}`, e.message);
        return def;
    }
};

// Convert array or CSV string into a normalized comma-separated string
const toCommaIds = (val) => {
    if (!val) return null;

    if (Array.isArray(val)) {
        return val.filter(Boolean).map(String).join(',');
    }

    if (typeof val === 'string') {
        return val
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
            .join(',');
    }

    return null;
};

// helpers (put near read/parseJSON/fkOrNull):
const csvFromAny = (v) => {
    if (Array.isArray(v)) return v.filter(Boolean).join(',');
    return String(v || '')
        .replace(/\s+/g, '')
        .replace(/,+/g, ',')
        .replace(/^,|,$/g, '');
};


// ==================================================
// POST /api/products  (create)
// ==================================================
router.post('/', uploadFields, async (req, res) => {
    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        const p = req.body;

        // Validate FKs (stay consistent with your table names)
        const sales_account_id     = await fkOrNull(conn, 'accounts',              p.sales_account_id);
        const purchase_account_id  = await fkOrNull(conn, 'accounts',              p.purchase_account_id);
        const inventory_account_id = await fkOrNull(conn, 'accounts',              p.inventory_account_id);
        const selling_currency_id  = await fkOrNull(conn, 'currency', p.selling_currency_id);
        const cost_currency_id     = await fkOrNull(conn, 'currency', p.cost_currency_id);

        const preferred_vendor_id  = await fkOrNull(conn, 'vendor',               p.preferred_vendor_id);
        const valuation_method_id  = await fkOrNull(conn, 'valuation_methods',  p.valuation_method_id);
        const sales_tax_id         = await fkOrNull(conn, 'taxes',                 p.sales_tax_id);

        // NEW: two fields you want saved
        const origin_ids = csvFromAny(p.origin_ids || parseJSON(p, 'origins', []));
        const pdt_uniqid = `pdt_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

        // INSERT now explicitly includes pdt_uniqid + origin_ids
        const [r1] = await conn.query(
            `INSERT INTO products
       (pdt_uniqid, origin_ids,
        item_type, product_name, sku, hscode,
        returnable, excise,
        enable_sales, selling_currency_id, selling_price, sales_account_id, sales_description, sales_tax_id,
        enable_purchase, cost_currency_id, cost_price, purchase_account_id, purchase_description, preferred_vendor_id,
        track_inventory, track_batches, inventory_account_id, valuation_method_id, reorder_point,
        description, created_at, updated_at)
       VALUES
       (?,?,?,?,  ?,?,  ?,?,?,?,?, ?,?,  ?,?,?,?,?, ?,?,  ?,?,?,?, ?,  ?, NOW(), NOW())`,
            [
                pdt_uniqid, origin_ids,

                read(p, ['item_type'], 'Goods'),
                read(p, ['product_name']),
                read(p, ['sku']),
                read(p, ['hscode'], null),

                readBool01(p, ['returnable']),
                readBool01(p, ['excise']),

                readBool01(p, ['enable_sales']),
                selling_currency_id,
                readNum(p, ['selling_price'], null),
                sales_account_id,
                read(p, ['sales_description'], null),
                sales_tax_id,

                readBool01(p, ['enable_purchase']),
                cost_currency_id,
                readNum(p, ['cost_price'], null),
                purchase_account_id,
                read(p, ['purchase_description'], null),
                preferred_vendor_id,

                readBool01(p, ['track_inventory']),
                readBool01(p, ['track_batches']),
                inventory_account_id,
                valuation_method_id,
                readNum(p, ['reorder_point'], null),

                read(p, ['description'], null),
            ]
        );

        const productId = r1.insertId;
        const rowFiles = (req.files?.['row_images[]'] || []);
        // ---- product_details ----
        // ---- product_details ----
        const rows = parseJSON(p, 'dimension_rows', []);
        if (Array.isArray(rows) && rows.length) {
            const values = rows.map((r) => {
                // which file (if any) belongs to this row?
                const idx = Number.isFinite(Number(r.image_upload_index)) ? Number(r.image_upload_index) : -1;
                const pack_image_path =
                    idx >= 0 && rowFiles[idx] ? relPath(rowFiles[idx].path)
                        : (r.pack_image_url || null);

                return [
                    productId,
                    numOrNull(r.origin_country_id),
                    (r.packing_id || null),                // free-text packing
                    r.dimensions || null,
                    r.dim_unit || r.dimensions_unit || 'cm',
                    r.net_weight === ''  ? null : numOrNull(r.net_weight),
                    r.gross_weight === ''? null : numOrNull(r.gross_weight),
                    r.weight_unit || 'kg',
                    numOrNull(r.brand_id),
                  //  numOrNull(r.manufacturer_id),
                    r.mpn || null,
                    r.isbn || null,
                    r.upc || null,
                    r.ean || null,
                    numOrNull(r.uom_id),
                    pack_image_path                         // <-- NEW
                ];
            });

            await conn.query(
                `INSERT INTO product_details
      (product_id, origin_id, packing_text, dimensions, dim_unit,
       net_wt, gross_wt, wt_unit, brand_id,
       mpn, isbn, upc, ean, uom_id, pack_image_path)
     VALUES ?`,
                [values]
            );
        }


        // ---- product_opening_stock ----
        const opening = (() => { try { return JSON.parse(p.opening_stocks || '[]'); } catch { return []; }})();
        if (Array.isArray(opening) && opening.length) {
            const values = opening
                .filter(r => r && r.warehouse_id)
                .map(r => [
                    productId,
                    numOrNull(r.warehouse_id),
                    r.qty === '' ? 0 : (numOrNull(r.qty) ?? 0),
                    r.unit_cost_per_unit === '' ? 0 : (numOrNull(r.unit_cost_per_unit) ?? 0),
                    new Date(),
                ]);

            if (values.length) {
                await conn.query(
                    `INSERT INTO product_opening_stock
         (product_id, warehouse_id, qty, unit_cost_per_unit, created_at)
       VALUES ?`,
                    [values]
                );
            }
        }


        // ---- images (unchanged) ----
        const files = [
            ...(req.files?.['images'] || []),
            ...(req.files?.['new_images[]'] || req.files?.['new_images'] || []),
        ];
        if (files.length) {
            const existPrimary =
                (await conn.query(
                    'SELECT COUNT(*) AS c FROM product_images WHERE product_id=? AND is_primary=1',
                    [productId]
                ))[0][0].c > 0;

            let primarySet = existPrimary;
            const now = new Date();
            const vals = files.map((f, i) => {
                const is_primary = primarySet ? 0 : (i === 0 ? 1 : 0);
                if (!primarySet && is_primary === 1) primarySet = true;
                return [
                    productId,
                    relPath(f.path),
                    is_primary,
                    f.originalname || null,
                    f.mimetype || null,
                    f.size || null,
                    i,
                    now,
                ];
            });

            await conn.query(
                `INSERT INTO product_images
         (product_id, file_path, is_primary, original_name, mime_type, size_bytes, sort_order, created_at)
         VALUES ?`,
                [vals]
            );
        }


        await conn.commit();
        return res.json({ ok: true, id: productId });
    } catch (e) {
        await conn.rollback();
        console.error('CREATE_FAILED', e?.sqlMessage || e?.message, {
            code: e?.code, errno: e?.errno, sqlState: e?.sqlState, sql: e?.sql
        });
        return sendCreateError(res, e, req);
    } finally {
        conn.release();
    }
});

// DEV helper: include SQL error back to client so UI can show it
function sendCreateError(res, e, req) {
    const payload = { ok: false, error: 'CREATE_FAILED' };

    // show details in dev or when client sends ?debug=1
    const debug = process.env.NODE_ENV !== 'production' || String(req.query.debug) === '1';
    if (debug) {
        payload.error_details = {
            message: e?.sqlMessage || e?.message || 'Unknown error',
            code: e?.code,
            errno: e?.errno,
            sqlState: e?.sqlState,
            sql: e?.sql,
            where: `${req.method} ${req.originalUrl}`
        };
    }
    return res.status(500).json(payload);
}



// ==================================================
// PUT /api/products/:id  (update; images non-destructive)
// ==================================================
// UPDATE PRODUCT
router.put('/:id', uploadFields, async (req, res) => {
    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        const productId = Number(req.params.id);
        if (!productId || Number.isNaN(productId)) {
            throw new Error('Invalid product id');
        }

        // Ensure product exists (and fetch pdt_uniqid if needed)
        const [[exist]] = await conn.query(
            'SELECT id, pdt_uniqid FROM products WHERE id=? LIMIT 1',
            [productId]
        );
        if (!exist) {
            await conn.rollback();
            return res.status(404).json({ ok: false, error: 'Product not found' });
        }

        const p = req.body;

        // ----- Validate FKs (stay consistent with your table names) -----
        const sales_account_id     = await fkOrNull(conn, 'accounts',            p.sales_account_id);
        const purchase_account_id  = await fkOrNull(conn, 'accounts',            p.purchase_account_id);
        const inventory_account_id = await fkOrNull(conn, 'accounts',            p.inventory_account_id);
        const selling_currency_id  = await fkOrNull(conn, 'currency',            p.selling_currency_id);
        const cost_currency_id     = await fkOrNull(conn, 'currency',            p.cost_currency_id);

        const preferred_vendor_id  = await fkOrNull(conn, 'vendor',              p.preferred_vendor_id);
        const valuation_method_id  = await fkOrNull(conn, 'valuation_methods',   p.valuation_method_id);
        const sales_tax_id         = await fkOrNull(conn, 'taxes',               p.sales_tax_id);

        // origin_ids may come as CSV or as array under "origins"/"origin_ids"
        const origin_ids = csvFromAny(p.origin_ids || parseJSON(p, 'origins', []));

        // ----- Update main products row (DO NOT change pdt_uniqid here) -----
        await conn.query(
            `UPDATE products SET
        origin_ids=?,
        item_type=?,
        product_name=?,
        sku=?,
        hscode=?,
        returnable=?,
        excise=?,
        enable_sales=?,
        selling_currency_id=?,
        selling_price=?,
        sales_account_id=?,
        sales_description=?,
        sales_tax_id=?,
        enable_purchase=?,
        cost_currency_id=?,
        cost_price=?,
        purchase_account_id=?,
        purchase_description=?,
        preferred_vendor_id=?,
        track_inventory=?,
        track_batches=?,
        inventory_account_id=?,
        valuation_method_id=?,
        reorder_point=?,
        description=?,
        updated_at=NOW()
      WHERE id=?`,
            [
                origin_ids,
                read(p, ['item_type'], 'Goods'),
                read(p, ['product_name']),
                read(p, ['sku']),
                read(p, ['hscode'], null),

                readBool01(p, ['returnable']),
                readBool01(p, ['excise']),

                readBool01(p, ['enable_sales']),
                selling_currency_id,
                readNum(p, ['selling_price'], null),
                sales_account_id,
                read(p, ['sales_description'], null),
                sales_tax_id,

                readBool01(p, ['enable_purchase']),
                cost_currency_id,
                readNum(p, ['cost_price'], null),
                purchase_account_id,
                read(p, ['purchase_description'], null),
                preferred_vendor_id,

                readBool01(p, ['track_inventory']),
                readBool01(p, ['track_batches']),
                inventory_account_id,
                valuation_method_id,
                readNum(p, ['reorder_point'], null),

                read(p, ['description'], null),

                productId
            ]
        );

        // ----- product_details: replace-all strategy -----
        // Frontend should send dimension_rows as JSON array
        const rowFiles = (req.files?.['row_images[]'] || []);
        const rows = parseJSON(p, 'dimension_rows', []);
        await conn.query('DELETE FROM product_details WHERE product_id=?', [productId]);

        if (Array.isArray(rows) && rows.length) {
            const values = rows.map((r) => {
                const idx = Number.isFinite(Number(r.image_upload_index)) ? Number(r.image_upload_index) : -1;
                const pack_image_path =
                    idx >= 0 && rowFiles[idx] ? relPath(rowFiles[idx].path)
                        : (r.pack_image_url || null);

                return [
                    productId,
                    numOrNull(r.origin_country_id),
                    (r.packing_id || null),
                    r.dimensions || null,
                    r.dim_unit || r.dimensions_unit || 'cm',
                    r.net_weight === ''  ? null : numOrNull(r.net_weight),
                    r.gross_weight === ''? null : numOrNull(r.gross_weight),
                    r.weight_unit || 'kg',
                    numOrNull(r.brand_id),
                  //  numOrNull(r.manufacturer_id),
                    r.mpn || null,
                    r.isbn || null,
                    r.upc || null,
                    r.ean || null,
                    numOrNull(r.uom_id),
                    pack_image_path
                ];
            });

            await conn.query(
                `INSERT INTO product_details
                 (product_id, origin_id, packing_text, dimensions, dim_unit,
                  net_wt, gross_wt, wt_unit, brand_id,
                  mpn, isbn, upc, ean, uom_id, pack_image_path)
                 VALUES ?`,
                [values]
            );
        }

        // ----- product_opening_stock: replace-all strategy -----
        const opening = (() => { try { return JSON.parse(p.opening_stocks || '[]'); } catch { return []; }})();
        await conn.query('DELETE FROM product_opening_stock WHERE product_id=?', [productId]);

        if (Array.isArray(opening) && opening.length) {
            const values = opening
                .filter(r => r && r.warehouse_id)
                .map(r => [
                    productId,
                    numOrNull(r.warehouse_id),
                    r.qty === '' ? 0 : (numOrNull(r.qty) ?? 0),
                    r.unit_cost_per_unit === '' ? 0 : (numOrNull(r.unit_cost_per_unit) ?? 0),
                    new Date(),
                ]);

            if (values.length) {
                await conn.query(
                    `INSERT INTO product_opening_stock
            (product_id, warehouse_id, qty, unit_cost_per_unit, created_at)
           VALUES ?`,
                    [values]
                );
            }
        }

        // ----- Images handling -----
        // Frontend can send:
        // - keep_image_ids: JSON array of existing product_images.id to keep
        // - primary_image_id: optional, marks one of the kept/new as primary
        // - New uploads under field names: 'images' and/or 'new_images[]'
        const keepIds = parseJSON(p, 'keep_image_ids', []);          // ids to keep
        const requestedPrimaryId = numOrNull(p.primary_image_id);     // requested primary (may be existing)
        const now = new Date();

        // 1) delete removed images
        // if (Array.isArray(keepIds) && keepIds.length) {
        //     await conn.query(
        //         `DELETE FROM product_images
        //   WHERE product_id=? AND id NOT IN (${keepIds.map(() => '?').join(',')})`,
        //         [productId, ...keepIds]
        //     );
        // } else {
        //     // if nothing specified, we treat as keep none (i.e., remove all existing before insert)
        //     await conn.query('DELETE FROM product_images WHERE product_id=?', [productId]);
        // }

        // 2) add new uploads
        const files = [
            ...(req.files?.['images'] || []),
            ...(req.files?.['new_images[]'] || req.files?.['new_images'] || []),
        ];

        if (files.length) {
            const vals = files.map((f, i) => ([
                productId,
                relPath(f.path),                   // keep original extension already handled by your storage config
                0,                                 // is_primary set later in step 3
                f.originalname || null,
                f.mimetype || null,
                f.size || null,
                i,                                 // sort_order for new ones
                now,
            ]));

            await conn.query(
                `INSERT INTO product_images
          (product_id, file_path, is_primary, original_name, mime_type, size_bytes, sort_order, created_at)
         VALUES ?`,
                [vals]
            );
        }

        // 3) ensure there is exactly one primary
        //    - if requestedPrimaryId exists (and belongs to this product), set it
        //    - else if none primary exists, pick the first by sort_order (or lowest id)
        const [[{ c: primCount }]] = await conn.query(
            'SELECT COUNT(*) AS c FROM product_images WHERE product_id=? AND is_primary=1',
            [productId]
        );

        // demote all first (we’ll set the one we want)
        await conn.query(
            'UPDATE product_images SET is_primary=0 WHERE product_id=?',
            [productId]
        );

        if (requestedPrimaryId) {
            // verify it belongs to the product
            const [[ok]] = await conn.query(
                'SELECT id FROM product_images WHERE id=? AND product_id=? LIMIT 1',
                [requestedPrimaryId, productId]
            );
            if (ok) {
                await conn.query(
                    'UPDATE product_images SET is_primary=1 WHERE id=?',
                    [requestedPrimaryId]
                );
            } else {
                // fallback if the requested id is invalid
                await conn.query(
                    `UPDATE product_images
             SET is_primary=1
           WHERE product_id=?
           ORDER BY sort_order ASC, id ASC
           LIMIT 1`,
                    [productId]
                );
            }
        } else {
            // no specific request: if none was primary (or all demoted), pick the first
            await conn.query(
                `UPDATE product_images
           SET is_primary=1
         WHERE product_id=?
         ORDER BY sort_order ASC, id ASC
         LIMIT 1`,
                [productId]
            );
        }

        await conn.commit();
        return res.json({ ok: true, id: productId });
    } catch (e) {
        await conn.rollback();
        console.error('UPDATE_FAILED', e?.sqlMessage || e?.message, {
            code: e?.code, errno: e?.errno, sqlState: e?.sqlState, sql: e?.sql
        });
        // reuse your existing error-shaper
        return sendCreateError(res, e, req);
    } finally {
        conn.release();
    }
});


// GET /api/products/:id/packings  -> product_details with image
router.get('/:id/packings', async (req, res) => {
    const { id } = req.params;
    try {
        const rows = await q(
            `
      SELECT
        d.id,
        d.origin_id,
        d.packing_text,
        d.dimensions,
        d.dim_unit,
        d.net_wt,
        d.gross_wt,
        d.wt_unit,
        d.brand_id,
       -- d.manufacturer_id,
        d.mpn,
        d.isbn,
        d.upc,
        d.ean,
        d.uom_id,
        d.pack_image_path,
        country.name as origin_name
      FROM product_details d
      LEFT JOIN country ON country.id = d.origin_id
      WHERE d.product_id=?
      ORDER BY d.id ASC
      `,
            [id]
        );

        const data = rows.map(r => ({
            id: r.id,
            origin_country_id: r.origin_id ?? '',
            origin_name:r.origin_name ?? '',
            packing_id: r.packing_text || '',
            dimensions: r.dimensions || '',
            dim_unit: r.dim_unit || 'cm',
            net_weight: r.net_wt != null ? String(r.net_wt) : '',
            gross_weight: r.gross_wt != null ? String(r.gross_wt) : '',
            weight_unit: r.wt_unit || 'kg',
            brand_id: r.brand_id != null ? String(r.brand_id) : '',
          //  manufacturer_id: r.manufacturer_id != null ? String(r.manufacturer_id) : '',
            mpn: r.mpn || '',
            isbn: r.isbn || '',
            upc: r.upc || '',
            ean: r.ean || '',
            uom_id: r.uom_id != null ? String(r.uom_id) : '',
            pack_image_url: r.pack_image_path || ''  // <- image for this packing row
        }));

        res.json({ product_id: id, packings: data });
    } catch (e) {
        console.error('GET /api/products/:id/packings error:', e);
        res.status(500).json({ error: 'Failed to load packings' });
    }
});





// ==================================================
// POST /api/products/:id/images  (add images)
// ==================================================
router.post('/:id/images', uploadFields, async (req, res) => {
    const { id } = req.params;
    const files = [
        ...(req.files?.images || []),
        ...(req.files?.['new_images[]'] || [])
    ];
    try {
        const count = (await q(`SELECT COUNT(*) c FROM product_images WHERE product_id=?`, [id]))[0]?.c || 0;
        for (let i = 0; i < files.length; i++) {
            await q(
                `INSERT INTO product_images (product_id, file_path, is_primary, created_at)
         VALUES (?, ?, ?, NOW())`,
                [id, relPath(files[i].path), (count === 0 && i === 0) ? 1 : 0]
            );
        }
        res.json({ success: true, added: files.length });
    } catch (e) {
        await Promise.all(files.map(f => fs.promises.unlink(f.path).catch(() => {})));
        res.status(500).json({ error: e.message });
    }
});

// ==================================================
// PATCH /api/products/:id/images/:imageId/primary
// ==================================================
router.patch('/:id/images/:imageId/primary', async (req, res) => {
    const { id, imageId } = req.params;
    try {
        await q(`UPDATE product_images SET is_primary=0 WHERE product_id=?`, [id]);
        await q(`UPDATE product_images SET is_primary=1 WHERE id=? AND product_id=?`, [imageId, id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================================================
// DELETE /api/products/:id/images/:imageId
// ==================================================
router.delete('/:id/images/:imageId', async (req, res) => {
    const { id, imageId } = req.params;
    try {
        const rows = await q(
            `SELECT file_path FROM product_images WHERE id=? AND product_id=?`,
            [imageId, id]
        );
        if (!rows.length) return res.status(404).json({ error: 'Image not found' });

        const rel = rows[0].file_path;
        await q(`DELETE FROM product_images WHERE id=? AND product_id=?`, [imageId, id]);

        const diskPath = path.join(process.cwd(), rel.replace(/^\//, ''));
        fs.promises.unlink(diskPath).catch(() => {});

        res.json({ success: true });
    } catch (err) {
        console.error('Delete image error', err);
        res.status(500).json({ error: 'Failed to delete image' });
    }
});

export default router;
