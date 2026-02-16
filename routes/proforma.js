// routes/proforma.routes.js
import express from "express";
import db from "../db.js";
import multer from "multer";
import crypto from "crypto";
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
    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();
        const result = await fn(conn);
        await conn.commit();
        return result;
    } catch (err) {
        try { await conn.rollback(); } catch { }
        throw err;
    } finally {
        conn.release();
    }
}

async function addHistory(conn, { module, moduleId, userId, action, details }) {
    if (!module || !moduleId || !userId || !action) return;
    await conn.query(
        'INSERT INTO history (module, module_id, user_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
        [module, moduleId, userId, action, JSON.stringify(details || {})]
    );
}


/* ============================================================================
   GET /api/proforma/next-number
============================================================================ */
// ---- numbering helpers (AGPI-YY-MM###) ----
function pad(n, w = 3) {
    const s = String(n);
    return s.length >= w ? s : "0".repeat(w - s.length) + s;
}
function parseIssueDate(input) {
    if (!input) return new Date();
    // Prefer YYYY-MM-DD (from <input type="date">)
    const raw = String(input).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return new Date(`${raw}T00:00:00`);
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? new Date() : d;
}
function yearPrefixSegment(type = 'proforma_invoice', issueDate) {
    const prefix = (type === 'sales_order' || type === 'sales order') ? 'AGSO' : 'AGPI';
    const dStr = parseIssueDate(issueDate);
    const yy = String(dStr.getFullYear()).slice(-2);
    const mm = String(dStr.getMonth() + 1).padStart(2, "0");
    return `${prefix}-${yy}-${mm}`; // Removed trailing dash
}

async function getMaxSequenceForPeriod(conn, prefix) {
    // Look for the highest number starting with this PREFIX-YY-MM
    // e.g. AGPI-26-01...
    const [rows] = await conn.query(
        `SELECT proforma_invoice_no AS no
       FROM proforma_invoice
      WHERE proforma_invoice_no LIKE ?
      ORDER BY proforma_invoice_no DESC
      LIMIT 1`,
        [`${prefix}%`]
    );
    const top = rows?.[0]?.no || null;
    if (!top) return 0;

    // Extract the sequence number from the end (last 3 digits)
    const seqStr = top.slice(-3);
    const seq = Number(seqStr);
    return Number.isFinite(seq) ? seq : 0;
}

async function generateNextProformaNumber(conn, { width = 3, type = 'proforma_invoice', issueDate } = {}) {
    const prefix = yearPrefixSegment(type, issueDate);
    const seq = await getMaxSequenceForPeriod(conn, prefix);
    return `${prefix}${pad(seq + 1, width)}`;
}

async function ensureUniqueProformaNumber(conn, n, { width = 3, type = 'proforma_invoice', issueDate } = {}) {
    let value = n || await generateNextProformaNumber(conn, { width, type, issueDate });
    // Check if the provided number matches the expected prefix for the date
    const expectedPrefix = yearPrefixSegment(type, issueDate);

    // If we're auto-generating or if the user changed the date but kept an old number, 
    // we should probably enforce the new prefix, but here we just ensure uniqueness.

    for (let i = 0; i < 10; i++) {
        const [[dupe]] = await conn.query(
            "SELECT id FROM proforma_invoice WHERE proforma_invoice_no=? LIMIT 1",
            [value]
        );
        if (!dupe) return value;

        const m = value.match(/^(.*?)(\d+)$/);
        value = m ? `${m[1]}${pad((parseInt(m[2], 10) || 0) + 1, width)}`
            : await generateNextProformaNumber(conn, { width, type, issueDate });
    }
    return value;
}

