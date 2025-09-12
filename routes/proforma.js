// routes/proforma.routes.js
import express from "express";
import db from "../db.js";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const router = express.Router();

/* ---------- paths / uploads ---------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOAD_DIR = path.join(__dirname, "..", "uploads", "proforma");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname || "");
        const base = path.basename(file.originalname || "file", ext).replace(/[^a-z0-9_\-\.]/gi, "_");
        cb(null, `${Date.now()}_${base}${ext}`);
    },
});
const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024, files: 20 },
    fileFilter: (_req, file, cb) => (/^image\/(png|jpe?g|webp)$/i.test(file.mimetype) ? cb(null, true) : cb(new Error("Only images allowed"))),
});

/* ---------- helpers ---------- */
const v = (x, f = null) => (x === undefined || x === "" ? f : x);
const n = (x, f = 0) => (Number.isFinite(Number(x)) ? Number(x) : f);
const d = (x) => (x ? new Date(x) : null);

async function tx(fn) {
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const result = await fn(conn);
        await conn.commit();
        return result;
    } catch (err) {
        try { await conn.rollback(); } catch {}
        throw err;
    } finally {
        conn.release();
    }
}

/* ============================================================================
   GET /api/proforma/next-number
============================================================================ */
// ---- numbering helpers (AGPI-YY-MM###) ----
function pad(n, w = 3) {
    const s = String(n);
    return s.length >= w ? s : "0".repeat(w - s.length) + s;
}
function currentYearPrefix() {
    const yy = String(new Date().getFullYear()).slice(-2);
    return `AGPI-${yy}-`;
}
function currentMonthSegment() {
    return String(new Date().getMonth() + 1).padStart(2, "0");
}
async function getMaxSequenceForYear(conn, yearPrefix) {
    const [rows] = await conn.query(
        `SELECT proforma_invoice_no AS no
       FROM proforma_invoice
      WHERE proforma_invoice_no LIKE ?
      ORDER BY proforma_invoice_no DESC
      LIMIT 1`,
        [`${yearPrefix}%`]
    );
    const top = rows?.[0]?.no || null;
    if (!top) return 0;
    const m = top.match(/(\d{3})$/);
    return m ? Number(m[1]) : 0;
}
async function generateNextProformaNumber(conn, { width = 3 } = {}) {
    const prefix = currentYearPrefix();
    const mm = currentMonthSegment();
    const seq = await getMaxSequenceForYear(conn, prefix);
    return `${prefix}${mm}${pad(seq + 1, width)}`;
}
async function ensureUniqueProformaNumber(conn, n, { width = 3 } = {}) {
    let value = n || await generateNextProformaNumber(conn, { width });
    for (let i = 0; i < 8; i++) {
        const [[dupe]] = await conn.query(
            "SELECT id FROM proforma_invoice WHERE proforma_invoice_no=? LIMIT 1",
            [value]
        );
        if (!dupe) return value;
        const m = value.match(/^(.*?)(\d{3})$/);
        value = m ? `${m[1]}${pad((parseInt(m[2], 10) || 0) + 1, width)}`
            : await generateNextProformaNumber(conn, { width });
    }
    // last fallback
    const mm = currentMonthSegment();
    const yy = String(new Date().getFullYear()).slice(-2);
    return `AGPI-${yy}-${mm}${pad(Math.floor(Math.random()*999), width)}`;
}

// ---- GET /api/proforma/next-number (promise API) ----
router.get("/next-number", async (_req, res) => {
    const conn = await db.promise().getConnection();
    try {
        const number = await generateNextProformaNumber(conn, { width: 3 });
        res.json({ number });
    } catch (e) {
        res.status(500).json({
            error: "Failed to generate next number",
            detail: e?.message || String(e),
        });
    } finally {
        conn.release();
    }
});

