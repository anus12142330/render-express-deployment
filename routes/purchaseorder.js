// server/routes/purchaseorder.js
import express from "express";
import db from "../db.js";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import dayjs from "dayjs";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import generatePdf from "./generatePdf.js";

const router = express.Router();

/* ------------------------------ helpers ------------------------------ */
const PO_PDF_DIR = path.resolve("uploads/purchaseorder/pdf");
fs.mkdirSync(PO_PDF_DIR, { recursive: true });


const errPayload = (message, type = "APP_ERROR", hint) => ({ error: { message, type, hint } });

const PO_UPLOAD_DIR = path.resolve("uploads/purchaseorder");
fs.mkdirSync(PO_UPLOAD_DIR, { recursive: true });

const poStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, PO_UPLOAD_DIR),
    filename: (_req, file, cb) =>
        cb(null, crypto.randomBytes(16).toString("hex") + path.extname(file.originalname)),
});
const upload = multer({ storage: poStorage });

const pdfStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, PO_PDF_DIR),
    filename: (_req, file, cb) => cb(null, `po_${crypto.randomBytes(12).toString("hex")}${path.extname(file.originalname)}`),
});
const uploadPdf = multer({ storage: pdfStorage });

const uploadFields = upload.fields([
    { name: "poAttachment", maxCount: 1 }, // legacy single
    { name: "files", maxCount: 30 },       // multiple
    { name: "paymentDocs", maxCount: 30 }, // optional multiple
]);

const relPath = (f) => (f ? `uploads/purchaseorder/${path.basename(f.path)}` : null);
const toNum = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const toIntOrNull = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
};

const addHistory = async (conn, { module, moduleId, userId, action, details }) => {
    if (!module || !moduleId || !userId || !action) return;
    await conn.query(
        'INSERT INTO history (module, module_id, user_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
        [module, moduleId, userId, action, JSON.stringify(details || {})]
    );
};

function getPOChangedFields(oldValues, newValues) {
    const changes = [];
    const fieldsToCompare = {
        po_number: 'PO Number',
        po_date: 'PO Date',
        currency_id: 'Currency',
        total: 'Total',
        notes: 'Notes',
    };

    for (const key in fieldsToCompare) {
        let oldVal, newVal;

        if (key === 'po_date' && oldValues[key] instanceof Date) {
            oldVal = dayjs(oldValues[key]).format('YYYY-MM-DD');
            newVal = String(newValues[key] || '');
        } else if (key === 'total') {
            oldVal = parseFloat(oldValues[key] || 0).toFixed(2);
            newVal = parseFloat(newValues[key] || 0).toFixed(2);
        } else {
            oldVal = String(oldValues[key] || '');
            newVal = String(newValues[key] || '');
        }

        if (oldVal !== newVal) {
            changes.push({ field: fieldsToCompare[key], from: oldValues[key] || 'empty', to: newValues[key] || 'empty' });
        }
    }
    return changes;
}

const cleanStr = (v) => {
    const s = v == null ? "" : String(v).trim();
    if (!s || s.toLowerCase() === "undefined" || s.toLowerCase() === "null") return null;
    return s;
};

const SORT_WHITELIST = new Set([
    "po_date",
    "po_number",
    "po_uniqid",
    "reference_no",
    "total",
    "delivery_date",
    "created_at",
    "updated_at",
]);

/* ------------------------------ status utils ------------------------------ */
async function resolveStatusIdByName(conn, name) {
    const nm = String(name || "").trim().toLowerCase();
    if (!nm) {
        const [any] = await conn.query("SELECT id FROM status ORDER BY id LIMIT 1");
        return any?.[0]?.id || null;
    }
    const [rows] = await conn.query("SELECT id FROM status WHERE LOWER(name)=? LIMIT 1", [nm]);
    if (rows?.[0]?.id) return rows[0].id;
    const [any] = await conn.query("SELECT id FROM status ORDER BY id LIMIT 1");
    return any?.[0]?.id || null;
}

/* ------------------------------ PO numbering ------------------------------ */
function pad(n, width) {
    const s = String(n);
    return s.length >= width ? s : "0".repeat(width - s.length) + s;
}

/**
 * Yearly prefix (scope for sequence)
 * Example 2025 → "AGPO-25-"
 */
function currentYearPrefix() {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    return `AGPO-${yy}-`;
}

/**
 * Month segment (for display only, not for resetting counter)
 * Example: September → "09"
 */
function currentMonthSegment() {
    const now = new Date();
    return String(now.getMonth() + 1).padStart(2, "0");
}

/**
 * Find max sequence already used for this year
 */
async function getMaxSequenceForYear(conn, yearPrefix) {
    const [rows] = await conn.query(
        `SELECT po_number
     FROM purchase_orders
     WHERE po_number LIKE ?
     ORDER BY po_number DESC
     LIMIT 1`,
        [`${yearPrefix}%`]
    );

    const top = rows?.[0]?.po_number || null;
    if (!top) return 0;

    // last 3 digits
    const m = top.match(/(\d{3})$/);
    return m ? Number(m[1]) : 0;
}

/**
 * Generate next PO number:
 * Format: AGPO-YY-MMNNN
 * - YY = year
 * - MM = month
 * - NNN = sequence that resets only once per year
 */
async function generateNextPONumber(conn, { width = 3 } = {}) {
    const yearPrefix = currentYearPrefix();
    const mm = currentMonthSegment();
    const latest = await getMaxSequenceForYear(conn, yearPrefix);
    const nextSeq = pad(latest + 1, width);
    return `${yearPrefix}${mm}${nextSeq}`;
}

/**
 * Ensure uniqueness (bump NNN if duplicate found)
 */
async function ensureUniquePONumber(conn, poNumber, { width = 3 } = {}) {
    const yearPrefix = currentYearPrefix();
    let value = poNumber;

    if (!value) value = await generateNextPONumber(conn, { width });

    for (let i = 0; i < 8; i++) {
        const [[dupe]] = await conn.query(
            "SELECT id FROM purchase_orders WHERE po_number = ? LIMIT 1",
            [value]
        );
        if (!dupe) return value;

        const m = value.match(/^(.*?)(\d{3})$/);
        if (m) {
            const base = m[1];
            const num = parseInt(m[2], 10) || 0;
            value = `${base}${pad(num + 1, width)}`;
        } else {
            value = await generateNextPONumber(conn, { width });
        }
    }

    // last fallback with random
    const mm = currentMonthSegment();
    return `${yearPrefix}${mm}${pad(Math.floor(Math.random() * 999), width)}`;
}
/* -------------------------------- VAT rates ------------------------------- */
router.get("/vat-rates", async (_req, res) => {
    const conn = await db.promise().getConnection();
    try {
        let rows = [];
        try { const [r] = await conn.query("SELECT id, name, percent, is_default FROM taxes ORDER BY percent ASC"); rows = r; } catch { }
        if (!rows?.length) return res.json([0, 5, 12, 18].map((v) => ({ value: String(v), label: `${v}%` })));
        res.json(rows.map(r => ({ id: r.id, value: String(r.percent), label: `${r.percent}%`, default: !!(r.is_default === 1 || r.is_default === true) })));
    } catch (e) {
        res.status(500).json(errPayload("Failed to load VAT rates"));
    } finally { conn.release(); }
});

/* ------------------------------- next number ------------------------------ */
router.get("/next-number", async (_req, res) => {
    const conn = await db.promise().getConnection();
    try {
        // uses the new yearly-sequence generator (no prefix arg needed)
        const poNumber = await generateNextPONumber(conn, { width: 3 });
        return res.json({ poNumber });
    } catch (e) {
        // Surface a tiny hint so you can see what went wrong during dev
        return res.status(500).json({
            error: "Failed to generate next PO number",
            hint: e?.message || String(e)
        });
    } finally {
        conn.release();
    }
});