// ---- GET /api/proforma/next-number (promise API) ----
router.get("/next-number", async (req, res) => {
    const { invoice_type = 'proforma_invoice', issue_date } = req.query;
    const conn = await db.promise().getConnection();
    try {
        const number = await generateNextProformaNumber(conn, { width: 3, type: invoice_type, issueDate: issue_date });
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
        status = ""
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

    if (status) {
        whereClauses.push(`pi.status_id = ?`);
        params.push(status);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    try {
        // Query for total count - The route is /api/proforma-invoices, but the table is proforma_invoice
        const countSql = `
            SELECT COUNT(pi.id) as total
            FROM proforma_invoice pi
            LEFT JOIN vendor c ON c.id = pi.buyer_id
            ${whereSql}
        `;
        const [[{ total }]] = await db.promise().query(countSql, params);

        // Query for data
        const dataSql = `
            SELECT
                pi.id,
                pi.uniqid,
                pi.date_issue,
                pi.proforma_invoice_no,
                c.display_name as customer_name,
                pi.contract_reference, 
                COALESCE(c.display_name, pi.buyer_address) as customer_display_name,
                pi.status_id as status,
                s.name as status_name,
                s.bg_colour,
                s.colour,
                pi.grand_total as total_amount,
                curr.name as currency_code
            FROM proforma_invoice pi
            LEFT JOIN vendor c ON c.id = pi.buyer_id
            LEFT JOIN currency curr ON curr.id = pi.currency_sale
            LEFT JOIN status s ON s.id = pi.status_id
            
            ${whereSql}
            ORDER BY ${sort_field} ${sort_order}
            LIMIT ? OFFSET ?
        `;
        const [rows] = await db.promise().query(dataSql, [...params, pp, offset]);

        res.json({ data: rows, totalRows: total });
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch proforma invoices", detail: e.message });
    }
});

/* ============================================================================
   POST /  (JSON or multipart with images[])
============================================================================ */
router.post("/", upload.array("attachments", 20), async (req, res) => {
    try {
        const payload = req.is("multipart/form-data")
            ? JSON.parse(req.body?.payload || "{}") // If multipart, payload is a stringified JSON
            : req.body || {}; // If not multipart, payload is direct JSON body
        const userId = req.session?.user?.id;

        const { header = {}, items = [], texts = {}, payment = {}, bank = {}, totals = {} } = payload;

        if (!header.proforma_invoice_no) return res.status(400).json({ error: "proforma_invoice_no is required" });
        if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "At least one item is required" });

        const result = await tx(async (conn) => {
            // Ensure the PI number is unique before inserting
            const finalPiNo = await ensureUniqueProformaNumber(conn, header.proforma_invoice_no, { type: header.invoice_type, issueDate: header.date_issue });
            const uniqid = crypto.randomUUID();

            // Prepare header data for insertion
            const headerData = [
                `INSERT INTO proforma_invoice (
           uniqid, invoice_type, expo_id, exporter, e_phone, e_fax, buyer_id, is_consignee_same_as_buyer, consignee_id, buyer_address, b_phone, b_fax, 
           consignee_name, consignee_address, c_phone, c_fax, port_loading, port_discharge,
           port_entry, country_destination, mode_of_transport, incoterms, terms_of_delivery, containerized, delivery_schedule,
           partial_shipment, transhipment, proforma_invoice_no, date_issue, date_expiry,
           contract_reference, contract_date, sub_total, vat_total, grand_total,
           currency_sale, exchange_rate, status_id, user_id,
           payment_terms_id, tenor, payment_description,
           bank_id,
           documents_provided, terms_conditions, other_terms, need_business_terms,
           buyer_reference
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                uniqid,
                v(header.invoice_type, 'proforma_invoice'),
                v(header.expo_id), v(header.exporter), v(header.e_phone), v(header.e_fax),
                v(header.buyer_id ?? header.buyer?.id),
                header.is_consignee_same_as_buyer ? 1 : 0,
                v(header.consignee_id),
                v(header.buyer_address, ""),
                v(header.b_phone ?? header.buyer?.bill_phone ?? header.buyer?.ship_phone ?? ""),
                v(header.b_fax ?? header.buyer?.bill_fax ?? header.buyer?.ship_fax ?? ""),

                // If is_consignee_same_as_buyer is true, use null for name, otherwise use provided name
                !header.is_consignee_same_as_buyer ? v(header.consignee_name) : 'Same as Buyer',
                // If is_consignee_same_as_buyer is true, use buyer's address, otherwise use consignee's address
                !header.is_consignee_same_as_buyer ? v(header.consignee_address, "") : 'Same as Buyer',
                // If is_consignee_same_as_buyer is true, use buyer's phone/fax
                !header.is_consignee_same_as_buyer ? v(header.c_phone, "") : null,
                !header.is_consignee_same_as_buyer ? v(header.c_fax, "") : null,
                v(header.port_loading), v(header.port_discharge),

                v(header.port_entry), v(header.country_destination),
                v(header.mode_of_transport), v(header.incoterms),
                v(header.terms_of_delivery), v(header.containerized), v(header.delivery_schedule),
                v(header.partial_shipment), v(header.transhipment),
                v(finalPiNo),
                d(header.date_issue),
                d(header.date_expiry),

                v(header.contract_reference, ""),
                d(header.contract_date),
                n(totals?.sub_total),
                n(totals?.vat_total),
                n(totals?.grand_total),
                v(header.currency_sale),
                v(header.exchange_rate),
                v(header.status_id, 'DRAFT'), // Default to 'DRAFT' if not provided
                v(header.user_id),

                v(payment?.payment_terms_id), v(payment?.tenor), v(payment?.description),
                v(bank?.bank_id),
                v(texts?.documents_provided), v(texts?.terms_conditions), v(texts?.other_terms),
                header.need_business_terms === false || header.need_business_terms === 0 || String(header.need_business_terms).toLowerCase() === 'no' ? 0 : 1,
                v(header.buyer_reference)
            ];
            const [hdr] = await conn.execute(headerData[0], headerData.slice(1));
            const proformaId = hdr.insertId;

            // items insert (bulk)
            if (items.length > 0) {
                const itemRows = items.map((it) => {
                    const productId = it.product_id ?? it.productId ?? null;
                    const productName = it.product_name ?? it.productName ?? "";
                    const description = it.description ?? "";
                    const hscode = it.hscode ?? it.hsn ?? "";
                    const quantity = it.quantity ?? it.qty ?? 0;
                    const uomIdRaw = it.uom_id ?? it.uom ?? null;
                    const uomName = it.uom_name ?? null;
                    const uomId = (uomIdRaw != null && String(uomIdRaw).trim() !== "" && !isNaN(Number(uomIdRaw))) ? Number(uomIdRaw) : null;
                    const unitPrice = it.unit_price ?? it.unitPrice ?? 0;
                    const vatId = it.vat_id ?? it.vatId ?? null;
                    const vatRate = it.vat_rate ?? it.vatRate ?? 0;
                    const origin = it.origin ?? "";
                    const packingId = it.packing_id ?? it.packingId ?? null;

                    return [
                        proformaId,
                        v(productId),
                        v(productName, ""),
                        v(description, ""),
                        v(hscode, ""),
                        n(quantity, 0),
                        uomId,
                        v(uomName),
                        n(unitPrice, 0),
                        v(vatId),
                        n(vatRate, 0),
                        v(origin, ""),
                        v(packingId)
                    ];
                });

                await conn.query(
                    `INSERT INTO proforma_invoice_items
               (proforma_invoice_id, product_id, product_name, description, hscode, quantity, uom_id, uom_name, unit_price, vat_id, vat_rate, origin, packing_id)
             VALUES ?`, // Added uom_name
                    [itemRows]
                );
            }

            // attachments (if any)
            if (req.files?.length) {
                const attRows = req.files.map((f) => [
                    proformaId,
                    f.originalname,
                    path.relative(path.resolve(), f.path).replace(/\\/g, "/"),
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

            // Add history
            await addHistory(conn, {
                module: 'proforma_invoice',
                moduleId: proformaId,
                userId: userId,
                action: 'CREATED',
                details: { proforma_invoice_no: finalPiNo }
            });
            return { proformaId, uniqid, proforma_invoice_no: finalPiNo };
        });

        res.status(201).json({
            success: true,
            proforma_invoice_id: result.proformaId,
            uniqid: result.uniqid,
            proforma_invoice_no: result.proforma_invoice_no,
            message: "Proforma created",
        });
    } catch (e) {
        // Enhanced error logging
        console.error("--- PROFORMA CREATE FAILED ---");
        console.error(e);
        console.error("------------------------------");
        res.status(500).json({
            error: "Failed to create proforma",
            detail: e.message,
            // Provide more specific SQL error details if available
            code: e.code,
            sqlMessage: e.sqlMessage,
        });
    }
});

/* ============================================================================
   PUT /:id  (replace items; add attachments)
============================================================================ */
router.put("/:id", upload.array("attachments", 20), async (req, res) => {
    const { id } = req.params; // id is actually the uniqid
    try {
        const userId = req.session?.user?.id;
        const payload = req.is("multipart/form-data")
            ? JSON.parse(req.body?.payload || "{}")
            : req.body || {};

        const { header = {}, items = [], texts = {}, payment = {}, bank = {}, totals = {} } = payload;
        const deletedAttachmentIds = JSON.parse(req.body.deletedAttachmentIds || "[]");

        if (!header.proforma_invoice_no) return res.status(400).json({ error: "proforma_invoice_no is required" });

        await tx(async (conn) => {
            // --- History Logging: Fetch old state before update ---
            const [[oldHeader]] = await conn.query("SELECT * FROM proforma_invoice WHERE uniqid=? LIMIT 1", [id]);
            if (!oldHeader) throw new Error("Proforma not found");

            // Resolve numeric id from uniqid first
            const [[existing]] = await conn.query("SELECT id, proforma_invoice_no FROM proforma_invoice WHERE uniqid=? LIMIT 1", [id]);
            if (!existing) throw new Error("Proforma not found");

            const proformaId = existing.id;

            // --- Server-side prefix adjustment based on invoice_type ---
            let finalPiNo = header.proforma_invoice_no;
            if (header.invoice_type === 'sales_order' && finalPiNo.startsWith('AGPI-')) {
                finalPiNo = finalPiNo.replace('AGPI-', 'AGSO-');
            } else if (header.invoice_type === 'proforma_invoice' && finalPiNo.startsWith('AGSO-')) {
                finalPiNo = finalPiNo.replace('AGSO-', 'AGPI-');
            }
            // --- End of prefix adjustment ---


            // Ensure the provided number doesn't clash with another existing record.
            const [[dupe]] = await conn.query(
                "SELECT id FROM proforma_invoice WHERE proforma_invoice_no=? AND id != ? LIMIT 1",
                [finalPiNo, proformaId]
            );
            if (dupe) throw new Error(`Proforma Invoice number ${finalPiNo} is already in use by another document.`);

            // Prepare header update data (use numeric id in WHERE)
            const headerUpdateData = [
                `UPDATE proforma_invoice SET 
           invoice_type=?, expo_id=?, exporter=?, e_phone=?, e_fax=?, is_consignee_same_as_buyer=?, consignee_id=?,
           buyer_id=?, buyer_address=?, b_phone=?, b_fax=?, 
           consignee_name=?, consignee_address=?, c_phone=?, c_fax=?,
           port_loading=?, port_discharge=?, port_entry=?, country_destination=?, mode_of_transport=?, incoterms=?, partial_shipment=?, transhipment=?,
           proforma_invoice_no=?, date_issue=?, date_expiry=?, sub_total=?, vat_total=?, grand_total=?,
           contract_reference=?, contract_date=?,
           currency_sale=?, exchange_rate=?, status_id=?, user_id=?,
           payment_terms_id=?, tenor=?, payment_description=?,
           bank_id=?,
           documents_provided=?, terms_conditions=?, other_terms=?, need_business_terms=?,
           terms_of_delivery=?, containerized=?, delivery_schedule=?,
           buyer_reference=?
         WHERE id=?`,
                v(header.invoice_type, 'proforma_invoice'),
                v(header.expo_id), v(header.exporter), v(header.e_phone), v(header.e_fax),
                header.is_consignee_same_as_buyer ? 1 : 0,
                v(header.consignee_id),
                v(header.buyer_id ?? header.buyer?.id),
                v(header.buyer_address, ""),
                v(header.b_phone ?? header.buyer?.bill_phone ?? header.buyer?.ship_phone ?? ""),
                v(header.b_fax ?? header.buyer?.bill_fax ?? header.buyer?.ship_fax ?? ""),
                // If is_consignee_same_as_buyer is true, use null for name, otherwise use provided name
                !header.is_consignee_same_as_buyer ? v(header.consignee_name) : 'Same as Buyer',
                // If is_consignee_same_as_buyer is true, use buyer's address, otherwise use consignee's address
                !header.is_consignee_same_as_buyer ? v(header.consignee_address, "") : 'Same as Buyer',
                // If is_consignee_same_as_buyer is true, use buyer's phone/fax
                !header.is_consignee_same_as_buyer ? v(header.c_phone, "") : null,
                !header.is_consignee_same_as_buyer ? v(header.c_fax, "") : null,
                v(header.port_loading), v(header.port_discharge), v(header.port_entry), v(header.country_destination),
                v(header.mode_of_transport), v(header.incoterms), v(header.partial_shipment), v(header.transhipment),
                v(finalPiNo), d(header.date_issue), d(header.date_expiry), n(totals?.sub_total), n(totals?.vat_total), n(totals?.grand_total),
                v(header.contract_reference, ""), d(header.contract_date),
                v(header.currency_sale), v(header.exchange_rate), v(header.status_id, 'DRAFT'), v(header.user_id),
                v(payment?.payment_terms_id), v(payment?.tenor), v(payment?.description),
                v(bank?.bank_id),
                v(texts?.documents_provided), v(texts?.terms_conditions), v(texts?.other_terms),
                header.need_business_terms === false || header.need_business_terms === 0 || String(header.need_business_terms).toLowerCase() === 'no' ? 0 : 1,
                v(header.terms_of_delivery),
                v(header.containerized),
                v(header.delivery_schedule),
                v(header.buyer_reference),
                proformaId,
            ];
            await conn.execute(headerUpdateData[0], headerUpdateData.slice(1));

            // replace items (delete by numeric proforma id)
            await conn.execute("DELETE FROM proforma_invoice_items WHERE proforma_invoice_id=?", [proformaId]);

            if (items.length) {
                const itemRows = items.map((it) => {
                    const productId = it.product_id ?? it.productId ?? null;
                    const productName = it.product_name ?? it.productName ?? "";
                    const description = it.description ?? "";
                    const hscode = it.hscode ?? it.hsn ?? "";
                    const quantity = it.quantity ?? it.qty ?? 0;
                    const uomIdRaw = it.uom_id ?? it.uom ?? null;
                    const uomName = it.uom_name ?? null;
                    const uomId = (uomIdRaw != null && String(uomIdRaw).trim() !== "" && !isNaN(Number(uomIdRaw))) ? Number(uomIdRaw) : null;
                    const unitPrice = it.unit_price ?? it.unitPrice ?? 0;
                    const vatId = it.vat_id ?? it.vatId ?? null;
                    const vatRate = it.vat_rate ?? it.vatRate ?? 0;
                    const origin = it.origin ?? "";
                    const packingId = it.packing_id ?? it.packingId ?? null;

                    return [
                        proformaId,
                        v(productId),
                        v(productName, ""),
                        v(description, ""),
                        v(hscode, ""),
                        n(quantity, 0),
                        uomId,
                        v(uomName),
                        n(unitPrice, 0),
                        v(vatId),
                        n(vatRate, 0),
                        v(origin, ""),
                        v(packingId)
                    ];
                });
                await conn.query(
                    `INSERT INTO proforma_invoice_items
             (proforma_invoice_id, product_id, product_name, description, hscode, quantity, uom_id, uom_name, unit_price, vat_id, vat_rate, origin, packing_id)
           VALUES ?`, // Added uom_name
                    [itemRows]
                );
            }

            // --- Handle attachment deletions ---
            if (Array.isArray(deletedAttachmentIds) && deletedAttachmentIds.length > 0) {
                const [filesToDelete] = await conn.query(
                    `SELECT id, file_path FROM proforma_invoice_attachments WHERE id IN (?) AND proforma_invoice_id = ?`,
                    [deletedAttachmentIds, proformaId]
                );

                for (const file of filesToDelete) {
                    // Delete from filesystem
                    if (file.file_path) {
                        const fullPath = path.resolve(file.file_path);
                        await fs.promises.unlink(fullPath).catch(e => console.warn(`Failed to delete file from disk: ${fullPath}`, e));
                    }
                }

                // Delete from database
                await conn.query(`DELETE FROM proforma_invoice_attachments WHERE id IN (?)`, [deletedAttachmentIds]);
            }

            // add new attachments (use numeric proforma id)
            if (req.files?.length) {
                const attRows = req.files.map((f) => [
                    proformaId,
                    f.originalname,
                    path.relative(path.resolve(), f.path).replace(/\\/g, "/"),
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

            // --- Log changes for history ---
            const changes = [];
            if (oldHeader.proforma_invoice_no !== finalPiNo) {
                changes.push({ field: 'proforma_invoice_no', from: oldHeader.proforma_invoice_no, to: finalPiNo });
            }
            // Add more field comparisons here if needed...

            if (changes.length > 0) {
                await addHistory(conn, {
                    module: 'proforma_invoice',
                    moduleId: proformaId,
                    userId: userId,
                    action: 'UPDATED',
                    details: { changes }
                });
            }
        });

        res.json({ success: true, message: "Proforma updated" });
    } catch (e) {
        // Enhanced error logging
        console.error("--- PROFORMA UPDATE FAILED ---");
        console.error(e);
        console.error("------------------------------");
        res.status(500).json({
            error: "Failed to update proforma",
            detail: e.message,
            // Provide more specific SQL error details if available
            code: e.code,
            sqlMessage: e.sqlMessage,
        });
    }
});
/* ============================================================================
   GET /:id
============================================================================ */
router.get("/:id", async (req, res) => {
    const { id } = req.params;
    try {
        const [[header]] = await db.promise().query(`
            SELECT 
                pi.*,
                p_load.name as port_loading_name,
                p_discharge.name as port_discharge_name,
                p_entry.name as port_entry_name,
                c_dest.name as country_destination_name,
                mot.name as mode_of_transport_name,
                inc.name as incoterms_name,
                ps.name as partial_shipment_name,
                ts.name as transhipment_name,
                pt.terms as payment_terms_name,
                c.display_name as buyer_name,
                c.uniqid as buyer_uniqid,
                consignee_details.display_name as consignee_name_from_db,
                consignee_details.uniqid as consignee_uniqid,
                b.bank_name,
                b.acc_name as account_name,
                b.acc_no as account_number,
                b.iban_no as iban,
                b.swift_code as swift,                
                s.name as status_name,
                s.bg_colour,
                s.colour,
                pi.exporter,
                pi.e_phone,
                pi.e_fax,
                curr.currency_fullname as currency_name,
                curr.name as currency_name,
                curr.label as currency_label
            FROM proforma_invoice pi
            LEFT JOIN delivery_place p_load ON p_load.id = pi.port_loading
            LEFT JOIN delivery_place p_discharge ON p_discharge.id = pi.port_discharge
            LEFT JOIN delivery_place p_entry ON p_entry.id = pi.port_entry
            LEFT JOIN country c_dest ON c_dest.id = pi.country_destination
            LEFT JOIN payment_terms pt ON pt.id = pi.payment_terms_id
            LEFT JOIN vendor c ON c.id = pi.buyer_id
            LEFT JOIN vendor consignee_details ON consignee_details.id = pi.consignee_id
            LEFT JOIN mode_of_shipment mot ON mot.id = pi.mode_of_transport
            LEFT JOIN inco_terms inc ON inc.id = pi.incoterms
            LEFT JOIN partial_shipment ps ON ps.id = pi.partial_shipment
            LEFT JOIN partial_shipment ts ON ts.id = pi.transhipment
            LEFT JOIN acc_bank_details b ON b.id = pi.bank_id
            LEFT JOIN status s ON s.id = pi.status_id
            LEFT JOIN currency curr ON curr.id = pi.currency_sale
            WHERE pi.uniqid=?
        `, [id]);

        if (!header) return res.status(404).json({ error: "Not found" });

        const [items] = await db.promise().query(
            `SELECT 
                pii.*,
                um.name as uom_name, 
                um.acronyms as uom_code,
                t.tax_name as tax_name,
                t.rate as tax_rate,
                (SELECT file_path 
                 FROM product_images 
                 WHERE product_id = pii.product_id 
                 ORDER BY is_primary DESC, id ASC 
                 LIMIT 1) as product_image
             FROM proforma_invoice_items pii
             LEFT JOIN uom_master um ON um.id = pii.uom_id
             LEFT JOIN taxes t ON t.id = pii.vat_id
             WHERE pii.proforma_invoice_id = ? 
             ORDER BY pii.id`,
            [header.id]
        );
        const [attachments] = await db.promise().query(
            "SELECT * FROM proforma_invoice_attachments WHERE proforma_invoice_id=? ORDER BY id",
            [header.id]
        );

        const [[docTemplate]] = await db.promise().query(
            "SELECT sign_path, stamp_path FROM document_templates WHERE document_id = 13 AND FIND_IN_SET(?, company_ids)",
            [header.expo_id]
        );
        res.json({ header, items, attachments, docTemplate: docTemplate || null });
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch proforma", detail: e.message });
    }
});

/* ============================================================================
   PUT /:uniqid/status
============================================================================ */
router.put("/:id/status", async (req, res) => {
    const { id } = req.params; // uniqid
    const { status_id } = req.body;
    const userId = req.session?.user?.id;

    if (!status_id) {
        return res.status(400).json(errPayload("status_id is required."));
    }

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        const [[pi]] = await conn.query("SELECT id, status_id as old_status_id FROM proforma_invoice WHERE uniqid = ?", [id]);
        if (!pi) {
            throw new Error("Proforma Invoice not found.");
        }

        // Update the status
        await conn.query("UPDATE proforma_invoice SET status_id = ? WHERE id = ?", [status_id, pi.id]);

        // Add history record
        const [[oldStatus]] = await conn.query("SELECT name FROM status WHERE id = ?", [pi.old_status_id]);
        const [[newStatus]] = await conn.query("SELECT name FROM status WHERE id = ?", [status_id]);
        await addHistory(conn, { module: 'proforma_invoice', moduleId: pi.id, userId, action: 'STATUS_CHANGED', details: { from: oldStatus?.name || pi.old_status_id, to: newStatus?.name || status_id } });

        await conn.commit();
        res.json({ success: true, message: "Status updated successfully." });
    } catch (error) {
        await conn.rollback();
        res.status(500).json(errPayload(error.message || "Failed to update status."));
    } finally {
        conn.release();
    }
});

/* ============================================================================
   GET /:id/history
============================================================================ */
router.get("/:id/history", async (req, res) => {
    const { id } = req.params; // uniqid
    try {
        const [[pi]] = await db.promise().query("SELECT id FROM proforma_invoice WHERE uniqid=?", [id]);
        if (!pi) return res.status(404).json({ error: "Not found" });

        const [history] = await db.promise().query(`
            SELECT h.id, h.action, h.details, h.created_at, u.name as user_name
            FROM history h
            LEFT JOIN user u ON u.id = h.user_id
            WHERE h.module = 'proforma_invoice' AND h.module_id = ?
            ORDER BY h.created_at DESC`, [pi.id]);
        const normalizeDetails = (val) => {
            if (!val) return {};
            if (typeof val === "string") {
                try { return JSON.parse(val); } catch { return {}; }
            }
            if (typeof val === "object") return val;
            return {};
        };
        res.json((history || []).map(h => ({ ...h, details: normalizeDetails(h.details) })));
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch history", detail: e.message });
    }
});

export default router;
