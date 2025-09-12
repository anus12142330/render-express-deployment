// server/routes/purchaseorder.js
import express from "express";
import db from "../db.js";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";

const router = express.Router();

/* ------------------------------ helpers ------------------------------ */
const errPayload = (message, type = "APP_ERROR", hint) => ({ error: { message, type, hint } });

const PO_UPLOAD_DIR = path.resolve("uploads/purchaseorder");
fs.mkdirSync(PO_UPLOAD_DIR, { recursive: true });

const poStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, PO_UPLOAD_DIR),
    filename: (_req, file, cb) =>
        cb(null, crypto.randomBytes(16).toString("hex") + path.extname(file.originalname)),
});
const upload = multer({ storage: poStorage });

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
        try { const [r] = await conn.query("SELECT id, name, percent, is_default FROM taxes ORDER BY percent ASC"); rows = r; } catch {}
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

        const params = [];
        let where = "";
        if (search) {
            where = "WHERE (po.po_number LIKE ? OR po.reference_no LIKE ? OR s.name LIKE ? OR v.display_name LIKE ?)";
            const token = `%${search}%`; params.push(token, token, token, token);
        }

        const [rows] = await db.promise().query(
            `SELECT
         po.id, po.po_number, po.po_uniqid, po.reference_no, po.vendor_id,
         DATE(po.po_date) AS po_date, DATE(po.delivery_date) AS delivery_date, po.currency_id, po.subtotal, po.discount_percent,
         po.total, po.status_id, s.name AS status_name, po.created_at, po.updated_at,
         v.display_name AS vendor_name
       FROM purchase_orders po
       LEFT JOIN vendor v ON v.id = po.vendor_id
       LEFT JOIN status s ON s.id = po.status_id
       ${where}
       ORDER BY ${sort_field} ${sort_order}
       LIMIT ? OFFSET ?`,
            [...params, per_page, offset]
        );

        const [count] = await db.promise().query(
            `SELECT COUNT(*) AS totalRows
       FROM purchase_orders po
       LEFT JOIN vendor v ON v.id = po.vendor_id
       LEFT JOIN status s ON s.id = po.status_id
       ${where}`,
            params
        );

        res.json({ data: rows || [], totalRows: count?.[0]?.totalRows || 0 });
    } catch (err) {
        res.status(500).json(errPayload(err?.message || "Failed to fetch purchase orders"));
    }
});

/* --------------------------------- get one -------------------------------- */
router.get("/by-uniqid/:uniqid", async (req, res) => {
    try {
        const uniqid = req.params.uniqid;
        if (!uniqid) return res.status(400).json(errPayload("Invalid uniqid"));

        const [[header]] = await db.promise().query(
            `SELECT
                 po.*, DATE_FORMAT(po.po_date, '%Y-%m-%d')  AS po_date, DATE_FORMAT(po.delivery_date, '%Y-%m-%d') AS delivery_date,
                 s.name AS status_name,
                 v.display_name AS vendor_name,                
                 dpl.name as loading_name,
                 dpd.name as discharge_name,
                 inco.name as inco_name,
                 tax.tax_name,
                 c.display_name as customer_name,
                 cr.name as currency,
                 cr.label as currency_label,
                 cr.currency_fullname,
                 ms.name as mode_shipment_name,
                   ct.label as container_type_label,
                   cl.label as container_load_label,
                 COALESCE(po.documents_payment_text, po.documents_payment) AS documents_payment_display
             FROM purchase_orders po
                 LEFT JOIN vendor v ON v.id = po.vendor_id
                 LEFT JOIN customer c ON c.id=po.customer_id
                 LEFT JOIN status s ON s.id = po.status_id
                 LEFT JOIN delivery_place as dpl ON dpl.id=po.port_loading
                 LEFT JOIN delivery_place as dpd ON dpd.id=po.port_discharge
                 LEFT JOIN inco_terms as inco ON inco.id=po.inco_terms_id
                 LEFT JOIN taxes as tax ON tax.id=po.vat_id
                 LEFT JOIN currency as cr ON cr.id=po.currency_id
                 LEFT JOIN mode_of_shipment as ms ON ms.id=po.mode_shipment_id
                LEFT JOIN container_type as ct ON ct.id=po.container_type_id
                LEFT JOIN container_load cl ON cl.id=po.container_load_id
             WHERE po.po_uniqid = ?
                 LIMIT 1`,
            [uniqid]
        );
        if (!header) return res.status(404).json(errPayload("Not found"));

        // --- Parse documents for payment fields ---
        const parseJson = (s, d = []) => { try { return JSON.parse(s ?? ""); } catch { return d; } };

// normalize for the frontend
        header.documents_payment_ids    = parseJson(header.documents_payment_ids, []);
        header.documents_payment_labels = parseJson(header.documents_payment_labels, []);
        header.documents_payment_text   = header.documents_payment_text ?? header.documents_payment ?? null;

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

        res.json({ header, items: items || [], attachments: attachments || [] });
    } catch (err) {
        res.status(500).json(errPayload(err?.message || "Failed to fetch by uniqid"));
    }
});

