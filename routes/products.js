// routes/products.js
import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import sharp from 'sharp';
import db from '../db.js';

const router = Router();

// ---------- uploads/product (multer) ----------
const ensureDir = (p) => { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); };
const UP_DIR = path.join(process.cwd(), 'uploads', 'product');
const THUMB_DIR = path.join(UP_DIR, 'thumbnail');
ensureDir(UP_DIR);
ensureDir(THUMB_DIR);

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
const relPath = (full, isThumb = false) => {
    const base = path.basename(full);
    return isThumb ? `/uploads/product/thumbnail/${base}` : `/uploads/product/${base}`;
};

// ==================================================
// GET /api/products  (list with search/sort/pager)
// ==================================================
router.get('/', async (req, res) => {
    try {
        const search = String(req.query.search || '').trim();
        const categoryFilterId = req.query.category ? Number(req.query.category) : null;
        const inStockOnly = ['1', 'true', 1, true].includes(req.query.in_stock_only);
        const isActiveFilter = req.query.is_active;
        const itemIdFilter = req.query.item_id !== undefined ? Number(req.query.item_id) : null;

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
                COALESCE(c.name, '')         LIKE ? OR
                COALESCE(p.hscode, '')       LIKE ? OR
                EXISTS (
                    SELECT 1 FROM product_details pd 
                    WHERE pd.product_id = p.id AND pd.packing_alias LIKE ?
                )
            )`);
            const s = `%${search}%`;
            params.push(s, s, s, s);
        }

        if (inStockOnly) {
            conds.push(`EXISTS (
                SELECT 1 
                FROM inventory_stock_batches isb 
                WHERE isb.product_id = p.id 
                AND isb.qty_on_hand > 0
            )`);
        }

        const inShipmentOnly = ['1', 'true', 1, true].includes(req.query.in_shipment_only);
        if (inShipmentOnly) {
            conds.push(`EXISTS (
                SELECT 1
                FROM purchase_order_items poi
                JOIN purchase_orders po ON po.id = poi.purchase_order_id
                WHERE poi.item_id = p.id
                  AND po.trade_type_id = 2
            )`);
        }

        if (isActiveFilter === '1' || isActiveFilter === 'true') {
            conds.push(`p.is_active = 1`);
        }

        if (categoryFilterId) {
            // To filter by a category and all its descendants, we first fetch the hierarchy.
            const allCategories = await q('SELECT id, parent_id FROM categories');
            const childIds = new Set();

            const findChildrenRecursive = (parentId) => {
                const children = allCategories.filter(c => c.parent_id === parentId);
                for (const child of children) {
                    if (!childIds.has(child.id)) {
                        childIds.add(child.id);
                        findChildrenRecursive(child.id);
                    }
                }
            };

            findChildrenRecursive(categoryFilterId);
            const idsToFilter = [categoryFilterId, ...Array.from(childIds)];
            conds.push(`p.category_id IN (?)`);
            params.push(idsToFilter);
        }

        if (Number.isFinite(itemIdFilter)) {
            conds.push(`p.item_id = ?`);
            params.push(itemIdFilter);
        }

        const userId = req.query.user_id;
        if (userId) {
            conds.push(`p.created_by = ?`);
            params.push(userId);
        }
        // Base condition to exclude deleted products, then add other filters.
        const baseWhere = 'p.is_deleted = 0';
        const whereSql = `WHERE ${baseWhere}${conds.length ? ` AND ${conds.join(' AND ')}` : ''}`;

        const sortableFields = {
            'id': 'p.id',
            'name': 'p.product_name',
            'category': 'c.name',
            'hscode': 'p.hscode',
            // Note: stock and reorder_point are calculated or not directly on the `products` table, making them harder to sort efficiently.
        };
        const sortField = sortableFields[req.query.sort_field] || 'p.id';
        const sortOrder = (String(req.query.sort_order).toLowerCase() === 'desc') ? 'DESC' : 'ASC';

        const rows = await q(
            `
                SELECT
                    p.id,
                    p.pdt_uniqid AS uniqid,
                    p.item_id,
                    p.item_type,
                    COALESCE(p.product_name, '') AS name,
                    p.category_id,
                    CASE
                        WHEN p.item_type = 'Service' OR p.item_id = 1 THEN sc.name
                        ELSE c.name
                    END as category_name,
                    p.reorder_point,
                    p.inventory_account_id,
                    p.purchase_account_id,
                    p.having_duty,
                    COALESCE(p.hscode, '') AS hscode,
                    0 AS unit_price,
                    COALESCE((SELECT SUM(isb.qty_on_hand) FROM inventory_stock_batches isb WHERE isb.product_id = p.id), 0) AS stock,
                    -- Correctly fetch the primary image's file_path, then any image's file_path
                    COALESCE(
                        (SELECT pi.file_path FROM product_images pi WHERE pi.product_id = p.id AND pi.is_primary = 1 LIMIT 1),
                        (SELECT pi.file_path FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.id ASC LIMIT 1)
                    ) AS image_url,
                    -- Correctly fetch the primary image's thumbnail_path, then any image's thumbnail_path
                    COALESCE(
                        (SELECT pi.thumbnail_path FROM product_images pi WHERE pi.product_id = p.id AND pi.is_primary = 1 LIMIT 1),
                        (SELECT pi.thumbnail_path FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.id ASC LIMIT 1)
                    ) AS thumbnail_url,
                    (
                        SELECT pd.packing_alias
                        FROM product_details pd 
                        WHERE pd.product_id = p.id ORDER BY pd.id ASC LIMIT 1
                    ) as packing_alias,
                    (
                        SELECT pd.packing_text
                        FROM product_details pd
                        WHERE pd.product_id = p.id ORDER BY pd.id ASC LIMIT 1
                    ) as packing_text
                    , 
                    (
                        SELECT pd.variety
                        FROM product_details pd
                        WHERE pd.product_id = p.id ORDER BY pd.id ASC LIMIT 1
                    ) as variety,
                    (
                        SELECT pd.grade_and_size_code
                        FROM product_details pd
                        WHERE pd.product_id = p.id ORDER BY pd.id ASC LIMIT 1
                    ) as grade_and_size_code,
                    (
                        SELECT um.name
                        FROM product_details pd_uom
                        JOIN uom_master um ON um.id = pd_uom.uom_id
                        WHERE pd_uom.product_id = p.id AND pd_uom.uom_id IS NOT NULL
                        ORDER BY pd_uom.id ASC LIMIT 1
                    ) as uom,
                     (
                        SELECT b.brand_name
                        FROM product_details pd
                        JOIN brands b ON b.id = pd.brand_id
                        WHERE pd.product_id = p.id ORDER BY pd.id ASC LIMIT 1
                    ) as brand,
                    (
                        SELECT pd.uom_id FROM product_details pd WHERE pd.product_id = p.id AND pd.uom_id IS NOT NULL ORDER BY pd.id ASC LIMIT 1
                    ) as uom_id,
                    p.is_taxable,
                    (
                        SELECT co.name
                        FROM product_details pd
                        JOIN country co ON co.id = pd.origin_id
                        WHERE pd.product_id = p.id ORDER BY pd.id ASC LIMIT 1
                    ) as origin
                FROM products p
                LEFT JOIN categories c ON c.id = p.category_id
                LEFT JOIN service_categories sc ON sc.id = p.category_id
                    ${whereSql}        -- <- WHERE should come AFTER joins
                ORDER BY ${sortField} ${sortOrder}
                LIMIT ? OFFSET ?
      `,
            [...params, limit, offset]
        );

        const totalRows = (await q(
            `SELECT COUNT(DISTINCT p.id) AS c FROM products p LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN service_categories sc ON sc.id = p.category_id ${whereSql}`,
            params
        ))[0]?.c || 0;

        res.json({
            data: rows.map(r => ({
                id: r.id,
                uniqid: r.uniqid || null,
                name: r.name,
                packing_text: r.packing_text || null,
                item_id: r.item_id ?? 0,
                item_type: r.item_type || 'Goods',
                packing_alias: r.packing_alias || null,
                category: r.category_name || '',
                category_id: r.category_id || null,
                reorder_point: r.reorder_point,
                hscode: r.hscode || '',
                unit_price: 0,
                stock_on_hand: Number(r.stock || 0),
                image_url: r.image_url || null,
                thumbnail_url: r.thumbnail_url || r.image_url || null,
                variety: r.variety || null,
                brand: r.brand || null,
                grade_and_size_code: r.grade_and_size_code || null,
                origin: r.origin || null,
                uom: r.uom || '',
                uom_id: r.uom_id || null,
                is_taxable: r.is_taxable ?? 0,
                having_duty: r.having_duty ?? 0,
                inventory_account_id: r.inventory_account_id || null,
                purchase_account_id: r.purchase_account_id || null
            })),
            totalRows
        });
    } catch (e) {
        console.error('GET /api/products error:', e);
        res.status(500).json({ error: 'Failed to load products', details: e.message });
    }
});

// ==================================================
// GET /api/products/count
// ==================================================
router.get('/count', async (req, res) => {
    try {
        const [rows] = await db.promise().query('SELECT COUNT(*) as total FROM products');
        res.json({ total: rows[0]?.total || 0 });
    } catch (err) {
        console.error('GET /api/products/count failed:', err);
        res.status(500).json({ error: 'Failed to get product count' });
    }
});

// ==================================================
// PATCH /api/products/:id/status (toggle active)
// ==================================================
router.patch('/:id/status', async (req, res) => {
    const { id } = req.params;
    const { is_active } = req.body;
    const userId = req.session?.user?.id;

    if (is_active === undefined || !userId) {
        return res.status(400).json({ error: 'Missing required fields or authentication.' });
    }

    try {
        await q('UPDATE products SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, id]);
        await q('INSERT INTO product_history (product_id, user_id, action, details) VALUES (?, ?, ?, ?)', [id, userId, 'STATUS_CHANGED', JSON.stringify({ to: is_active ? 'active' : 'inactive' })]);
        res.json({ success: true, id, is_active });
    } catch (e) {
        console.error('Failed to update product status:', e);
        res.status(500).json({ error: 'Database update failed.' });
    }
});

// GET /api/products/packings/:packingDetailId/in-use
// This must come BEFORE the general /:identifier route
router.get('/packings/:packingDetailId/in-use', async (req, res) => {
    const { packingDetailId } = req.params;
    try {
        // If your schema uses a different table/column, change here:
        const rows = await q(
            'SELECT COUNT(*) AS c FROM purchase_order_items WHERE packing_id = ?',
            [packingDetailId]
        );
        const count = rows?.[0]?.c || 0;
        res.json({ inUse: count > 0, count });
    } catch (e) {
        console.error('packings in-use check failed', e);
        res.status(500).json({ inUse: true, error: 'CHECK_FAILED' });
    }
});
// ==================================================
// GET /api/products/:id (details + images + opening)
// ==================================================
// ==================================================
// GET /api/products/:id (details + images + opening + dimension_rows + origins array)
// ==================================================
router.get('/:identifier', async (req, res) => {
    const { identifier } = req.params;
    try {
        const isNumericId = /^\d+$/.test(identifier);
        const whereField = isNumericId ? 'p.id' : 'p.pdt_uniqid';

        // 1) main product
        const rows = await q(
            `
      SELECT
        p.*,
        CASE
            WHEN p.item_type = 'Service' OR p.item_id = 1 THEN sc.name
            ELSE cat.name
        END AS category_name,
        sales_acc.name AS sales_account_name,
        p.is_active,
        purch_acc.name AS purchase_account_name,
        inv_acc.name AS inventory_account_name,
        mos.name as mode_of_shipment_name,
        vm.method_name AS valuation_method_name,
        creator.name   AS created_by_name
      FROM products p
      LEFT JOIN categories cat ON cat.id = p.category_id
      LEFT JOIN service_categories sc ON sc.id = p.category_id
      LEFT JOIN acc_chart_accounts sales_acc ON sales_acc.id = p.sales_account_id
      LEFT JOIN acc_chart_accounts purch_acc ON purch_acc.id = p.purchase_account_id
      LEFT JOIN acc_chart_accounts inv_acc ON inv_acc.id = p.inventory_account_id
      LEFT JOIN mode_of_shipment mos ON mos.id = p.mode_of_shipment_id
      LEFT JOIN valuation_methods vm ON vm.id = p.valuation_method_id
      LEFT JOIN \`user\` creator ON creator.id = p.created_by
      WHERE ${whereField} = ?
      `,
            [identifier]
        );
        if (!rows.length) return res.status(404).json({ error: 'Not found' });
        const product = rows[0];
        const productId = product.id;

        // Check if the product is used in any transactions
        // Uses purchase orders and AP bills (ap_bill_lines) instead of legacy purchase_bill_items
        const [usage] = await q(
            `SELECT (
     (SELECT 1 FROM purchase_order_items WHERE item_id = ? LIMIT 1) IS NOT NULL OR
     (SELECT 1 FROM ap_bill_lines        WHERE product_id = ? LIMIT 1) IS NOT NULL
   ) AS in_use`,
            [productId, productId]
        );
        const is_in_use = !!usage?.in_use;

        // 2) images (unchanged)
        const images = (await q(
            `SELECT id, file_path, thumbnail_path, is_primary
       FROM product_images
       WHERE product_id=?
       ORDER BY is_primary DESC, id ASC`,
            [productId]
        )).map(r => ({ ...r, file_path: r.file_path }));

        // 3) opening stocks (unchanged)
        const warehousesForView = await q(
            `SELECT w.id AS warehouse_id, w.warehouse_name,
              IFNULL((SELECT SUM(isb.qty_on_hand) FROM inventory_stock_batches isb WHERE isb.product_id = ? AND isb.warehouse_id = w.id), 0) AS qty,
              IFNULL((SELECT unit_cost FROM inventory_stock_batches isb WHERE isb.product_id = ? AND isb.warehouse_id = w.id ORDER BY id DESC LIMIT 1), 0) AS unit_cost_per_unit,
              0 AS committed_qty
       FROM warehouses w
       WHERE w.is_inactive = 0
       ORDER BY w.warehouse_name`,
            [productId, productId]
        );

        const openingStocksForEdit = await q(
            `SELECT
                s.warehouse_id,
                w.warehouse_name,
                s.qty,
                s.unit_cost_per_unit
            FROM product_opening_stock s
            JOIN warehouses w ON w.id = s.warehouse_id
            WHERE s.product_id = ?
            ORDER BY w.warehouse_name`,
            [productId]
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
        d.variety,
        d.grade_and_size_code,
        d.packing_alias,
        d.brand_id,
       -- d.manufacturer_id,
        d.mpn,
        d.isbn,
        d.upc,
        d.ean,
        d.uom_id,
        d.pack_image_path
        , c.name as origin_name
      FROM product_details d
      LEFT JOIN country c ON c.id = d.origin_id
      -- LEFT JOIN packing pk ON pk.id = d.packing_id
      WHERE d.product_id=?
      ORDER BY d.id ASC
      `,
            [productId]
        );

        // 5) normalize for frontend (keep field names the UI expects)
        const dimension_rows = details.map(r => ({
            id: r.id,
            origin_country_id: r.origin_id ?? '',
            origin_name: r.origin_name ?? '',
            // UI shows packing as TEXT (textbox). Prefer name, fall back to id, then empty string.
            packing: r.packing_text || null,
            packing_id: r.packing_text || '',
            dimensions: r.dimensions || '',
            dim_unit: r.dim_unit || 'cm',
            net_weight: r.net_wt != null ? r.net_wt.toString() : '',
            gross_weight: r.gross_wt != null ? r.gross_wt.toString() : '',
            weight_unit: r.wt_unit || 'kg',
            variety: r.variety || '',
            grade_and_size_code: r.grade_and_size_code || '',
            packing_alias: r.packing_alias || '',
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

        let origin_names = [];
        if (origins.length > 0) {
            const originData = await q(
                `SELECT name FROM country WHERE id IN (?)`,
                [origins]
            );
            origin_names = originData.map(c => c.name);
        }

        // 7) respond with everything the UI needs
        // 8) Fetch product history
        const history = await q(
            `SELECT ph.id, ph.action, ph.details, ph.created_at, u.name as user_name
             FROM product_history ph
             LEFT JOIN user u ON u.id = ph.user_id
             WHERE ph.product_id = ?
             ORDER BY ph.created_at DESC`,
            [productId]
        );

        // 9) Fetch QC defect types for this product
        const qcDefectTypes = await q(
            `SELECT dt.id, dt.code, dt.name, dt.description, dt.severity, dt.sort_order
             FROM product_qc_defect_types pqdt
             JOIN qc_defect_types dt ON dt.id = pqdt.defect_type_id
             WHERE pqdt.product_id = ? AND dt.is_active = 1
             ORDER BY dt.sort_order, dt.name`,
            [productId]
        );

        // 10) Fetch product-specific QC config rules and merge with global config
        const productQcConfig = await q(
            `SELECT pqc.config_key, qc.config_name, pqc.config_value, pqc.description
             FROM product_qc_config pqc
             LEFT JOIN qc_config qc ON qc.config_key = pqc.config_key
             WHERE pqc.product_id = ?`,
            [productId]
        );

        // Fetch global config to show all available config rules
        const globalConfig = await q(
            `SELECT config_key, config_name, config_value, description
             FROM qc_config
             WHERE is_active = 1
             ORDER BY config_key`
        );

        // Merge: use product-specific values if available, otherwise use global defaults
        const configMap = {};
        if (Array.isArray(globalConfig) && globalConfig.length > 0) {
            globalConfig.forEach(gc => {
                configMap[gc.config_key] = {
                    config_key: gc.config_key,
                    config_name: gc.config_name,
                    config_value: gc.config_value,
                    description: gc.description
                };
            });
        }
        if (Array.isArray(productQcConfig) && productQcConfig.length > 0) {
            productQcConfig.forEach(pc => {
                if (configMap[pc.config_key]) {
                    configMap[pc.config_key].config_value = pc.config_value; // Override with product-specific value
                } else {
                    // Add product-specific config even if not in global (edge case)
                    configMap[pc.config_key] = {
                        config_key: pc.config_key,
                        config_name: pc.config_name || pc.config_key,
                        config_value: pc.config_value,
                        description: pc.description
                    };
                }
            });
        }
        const mergedConfig = Object.values(configMap);

        res.json({
            ...product,
            images,
            opening_stocks: openingStocksForEdit, // For Edit Modal
            warehouses: warehousesForView,       // For View Page
            origin_ids,                // CSV, unchanged
            origins,                   // array for easy hydration
            origin_names,
            dimension_rows,            // fully hydrated packing/origin rows
            history: history || [],
            in_use: is_in_use,
            qc_defect_types: qcDefectTypes || [],
            qc_tolerance_min: product.qc_tolerance_min != null ? product.qc_tolerance_min : 0,
            qc_tolerance_max: product.qc_tolerance_max != null ? product.qc_tolerance_max : 3,
            qc_config: mergedConfig || [],
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
        const created_by_id = req.session?.user?.id;

        if (!created_by_id) {
            await conn.rollback();
            return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', error_details: { message: 'User session not found. Please log in again.' } });
        }

        // Validate FKs (stay consistent with your table names)
        const sales_account_id = await fkOrNull(conn, 'acc_chart_accounts', p.sales_account_id);
        const purchase_account_id = await fkOrNull(conn, 'acc_chart_accounts', p.purchase_account_id);
        const selling_currency_id = await fkOrNull(conn, 'currency', p.selling_currency_id);
        const cost_currency_id = await fkOrNull(conn, 'currency', p.cost_currency_id);
        const category_id = await fkOrNull(conn, 'categories', p.category_id);
        const mode_of_shipment_id = await fkOrNull(conn, 'mode_of_shipment', p.mode_of_shipment_id);

        const preferred_vendor_id = await fkOrNull(conn, 'vendor', p.preferred_vendor_id);
        const valuation_method_id = await fkOrNull(conn, 'valuation_methods', p.valuation_method_id);
        const inventory_account_id = await fkOrNull(conn, 'acc_chart_accounts', p.inventory_account_id);
        const sales_tax_id = await fkOrNull(conn, 'taxes', p.sales_tax_id);
        const purchase_tax_id = await fkOrNull(conn, 'taxes', p.purchase_tax_id);

        const pdt_uniqid = `pdt_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
        const itemIdRaw = readNum(p, ['item_id'], req.query?.item_id ?? 0);
        let itemTypeRaw = read(p, ['item_type'], req.query?.item_type ?? 'Goods');
        itemTypeRaw = String(itemTypeRaw || '').toLowerCase() === 'service' ? 'Service' : 'Goods';
        let item_id = itemIdRaw;
        let item_type = itemTypeRaw;
        if (item_type === 'Service') item_id = 1;
        if (Number(item_id) === 1) item_type = 'Service';

        const productValues = [
            pdt_uniqid, item_id, item_type, category_id, readBool01(p, ['is_taxable']), mode_of_shipment_id,
            read(p, ['product_name']),
            read(p, ['hscode'], null),
            created_by_id,
            readBool01(p, ['returnable']),
            readBool01(p, ['excise']),
            readBool01(p, ['having_duty']),
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
            purchase_tax_id,
            read(p, ['purchase_description'], null),
            preferred_vendor_id,
            readBool01(p, ['track_inventory']),
            readBool01(p, ['track_batches']),
            valuation_method_id,
            inventory_account_id,
            readNum(p, ['reorder_point'], null),
            read(p, ['description'], null),
            readNum(p, ['qc_tolerance_min'], 0),
            readNum(p, ['qc_tolerance_max'], 3),
        ];
        const productPlaceholders = productValues.map(() => '?').join(', ');
        const [r1] = await conn.query(
            `INSERT INTO products
       (pdt_uniqid, item_id, item_type, category_id, is_taxable, mode_of_shipment_id, product_name, hscode, created_by,
        returnable, excise, having_duty,
        enable_sales, selling_currency_id, selling_price, sales_account_id, sales_description, sales_tax_id,
        enable_purchase, cost_currency_id, cost_price, purchase_account_id, purchase_tax_id, purchase_description, preferred_vendor_id,
        track_inventory, track_batches, valuation_method_id, inventory_account_id, reorder_point,
        description, qc_tolerance_min, qc_tolerance_max, created_at, updated_at)
       VALUES
       (${productPlaceholders}, NOW(), NOW())`,
            productValues
        );

        const productId = r1.insertId;

        await conn.query(
            `INSERT INTO product_history (product_id, user_id, action, details, created_at) VALUES (?, ?, ?, ?, NOW())`,
            [productId, created_by_id, 'CREATED', JSON.stringify({ name: read(p, ['product_name']) })]
        );

        const rowFiles = (req.files?.['row_images[]'] || []);
        // ---- product_details ----
        // ---- product_details ----
        const rows = parseJSON(p, 'dimension_rows', []);
        const isService = item_type === 'Service' || Number(item_id) === 1;
        if (!isService && (!Array.isArray(rows) || rows.length === 0 || !rows[0].uom_id)) {
            await conn.rollback();
            return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', error_details: { message: 'UOM (Unit of Measure) is a required field.' } });
        }

        const values = Array.isArray(rows) ? rows.map((r) => {
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
                r.net_weight === '' ? null : numOrNull(r.net_weight),
                r.gross_weight === '' ? null : numOrNull(r.gross_weight),
                r.weight_unit || 'kg',
                numOrNull(r.brand_id),
                r.mpn || null,
                r.isbn || null,
                r.upc || null,
                r.ean || null,
                numOrNull(r.uom_id),
                pack_image_path,                        // <-- NEW
                r.variety || null,
                r.grade_and_size_code || null,
                r.packing_alias || null
            ];
        }) : [];

        if (values.length) {
            await conn.query(
                `INSERT INTO product_details
  (product_id, origin_id, packing_text, dimensions, dim_unit,
   net_wt, gross_wt, wt_unit, brand_id,
   mpn, isbn, upc, ean, uom_id, pack_image_path,
   variety, grade_and_size_code, packing_alias)
 VALUES ?`,
                [values]
            );
        }


        // ---- product_opening_stock ----
        const opening = (() => { try { return JSON.parse(p.opening_stocks || '[]'); } catch { return []; } })();
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
            const [[{ c: existingPrimaryCount }]] = await conn.query(
                'SELECT COUNT(*) AS c FROM product_images WHERE product_id=? AND is_primary=1',
                [productId]
            );

            let primarySet = existingPrimaryCount > 0;
            const now = new Date();

            const imageInsertData = await Promise.all(files.map(async (f, i) => {
                const thumbName = `thumb_${f.filename}`;
                const thumbDiskPath = path.join(THUMB_DIR, thumbName);
                await sharp(f.path)
                    .resize(200, 200, { fit: 'inside', withoutEnlargement: true })
                    .toFile(thumbDiskPath);

                const is_primary = primarySet ? 0 : (i === 0 ? 1 : 0);
                if (!primarySet && is_primary === 1) primarySet = true;

                return [
                    productId,
                    relPath(f.path),
                    //relPath(thumbDiskPath),
                    relPath(thumbDiskPath, true),
                    is_primary,
                    f.originalname || null,
                    f.mimetype || null,
                    f.size || null,
                    i,
                    now,
                ];
            }));

            await conn.query(
                `INSERT INTO product_images (product_id, file_path, thumbnail_path, is_primary, original_name, mime_type, size_bytes, sort_order, created_at)
         VALUES ?`,
                [imageInsertData]
            );
        }

        // Save QC defect types (many-to-many relationship)
        const qcDefectTypes = parseJSON(p, 'qc_defect_types', []);
        if (Array.isArray(qcDefectTypes) && qcDefectTypes.length > 0) {
            const defectTypeValues = qcDefectTypes
                .filter(id => id && Number.isFinite(Number(id)))
                .map(defectTypeId => [productId, Number(defectTypeId)]);

            if (defectTypeValues.length > 0) {
                await conn.query(
                    `INSERT INTO product_qc_defect_types (product_id, defect_type_id) VALUES ?`,
                    [defectTypeValues]
                );
            }
        }

        // Save product-specific QC config rules
        const qcConfig = parseJSON(p, 'qc_config', {});
        if (typeof qcConfig === 'object' && qcConfig !== null) {
            // Get global config to get descriptions
            const [globalConfig] = await conn.query(
                'SELECT config_key, description FROM qc_config WHERE is_active = 1'
            );
            const configMap = {};
            globalConfig.forEach(gc => {
                configMap[gc.config_key] = gc.description;
            });

            // Insert product-specific config values
            for (const [configKey, configValue] of Object.entries(qcConfig)) {
                if (configKey.startsWith('editing_')) continue; // Skip editing flags

                await conn.query(
                    `INSERT INTO product_qc_config (product_id, config_key, config_value, description)
                     VALUES (?, ?, ?, ?)`,
                    [productId, configKey, configValue || '', configMap[configKey] || null]
                );
            }
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

function getChangedFields(oldValues, newValues) {
    const changes = [];
    // Only iterate over the keys we've defined in our `newValuesForHistory` object.
    // This prevents comparing fields like `id`, `created_at`, etc.
    const keysToCompare = Object.keys(newValues);

    const numericFields = ['selling_price', 'cost_price', 'reorder_point', 'qc_tolerance_min', 'qc_tolerance_max'];
    const booleanFields = ['returnable', 'excise', 'having_duty', 'is_taxable', 'enable_sales', 'enable_purchase', 'track_inventory', 'track_batches'];

    for (const key of keysToCompare) {
        const oldValue = oldValues[key];
        const newValue = newValues[key];

        // Normalize null/undefined to empty string for string comparison
        const oldString = oldValue == null ? '' : String(oldValue);
        const newString = newValue == null ? '' : String(newValue);

        if (booleanFields.includes(key)) {
            // Booleans are already normalized to 0 or 1 in newValues.
            // DB stores TINYINT(1) which can be 0 or 1.
            if (Number(oldValue) !== Number(newValue)) {
                changes.push({ field: key, from: oldValue, to: newValue });
            }
        } else if (numericFields.includes(key)) {
            // For decimal/float fields, compare them as numbers to avoid "8.50" vs "8.5" issues.
            // Treat null/undefined/empty as null for a safer comparison.
            const oldNum = (oldValue === null || oldValue === undefined || String(oldValue).trim() === '') ? null : parseFloat(oldValue);
            const newNum = (newValue === null || newValue === undefined || String(newValue).trim() === '') ? null : parseFloat(newValue);

            // Use a tolerance-based comparison to handle floating point precision issues
            // For tolerance fields (qc_tolerance_min, qc_tolerance_max), round to 2 decimal places
            // For other numeric fields, use a small epsilon for comparison
            if (key === 'qc_tolerance_min' || key === 'qc_tolerance_max') {
                const oldRounded = oldNum === null ? null : Math.round(oldNum * 100) / 100;
                const newRounded = newNum === null ? null : Math.round(newNum * 100) / 100;
                if (oldRounded !== newRounded) {
                    changes.push({ field: key, from: oldValue, to: newValue });
                }
            } else {
                // For other numeric fields, use epsilon comparison to handle floating point precision
                if (oldNum === null && newNum === null) {
                    // Both null, no change
                } else if (oldNum === null || newNum === null) {
                    // One is null, other is not - this is a change
                    changes.push({ field: key, from: oldValue, to: newValue });
                } else {
                    // Both are numbers, compare with small epsilon
                    const epsilon = 0.0001;
                    if (Math.abs(oldNum - newNum) > epsilon) {
                        changes.push({ field: key, from: oldValue, to: newValue });
                    }
                }
            }
        } else {
            // For all other fields (strings, FK IDs), compare as strings.
            if (oldString !== newString) {
                changes.push({ field: key, from: oldValue, to: newValue });
            }
        }
    }
    return changes;
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

        const updated_by_id = req.session?.user?.id;
        if (!updated_by_id) {
            await conn.rollback();
            return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', error_details: { message: 'User session not found. Please log in again.' } });
        }

        // Ensure product exists (and fetch pdt_uniqid if needed)
        const [[oldProduct]] = await conn.query(
            'SELECT * FROM products WHERE id=? LIMIT 1',
            [productId]
        );
        if (!oldProduct) {
            await conn.rollback();
            return res.status(404).json({ ok: false, error: 'Product not found' });
        }

        const p = req.body;
        // ----- Validate FKs (stay consistent with your table names) -----
        const sales_account_id = await fkOrNull(conn, 'acc_chart_accounts', p.sales_account_id);
        const purchase_account_id = await fkOrNull(conn, 'acc_chart_accounts', p.purchase_account_id);
        const selling_currency_id = await fkOrNull(conn, 'currency', p.selling_currency_id);
        const cost_currency_id = await fkOrNull(conn, 'currency', p.cost_currency_id);
        const category_id = await fkOrNull(conn, 'categories', p.category_id);
        const mode_of_shipment_id = await fkOrNull(conn, 'mode_of_shipment', p.mode_of_shipment_id);

        const preferred_vendor_id = await fkOrNull(conn, 'vendor', p.preferred_vendor_id);
        const valuation_method_id = await fkOrNull(conn, 'valuation_methods', p.valuation_method_id);
        const inventory_account_id = await fkOrNull(conn, 'acc_chart_accounts', p.inventory_account_id);
        const sales_tax_id = await fkOrNull(conn, 'taxes', p.sales_tax_id);
        const purchase_tax_id = await fkOrNull(conn, 'taxes', p.purchase_tax_id);

        const newValuesForHistory = {
            category_id,
            product_name: read(p, ['product_name']),
            hscode: read(p, ['hscode'], null),
            mode_of_shipment_id,
            returnable: readBool01(p, ['returnable']),
            excise: readBool01(p, ['excise']),
            having_duty: readBool01(p, ['having_duty']),
            is_taxable: readBool01(p, ['is_taxable']),
            enable_sales: readBool01(p, ['enable_sales']),
            selling_currency_id,
            selling_price: readNum(p, ['selling_price'], null),
            sales_account_id,
            sales_description: read(p, ['sales_description'], null),
            sales_tax_id,
            enable_purchase: readBool01(p, ['enable_purchase']),
            cost_currency_id,
            cost_price: readNum(p, ['cost_price'], null),
            purchase_account_id,
            purchase_tax_id,
            purchase_description: read(p, ['purchase_description'], null),
            preferred_vendor_id,
            track_inventory: readBool01(p, ['track_inventory']),
            track_batches: readBool01(p, ['track_batches']),
            valuation_method_id,
            inventory_account_id,
            reorder_point: readNum(p, ['reorder_point'], null),
            description: read(p, ['description'], null),
            qc_tolerance_min: readNum(p, ['qc_tolerance_min'], 0),
            qc_tolerance_max: readNum(p, ['qc_tolerance_max'], 3),
        };

        const changedFields = getChangedFields(oldProduct, newValuesForHistory);

        // ----- Update main products row (DO NOT change pdt_uniqid here) -----
        await conn.query(
            `UPDATE products SET
        category_id=?,
        product_name=?,
        mode_of_shipment_id=?,
        hscode=?,
        returnable=?,
        excise=?,
        having_duty=?,
        is_taxable=?,
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
        purchase_tax_id=?,
        purchase_description=?,
        preferred_vendor_id=?,
        track_inventory=?,
        track_batches=?,
        valuation_method_id=?,
        inventory_account_id=?,
        reorder_point=?,
        description=?,
        qc_tolerance_min=?,
        qc_tolerance_max=?,
        updated_at=NOW()
      WHERE id=?`,
            [
                category_id,
                read(p, ['product_name']),
                mode_of_shipment_id,
                read(p, ['hscode'], null),

                readBool01(p, ['returnable']),
                readBool01(p, ['excise']),
                readBool01(p, ['having_duty']),
                readBool01(p, ['is_taxable']),

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
                purchase_tax_id,
                read(p, ['purchase_description'], null),
                preferred_vendor_id,

                readBool01(p, ['track_inventory']),
                readBool01(p, ['track_batches']),
                valuation_method_id,
                inventory_account_id,
                readNum(p, ['reorder_point'], null),

                read(p, ['description'], null),
                readNum(p, ['qc_tolerance_min'], 0),
                readNum(p, ['qc_tolerance_max'], 3),

                productId
            ]
        );

        // Update QC defect types (delete existing and insert new)
        await conn.query('DELETE FROM product_qc_defect_types WHERE product_id = ?', [productId]);
        const qcDefectTypes = parseJSON(p, 'qc_defect_types', []);
        if (Array.isArray(qcDefectTypes) && qcDefectTypes.length > 0) {
            const defectTypeValues = qcDefectTypes
                .filter(id => id && Number.isFinite(Number(id)))
                .map(defectTypeId => [productId, Number(defectTypeId)]);

            if (defectTypeValues.length > 0) {
                await conn.query(
                    `INSERT INTO product_qc_defect_types (product_id, defect_type_id) VALUES ?`,
                    [defectTypeValues]
                );
            }
        }

        // Update product-specific QC config rules
        const qcConfig = parseJSON(p, 'qc_config', {});
        if (typeof qcConfig === 'object' && qcConfig !== null) {
            // Get global config to get descriptions
            const [globalConfig] = await conn.query(
                'SELECT config_key, description FROM qc_config WHERE is_active = 1'
            );
            const configMap = {};
            globalConfig.forEach(gc => {
                configMap[gc.config_key] = gc.description;
            });

            // Insert or update product-specific config values
            for (const [configKey, configValue] of Object.entries(qcConfig)) {
                if (configKey.startsWith('editing_')) continue; // Skip editing flags

                await conn.query(
                    `INSERT INTO product_qc_config (product_id, config_key, config_value, description)
                     VALUES (?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), updated_at = NOW()`,
                    [productId, configKey, configValue || '', configMap[configKey] || null]
                );
            }
        }

        if (changedFields.length > 0) {
            await conn.query(
                `INSERT INTO product_history (product_id, user_id, action, details, created_at) VALUES (?, ?, ?, ?, NOW())`,
                [productId, updated_by_id, 'UPDATED', JSON.stringify(changedFields)]
            );
        }

        // ----- product_details: Smarter update to preserve IDs -----
        const rowFiles = (req.files?.['row_images[]'] || []);
        const incomingRows = parseJSON(p, 'dimension_rows', []);
        const isService = String(oldProduct?.item_type || '').toLowerCase() === 'service' || Number(oldProduct?.item_id) === 1;
        if (!isService && (!Array.isArray(incomingRows) || incomingRows.length === 0 || !incomingRows[0].uom_id)) {
            await conn.rollback();
            return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', error_details: { message: 'UOM (Unit of Measure) is a required field.' } });
        }

        if (Array.isArray(incomingRows) && incomingRows.length) {
            // 1. Get existing detail IDs for this product to compare against
            const [existingDetailRows] = await conn.query('SELECT id FROM product_details WHERE product_id=?', [productId]);
            const existingDetailIds = existingDetailRows.map(r => r.id);
            const idsToKeep = [];

            // 2. Process incoming rows: update existing, insert new
            for (const r of incomingRows) {
                const idx = Number.isFinite(Number(r.image_upload_index)) ? Number(r.image_upload_index) : -1;
                const pack_image_path =
                    idx >= 0 && rowFiles[idx] ? relPath(rowFiles[idx].path)
                        : (r.pack_image_url || null);

                const rowData = [
                    numOrNull(r.origin_country_id),
                    (r.packing_id || null),
                    r.dimensions || null,
                    r.dim_unit || r.dimensions_unit || 'cm',
                    r.net_weight === '' ? null : numOrNull(r.net_weight),
                    r.gross_weight === '' ? null : numOrNull(r.gross_weight),
                    r.weight_unit || 'kg',
                    numOrNull(r.brand_id),
                    r.mpn || null,
                    r.isbn || null,
                    r.upc || null,
                    r.ean || null,
                    numOrNull(r.uom_id),
                    pack_image_path,
                    r.variety || null,
                    r.grade_and_size_code || null,
                    r.packing_alias || null
                ];

                if (r.id && existingDetailIds.includes(Number(r.id))) {
                    // UPDATE existing row
                    await conn.query(
                        `UPDATE product_details SET
                            origin_id=?, packing_text=?, dimensions=?, dim_unit=?,
                            net_wt=?, gross_wt=?, wt_unit=?, brand_id=?,
                            mpn=?, isbn=?, upc=?, ean=?, uom_id=?, pack_image_path=?,
                            variety=?, grade_and_size_code=?, packing_alias=?
                         WHERE id=? AND product_id=?`,
                        [...rowData, r.id, productId]
                    );
                    idsToKeep.push(Number(r.id));
                } else {
                    // INSERT new row
                    await conn.query(
                        `INSERT INTO product_details
                            (product_id, origin_id, packing_text, dimensions, dim_unit,
                             net_wt, gross_wt, wt_unit, brand_id,
                             mpn, isbn, upc, ean, uom_id, pack_image_path,
                             variety, grade_and_size_code, packing_alias)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [productId, ...rowData]
                    );
                }
            }
            // 3. Delete rows from DB that were removed in the UI
            const idsToDelete = existingDetailIds.filter(id => !idsToKeep.includes(id));
            if (idsToDelete.length > 0) {
                await conn.query(`DELETE FROM product_details WHERE id IN (?)`, [idsToDelete]);
            }
        } else if (isService) {
            await conn.query('DELETE FROM product_details WHERE product_id=?', [productId]);
        }

        // ----- product_opening_stock: replace-all strategy -----
        const opening = (() => { try { return JSON.parse(p.opening_stocks || '[]'); } catch { return []; } })();
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
            const imageInsertData = await Promise.all(files.map(async (f, i) => {
                const thumbName = `thumb_${f.filename}`; // Keep same name logic
                const thumbDiskPath = path.join(THUMB_DIR, thumbName); // Save to thumb dir
                await sharp(f.path)
                    .resize(200, 200, { fit: 'inside', withoutEnlargement: true })
                    .toFile(thumbDiskPath);

                return [
                    productId,
                    relPath(f.path),
                    relPath(thumbDiskPath, true), // Use the new relPath logic
                    0, // is_primary is handled later
                    f.originalname || null,
                    f.mimetype || null,
                    f.size || null,
                    i,
                    now,
                ];
            }));

            await conn.query(
                `INSERT INTO product_images
          (product_id, file_path, thumbnail_path, is_primary, original_name, mime_type, size_bytes, sort_order, created_at)
         VALUES ?`,
                [imageInsertData]
            );
        }

        // 3) ensure there is exactly one primary
        //    - if requestedPrimaryId exists (and belongs to this product), set it
        //    - else if none primary exists, pick the first by sort_order (or lowest id)
        const [[{ c: primCount }]] = await conn.query( // This check is not strictly needed anymore but is harmless
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

        // ----- Thumbnail Generation for Existing Images -----
        // After all other updates, check if any existing images are missing thumbnails.
        const [imagesWithoutThumbnails] = await conn.query(
            `SELECT id, file_path FROM product_images WHERE product_id = ? AND (thumbnail_path IS NULL OR thumbnail_path = '')`,
            [productId]
        );

        if (imagesWithoutThumbnails.length > 0) {
            for (const image of imagesWithoutThumbnails) {
                try {
                    const originalRelativePath = image.file_path;
                    if (!originalRelativePath) continue;

                    const originalFileName = path.basename(originalRelativePath);
                    const originalDiskPath = path.join(UP_DIR, originalFileName);

                    if (fs.existsSync(originalDiskPath)) {
                        const thumbName = `thumb_${originalFileName}`;
                        const thumbDiskPath = path.join(THUMB_DIR, thumbName);

                        await sharp(originalDiskPath)
                            .resize(200, 200, { fit: 'inside', withoutEnlargement: true })
                            .toFile(thumbDiskPath);

                        const thumbRelativePath = relPath(thumbDiskPath, true);
                        await conn.query(`UPDATE product_images SET thumbnail_path = ? WHERE id = ?`, [thumbRelativePath, image.id]);
                    }
                } catch (thumbError) {
                    console.error(`Failed to generate thumbnail for image ID ${image.id}:`, thumbError);
                }
            }
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
        d.variety,
        d.grade_and_size_code,
        d.packing_alias,
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
            origin_name: r.origin_name ?? '',
            packing_text: r.packing_text || '',
            dimensions: r.dimensions || '',
            dim_unit: r.dim_unit || 'cm',
            net_weight: r.net_wt != null ? String(r.net_wt) : '',
            gross_weight: r.gross_wt != null ? String(r.gross_wt) : '',
            weight_unit: r.wt_unit || 'kg',
            variety: r.variety || '',
            grade_and_size_code: r.grade_and_size_code || '',
            packing_alias: r.packing_alias || '',
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
        for (const [i, file] of files.entries()) {
            const thumbName = `thumb_${file.filename}`; // Keep same name logic
            const thumbDiskPath = path.join(THUMB_DIR, thumbName); // Save to thumb dir
            await sharp(file.path)
                .resize(200, 200, { fit: 'inside', withoutEnlargement: true })
                .toFile(thumbDiskPath);

            await q(
                `INSERT INTO product_images (product_id, file_path, thumbnail_path, is_primary, created_at)
                 VALUES (?, ?, ?, ?, NOW())`,
                [id, relPath(file.path), relPath(thumbDiskPath, true), (count === 0 && i === 0) ? 1 : 0]
            );
        }
        res.json({ success: true, added: files.length });
    } catch (e) {
        await Promise.all(files.map(f => fs.promises.unlink(f.path).catch(() => { })));
        res.status(500).json({ error: e.message });
    }
});

// ==================================================
// DELETE /api/products/:id (soft delete)
// This must come before other DELETE routes with more segments like /:id/images/:imageId
// ==================================================
router.delete('/:id', async (req, res) => {
    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();
        const productId = Number(req.params.id);
        const userId = req.session?.user?.id;

        if (!productId || !userId) {
            return res.status(400).json({ error: 'Invalid request or not authenticated.' });
        }

        // Check if the product is in use before allowing deletion
        // Use purchase orders and AP bills (ap_bill_lines) instead of legacy purchase_bill_items
        const [usageResult] = await q(
            `SELECT (
                (SELECT 1 FROM purchase_order_items WHERE item_id = ? LIMIT 1) IS NOT NULL OR
                (SELECT 1 FROM ap_bill_lines        WHERE product_id = ? LIMIT 1) IS NOT NULL
            ) AS in_use`,
            [productId, productId]
        );
        const usage = usageResult?.[0];

        if (usage?.in_use) {
            return res.status(400).json({ error: 'This product cannot be deleted because it is part of one or more transactions.' });
        }

        await conn.query('UPDATE products SET is_deleted = 1 WHERE id = ?', [productId]);
        await conn.query('INSERT INTO product_history (product_id, user_id, action, details) VALUES (?, ?, ?, ?)', [productId, userId, 'DELETED', JSON.stringify({ message: 'Product marked as deleted.' })]);

        await conn.commit();
        res.json({ success: true, message: 'Product deleted successfully.' });
    } catch (e) {
        await conn.rollback();
        res.status(500).json({ error: 'Database operation failed.', details: e.message });
    } finally {
        conn.release();
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
        fs.promises.unlink(diskPath).catch(() => { });

        res.json({ success: true });
    } catch (err) {
        console.error('Delete image error', err);
        res.status(500).json({ error: 'Failed to delete image' });
    }
});

export default router;