/* ============================================================================
   POST /api/proforma-invoices  (JSON or multipart with images[])
============================================================================ */
router.post("/proforma-invoices", upload.array("images", 20), async (req, res) => {
    try {
        const payload = req.is("multipart/form-data")
            ? JSON.parse(req.body?.payload || "{}")
            : req.body || {};

        const {
            // header
            expo_id, exporter, e_phone, e_fax,
            buyer_id, buyer, buyerAddress, b_phone, b_fax,
            consignee, c_phone, c_fax,
            port_loading, port_discharge, port_entry, country_destination,
            piNo, dateIssue, dateExpiry,
            contractRef, contractDate,
            currencyId, approval = 0, user_id,
            // items
            items = [],
        } = payload;

        if (!piNo) return res.status(400).json({ error: "proforma_invoice_no (piNo) is required" });
        if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "At least one item is required" });

        const result = await tx(async (conn) => {
            // header insert
            const [hdr] = await conn.execute(
                `INSERT INTO proforma_invoice
          (expo_id, exporter, e_phone, e_fax,
           buyer_id, buyer_address, b_phone, b_fax,
           consignee, c_phone, c_fax,
           port_loading, port_discharge, port_entry, country_destination,
           proforma_invoice_no, date_issue, date_expiry,
           contract_reference, contract_date,
           currency_sale, approval, user_id)
         VALUES (?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?,?, ?,?,?, ?,?, ?,?, ?)`,
                [
                    v(expo_id), v(exporter), v(e_phone), v(e_fax),
                    // prefer explicit buyer_id; fall back to buyer?.id
                    v(buyer_id ?? buyer?.id ?? buyer?.uniqid),
                    v(buyerAddress, ""),
                    v(b_phone ?? buyer?.bill_phone ?? buyer?.ship_phone ?? ""),
                    v(b_fax ?? buyer?.bill_fax ?? buyer?.ship_fax ?? ""),
                    v(consignee ?? ""),
                    v(c_phone ?? ""),
                    v(c_fax ?? ""),
                    v(port_loading), v(port_discharge), v(port_entry), v(country_destination),
                    v(piNo),
                    d(dateIssue),
                    d(dateExpiry),
                    v(contractRef),
                    d(contractDate),
                    v(currencyId),
                    n(approval, 0),
                    v(user_id),
                ]
            );
            const proformaId = hdr.insertId;

            // items insert (bulk)
            const itemRows = items.map((it) => {
                const qty = n(it.quantity, 0);
                const price = n(it.unitPrice, 0);
                const total = qty * price;
                return [
                    proformaId,
                    v(it.productId),
                    v(it.productName, ""),
                    v(it.packing, ""),                 // description
                    v(it.hsn ?? it.hscode, ""),        // hscode
                    qty,
                    v(it.uom ?? it.uom_id, ""),        // uom_id
                    price,
                    n(it.discount_percent ?? it.discountPercent, 0),
                    total,
                ];
            });

            await conn.query(
                `INSERT INTO proforma_invoice_items
           (proforma_invoice_id, product_id, product_name, description, hscode, quantity, uom_id, unit_price, discount_percent, total_price)
         VALUES ?`,
                [itemRows]
            );

            // attachments (if any)
            if (req.files?.length) {
                const attRows = req.files.map((f) => [
                    proformaId,
                    f.originalname,
                    path.join("uploads", "proforma", path.basename(f.path)).replace(/\\/g, "/"),
                    "image",
                    f.mimetype,
                    f.size,
                    new Date(),
                ]);
                await conn.query(
                    `INSERT INTO proforma_invoice_attachments
             (proforma_invoice_id, file_name, file_path, category, mime_type, size_bytes, created_at)
           VALUES ?`,
                    [attRows]
                );
            }

            return proformaId;
        });

        res.json({ success: true, proforma_invoice_id: result, message: "Proforma created" });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Failed to create proforma", detail: e.message });
    }
});