/* ---------------------------------- create -------------------------------- */
/* ---------------------------------- create -------------------------------- */
router.post("/", uploadFields, async (req, res) => {
    // --- tiny helpers (pure) ---
    const nz = (n, d = 0) => {
        const v = Number(n);
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
    const mode = (req.query.mode || "ISSUE").toUpperCase(); // DRAFT | ISSUE
    let payload = {};
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
        const discount_amount = +(subtotal * (discountPct / 100)).toFixed(2);
        const taxable = Math.max(0, +(subtotal - discount_amount).toFixed(2));

        // Distribute discount proportionally; compute per-row VAT on discounted base
        const safeSub = subtotal || 1;
        let vat_total = 0;

        const normalizedRows = baseRows.map((br) => {
            const discountShare = +(discount_amount * (br.amount_row_net / safeSub)).toFixed(2);
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

        const status_id =
            payload.status_id ??
            (await resolveStatusIdByName(conn, mode === "DRAFT" ? "Draft" : "Issued"));

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
        po_uniqid, po_number, reference_no,
        vendor_id, currency_id, is_organization, customer_id,
        delivery_address, billing_address, shipping_address,
        po_date, delivery_date,
        port_loading, port_discharge, inco_terms_id, no_containers,
        mode_shipment_id, partial_shipment_id, container_type_id, container_load_id,
        payment_terms, documents_payment, documents_payment_ids, documents_payment_labels, documents_payment_text,
        termscondition, notes,
        subtotal, discount_percent, taxable, vat_total, total,
        vat_id, vat_rate, vat_amount,
        status_id, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
            [
                po_uniqid,
                po_number,
                cleanStr(payload.reference),

                payload.vendorId || null,
                payload.currencyId || null,
                payload.deliverTo === "org" ? 1 : 0,
                payload.customerId || null,

                cleanStr(payload.deliveryAddress),
                cleanStr(payload.vendorBillAddrText) || cleanStr(payload.billing_address),
                cleanStr(payload.vendorShipAddrText) || cleanStr(payload.shipping_address),

                cleanStr(payload.poDate),
                cleanStr(payload.deliveryDate),

                cleanStr(payload.portLoading),
                cleanStr(payload.portDischarge),
                cleanStr(payload.incoterm),
                // Only save containers when mode_shipment_id === 1, else NULL
                Number(payload.mode_shipment_id) === 1 ? toIntOrNull(payload.containerCount) : null,

                // Shipment fields
                payload.mode_shipment_id || null,
                payload.partial_shipment_id || null,
                payload.container_type_id || null,
                payload.container_load_id || null,

                cleanStr(payload.paymentTermsText) || cleanStr(payload.payment_terms),
                // keep legacy string too (if used elsewhere)
                cleanStr(payload.documentsForPayment) || cleanStr(payload.documents_payment),
                JSON.stringify(docs_ids || []),
                JSON.stringify(docs_labels || []),
                docs_text || null,

                cleanStr(payload.terms) || cleanStr(payload.termscondition),
                cleanStr(payload.customerNotes) || cleanStr(payload.notes),

                subtotal,
                discountPct,
                taxable,
                vat_total,
                total,

                // legacy header VAT fields
                payload.vat_id != null ? Number(payload.vat_id) : null,
                toPct(payload.vatPct),     // store percent form
                vat_total,                 // mirror sum of line VAT
                status_id,
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
                discount_percent: discountPct,
                taxable,
                vat_total,
                total,
                status_id,
                status_name: srow?.name || (mode === "DRAFT" ? "Draft" : "Issued"),
            },
        });
    } catch (err) {
        try {
            await conn.rollback();
        } catch {}
        // cleanup any uploaded files if we failed
        const all = [req.files?.poAttachment?.[0], ...(req.files?.files || []), ...(req.files?.paymentDocs || [])].filter(Boolean);
        await Promise.all(all.map((f) => fs.promises.unlink(f.path).catch(() => {})));

        res.status(500).json(
            errPayload(
                "Failed to create purchase order",
                err?.code || "DB_ERROR",
                err?.sqlMessage || err?.message
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

    // ===== helpers (local, side-effect free) =====
    const nz = (n, d = 0) => {
        const v = Number(n);
        return Number.isFinite(v) ? v : d;
    };
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
        const [[po]] = await conn.query(
            "SELECT id, po_number FROM purchase_orders WHERE po_uniqid = ? LIMIT 1",
            [uniqid]
        );
        if (!po) return res.status(404).json(errPayload("Purchase order not found"));

        const poId = po.id;

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
        if (incomingPoNumber && incomingPoNumber !== po.po_number) {
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
        const discountPct = toNum(payload.discountPct, 0);
        const discount_amount = +(subtotal * (discountPct / 100)).toFixed(2);
        const taxable = Math.max(0, +(subtotal - discount_amount).toFixed(2));

        const safeSub = subtotal || 1;
        let vat_total = 0;

        const normalizedRows = baseRows.map((br) => {
            const discountShare = +(discount_amount * (br.amount_row_net / safeSub)).toFixed(2);
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
        let status_id = payload.status_id ?? null;
        if (!status_id && payload.status_name) {
            status_id = await resolveStatusIdByName(conn, payload.status_name);
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



        // ===== header update =====
        await conn.query(
            `UPDATE purchase_orders SET
         po_number=?, reference_no=?,
         vendor_id=?, currency_id=?, is_organization=?, customer_id=?,
         delivery_address=?, billing_address=?, shipping_address=?,
         po_date=?, delivery_date=?,
         port_loading=?, port_discharge=?, inco_terms_id=?, no_containers=?,
         mode_shipment_id=?, partial_shipment_id=?, container_type_id=?, container_load_id=?,
         payment_terms=?, documents_payment=?, documents_payment_ids=?, documents_payment_labels=?, documents_payment_text=?,
         termscondition=?, notes=?,
         subtotal=?, discount_percent=?, taxable=?, vat_total=?, total=?,
         vat_id=?, vat_rate=?, vat_amount=?,
         status_id = COALESCE(?, status_id),
         updated_at=NOW()
       WHERE id=?`,
            [
                incomingPoNumber || po.po_number,
                cleanStr(payload.reference),

                payload.vendorId || null,
                payload.currencyId || null,
                payload.deliverTo === "org" ? 1 : 0,
                payload.customerId || null,

                cleanStr(payload.deliveryAddress),
                cleanStr(payload.vendorBillAddrText) || cleanStr(payload.billing_address),
                cleanStr(payload.vendorShipAddrText) || cleanStr(payload.shipping_address),

                cleanStr(payload.poDate),
                cleanStr(payload.deliveryDate),

                cleanStr(payload.portLoading),
                cleanStr(payload.portDischarge),
                cleanStr(payload.incoterm),
               // cleanStr(payload.containerCount),
                (Number(payload.mode_shipment_id) === 1
                    ? toIntOrNull(payload.containerCount)
                        : null),

                // NEW shipment fields
                payload.mode_shipment_id || null,
                payload.partial_shipment_id || null,
                payload.container_type_id || null,
                payload.container_load_id || null,

                cleanStr(payload.paymentTermsText) || cleanStr(payload.payment_terms),
                cleanStr(payload.documentsForPayment) || cleanStr(payload.documents_payment),
                JSON.stringify(docs_ids || []),
                JSON.stringify(docs_labels || []),
                docs_text || null,

                cleanStr(payload.terms) || cleanStr(payload.termscondition),
                cleanStr(payload.customerNotes) || cleanStr(payload.notes),

                subtotal,
                discountPct,
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
                    } catch {}
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

        await conn.commit();
        res.json({
            ok: true,
            totals: { subtotal, discount_percent: discountPct, taxable, vat_total, total },
            items_saved: normalizedRows.length,
        });
    } catch (err) {
        try {
            await conn.rollback();
        } catch {}
        res
            .status(500)
            .json(
                errPayload(
                    "Failed to update purchase order",
                    err?.code || "DB_ERROR",
                    err?.sqlMessage || err?.message
                )
            );
    } finally {
        conn.release();
    }
});


/* ------------------------------- status update ---------------------------- */
router.put("/:uniqid/status", async (req, res) => {
    const uniqid = req.params.uniqid;
    const { status_id, status_name } = req.body;

    const conn = await db.promise().getConnection();
    try {
        const [[po]] = await conn.query("SELECT id FROM purchase_orders WHERE po_uniqid = ? LIMIT 1", [uniqid]);
        if (!po) return res.status(404).json({ error: { message: "Not found" } });

        let sid = status_id ?? null;
        if (!sid && status_name) {
            const [[s]] = await conn.query("SELECT id FROM status WHERE LOWER(name)=LOWER(?) LIMIT 1", [String(status_name)]);
            sid = s?.id ?? null;
        }
        if (!sid) return res.status(400).json({ error: { message: "Invalid status" } });

        await conn.query("UPDATE purchase_orders SET status_id=?, updated_at=NOW() WHERE id=?", [sid, po.id]);
        const [[srow]] = await conn.query("SELECT name FROM status WHERE id=? LIMIT 1", [sid]);
        res.json({ ok: true, status_id: sid, status_name: srow?.name || status_name });
    } catch (err) {
        res.status(500).json({ error: { message: "Failed to update status" } });
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
            await fs.promises.unlink(abs).catch(() => {});
        }
        res.json({ ok: true, id });
    } catch (err) {
        res.status(500).json({ error: { message: "Failed to delete attachment" } });
    } finally { conn.release(); }
});

export default router;