/* ----------------------------------- list --------------------------------- */
router.get("/", async (req, res) => {
    try {
        const page = Math.max(parseInt(req.query.page || "1", 10), 1);
        const per_page = Math.min(Math.max(parseInt(req.query.per_page || "10", 10), 1), 100);
        const offset = (page - 1) * per_page;
        const search = (req.query.search || "").trim();
        const sort_field = SORT_WHITELIST.has(req.query.sort_field) ? req.query.sort_field : "po_date";
        const sort_order = (req.query.sort_order || "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

        const createdBy = req.query.created_by;
        const statusId = req.query.status_id;
        const editRequestStatus = req.query.edit_request_status;
        const currencyId = req.query.currency_id;
        const vendorId = req.query.vendor_id;
        const params = [];
        let where = "WHERE 1=1";
        if (search) {
            where += " AND (po.po_number LIKE ? OR po.reference_no LIKE ? OR s.name LIKE ? OR v.display_name LIKE ? OR tt.name LIKE ?)";
            const token = `%${search}%`; params.push(token, token, token, token, token);
        }
        if (editRequestStatus) { where += " AND po.edit_request_status = ?"; params.push(editRequestStatus); }
        if (createdBy) { where += " AND po.created_by = ?"; params.push(createdBy); }
        if (statusId) { where += " AND po.status_id = ?"; params.push(statusId); }
        if (currencyId) { where += " AND po.currency_id = ?"; params.push(parseInt(currencyId)); }
        if (vendorId) { where += " AND po.vendor_id = ?"; params.push(parseInt(vendorId)); }

        const [rows] = await db.promise().query(
            `SELECT
         po.id, po.po_number, po.po_uniqid, po.reference_no, po.vendor_id,
         po.trade_type_id, tt.name AS trade_type_name,
         DATE(po.po_date) AS po_date, DATE(po.delivery_date) AS delivery_date, po.subtotal, po.discount_percent,
         po.total, po.open_balance, po.status_id, s.name AS status_name, s.bg_colour, s.colour, po.created_at, po.updated_at,
         u_creator.name as created_by_name, u_approver.name as approved_by_name, po.approval_comment, po.edit_request_reason,
         edit_req_user.name as edit_requested_by_name, po.edit_requested_at,
         v.display_name AS vendor_name,
         po.currency_id, c.name AS currency_code
       FROM purchase_orders po
       LEFT JOIN vendor v ON v.id = po.vendor_id
       LEFT JOIN status s ON s.id = po.status_id
       LEFT JOIN currency c ON c.id = po.currency_id
       LEFT JOIN trade_type tt ON tt.id = po.trade_type_id
       LEFT JOIN user u_creator ON po.created_by = u_creator.id
       LEFT JOIN user u_approver ON po.approved_by_id = u_approver.id
       LEFT JOIN user edit_req_user ON po.edit_requested_by = edit_req_user.id
       ${where}
       ORDER BY ${sort_field} ${sort_order}
       LIMIT ? OFFSET ?`,
            [...params, per_page, offset]
        );

        let shipmentStatusMap = new Map();
        if ((rows || []).length > 0) {
            const poIds = rows
                .map(r => r.id)
                .filter((id) => Number.isFinite(Number(id)));
            if (poIds.length > 0) {
                const placeholders = poIds.map(() => '?').join(',');
                const [shipmentRows] = await db.promise().query(
                    `SELECT 
                        s.po_id,
                        s.lot_number,
                        s.total_lots,
                        ss.name AS stage_name,
                        ss.chip_bg_color AS stage_bg_color,
                        ss.chip_text_color AS stage_text_color
                     FROM shipment s
                     LEFT JOIN shipment_stage ss ON ss.id = s.shipment_stage_id
                     WHERE s.po_id IN (${placeholders})
                     ORDER BY s.po_id, s.lot_number`,
                    poIds
                );
                shipmentRows.forEach((ship) => {
                    const key = ship.po_id;
                    if (!shipmentStatusMap.has(key)) shipmentStatusMap.set(key, []);
                    shipmentStatusMap.get(key).push({
                        lot_number: ship.lot_number,
                        total_lots: ship.total_lots,
                        status: ship.stage_name || '',
                        bg_color: ship.stage_bg_color || null,
                        text_color: ship.stage_text_color || null
                    });
                });
            }
        }

        const enrichedRows = (rows || []).map((row) => ({
            ...row,
            lot_statuses: shipmentStatusMap.get(row.id) || []
        }));

        const [count] = await db.promise().query(
            `SELECT COUNT(*) AS totalRows
       FROM purchase_orders po
       LEFT JOIN vendor v ON v.id = po.vendor_id
       LEFT JOIN status s ON s.id = po.status_id
       LEFT JOIN user u_creator ON po.created_by = u_creator.id
       LEFT JOIN user edit_req_user ON po.edit_requested_by = edit_req_user.id
       LEFT JOIN user u_approver ON po.approved_by_id = u_approver.id
      LEFT JOIN trade_type tt ON tt.id = po.trade_type_id
       ${where}`,
            params
        );

        res.json({ data: enrichedRows, totalRows: count?.[0]?.totalRows || 0 });
    } catch (err) {
        res.status(500).json(errPayload(err?.message || "Failed to fetch purchase orders"));
    }
});

/* ---------------------------- get 5 most recent --------------------------- */
router.get("/recent", async (req, res) => {
    try {
        const vendorId = req.query.vendor_id ? parseInt(req.query.vendor_id, 10) : null;
        const page = Math.max(parseInt(req.query.page || "1", 10), 1);
        const per_page = Math.min(Math.max(parseInt(req.query.per_page || "5", 10), 1), 100);
        const offset = (page - 1) * per_page;

        let whereClause = "";
        const params = [];

        if (vendorId && Number.isFinite(vendorId)) {
            whereClause = "WHERE po.vendor_id = ?";
            params.push(vendorId);
        }

        // Get total count for pagination
        let totalRows = 0;
        if (vendorId) {
            const [countResult] = await db.promise().query(
                `SELECT COUNT(*) as total FROM purchase_orders po ${whereClause}`, params
            );
            totalRows = countResult[0]?.total || 0;
        }

        const [rows] = await db.promise().query(
            `SELECT
                po.id, po.po_number, po.po_uniqid, po.reference_no, po.vendor_id,
                DATE(po.po_date) AS po_date, DATE(po.delivery_date) AS delivery_date, po.subtotal, po.discount_percent,
                po.total, po.status_id, s.name AS status_name, s.bg_colour, s.colour, po.created_at, po.updated_at,
                v.display_name AS vendor_name,
                c.name AS currency_code
            FROM purchase_orders po
            LEFT JOIN vendor v ON v.id = po.vendor_id
            LEFT JOIN status s ON s.id = po.status_id
            LEFT JOIN currency c ON c.id = po.currency_id
            ${whereClause}
            ORDER BY po.po_date DESC, po.id DESC, po.created_at DESC
            LIMIT ? OFFSET ?`,
            [...params, per_page, offset]
        );

        res.json({ data: rows || [], totalRows });
    } catch (err) {
        res.status(500).json(errPayload(err?.message || "Failed to fetch recent purchase orders"));
    }
});


/* --------------------------------- get one -------------------------------- */
router.get("/by-uniqid/:uniqid", async (req, res) => {
    try {
        const uniqid = req.params.uniqid;
        const fetchHistory = req.query.history === 'true';
        if (!uniqid) return res.status(400).json(errPayload("Invalid uniqid"));

        const [[header]] = await db.promise().query(
            `SELECT
                 po.*, DATE_FORMAT(po.po_date, '%Y-%m-%d')  AS po_date, DATE_FORMAT(po.delivery_date, '%Y-%m-%d') AS delivery_date,
                 s.name AS status_name, s.bg_colour, s.colour,
                 v.display_name AS vendor_name,
                 dpl.name as loading_name, dpl.id as port_loading_id,
                 po.company_id,
                comp.name  as company_name,
                comp.logo  as company_logo,               
                 dpd.name as discharge_name, dpd.id as port_discharge_id,
                 inco.name as inco_name,
                 inco.acronyms as inco_acronyms,
                 tax.tax_name,
                 c.display_name as customer_name,
                 cr.name as currency,
                 cr.label as currency_label,
                 cr.currency_fullname,
                 cr.subunit_label,
                 ms.name as mode_shipment_name,
                   ct.label as container_type_label,
                   -- Edit Request Fields
                   po.edit_request_status,
                   edit_req_user.name as edit_requested_by_name,
                   po.edit_requested_at,
                   cl.label as container_load_label,
                 COALESCE(po.documents_payment_text, po.documents_payment) AS documents_payment_display,
                 pt.terms as payment_terms_name
             FROM purchase_orders po
                 LEFT JOIN vendor v ON v.id = po.vendor_id
                 LEFT JOIN vendor c ON c.id=po.customer_id
                 LEFT JOIN company_settings comp ON comp.id = po.company_id
                 LEFT JOIN status s ON s.id = po.status_id
                 LEFT JOIN delivery_place as dpl ON dpl.id=po.port_loading
                 LEFT JOIN delivery_place as dpd ON dpd.id=po.port_discharge
                 LEFT JOIN inco_terms as inco ON inco.id=po.inco_terms_id
                 LEFT JOIN taxes as tax ON tax.id=po.vat_id
                 LEFT JOIN currency as cr ON cr.id=po.currency_id
                 LEFT JOIN mode_of_shipment as ms ON ms.id=po.mode_shipment_id
                LEFT JOIN container_type as ct ON ct.id=po.container_type_id
                LEFT JOIN container_load cl ON cl.id=po.container_load_id
                LEFT JOIN payment_terms pt ON pt.id = po.payment_terms_id
                LEFT JOIN user edit_req_user ON edit_req_user.id = po.edit_requested_by
             WHERE po.po_uniqid = ?
                 LIMIT 1`,
            [uniqid]
        );
        if (!header) return res.status(404).json(errPayload("Not found"));

        // --- Parse documents for payment fields ---
        const parseJson = (s, d = []) => { try { return JSON.parse(s ?? ""); } catch { return d; } };

        // normalize for the frontend
        header.documents_payment_ids = parseJson(header.documents_payment_ids, []);
        header.documents_payment_labels = parseJson(header.documents_payment_labels, []);
        header.documents_payment_text = header.documents_payment_text ?? header.documents_payment ?? null;

        // (optional legacy)
        header.documents_payment = header.documents_payment ?? header.documents_payment_text ?? null;

        const [items] = await db.promise().query(
            `SELECT
                 i.id,
                 i.purchase_order_id,
                 i.item_name,
                 i.item_id,
                 i.hscode,
                 i.description,
                 i.account,
                 i.packing_id,
                 i.packing_label,
                 i.uom_id,
                 i.origin,
                 i.quantity,
                 i.rate,
                 i.amount,                 -- legacy pre-discount net
                 i.vat_id,                 -- << add
                 i.vat_percent,            -- << add
                 i.vat_amount,             -- << add
                 i.amount_row_net,         -- << add (qty*rate pre-discount)
                 i.amount_net,             -- << add (discounted base used for VAT)
                 um.acronyms AS uom_acronyms,
                 um.name AS uom_name,
               taxes.tax_name,
               taxes.percent,
                 COALESCE(
                         pi.file_path,
                         (SELECT file_path
                          FROM product_images
                          WHERE product_id = i.item_id
                          ORDER BY is_primary DESC, id ASC
                         LIMIT 1)
  ) AS image_url
             FROM purchase_order_items AS i
                      LEFT JOIN uom_master AS um ON um.id = i.uom_id
                      LEFT JOIN taxes ON taxes.id = i.vat_id
                      LEFT JOIN product_images AS pi
                                ON pi.product_id = i.item_id AND pi.is_primary = 1
             WHERE i.purchase_order_id = ?
             ORDER BY i.id ASC`,
            [header.id]
        );

        const [attachments] = await db.promise().query(
            `SELECT
                 purchase_order_attachments.id, file_name, file_path, mime_type, size_bytes,
                 created_at, category
             FROM purchase_order_attachments
             WHERE purchase_order_attachments.purchase_order_id = ?
             ORDER BY purchase_order_attachments.id ASC`,
            [header.id]
        );

        let history = [];
        if (fetchHistory) {
            const [historyRows] = await db.promise().query(
                `SELECT h.id, h.action, h.details, h.created_at, u.name as user_name
                 FROM history h
                 LEFT JOIN user u ON u.id = h.user_id
                 WHERE h.module = 'purchase_order' AND h.module_id = ?
                 ORDER BY h.created_at DESC`,
                [header.id]
            );
            history = historyRows || [];
        }

        // --- Document Template (for signatures/stamps) ---
        // --- Document Template (signature & stamp) ---
        // Prefer exact company match; fallback to a global template (company_id IS NULL) if you keep one
        let documentTemplate = null;
        try {
            const poCompanyId = header.company_id; // from your header query
            // The document_id for Purchase Order is 14
            const [tplRows] = await db.promise().query(
                `
    SELECT
      id,
      document_id,
      company_ids,
      sign_path      AS signature_path,  -- alias to what frontend expects
      stamp_path     AS stamp_path,
      template_attachment_path
    FROM document_templates
    WHERE document_id = ?
      AND (
            FIND_IN_SET(?, company_ids) > 0   -- exact company match in CSV
         OR company_ids IS NULL
         OR company_ids = ''
      )
    ORDER BY
      CASE WHEN FIND_IN_SET(?, company_ids) > 0 THEN 0 ELSE 1 END,
      id ASC
    LIMIT 1
    `,
                [14, poCompanyId, poCompanyId]
            );

            documentTemplate = tplRows?.[0] || null;
        } catch (e) {
            console.error("document_templates fetch error:", e);
            documentTemplate = null;
        }


        return res.json({
            header,
            items: items || [],
            attachments: attachments || [],
            history,
            documentTemplate, // contains stamp_path and signature_path
        });
    } catch (err) {
        res.status(500).json(errPayload(err?.message || "Failed to fetch by uniqid"));
    }
});

/* ---------------------------------- create -------------------------------- */
/* ---------------------------------- create -------------------------------- */
router.post("/", uploadFields, async (req, res) => {
    // --- tiny helpers (pure) ---
    const nz = (n, d = 0) => {
        const v = Number(n); // Corrected from `Number(v)` to `Number(n)`
        return Number.isFinite(v) ? v : d;
    };
    const nn = (v) => (v === undefined || v === "" ? null : v);
    const cleanStr = (v) =>
        v === undefined || v === null ? null : String(v).trim() || null;
    const toNum = (v, d = 0) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : d;
    };
    // Normalize rate to **percent** (e.g., 0.05 → 5). Keep 5, 12, 18 as-is.
    const toPct = (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return 0;
        return n <= 1 ? +(n * 100).toFixed(6) : n;
    };
    const toIntOrNull = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.trunc(n) : null;
    };

    // --- parse payload ---
    const mode = (req.query.mode || "ISSUE").toUpperCase(); // DRAFT | ISSUE | SAVE
    const userId = req.session?.user?.id;
    let payload = {}; // DRAFT | SAVE | ISSUE
    try {
        payload = JSON.parse(req.body.payload || "{}");
    } catch {
        return res.status(400).json(errPayload("Invalid JSON payload"));
    }

    // files
    const poAttachment = req.files?.poAttachment?.[0] || null;
    const extraFiles = [...(req.files?.files || []), ...(req.files?.paymentDocs || [])];

    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    const discountPct = toNum(payload.discountPct, 0);

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        // ===== PRELOAD VAT by id (single roundtrip) =====
        const vatIds = [...new Set(rows.map((r) => r?.vat_id ?? r?.vatId).filter(Boolean))].map(Number);
        const taxMap = {};
        if (vatIds.length) {
            const [taxRows] = await conn.query(
                `SELECT id, COALESCE(rate, percent) AS rate FROM taxes WHERE id IN (?)`,
                [vatIds]
            );
            taxRows.forEach((t) => {
                taxMap[t.id] = toPct(t.rate); // store as percent (5, 12, 18…)
            });
        }

        // ===== compute rows + totals =====
        let subtotal = 0;

        const baseRows = rows.map((r) => {
            // Accept both new & legacy keys from UI
            const quantity = nz(r.quantity ?? r.qty, 0);
            const rate = nz(r.rate ?? r.unitPrice, 0);

            // uom_id must be INT or null
            const uomRaw = r.uom_id ?? r.uom ?? null;
            const uom_id =
                uomRaw == null
                    ? null
                    : Number.isFinite(Number(uomRaw))
                        ? Number(uomRaw)
                        : null;

            const amount_row_net = +(quantity * rate).toFixed(2);
            subtotal += amount_row_net;

            // Resolve VAT percent
            const rVatId = r.vat_id ?? r.vatId ?? null;
            const fromMap = rVatId != null ? taxMap[Number(rVatId)] : null; // already percent
            const rawVat = fromMap != null ? fromMap : (r.vat_percent ?? r.vatPercent);
            const vat_percent = toPct(rawVat); // normalized percent
            const packing_id = toIntOrNull(r.packing_id ?? r.packingId);
            const packing_label = cleanStr(r.packing_label ?? r.packingLabel);

            return {
                item_name: String(r.item_name || r.productName || r.description || "Item").slice(0, 255),
                item_id: r.item_id != null ? Number(r.item_id) : (r.productId ? Number(r.productId) : null),
                hscode: cleanStr(r.hscode)?.slice(0, 100) || null,
                description: cleanStr(r.description)?.slice(0, 300) || null,
                account: cleanStr(r.account),
                packing_id,
                packing_label,
                uom_id,
                origin: cleanStr(r.origin),
                quantity,
                rate,
                amount_row_net,   // qty*rate pre-discount
                vat_id: rVatId != null ? Number(rVatId) : null,
                vat_percent,      // percent, not fraction
            };
        });

        subtotal = +subtotal.toFixed(2);

        // Correctly calculate discount based on type
        const discount_type = payload.discount_type === 'fixed' ? 'fixed' : 'percentage';
        const discount_input_value = toNum(payload.discount_amount, 0); // The value from the input field
        const calculated_discount_amount = discount_type === 'fixed'
            ? discount_input_value
            : +(subtotal * (discount_input_value / 100)).toFixed(2);
        const discount_percent = discount_type === 'percentage' ? discount_input_value : 0; // for legacy

        const taxable = Math.max(0, +(subtotal - calculated_discount_amount).toFixed(2));

        // Distribute discount proportionally; compute per-row VAT on discounted base
        const safeSub = subtotal || 1;
        let vat_total = 0;

        const normalizedRows = baseRows.map((br) => {
            const discountShare = +(calculated_discount_amount * (br.amount_row_net / safeSub)).toFixed(2);
            const amount_net = +(br.amount_row_net - discountShare).toFixed(2); // discounted base
            const vat_amount = +((amount_net * br.vat_percent) / 100).toFixed(2);
            vat_total += vat_amount;
            return {
                ...br,
                amount_net,
                amount: br.amount_row_net, // legacy compat
                vat_amount,
            };
        });

        vat_total = +vat_total.toFixed(2);
        const total = +(taxable + vat_total).toFixed(2);

        // ===== PO number logic =====
        const po_uniqid = `po_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

        let po_number;
        if (cleanStr(payload.poNumber)) {
            const [[dupe]] = await conn.query(
                "SELECT id FROM purchase_orders WHERE po_number = ? LIMIT 1",
                [payload.poNumber]
            );
            if (dupe) {
                const suggestion = await generateNextPONumber(conn, { prefix: currentPrefix(), width: 3 });
                await conn.rollback();
                return res
                    .status(409)
                    .json(errPayload("Duplicate PO number", "DUPLICATE", `Try: ${suggestion}`));
            }
            po_number = payload.poNumber;
        } else {
            po_number = await ensureUniquePONumber(conn, null, { width: 3 });
        }

        // Set status_id: 3 for Draft, 5 for Save (which is like Issue) and Save & Send (Issue)
        const status_id = payload.status_id ?? (mode === "DRAFT" ? 3 : 5); // SAVE and ISSUE both become 5

        // ===== Documents for payment fields =====
        const docs_ids = Array.isArray(payload.documentsForPaymentIds)
            ? payload.documentsForPaymentIds
            : [];
        const docs_labels = Array.isArray(payload.documentsForPaymentLabels)
            ? payload.documentsForPaymentLabels
            : [];
        const docs_text =
            cleanStr(payload.documentsForPaymentText) ||
            cleanStr(payload.documentsForPayment) ||
            cleanStr(payload.documents_payment);

        // ===== Header insert =====
        const [ins] = await conn.query(
            `INSERT INTO purchase_orders (
    po_uniqid, po_number, reference_no, trade_type_id, vendor_id, company_id,
    currency_id, is_organization, customer_id, customer, discount_type, discount_amount,
    vendor_address, billing_address, shipping_address,
        po_date, delivery_date,
        port_loading, port_discharge, inco_terms_id, no_containers,
        mode_shipment_id, partial_shipment_id, container_type_id, container_load_id,
        payment_terms_id, payment_description, documents_payment, documents_payment_ids, documents_payment_labels, documents_payment_text,
        termscondition, notes,
        subtotal, discount_percent, taxable, vat_total, total, 
        vat_id, vat_rate, vat_amount,
        status_id, created_at, updated_at, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW(),?)`,
            [
                po_uniqid,
                po_number,
                cleanStr(payload.reference), // Corrected from `payload.reference` to `cleanStr(payload.reference)`
                payload.tradeTypeId || null,
                payload.vendorId || null,
                payload.companyId || null,

                payload.currencyId || null,
                payload.deliverTo === "org" ? 1 : 0,
                payload.customerId || null,
                // Add the customer JSON object to the INSERT statement (if customer is selected)
                payload.customerDetail ? JSON.stringify(payload.customerDetail) : null,
                discount_type,
                discount_input_value, // <-- Save the raw input value (percentage or fixed amount)
                cleanStr(payload.vendorAddressText),  // NEW
                cleanStr(payload.vendorBillAddrText),
                cleanStr(payload.vendorShipAddrText),

                cleanStr(payload.poDate),
                cleanStr(payload.deliveryDate),

                cleanStr(payload.portLoading),
                cleanStr(payload.portDischarge),
                cleanStr(payload.incoterm),
                toIntOrNull(payload.containerCount), // Save containerCount regardless of mode

                // Shipment fields
                payload.mode_shipment_id || null,
                payload.partial_shipment_id || null,
                payload.container_type_id || null,
                payload.container_load_id || null,

                payload.paymentTermsId || null,
                cleanStr(payload.paymentTermsText) || cleanStr(payload.payment_terms), // Use new payment_description
                // keep legacy string too (if used elsewhere)
                cleanStr(payload.documentsForPayment) || cleanStr(payload.documents_payment),
                JSON.stringify(docs_ids || []),
                JSON.stringify(docs_labels || []),
                docs_text || null,

                cleanStr(payload.terms) || cleanStr(payload.termscondition),
                cleanStr(payload.customerNotes) || cleanStr(payload.notes),

                subtotal,
                discount_percent, // Save legacy field
                taxable,
                vat_total,
                total,

                // legacy header VAT fields
                payload.vat_id != null ? Number(payload.vat_id) : null,
                toPct(payload.vatPct),     // store percent form
                vat_total,                 // mirror sum of line VAT
                status_id,
                userId,
            ]
        );

        const poId = ins.insertId;

        // ===== Items insert =====
        if (normalizedRows.length) {
            const values = normalizedRows.map((r) => [
                poId,
                String(r.item_name || "Item"),
                r.item_id != null ? Number(r.item_id) : null,
                nn(r.hscode),
                nn(r.description),
                nn(r.account),
                r.packing_id != null ? Number(r.packing_id) : null,
                nn(r.packing_label),
                r.uom_id,              // int or null
                nn(r.origin),
                nz(r.quantity, 0),
                nz(r.rate, 0),
                nz(r.amount, 0),       // legacy "amount" (pre-discount)
                r.vat_id != null ? Number(r.vat_id) : null,
                nz(r.vat_percent, 0),  // percent value
                nz(r.vat_amount, 0),
                nz(r.amount_row_net, 0),
                nz(r.amount_net, 0),
            ]);

            await conn.query(
                `INSERT INTO purchase_order_items
          (purchase_order_id, item_name, item_id, hscode, description, account,
           packing_id, packing_label, uom_id, origin, quantity, rate, amount,
           vat_id, vat_percent, vat_amount, amount_row_net, amount_net)
         VALUES ?`,
                [values]
            );
        }

        // ===== Attachments =====
        const toPersist = [poAttachment, ...(extraFiles || [])].filter(Boolean);
        if (toPersist.length) {
            const insertValues = toPersist.map((f) => [
                poId,
                f.originalname,
                relPath(f),
                f.mimetype || null,
                f.size || null,
                new Date(),
                f === poAttachment ? "PO" : "PAYMENT",
            ]);
            await conn.query(
                `INSERT INTO purchase_order_attachments
           (purchase_order_id, file_name, file_path, mime_type, size_bytes, created_at, category)
         VALUES ?`,
                [insertValues]
            );
        }

        await conn.commit();

        const [[srow]] = await db.promise().query(
            "SELECT name FROM status WHERE id = ? LIMIT 1",
            [status_id]
        );

        res.json({
            header: {
                id: poId,
                po_uniqid,
                po_number,
                po_date: payload.poDate,
                subtotal,
                discount_percent: discount_percent,
                taxable,
                vat_total,
                total,
                status_id,
                status_name: srow?.name,
            },
        });
    } catch (err) {
        try {
            await conn.rollback();
        } catch { }
        // cleanup any uploaded files if we failed
        const all = [req.files?.poAttachment?.[0], ...(req.files?.files || []), ...(req.files?.paymentDocs || [])].filter(Boolean);
        await Promise.all(all.map((f) => fs.promises.unlink(f.path).catch(() => { })));

        res.status(500).json(
            errPayload(
                "Failed to create purchase order",
                err?.code || "DB_ERROR",
                err?.sqlMessage || err?.message // The detailed message will now be the hint
            )
        );
    } finally {
        conn.release();
    }
});


/* ---------------------------------- update --------------------------------
   IMPORTANT: If no payload is sent (attachments only), we DO NOT touch header/items.
---------------------------------------------------------------------------- */
// UPDATE Purchase Order (header + items + attachments)
router.put("/:uniqid", uploadFields, async (req, res) => {
    const uniqid = req.params.uniqid;
    const mode = (req.query.mode || "SAVE").toUpperCase(); // SAVE | DRAFT | ISSUE
    const user_id = req.session?.user?.id;

    // ===== helpers (local, side-effect free) =====
    const nz = (n, d = 0) => {
        const v = Number(n);
        return Number.isFinite(v) ? v : d;
    }; // Corrected from `Number(v)` to `Number(n)`
    const nn = (v) => (v === undefined || v === "" ? null : v);
    const cleanStr = (v) =>
        v === undefined || v === null ? null : String(v).trim() || null;
    const toNum = (v, d = 0) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : d;
    };

    const attachmentsOnly = !req.body.payload || req.body.payload === "{}";
    const conn = await db.promise().getConnection();

    try {
        // ===== find PO =====
        const [[oldPO]] = await conn.query(
            "SELECT * FROM purchase_orders WHERE po_uniqid = ? LIMIT 1",
            [uniqid]
        );
        if (!oldPO) return res.status(404).json(errPayload("Purchase order not found"));

        const poId = oldPO.id;

        if (!user_id) {
            return res.status(401).json(errPayload("Unauthorized. User session not found."));
        }

        // ===== attachments-only path =====
        if (attachmentsOnly) {
            const all = []
                .concat(req.files?.files || [])
                .concat(req.files?.poAttachment || [])
                .concat(req.files?.paymentDocs || []);
            if (!all.length) return res.json({ ok: true, added: 0, attachments: [] });

            await conn.beginTransaction();

            const insertValues = all.map((f) => [
                poId,
                f.originalname,
                relPath(f),
                f.mimetype || null,
                f.size || null,
                new Date(),
                (req.files?.poAttachment || []).includes(f) ? "PO" : "PAYMENT",
            ]);

            await conn.query(
                `INSERT INTO purchase_order_attachments
         (purchase_order_id, file_name, file_path, mime_type, size_bytes, created_at, category)
         VALUES ?`,
                [insertValues]
            );
            await conn.commit();

            const [attachments] = await conn.query(
                `SELECT id, file_name, file_path, mime_type, size_bytes, created_at, category
           FROM purchase_order_attachments
          WHERE purchase_order_id = ?
          ORDER BY id ASC`,
                [poId]
            );
            return res.json({ ok: true, added: all.length, attachments });
        }

        // ===== full update =====
        let payload = {};
        try {
            payload = JSON.parse(req.body.payload || "{}");
        } catch {
            return res.status(400).json(errPayload("Invalid JSON payload"));
        }

        const rowsIn = Array.isArray(payload.rows) ? payload.rows : [];
        const poAttachment = req.files?.poAttachment?.[0] || null;
        const extraFiles = [...(req.files?.files || []), ...(req.files?.paymentDocs || [])];
        const deletedAttachmentIds = JSON.parse(req.body.deletedAttachmentIds || "[]");

        await conn.beginTransaction();

        // ----- duplicate PO number check -----
        const incomingPoNumber = cleanStr(payload.poNumber);
        if (incomingPoNumber && incomingPoNumber !== oldPO.po_number) {
            const [[dupe]] = await conn.query(
                "SELECT id FROM purchase_orders WHERE po_number = ? AND id <> ? LIMIT 1",
                [incomingPoNumber, poId]
            );
            if (dupe) {
                const suggestion = await generateNextPONumber(conn, {
                    prefix: currentPrefix(),
                    width: 3,
                });
                await conn.rollback();
                return res
                    .status(409)
                    .json(errPayload("Duplicate PO number", "DUPLICATE", `Try: ${suggestion}`));
            }
        }

        // ----- preload tax rates for used vat_id values -----
        const vatIds = [
            ...new Set(
                rowsIn
                    .map((r) => r?.vat_id ?? r?.vatId)
                    .filter((x) => x !== null && x !== undefined && String(x).trim() !== "")
            ),
        ].map(Number);
        const taxMap = {};
        if (vatIds.length) {
            const [taxRows] = await conn.query(
                `SELECT id, COALESCE(rate, percent) AS rate FROM taxes WHERE id IN (?)`,
                [vatIds]
            );
            taxRows.forEach((t) => {
                taxMap[t.id] = toNum(t.rate, 0);
            });
        }

        // ===== normalize rows so nothing important is undefined =====
        let subtotal = 0;

        const baseRows = rowsIn.map((r) => {
            // accept both new + legacy keys
            const quantity = nz(r.quantity ?? r.qty, 0);
            const rate = nz(r.rate ?? r.unitPrice, 0);

            // uom_id should be INT or null; accept r.uom_id or r.uom
            const uomRaw = r.uom_id ?? r.uom ?? null;
            const uom_id =
                uomRaw == null
                    ? null
                    : Number.isFinite(Number(uomRaw))
                        ? Number(uomRaw)
                        : null;

            const amount_row_net = +(quantity * rate).toFixed(2);
            subtotal += amount_row_net;

            const rVatId = r.vat_id ?? r.vatId ?? null;
            const percentFromId =
                rVatId != null ? toNum(taxMap[Number(rVatId)], null) : null;
            const vat_percent =
                percentFromId != null
                    ? percentFromId
                    : nz(r.vat_percent ?? r.vatPercent, 0);

            const packing_id = toIntOrNull(r.packing_id ?? r.packingId);
            const packing_label = cleanStr(r.packing_label ?? r.packingLabel);

            return {
                item_name: String(r.item_name || r.productName || r.description || "Item").slice(
                    0,
                    255
                ),
                item_id:
                    r.item_id != null
                        ? Number(r.item_id)
                        : r.productId
                            ? Number(r.productId)
                            : null,
                hscode: cleanStr(r.hscode)?.slice(0, 100) || null,
                description: cleanStr(r.description)?.slice(0, 300) || null,
                account: cleanStr(r.account),
                packing_id,
                packing_label,
                uom_id,
                origin: cleanStr(r.origin),
                quantity,
                rate,
                amount_row_net,
                vat_id: rVatId != null ? Number(rVatId) : null,
                vat_percent,
            };
        });

        subtotal = +subtotal.toFixed(2);

        // Correctly calculate discount based on type
        const discount_type = payload.discount_type === 'fixed' ? 'fixed' : 'percentage';
        const discount_input_value = toNum(payload.discount_amount, 0); // The value from the input field
        const calculated_discount_amount = discount_type === 'fixed'
            ? discount_input_value
            : +(subtotal * (discount_input_value / 100)).toFixed(2);
        const discount_percent = discount_type === 'percentage' ? discount_input_value : 0; // for legacy

        const taxable = Math.max(0, +(subtotal - calculated_discount_amount).toFixed(2));

        const safeSub = subtotal || 1;
        let vat_total = 0;

        const normalizedRows = baseRows.map((br) => {
            const discountShare = +(calculated_discount_amount * (br.amount_row_net / safeSub)).toFixed(2);
            const amount_net = +(br.amount_row_net - discountShare).toFixed(2);
            const vat_amount = +((amount_net * nz(br.vat_percent, 0)) / 100).toFixed(2);
            vat_total += vat_amount;
            return {
                ...br,
                amount_net,
                amount: br.amount_row_net, // legacy compat
                vat_amount,
            };
        });

        vat_total = +vat_total.toFixed(2);
        const total = +(taxable + vat_total).toFixed(2);

        // ----- optional status update -----
        // Use a consistent and safe way to determine status_id
        let status_id;
        const requestedStatusId = parseInt(payload.status_id, 10);
        if (Number.isFinite(requestedStatusId)) {
            status_id = requestedStatusId;
        } else {
            status_id = mode === "DRAFT" ? 3 : 5; // Default: 3 for Draft, 5 for Save/Issue
        }

        // ----- documents for payment -----
        const docs_ids = Array.isArray(payload.documentsForPaymentIds)
            ? payload.documentsForPaymentIds
            : [];
        const docs_labels = Array.isArray(payload.documentsForPaymentLabels)
            ? payload.documentsForPaymentLabels
            : [];
        const docs_text =
            cleanStr(payload.documentsForPaymentText) ||
            cleanStr(payload.documentsForPayment) ||
            cleanStr(payload.documents_payment);

        // Correctly build the customer JSON object for the update
        const customerObject = payload.customerDetail
            ? {
                name: payload.customerDetail.name,
                full_address: payload.customerDetail.full_address,
                telephone: payload.customerDetail.telephone,
                fax: payload.customerDetail.fax,
                country: payload.customerDetail.country,
            }
            : null;


        // ===== header update =====
        await conn.query(
            `UPDATE purchase_orders SET
         po_number=?, reference_no=?, trade_type_id=?, company_id=?, discount_type=?, discount_amount=?,
         vendor_id=?, currency_id=?, is_organization=?, customer_id=?,
         customer=?,vendor_address=?, billing_address=?, shipping_address=?,
         po_date=?, delivery_date=?,
         port_loading=?, port_discharge=?, inco_terms_id=?, no_containers=?,
         mode_shipment_id=?, partial_shipment_id=?, container_type_id=?, container_load_id=?, 
         payment_terms_id=?, payment_description=?, documents_payment=?, documents_payment_ids=?, documents_payment_labels=?, documents_payment_text=?,
         termscondition=?, notes=?,
         subtotal=?, discount_percent=?, taxable=?, vat_total=?, total=?, 
         vat_id=?, vat_rate=?, vat_amount=?,
         status_id = ?,
         updated_at=NOW()
       WHERE id=?`,
            [
                incomingPoNumber || oldPO.po_number,
                cleanStr(payload.reference),
                payload.tradeTypeId || null, // trade_type_id
                payload.companyId || null,   // company_id
                discount_type,
                discount_input_value, // <-- Save the raw input value

                payload.vendorId || null,
                payload.currencyId || null,
                payload.deliverTo === "org" ? 1 : 0,
                payload.customerId || null,
                JSON.stringify(customerObject), // Add the customer JSON object here
                cleanStr(payload.vendorAddressText),
                cleanStr(payload.vendorBillAddrText),
                cleanStr(payload.vendorShipAddrText),

                cleanStr(payload.poDate),
                cleanStr(payload.deliveryDate),

                cleanStr(payload.portLoading),
                cleanStr(payload.portDischarge),
                cleanStr(payload.incoterm),
                toIntOrNull(payload.containerCount), // Save containerCount regardless of mode

                // NEW shipment fields
                payload.mode_shipment_id || null,
                payload.partial_shipment_id || null,
                payload.container_type_id || null,
                payload.container_load_id || null,

                payload.paymentTermsId || null, // Use new payment_terms_id
                // Prioritize paymentTermsText, even if it's an empty string.
                // Use nullish coalescing operator (??) for cleaner logic.
                cleanStr(payload.paymentTermsText) ?? cleanStr(payload.payment_terms), // Use new payment_description
                cleanStr(payload.documentsForPayment) || cleanStr(payload.documents_payment),
                JSON.stringify(docs_ids || []),
                JSON.stringify(docs_labels || []),
                docs_text || null,

                cleanStr(payload.terms) || cleanStr(payload.termscondition),
                cleanStr(payload.customerNotes) || cleanStr(payload.notes),

                subtotal,
                discount_percent, // Save legacy field
                taxable,
                vat_total,
                total,

                // keep legacy header VAT fields for compat if you have them
                payload.vat_id != null ? Number(payload.vat_id) : null,
                toNum(payload.vatPct, 0),
                vat_total,

                status_id,
                poId,
            ]
        );

        // ===== items replace =====
        await conn.query("DELETE FROM purchase_order_items WHERE purchase_order_id = ?", [
            poId,
        ]);

        if (normalizedRows.length) {
            const values = normalizedRows.map((r) => [
                poId,
                String(r.item_name || "Item"),
                r.item_id != null ? Number(r.item_id) : null,
                nn(r.hscode),
                nn(r.description),
                nn(r.account),
                r.packing_id != null ? Number(r.packing_id) : null,
                nn(r.packing_label),
                r.uom_id, // int or null
                nn(r.origin),
                nz(r.quantity, 0),
                nz(r.rate, 0),
                nz(r.amount, 0),
                r.vat_id != null ? Number(r.vat_id) : null,
                nz(r.vat_percent, 0),
                nz(r.vat_amount, 0),
                nz(r.amount_row_net, 0),
                nz(r.amount_net, 0),
            ]);

            await conn.query(
                `INSERT INTO purchase_order_items
           (purchase_order_id, item_name, item_id, hscode, description, account,
            packing_id, packing_label,uom_id, origin, quantity, rate, amount,
            vat_id, vat_percent, vat_amount, amount_row_net, amount_net)
         VALUES ?`,
                [values]
            );
        }

        // ===== delete requested attachments =====
        if (Array.isArray(deletedAttachmentIds) && deletedAttachmentIds.length) {
            const [old] = await conn.query(
                `SELECT id, file_path
           FROM purchase_order_attachments
          WHERE id IN (?) AND purchase_order_id = ?`,
                [deletedAttachmentIds, poId]
            );
            for (const row of old) {
                await conn.query(
                    `DELETE FROM purchase_order_attachments WHERE id = ?`,
                    [row.id]
                );
                if (row.file_path) {
                    try {
                        await fs.promises.unlink(path.resolve(row.file_path));
                    } catch { }
                }
            }
        }

        // ===== add new attachments (if any) =====
        const toPersist = [poAttachment, ...(extraFiles || [])].filter(Boolean);
        if (toPersist.length) {
            const insertValues = toPersist.map((f) => [
                poId,
                f.originalname,
                relPath(f),
                f.mimetype || null,
                f.size || null,
                new Date(),
                f === poAttachment ? "PO" : "PAYMENT",
            ]);
            await conn.query(
                `INSERT INTO purchase_order_attachments
           (purchase_order_id, file_name, file_path, mime_type, size_bytes, created_at, category)
         VALUES ?`,
                [insertValues]
            );
        }

        // --- Create History Record for Update ---
        // Fetch currency names for more descriptive history
        let oldCurrencyName = 'N/A';
        if (oldPO.currency_id) {
            const [[curr]] = await conn.query('SELECT name FROM currency WHERE id = ?', [oldPO.currency_id]);
            oldCurrencyName = curr?.name || oldPO.currency_id;
        }

        let newCurrencyName = 'N/A';
        const newCurrencyId = toIntOrNull(payload.currencyId);
        if (newCurrencyId) {
            const [[curr]] = await conn.query('SELECT name FROM currency WHERE id = ?', [newCurrencyId]);
            newCurrencyName = curr?.name || newCurrencyId;
        }

        // We create a copy of oldPO and newPayload to pass to the history function,
        // replacing the currency_id with the resolved name.
        const oldValuesForHistory = { ...oldPO, currency_id: oldCurrencyName };
        const newValuesForHistory = {
            po_number: incomingPoNumber || oldPO.po_number,
            po_date: cleanStr(payload.poDate),
            currency_id: newCurrencyName,
            total: total.toFixed(2),
            notes: cleanStr(payload.customerNotes) || cleanStr(payload.notes),
        };

        const changedFields = getPOChangedFields(oldValuesForHistory, newValuesForHistory);

        if (changedFields.length > 0) {
            await addHistory(conn, {
                module: 'purchase_order',
                moduleId: poId,
                userId: user_id,
                action: 'UPDATED',
                details: { changes: changedFields }
            });
        }

        await conn.commit();
        res.json({
            ok: true,
            totals: { subtotal, discount_percent: discount_percent, taxable, vat_total, total },
            items_saved: normalizedRows.length,
        });
    } catch (err) {
        try {
            await conn.rollback();
        } catch { }
        res
            .status(500)
            .json(
                errPayload(
                    "Failed to update purchase order",
                    err?.code || "DB_ERROR",
                    err?.sqlMessage || err?.message // The detailed message will now be the hint
                )
            );
    } finally {
        conn.release();
    }
});

/* ---------------------------------- approve --------------------------------- */
router.post('/:id/approve', uploadPdf.single('pdfFile'), async (req, res) => {
    const { id } = req.params;
    const { comment } = req.body;
    const userId = req.session?.user?.id;
    const userName = req.session?.user?.name;
    const pdfFile = req.file;

    if (!userId) {
        return res.status(401).json(errPayload('Authentication required.'));
    }

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        // Determine the PDF path to save. It will be null if no file was uploaded.
        const pdfPath = pdfFile ? path.join('uploads/purchaseorder/pdf', pdfFile.filename).replace(/\\/g, '/') : null;

        const [updateResult] = await conn.query(
            `UPDATE purchase_orders SET
                status_id = ?,
                approval_comment = ?,
                approved_by_id = ?,
                approved_at = NOW(),
                pdf_path = ?
             WHERE id = ? AND status_id = ?`, // Only approve if status is 'Submitted for Approval'
            [1, comment || null, userId, pdfPath, id, 8] // 1: Approved, 8: Submitted for Approval
        );

        const updatedCount = updateResult.affectedRows;

        if (updatedCount === 0) {
            throw new Error('Purchase order not found or has already been processed.');
        }

        // Add a history record for the status change itself
        await addHistory(conn, {
            module: 'purchase_order',
            moduleId: id,
            userId: userId,
            action: 'STATUS_CHANGED',
            details: { to_status: 'Approved' }
        });

        const historyDetails = {
            comment: comment || 'No comment provided.',
            userName: userName, // Use userName to be consistent with other history logs
        };

        await addHistory(conn, {
            module: 'purchase_order',
            moduleId: id, // Use the numeric id for the history table
            userId: userId,
            action: 'APPROVED',
            details: historyDetails
        });

        await conn.commit();

        res.status(200).json({ message: 'Purchase Order approved successfully.' });
    } catch (error) {
        // If something fails, delete the uploaded PDF file to prevent orphans
        if (pdfFile) {
            fs.promises.unlink(pdfFile.path).catch(err => console.error("Failed to clean up PDF on error:", err));
        }
        await conn.rollback();
        console.error('Failed to approve PO:', error);
        res.status(500).json(errPayload(error.message || 'An error occurred during approval.'));
    } finally {
        conn.release();

    }
});

/* ---------------------------------- reject ---------------------------------- */
router.post('/:id/reject', async (req, res) => {
    const { id } = req.params;
    const { comment } = req.body;
    const userId = req.session?.user?.id;

    if (!userId) {
        return res.status(401).json(errPayload('Authentication required.'));
    }
    if (!comment) {
        return res.status(400).json(errPayload('A comment is required to reject a purchase order.'));
    }

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        const [updateResult] = await conn.query(
            `UPDATE purchase_orders SET
                status_id = 9, -- 9 = Rejected
                rejection_reason = ?
             WHERE id = ? AND status_id = 8`, // Only reject if status is 'Submitted for Approval'
            [comment, id, 8]
        );

        if (updateResult.affectedRows === 0) {
            throw new Error('Purchase order not found or has already been processed.');
        }

        await addHistory(conn, {
            module: 'purchase_order',
            moduleId: id,
            userId: userId,
            action: 'REJECTED',
            details: { reason: comment }
        });

        await conn.commit();
        res.status(200).json({ message: 'Purchase Order rejected successfully.' });
    } catch (error) {
        await conn.rollback();
        res.status(500).json(errPayload(error.message || 'An error occurred during rejection.'));
    } finally {
        conn.release();
    }
});

/* ------------------------------- status update ---------------------------- */
router.put("/:uniqid/status", async (req, res) => {
    const uniqid = req.params.uniqid;
    const { status_id, confirmation_type, customer_id } = req.body;
    const userId = req.session?.user?.id;

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();
        const [[po]] = await conn.query("SELECT id FROM purchase_orders WHERE po_uniqid = ? LIMIT 1", [uniqid]);
        if (!po) return res.status(404).json(errPayload("Not found"));

        const sid = parseInt(status_id, 10);
        if (!Number.isFinite(sid)) return res.status(400).json(errPayload("Invalid status_id provided. It must be a number."));

        // Build the update query dynamically to include confirmation details if provided
        let updateQuery = "UPDATE purchase_orders SET status_id = ?, updated_at = NOW()";
        const params = [sid];

        // If the status is 'Confirmed' (7), save the confirmation details.
        if (sid === 7 && confirmation_type) {
            updateQuery += ", confirmation_type = ?, confirmation_customer_id = ?";
            params.push(confirmation_type, customer_id || null);
        }

        updateQuery += " WHERE id = ?";
        params.push(po.id);

        await conn.query(updateQuery, params);
        const [[srow]] = await conn.query("SELECT name FROM status WHERE id=? LIMIT 1", [sid]);

        // Add to history
        await addHistory(conn, {
            module: 'purchase_order',
            moduleId: po.id,
            userId: userId,
            action: 'STATUS_CHANGED',
            details: { to_status: srow?.name || sid }
        });

        await conn.commit();

        res.json({ ok: true, status_id: sid, status_name: srow?.name || null });
    } catch (err) {
        await conn.rollback();
        console.error("Failed to update PO status:", err);
        res.status(500).json(errPayload("Failed to update status", "DB_ERROR", err.message));
    } finally { conn.release(); }
});

/* ------------------------- request po edit ------------------------ */
router.post("/:uniqid/request-edit", async (req, res) => {
    const { uniqid } = req.params;
    const { reason } = req.body;
    const userId = req.session?.user?.id;

    if (!userId) return res.status(401).json(errPayload("Authentication required."));
    if (!reason) return res.status(400).json(errPayload("A reason for the edit request is required."));

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();
        const [[po]] = await conn.query("SELECT id, status_id, edit_request_status FROM purchase_orders WHERE po_uniqid = ? LIMIT 1", [uniqid]);
        if (!po) throw new Error("Purchase Order not found.");

        // Prevent new requests if one is already pending
        if (po.edit_request_status === 'pending') {
            throw new Error("An edit request is already pending for this purchase order.");
        }

        await conn.query(
            `UPDATE purchase_orders SET 
                edit_request_status = 'pending',
                edit_requested_by = ?,
                edit_requested_at = NOW(),
                edit_request_reason = ?,
                edit_approved_by = NULL,
                edit_approved_at = NULL,
                edit_rejection_reason = NULL
             WHERE id = ?`,
            [userId, reason, po.id]
        );

        await addHistory(conn, { module: 'purchase_order', moduleId: po.id, userId, action: 'EDIT_REQUESTED', details: { reason } });
        await conn.commit();
        res.status(200).json({ message: "Edit request submitted successfully." });
    } catch (error) {
        await conn.rollback();
        res.status(500).json(errPayload(error.message || "An error occurred while submitting the request."));
    } finally { conn.release(); }
});

/* ----------------------- approve/reject po edit ----------------------- */
router.post("/:uniqid/decide-edit-request", async (req, res) => {
    const { uniqid } = req.params;
    const { decision, reason } = req.body; // decision: 'approve' or 'reject'
    const managerId = req.session?.user?.id;

    if (!managerId) return res.status(401).json(errPayload("Authentication required."));
    if (!['approve', 'reject', 'confirm'].includes(decision)) return res.status(400).json(errPayload("Invalid decision."));
    if (decision === 'reject' && !reason) return res.status(400).json(errPayload("A reason is required for rejection."));

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();
        const [[po]] = await conn.query("SELECT id, status_id FROM purchase_orders WHERE po_uniqid = ? AND edit_request_status = 'pending' LIMIT 1", [uniqid]);
        if (!po) throw new Error("No pending edit request found for this purchase order.");

        if (decision === 'approve' || decision === 'confirm') {
            // Revert status to 'Issued' (5) to allow editing and set edit status to 'approved'
            await conn.query(
                `UPDATE purchase_orders SET 
                    status_id = 5, 
                    edit_request_status = 'approved',
                    edit_approved_by = ?,
                    edit_approved_at = NOW()
                 WHERE id = ?`,
                [managerId, po.id]
            );
            await addHistory(conn, { module: 'purchase_order', moduleId: po.id, userId: managerId, action: 'EDIT_REQUEST_APPROVED', details: {} });
        } else { // Reject
            await conn.query(
                `UPDATE purchase_orders SET 
                    edit_request_status = 'rejected',
                    edit_rejection_reason = ?
                 WHERE id = ?`,
                [reason, po.id]
            );
            await addHistory(conn, { module: 'purchase_order', moduleId: po.id, userId: managerId, action: 'EDIT_REQUEST_REJECTED', details: { reason } });
        }

        await conn.commit();
        res.status(200).json({ message: `Edit request has been ${decision}d.` });
    } catch (error) {
        await conn.rollback();
        res.status(500).json(errPayload(error.message || "An error occurred."));
    } finally { conn.release(); }
});

/* ------------------------- submit for approval ------------------------ */
router.post("/:uniqid/submit-for-approval", async (req, res) => {
    const { uniqid } = req.params;
    const userId = req.session?.user?.id;

    if (!userId) {
        return res.status(401).json(errPayload("Authentication required."));
    }

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        // Find the PO and ensure its status is 'Issued' (ID 5)
        const [[po]] = await conn.query(
            "SELECT id, status_id FROM purchase_orders WHERE po_uniqid = ? LIMIT 1",
            [uniqid]
        );

        if (!po) {
            throw new Error("Purchase Order not found.");
        }
        if (po.status_id !== 5) {
            throw new Error("This action is only available for 'Issued' purchase orders.");
        }

        // Update status to 'Submitted for Approval' (ID 8)
        await conn.query("UPDATE purchase_orders SET status_id = 8 WHERE id = ?", [po.id]);

        // Add history record
        await addHistory(conn, { module: 'purchase_order', moduleId: po.id, userId, action: 'STATUS_CHANGED', details: { to_status: 'Submitted for Approval' } });

        await conn.commit();
        res.status(200).json({ message: "Purchase Order submitted for approval." });
    } catch (error) {
        await conn.rollback();
        res.status(500).json(errPayload(error.message || "An error occurred during submission."));
    } finally { conn.release(); }
});
/* --------------------------- delete single attachment --------------------- */
router.delete("/attachment/:id", async (req, res) => {
    const id = Number(req.params.id || 0);
    if (!id) return res.status(400).json({ error: { message: "Invalid attachment id" } });

    const conn = await db.promise().getConnection();
    try {
        const [[row]] = await conn.query(
            "SELECT id, file_path FROM purchase_order_attachments WHERE id = ? LIMIT 1",
            [id]
        );
        if (!row) return res.status(404).json({ error: { message: "Attachment not found" } });

        await conn.query("DELETE FROM purchase_order_attachments WHERE id = ?", [id]);
        if (row.file_path) {
            const abs = path.resolve(String(row.file_path));
            await fs.promises.unlink(abs).catch(() => { });
        }
        res.json({ ok: true, id });
    } catch (err) {
        res.status(500).json({ error: { message: "Failed to delete attachment" } });
    } finally { conn.release(); }
});

/* ------------------------- get items for a PO ------------------------- */
router.get("/items/:poId", async (req, res) => {
    const poId = Number(req.params.poId);
    if (!poId) {
        return res.status(400).json(errPayload("Invalid Purchase Order ID."));
    }

    try {
        const [items] = await db.promise().query(
            `SELECT
                 i.id,
                 i.purchase_order_id,
                 i.item_name,
                 i.item_id AS product_id,
                 i.hscode,
                 i.description,
                 i.quantity,
                 i.rate,
                 i.amount,
                 i.uom_id,
                 um.name AS uom_label,
                 COALESCE(SUM(spia.planned_quantity), 0) AS planned_quantity,
                 COALESCE(SUM(spia.allocated_quantity), 0) AS allocated_quantity,
                 COALESCE(SUM(spia.loaded_quantity), 0) AS loaded_quantity,
                 GREATEST(i.quantity - COALESCE(SUM(spia.allocated_quantity), 0), 0) AS open_quantity,
                 GREATEST(i.quantity - COALESCE(SUM(spia.allocated_quantity), 0), 0) AS remaining_quantity,
                 (SELECT pi.thumbnail_path
                  FROM product_images pi
                  WHERE pi.product_id = i.item_id
                  ORDER BY pi.is_primary DESC, pi.id ASC
                  LIMIT 1) AS thumbnail_path,
                 (SELECT pi.file_path
                  FROM product_images pi
                  WHERE pi.product_id = i.item_id
                  ORDER BY pi.is_primary DESC, pi.id ASC
                  LIMIT 1) AS image_url,
                 (SELECT pd.variety
                  FROM product_details pd
                  WHERE pd.product_id = i.item_id
                  ORDER BY pd.id ASC
                  LIMIT 1) AS variety,
                 (SELECT pd.grade_and_size_code
                  FROM product_details pd
                  WHERE pd.product_id = i.item_id
                  ORDER BY pd.id ASC
                  LIMIT 1) AS grade_and_size_code
             FROM purchase_order_items AS i
             LEFT JOIN uom_master um ON um.id = i.uom_id
             LEFT JOIN shipment_po_item_allocation spia ON spia.po_item_id = i.id AND spia.po_id = i.purchase_order_id
             WHERE i.purchase_order_id = ?
             GROUP BY i.id, i.purchase_order_id, i.item_name, i.item_id, i.hscode, i.description, i.quantity, i.rate, i.amount, i.uom_id, um.name`,
            [poId]
        );
        res.json(items || []);
    } catch (err) {
        res.status(500).json(errPayload(err?.message || "Failed to fetch purchase order items"));
    }
});

router.post("/create-from-po/:uniqid", upload.single('confirmation_attachment'), async (req, res) => {
    const { uniqid } = req.params;
    const { containers_stock_sales, containers_back_to_back, customer_id } = req.body;
    const userId = req.session?.user?.id;
    const attachment = req.file;

    if (!userId) return res.status(401).json(errPayload("Authentication required."));

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        // --- 1. Fetch PO Details & Validate Container Counts ---
        const [[po]] = await conn.query(
            `SELECT id, vendor_id, po_number, no_containers, mode_shipment_id FROM purchase_orders WHERE po_uniqid = ? LIMIT 1`,
            [uniqid]
        );
        if (!po) {
            throw new Error("Purchase Order not found.");
        }

        const stockContainers = Number(containers_stock_sales) || 0;
        const b2bContainers = Number(containers_back_to_back) || 0;
        const totalEntered = stockContainers + b2bContainers;

        if (totalEntered !== (Number(po.no_containers) || 0)) {
            throw new Error(`Container count mismatch. PO has ${po.no_containers}, but ${totalEntered} were provided.`);
        }
        if (b2bContainers > 0 && !customer_id) { // This validation is still important
            throw new Error('Customer is required for Back to Back sales.');
        }

        // --- 2. Determine Confirmation Type ---
        let confirmationType;
        if (stockContainers > 0 && b2bContainers === 0) {
            confirmationType = 'stock_and_sales';
        } else if (b2bContainers > 0 && stockContainers === 0) {
            confirmationType = 'back_to_back';
        } else {
            confirmationType = 'mixed';
        }

        // --- 3. Create a SINGLE Shipment Record ---
        const shipUniqid = `ship_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
        const [shipmentResult] = await conn.query(
            `INSERT INTO shipment (ship_uniqid, po_id, vendor_id, created_by, created_date, no_containers, containers_stock_sales, containers_back_to_back) VALUES (?, ?, ?, ?, NOW(), ?, ?, ?)`,
            [shipUniqid, po.id, po.vendor_id, userId, po.no_containers, stockContainers, b2bContainers]
        );
        const newShipmentId = shipmentResult.insertId;

        // --- 4. Update the Purchase Order with all confirmation details ---
        await conn.query(
            `UPDATE purchase_orders SET 
                status_id = 7,
                confirmation_type = ?,
                confirmation_customer_id = ?,
                containers_stock_sales = ?,
                containers_back_to_back = ?
             WHERE id = ?`,
            [confirmationType, (b2bContainers > 0 ? customer_id : null), stockContainers, b2bContainers, po.id]
        );

        // --- Set the initial stage on the NEW shipment record ---
        await conn.query(
            `UPDATE shipment SET shipment_stage_id = 1 WHERE id = ?`,
            [newShipmentId]
        );

        // --- 5. Handle Attachment ---
        if (attachment) {
            await conn.query(
                `INSERT INTO purchase_order_attachments
                   (purchase_order_id, file_name, file_path, mime_type, size_bytes, created_at, category)
                 VALUES (?, ?, ?, ?, ?, NOW(), ?)`,
                [po.id, attachment.originalname, relPath(attachment), attachment.mimetype, attachment.size, 'CONFIRMATION']
            );
        }

        // --- 6. Log History ---
        await addHistory(conn, { module: 'purchase_order', moduleId: po.id, userId, action: 'STATUS_CHANGED', details: { to_status: 'Confirmed' } });
        await addHistory(conn, { module: 'shipment', moduleId: newShipmentId, userId, action: 'CREATED', details: { from_po: po.po_number } });

        await conn.commit();
        res.status(201).json({ message: "Shipment created successfully.", shipment: { id: newShipmentId, uniqid: shipUniqid } });

    } catch (error) {
        await conn.rollback();
        console.error("Failed to create shipment from PO:", error);
        res.status(500).json(errPayload(error.message || "An error occurred."));
    } finally {
        conn.release();
    }
});

