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
    // fileFilter: (_req, file, cb) => (/^image\/(png|jpe?g|webp)$/i.test(file.mimetype) ? cb(null, true) : cb(new Error("Only images allowed"))),
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
   GET /api/proforma (list with search/pagination)
============================================================================ */
router.get("/", async (req, res) => {
    const {
        page = 1,
        per_page = 10,
        search = "",
        sort_field = "pi.date_issue",
        sort_order = "DESC",
    } = req.query;

    const p = Number(page);
    const pp = Number(per_page);
    const offset = (p - 1) * pp;

    const whereClauses = [];
    const params = [];

    if (search) {
        const s = `%${search}%`;
        whereClauses.push(`(
            pi.proforma_invoice_no LIKE ? OR
            pi.buyer_address LIKE ? OR
            pi.contract_reference LIKE ? OR
            c.display_name LIKE ?
        )`);
        params.push(s, s, s, s);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    try {
        // Query for total count
        const countSql = `
            SELECT COUNT(pi.id) as total
            FROM proforma_invoice pi
            LEFT JOIN customers c ON c.id = pi.buyer_id
            ${whereSql}
        `;
        const [[{ total }]] = await db.query(countSql, params);

        // Query for data
        const dataSql = `
            SELECT
                pi.id,
                pi.date_issue,
                pi.proforma_invoice_no,
                pi.contract_reference,
                c.display_name as customer_name,
                pi.status,
                pi.grand_total as total_amount
            FROM proforma_invoice pi
            LEFT JOIN customers c ON c.id = pi.buyer_id
            ${whereSql}
            ORDER BY ${sort_field} ${sort_order}
            LIMIT ? OFFSET ?
        `;
        const [rows] = await db.query(dataSql, [...params, pp, offset]);

        res.json({ data: rows, totalRows: total });
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch proforma invoices", detail: e.message });
    }
});

/* ============================================================================
   POST /api/proforma-invoices  (JSON or multipart with images[])
============================================================================ */
router.post("/", upload.array("attachments", 20), async (req, res) => {
    try {
        const payload = req.is("multipart/form-data")
            ? JSON.parse(req.body?.payload || "{}") // If multipart, payload is a stringified JSON
            : req.body || {}; // If not multipart, payload is direct JSON body

        const {
            header = {}, // Destructure header object
            // items
            // Note: items should be an array, ensure it's parsed correctly from payload
            // if payload is coming from form-data and items is nested.
            items = [],
            // texts
            texts = {},
            // payment
            payment = {},
            // bank
            bank = {},
        } = payload;

        const {
            expo_id, exporter, e_phone, e_fax,
            buyer_id = null, buyer, buyer_address, b_phone, b_fax,
            consignee_address, c_phone, c_fax,
            port_loading, port_discharge, port_entry, country_destination,
            proforma_invoice_no, date_issue, date_expiry, // These are required, no defaults
            buyer_reference, contract_reference, contract_date,
            currency_sale, approval = 0, user_id = null, // Add defaults
            mode_of_transport, incoterms, partial_shipment, transhipment,
        } = header; // Extract header fields from the header object

        if (!proforma_invoice_no) return res.status(400).json({ error: "proforma_invoice_no is required" });
        if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "At least one item is required" });

        const result = await tx(async (conn) => {
            // Ensure the PI number is unique before inserting
            const finalPiNo = await ensureUniqueProformaNumber(conn, proforma_invoice_no);

            // Prepare header data for insertion
            const headerData = [
                `INSERT INTO proforma_invoice
          (expo_id, exporter, e_phone, e_fax,
           buyer_id, buyer_address, b_phone, b_fax,           
           consignee_name, consignee_address, c_phone, c_fax,
           port_loading, port_discharge, port_entry, country_destination, mode_of_transport, incoterms, partial_shipment, transhipment,
           proforma_invoice_no, date_issue, date_expiry,
           contract_reference, contract_date,
           currency_sale, approval, user_id,
           payment_terms_id, tenor, payment_description,
           bank_id,
           documents_provided, terms_conditions, other_terms,
           buyer_reference)
         VALUES (?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?,?,?,?,?, ?,?,?, ?,?, ?,?,?, ?,?,?, ?,?,?, ?,?)`,
                v(expo_id), v(exporter), v(e_phone), v(e_fax),
                v(buyer_id ?? buyer?.id ?? buyer?.uniqid),
                v(buyer_address, ""),
                v(b_phone ?? buyer?.bill_phone ?? buyer?.ship_phone ?? ""),
                v(b_fax ?? buyer?.bill_fax ?? buyer?.ship_fax ?? ""),
                v(payload.header?.consignee_name), // Use consignee_name from payload.header
                v(consignee_address ?? ""), // Added consignee_address from payload
                v(c_phone ?? ""),
                v(c_fax ?? ""),
                v(port_loading), v(port_discharge), v(port_entry), v(country_destination), v(mode_of_transport), v(incoterms), v(partial_shipment), v(transhipment),
                v(finalPiNo),
                d(date_issue),
                d(date_expiry),
                v(contract_reference),
                d(contract_date),
                v(currency_sale),
                n(approval, 0),
                v(user_id),
                v(payment?.payment_terms_id), v(payment?.tenor), v(payment?.description),
                v(bank?.bank_id),
                v(texts?.documents_provided), v(texts?.terms_conditions), v(texts?.other_terms),
                v(buyer_reference)
            ];
            const [hdr] = await conn.execute(headerData[0], headerData.slice(1));
            const proformaId = hdr.insertId;

            // items insert (bulk)
            if (items.length > 0) {
                const itemRows = items.map((it) => [
                        proformaId,
                        v(it.product_id),
                        v(it.product_id ?? it.productId),
                        v(it.product_name, ""),
                        v(it.description, ""),
                        v(it.hscode, ""),
                        n(it.quantity, 0),
                        v(it.uom_id, ""),
                        n(it.unit_price, 0),
                        n(it.vat_id),
                        n(it.vat_rate, 0),
                        v(it.origin, ""),
                        v(it.packing_id)
                    ]);

                await conn.query(
                    `INSERT INTO proforma_invoice_items
               (proforma_invoice_id, product_id, product_name, description, hscode, quantity, uom_id, unit_price, vat_id, vat_rate, origin, packing_id)
             VALUES ?`,
                    [itemRows]
                );
            }

            // attachments (if any)
            if (req.files?.length) {
                const attRows = req.files.map((f) => [
                    proformaId,
                    f.originalname,
                    path.join("uploads", "proforma", path.basename(f.path)).replace(/\\/g, "/"),
                    f.mimetype.startsWith('image/') ? 'image' : 'document',
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

        res.status(201).json({ success: true, proforma_invoice_id: result, message: "Proforma created" });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Failed to create proforma", detail: e.message });
    }
});

/* ============================================================================
   PUT /api/proforma-invoices/:id  (replace items; add attachments)
============================================================================ */
router.put("/:id", upload.array("attachments", 20), async (req, res) => {
    const { id } = req.params;
    try {
        const payload = req.is("multipart/form-data")
            ? JSON.parse(req.body?.payload || "{}")
            : req.body || {};

        // Standardize payload structure to match POST route
        const {
            header = {},
            items = [],
            texts = {},
            payment = {},
            bank = {},
        } = payload;

        const {
            expo_id, exporter, e_phone, e_fax,
            buyer_id, buyer, buyer_address, b_phone, b_fax,
            consignee_address, c_phone, c_fax,
            port_loading, port_discharge, port_entry, country_destination,
            proforma_invoice_no, date_issue, date_expiry, // These are required, no defaults
            buyer_reference, contract_reference, contract_date,
            currency_sale, approval = 0, user_id = null, // Add defaults
            mode_of_transport, incoterms, partial_shipment, transhipment,
        } = header;

        await tx(async (conn) => {
            // On update, we still want to ensure the provided number doesn't clash with another existing record.
            const [[dupe]] = await conn.query(
                "SELECT id FROM proforma_invoice WHERE proforma_invoice_no=? AND id != ? LIMIT 1",
                [proforma_invoice_no, id]
            );
            if (dupe) throw new Error(`Proforma Invoice number ${proforma_invoice_no} is already in use by another document.`);

            // Prepare header update data
            const headerUpdateData = [
                `UPDATE proforma_invoice SET
           expo_id=?, exporter=?, e_phone=?, e_fax=?,
           buyer_id=?, buyer_address=?, b_phone=?, b_fax=?,
           consignee_name=?, consignee_address=?, c_phone=?, c_fax=?,
           port_loading=?, port_discharge=?, port_entry=?, country_destination=?, mode_of_transport=?, incoterms=?, partial_shipment=?, transhipment=?,
           proforma_invoice_no=?, date_issue=?, date_expiry=?,
           contract_reference=?, contract_date=?,
           currency_sale=?, approval=?, user_id=?,
           payment_terms_id=?, tenor=?, payment_description=?,
           bank_id=?,
           documents_provided=?, terms_conditions=?, other_terms=?,
           buyer_reference=?
         WHERE id=?`,
                v(expo_id), v(exporter), v(e_phone), v(e_fax),
                v(buyer_id ?? buyer?.id ?? buyer?.uniqid),
                v(buyer_address, ""),
                v(b_phone ?? buyer?.bill_phone ?? buyer?.ship_phone ?? ""),
                v(b_fax ?? buyer?.bill_fax ?? buyer?.ship_fax ?? ""),
                v(payload.header?.consignee_name), // Correctly access consignee_name from payload.header
                v(consignee_address ?? ""),
                v(c_phone ?? ""), v(c_fax ?? ""),
                v(port_loading), v(port_discharge), v(port_entry), v(country_destination), v(mode_of_transport), v(incoterms), v(partial_shipment), v(transhipment),
                v(proforma_invoice_no), d(date_issue), d(date_expiry),
                v(contract_reference), d(contract_date),
                v(currency_sale), n(approval, 0), v(user_id),
                v(payment?.payment_terms_id), v(payment?.tenor), v(payment?.description),
                v(bank?.bank_id),
                v(texts?.documents_provided), v(texts?.terms_conditions), v(texts?.other_terms),
                v(buyer_reference),
                id,
            ];
            await conn.execute(headerUpdateData[0], headerUpdateData.slice(1));

            // replace items
            await conn.execute("DELETE FROM proforma_invoice_items WHERE proforma_invoice_id=?", [id]);

            if (items.length) {
                const itemRows = items.map((it) => [
                    id,
                    v(it.product_id),
                    v(it.product_id ?? it.productId),
                    v(it.product_name, ""),
                    v(it.description, ""),
                    v(it.hscode, ""),
                    n(it.quantity, 0),
                    v(it.uom_id, ""),
                    n(it.unit_price, 0),
                    n(it.vat_id),
                    n(it.vat_rate, 0),
                    v(it.origin, ""),
                    v(it.packing_id)
                ]);
                await conn.query(
                    `INSERT INTO proforma_invoice_items
             (proforma_invoice_id, product_id, product_name, description, hscode, quantity, uom_id, unit_price, vat_id, vat_rate, origin, packing_id)
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
                    f.mimetype.startsWith('image/') ? 'image' : 'document',
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
router.get("/:id", async (req, res) => {
    const { id } = req.params;
    try {
        const [[header]] = await db.query(`
            SELECT 
                pi.*,
                p_load.name as port_loading_name,
                p_discharge.name as port_discharge_name,
                p_entry.name as port_entry_name,
                c_dest.name as country_destination_name,
                pt.terms as payment_terms_name
            FROM proforma_invoice pi
            LEFT JOIN ports p_load ON p_load.id = pi.port_loading
            LEFT JOIN ports p_discharge ON p_discharge.id = pi.port_discharge
            LEFT JOIN ports p_entry ON p_entry.id = pi.port_entry
            LEFT JOIN country c_dest ON c_dest.id = pi.country_destination
            LEFT JOIN payment_terms pt ON pt.id = pi.payment_terms_id
            WHERE pi.id=?
        `, [id]);

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