/* ============================================================================
   PUT /api/proforma-invoices/:id  (replace items; add attachments)
============================================================================ */
router.put("/proforma-invoices/:id", upload.array("images", 20), async (req, res) => {
    const { id } = req.params;
    try {
        const payload = req.is("multipart/form-data")
            ? JSON.parse(req.body?.payload || "{}")
            : req.body || {};

        const {
            expo_id, exporter, e_phone, e_fax,
            buyer_id, buyer, buyerAddress, b_phone, b_fax,
            consignee, c_phone, c_fax,
            port_loading, port_discharge, port_entry, country_destination,
            piNo, dateIssue, dateExpiry,
            contractRef, contractDate,
            currencyId, approval, user_id,
            items = [],
        } = payload;

        await tx(async (conn) => {
            await conn.execute(
                `UPDATE proforma_invoice SET
           expo_id=?, exporter=?, e_phone=?, e_fax=?,
           buyer_id=?, buyer_address=?, b_phone=?, b_fax=?,
           consignee=?, c_phone=?, c_fax=?,
           port_loading=?, port_discharge=?, port_entry=?, country_destination=?,
           proforma_invoice_no=?, date_issue=?, date_expiry=?,
           contract_reference=?, contract_date=?,
           currency_sale=?, approval=?, user_id=?
         WHERE id=?`,
                [
                    v(expo_id), v(exporter), v(e_phone), v(e_fax),
                    v(buyer_id ?? buyer?.id ?? buyer?.uniqid),
                    v(buyerAddress, ""),
                    v(b_phone ?? buyer?.bill_phone ?? buyer?.ship_phone ?? ""),
                    v(b_fax ?? buyer?.bill_fax ?? buyer?.ship_fax ?? ""),
                    v(consignee ?? ""), v(c_phone ?? ""), v(c_fax ?? ""),
                    v(port_loading), v(port_discharge), v(port_entry), v(country_destination),
                    v(piNo), d(dateIssue), d(dateExpiry),
                    v(contractRef), d(contractDate),
                    v(currencyId), n(approval, 0), v(user_id),
                    id,
                ]
            );

            // replace items
            await conn.execute("DELETE FROM proforma_invoice_items WHERE proforma_invoice_id=?", [id]);

            if (items.length) {
                const itemRows = items.map((it) => {
                    const qty = n(it.quantity, 0);
                    const price = n(it.unitPrice, 0);
                    return [
                        id,
                        v(it.productId),
                        v(it.productName, ""),
                        v(it.packing, ""),
                        v(it.hsn ?? it.hscode, ""),
                        qty,
                        v(it.uom ?? it.uom_id, ""),
                        price,
                        n(it.discount_percent ?? it.discountPercent, 0),
                        qty * price,
                    ];
                });
                await conn.query(
                    `INSERT INTO proforma_invoice_items
             (proforma_invoice_id, product_id, product_name, description, hscode, quantity, uom_id, unit_price, discount_percent, total_price)
           VALUES ?`,
                    [itemRows]
                );
            }

            // add new attachments (do not delete existing)
            if (req.files?.length) {
                const attRows = req.files.map((f) => [
                    id,
                    f.originalname,
                    path.join("uploads", "proforma", path.basename(f.path)).replace(/\\/g, "/"),
                    "image",
                    f.mimetype,
                    f.size,
                    new Date(),
                ]);
                await conn.query(
                    `INSERT INTO proforma_invoice_attachments
             (proforma_invoice_id, file_name, file_path, category, mime_type, size_bytes, created_at)
           VALUES ?`,
                    [attRows]
                );
            }
        });

        res.json({ success: true, message: "Proforma updated" });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Failed to update proforma", detail: e.message });
    }
});

/* ============================================================================
   GET /api/proforma-invoices/:id
============================================================================ */
router.get("/proforma-invoices/:id", async (req, res) => {
    const { id } = req.params;
    try {
        const [[header]] = await db.query("SELECT * FROM proforma_invoice WHERE id=?", [id]);
        if (!header) return res.status(404).json({ error: "Not found" });

        const [items] = await db.query(
            "SELECT * FROM proforma_invoice_items WHERE proforma_invoice_id=? ORDER BY id",
            [id]
        );
        const [attachments] = await db.query(
            "SELECT * FROM proforma_invoice_attachments WHERE proforma_invoice_id=? ORDER BY id",
            [id]
        );
        res.json({ header, items, attachments });
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch proforma", detail: e.message });
    }
});

export default router;