/* ------------------------- generate and save pdf ------------------------ */
router.post('/:id/generate-and-save-pdf', uploadPdf.single('pdfFile'), async (req, res) => {
    const { id } = req.params; // This is the PO *numeric* ID
    const userId = req.session?.user?.id;
    const pdfFile = req.file;

    if (!userId) {
        return res.status(401).json(errPayload('Authentication required.'));
    }
    if (!pdfFile) {
        return res.status(400).json(errPayload('No PDF file was uploaded.'));
    }

    const conn = await db.promise().getConnection();
    try {
        const [[po]] = await conn.query('SELECT id FROM purchase_orders WHERE id = ?', [id]);
        if (!po) {
            // Clean up uploaded file if PO doesn't exist
            fs.promises.unlink(pdfFile.path).catch(err => console.error("Failed to clean up PDF on error:", err));
            return res.status(404).json(errPayload('Purchase Order not found.'));
        }

        // The file is already saved by multer, we just need the relative path
        const relativePdfPath = path.join('uploads/purchaseorder/pdf', pdfFile.filename).replace(/\\/g, '/');

        // Update the purchase_orders table with the path to the generated PDF
        await conn.query('UPDATE purchase_orders SET pdf_path = ? WHERE id = ?', [relativePdfPath, id]);

        res.status(200).json({ message: 'PDF saved successfully.', path: relativePdfPath });
    } catch (error) {
        res.status(500).json(errPayload(error.message || 'Failed to save PDF.'));
    } finally {
        conn.release();
    }
});



/* ----------------------------- GET PAYMENT ALLOCATIONS ------------------ */
// GET /api/purchaseorder/:id/payment-allocations - Get payment allocations for a PO
router.get('/:id/payment-allocations', async (req, res, next) => {
    try {
        const { id } = req.params;
        const isNumeric = /^\d+$/.test(id);
        const whereField = isNumeric ? 'po.id' : 'po.po_uniqid';

        // Get PO info
        const [[po]] = await db.promise().query(`
            SELECT po.id, po.po_uniqid, po.po_number, po.total, po.currency_id, po.po_date,
                   c.name as currency_code, v.display_name as supplier_name
            FROM purchase_orders po
            LEFT JOIN currency c ON c.id = po.currency_id
            LEFT JOIN vendor v ON v.id = po.vendor_id
            WHERE ${whereField} = ?
        `, [id]);

        if (!po) {
            return res.status(404).json({ error: 'Purchase order not found' });
        }

        console.log('PO data:', { id: po.id, total: po.total, currency_id: po.currency_id, currency_code: po.currency_code });

        // Get payment allocations for this PO (advance payments)
        const [allocations] = await db.promise().query(`
            SELECT 
                pa.id,
                pa.amount_bank,
                pa.amount_base,
                p.id as payment_id,
                p.payment_uniqid,
                p.payment_number,
                p.transaction_date,
                p.payment_type,
                p.status_id,
                p.currency_id as payment_currency_id,
                p.currency_code as payment_currency_code,
                s.name as payment_status_name,
                pt.name as payment_type_name
            FROM tbl_payment_allocation pa
            INNER JOIN tbl_payment p ON p.id = pa.payment_id
            LEFT JOIN status s ON s.id = p.status_id
            LEFT JOIN payment_type pt ON pt.id = p.payment_type_id
            WHERE pa.po_id = ?
              AND pa.alloc_type = 'advance'
              AND (p.is_deleted = 0 OR p.is_deleted IS NULL)
            ORDER BY p.transaction_date DESC, p.id DESC
        `, [po.id]);

        // Calculate totals
        const totalAmount = parseFloat(po.total || 0);
        console.log('Total amount calculated:', totalAmount, 'from po.total:', po.total);

        console.log('Allocations found:', allocations.length);
        const totalAdjusted = allocations.reduce((sum, alloc) => {
            // Use amount_bank if payment currency matches PO currency, otherwise amount_base
            const poCurrencyId = po.currency_id;
            const paymentCurrencyId = alloc.payment_currency_id;
            const amount = (poCurrencyId && paymentCurrencyId && poCurrencyId === paymentCurrencyId)
                ? parseFloat(alloc.amount_bank || 0)
                : parseFloat(alloc.amount_base || 0);
            console.log('Allocation amount:', amount, 'amount_bank:', alloc.amount_bank, 'amount_base:', alloc.amount_base, 'currencies match:', poCurrencyId === paymentCurrencyId);
            return sum + amount;
        }, 0);
        const outstanding = totalAmount - totalAdjusted;
        console.log('Summary:', { totalAmount, totalAdjusted, outstanding });

        res.json({
            po: {
                id: po.id,
                po_uniqid: po.po_uniqid,
                po_number: po.po_number,
                po_date: po.po_date,
                total: totalAmount,
                currency_id: po.currency_id,
                currency_code: po.currency_code,
                supplier_name: po.supplier_name
            },
            allocations: allocations || [],
            summary: {
                total_amount: totalAmount,
                total_adjusted: totalAdjusted,
                outstanding: outstanding,
                currency_code: po.currency_code
            }
        });
    } catch (e) {
        console.error('Error fetching payment allocations:', e);
        next(e);
    }
});

export default router;
