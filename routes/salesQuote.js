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
const UPLOAD_DIR = path.join(__dirname, "..", "uploads", "sales-quotes");
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
        try { await conn.rollback(); } catch {}
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
   Number helpers (AGSQ-YY-MM###)
============================================================================ */
function pad(n, w = 3) {
    const s = String(n);
    return s.length >= w ? s : "0".repeat(w - s.length) + s;
}
function currentYearPrefix() {
    const yy = String(new Date().getFullYear()).slice(-2);
    return `AGSQ-${yy}-`;
}
function currentMonthSegment() {
    return String(new Date().getMonth() + 1).padStart(2, "0");
}
async function getMaxSequenceForYear(conn, yearPrefix) {
    const [rows] = await conn.query(
        `SELECT proforma_invoice_no AS no
       FROM sales_quote
      WHERE proforma_invoice_no LIKE ?
      ORDER BY proforma_invoice_no DESC
      LIMIT 1`,
        [`${yearPrefix}%`]
    );
    const top = rows?.[0]?.no || null;
    if (!top) return 0;
    // Remove suffix (-L, -U, -T) if present before extracting sequence
    const withoutSuffix = top.replace(/[-][LUT]$/, '');
    const m = withoutSuffix.match(/(\d{3})$/);
    return m ? Number(m[1]) : 0;
}
async function generateNextQuoteNumber(conn, { width = 3 } = {}) {
    const prefix = currentYearPrefix();
    const mm = currentMonthSegment();
    const seq = await getMaxSequenceForYear(conn, prefix);
    return `${prefix}${mm}${pad(seq + 1, width)}`;
}
async function ensureUniqueQuoteNumber(conn, n, { width = 3 } = {}) {
    let value = n || await generateNextQuoteNumber(conn, { width });
    // Extract suffix if present (-L, -U, -T)
    const suffixMatch = value.match(/[-]([LUT])$/);
    const suffix = suffixMatch ? `-${suffixMatch[1]}` : '';
    const baseValue = suffix ? value.replace(/[-][LUT]$/, '') : value;
    
    for (let i = 0; i < 8; i++) {
        const [[dupe]] = await conn.query(
            "SELECT id FROM sales_quote WHERE proforma_invoice_no=? LIMIT 1",
            [value]
        );
        if (!dupe) return value;
        // Increment the sequence number while preserving suffix
        const m = baseValue.match(/^(.*?)(\d{3})$/);
        if (m) {
            const incremented = `${m[1]}${pad((parseInt(m[2], 10) || 0) + 1, width)}${suffix}`;
            value = incremented;
        } else {
            // If pattern doesn't match, generate new number and add suffix back
            const newBase = await generateNextQuoteNumber(conn, { width });
            value = suffix ? `${newBase}${suffix}` : newBase;
        }
    }
    const prefix = currentYearPrefix();
    const mm = currentMonthSegment();
    const fallback = `${prefix}${mm}${pad(Math.floor(Math.random() * 999), width)}`;
    return suffix ? `${fallback}${suffix}` : fallback;
}

/* ============================================================================
   GET /api/sales-quotes/next-number
============================================================================ */
router.get("/next-number", async (_req, res) => {
    const conn = await db.promise().getConnection();
    try {
        const number = await generateNextQuoteNumber(conn, { width: 3 });
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
   GET /api/sales-quotes (list with search/pagination)
============================================================================ */
router.get("/", async (req, res) => {
    const {
        page = 1,
        per_page = 10,
        search = "",
        sort_field = "sq.date_issue",
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
            sq.proforma_invoice_no LIKE ? OR
            sq.buyer_address LIKE ? OR
            sq.contract_reference LIKE ? OR
            c.display_name LIKE ?
        )`);
        params.push(s, s, s, s);
    }

    if (status) {
        whereClauses.push(`sq.status_id = ?`);
        params.push(status);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    try {
        const countSql = `
            SELECT COUNT(sq.id) as total
            FROM sales_quote sq
            LEFT JOIN vendor c ON c.id = sq.buyer_id
            ${whereSql}
        `;
        const [[{ total }]] = await db.promise().query(countSql, params);

        const dataSql = `
            SELECT
                sq.id,
                sq.uniqid,
                sq.date_issue,
                sq.proforma_invoice_no,
                c.display_name as customer_name,
                sq.contract_reference,
                COALESCE(c.display_name, sq.buyer_address) as customer_display_name,
                sq.status_id as status,
                s.name as status_name,
                s.bg_colour,
                s.colour,
                sq.grand_total as total_amount,
                curr.name as currency_code
            FROM sales_quote sq
            LEFT JOIN vendor c ON c.id = sq.buyer_id
            LEFT JOIN currency curr ON curr.id = sq.currency_sale
            LEFT JOIN status s ON s.id = sq.status_id
            ${whereSql}
            ORDER BY ${sort_field} ${sort_order}
            LIMIT ? OFFSET ?
        `;
        const [rows] = await db.promise().query(dataSql, [...params, pp, offset]);

        res.json({ data: rows, totalRows: total });
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch sales quotes", detail: e.message });
    }
});

/* ============================================================================
   POST /api/sales-quotes  (JSON or multipart)
============================================================================ */
router.post("/", upload.array("attachments", 20), async (req, res) => {
    try {
        const payload = req.is("multipart/form-data")
            ? JSON.parse(req.body?.payload || "{}")
            : req.body || {};
        const userId = req.session?.user?.id;

        const { header = {}, items = [], texts = {}, payment = {}, bank = {}, totals = {} } = payload;

        if (!header.proforma_invoice_no) return res.status(400).json({ error: "sales_quote_no is required" });
        if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "At least one item is required" });

        const result = await tx(async (conn) => {
            const finalNo = await ensureUniqueQuoteNumber(conn, header.proforma_invoice_no);
            const uniqid = crypto.randomUUID();

            const headerSql = `INSERT INTO sales_quote SET
                uniqid=?,
                invoice_type=?,
                expo_id=?,
                exporter=?,
                e_phone=?,
                e_fax=?,
                buyer_id=?,
                is_consignee_same_as_buyer=?,
                consignee_id=?,
                buyer_address=?,
                b_phone=?,
                b_fax=?,
                consignee_name=?,
                consignee_address=?,
                c_phone=?,
                c_fax=?,
                port_loading=?,
                port_discharge=?,
                port_entry=?,
                country_destination=?,
                mode_of_transport=?,
                incoterms=?,
                delivery_schedule=?,
                partial_shipment=?,
                transhipment=?,
                proforma_invoice_no=?,
                date_issue=?,
                date_expiry=?,
                contract_reference=?,
                contract_date=?,
                sub_total=?,
                vat_total=?,
                grand_total=?,
                currency_sale=?,
                exchange_rate=?,
                status_id=?,
                user_id=?,
                payment_terms_id=?,
                tenor=?,
                payment_description=?,
                bank_id=?,
                documents_provided=?,
                terms_conditions=?,
                other_terms=?,
                buyer_reference=?,
                manager_id=?,
                approved_at=?,
                rejection_reason=?,
                sent_at=?,
                customer_decision=?,
                customer_decision_reason=?,
                customer_decision_at=?,
                lost_reason=?,
                closed_at=?`;
            const headerValues = [
                uniqid,
                'sales_quote',
                v(header.expo_id),
                v(header.exporter),
                v(header.e_phone),
                v(header.e_fax),
                v(header.buyer_id ?? header.buyer?.id),
                header.is_consignee_same_as_buyer ? 1 : 0,
                v(header.consignee_id),
                v(header.buyer_address, ""),
                v(header.b_phone ?? header.buyer?.bill_phone ?? header.buyer?.ship_phone ?? ""),
                v(header.b_fax ?? header.buyer?.bill_fax ?? header.buyer?.ship_fax ?? ""),
                !header.is_consignee_same_as_buyer ? v(header.consignee_name) : 'Same as Buyer',
                !header.is_consignee_same_as_buyer ? v(header.consignee_address, "") : 'Same as Buyer',
                !header.is_consignee_same_as_buyer ? v(header.c_phone, "") : null,
                !header.is_consignee_same_as_buyer ? v(header.c_fax, "") : null,
                v(header.port_loading),
                v(header.port_discharge),
                v(header.port_entry),
                v(header.country_destination),
                v(header.mode_of_transport),
                v(header.incoterms),
                v(header.delivery_schedule),
                v(header.partial_shipment),
                v(header.transhipment),
                v(finalNo),
                d(header.date_issue),
                d(header.date_expiry),
                v(header.contract_reference, ""),
                d(header.contract_date),
                n(totals?.sub_total),
                n(totals?.vat_total),
                n(totals?.grand_total),
                v(header.currency_sale),
                v(header.exchange_rate),
                v(header.status_id, 'SQ_DRAFT'),
                v(header.user_id ?? userId),
                v(payment?.payment_terms_id),
                v(payment?.tenor),
                v(payment?.description),
                v(bank?.bank_id),
                v(texts?.documents_provided),
                v(texts?.terms_conditions),
                v(texts?.other_terms),
                v(header.buyer_reference),
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null
            ];
            const [hdr] = await conn.execute(headerSql, headerValues);
            const quoteId = hdr.insertId;

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
                        quoteId,
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
                    `INSERT INTO sales_quote_items
               (sales_quote_id, product_id, product_name, description, hscode, quantity, uom_id, uom_name, unit_price, vat_id, vat_rate, origin, packing_id)
             VALUES ?`,
                    [itemRows]
                );
            }

            if (req.files?.length) {
                const attRows = req.files.map((f) => [
                    quoteId,
                    f.originalname,
                    path.relative(path.resolve(), f.path).replace(/\\/g, "/"),
                    f.mimetype.startsWith('image/') ? 'image' : 'document',
                    f.mimetype,
                    f.size,
                    new Date(),
                ]);
                await conn.query(
                    `INSERT INTO sales_quote_attachments
             (sales_quote_id, file_name, file_path, category, mime_type, size_bytes, created_at)
           VALUES ?`,
                    [attRows]
                );
            }

            await addHistory(conn, {
                module: 'sales_quote',
                moduleId: quoteId,
                userId: userId,
                action: 'CREATED',
                details: { sales_quote_no: finalNo }
            });
            return { quoteId, uniqid, sales_quote_no: finalNo };
        });

        res.status(201).json({
            success: true,
            sales_quote_id: result.quoteId,
            uniqid: result.uniqid,
            sales_quote_no: result.sales_quote_no,
            message: "Sales quote created",
        });
    } catch (e) {
        console.error("--- SALES QUOTE CREATE FAILED ---");
        console.error(e);
        console.error("------------------------------");
        res.status(500).json({
            error: "Failed to create sales quote",
            detail: e.message,
            code: e.code,
            sqlMessage: e.sqlMessage,
        });
    }
});

/* ============================================================================
   PUT /api/sales-quotes/:id
============================================================================ */
router.put("/:id", upload.array("attachments", 20), async (req, res) => {
    const { id } = req.params;
    try {
        const userId = req.session?.user?.id;
        const payload = req.is("multipart/form-data")
            ? JSON.parse(req.body?.payload || "{}")
            : req.body || {};

        const { header = {}, items = [], texts = {}, payment = {}, bank = {}, totals = {} } = payload;
        const deletedAttachmentIds = JSON.parse(req.body?.deletedAttachmentIds || "[]");

        if (!header.proforma_invoice_no) return res.status(400).json({ error: "sales_quote_no is required" });

        await tx(async (conn) => {
            const [[oldHeader]] = await conn.query("SELECT * FROM sales_quote WHERE uniqid=? LIMIT 1", [id]);
            if (!oldHeader) throw new Error("Sales quote not found");

            const [[existing]] = await conn.query("SELECT id, proforma_invoice_no FROM sales_quote WHERE uniqid=? LIMIT 1", [id]);
            if (!existing) throw new Error("Sales quote not found");

            const quoteId = existing.id;

            const [[dupe]] = await conn.query(
                "SELECT id FROM sales_quote WHERE proforma_invoice_no=? AND id != ? LIMIT 1",
                [header.proforma_invoice_no, quoteId]
            );
            if (dupe) throw new Error(`Sales quote number ${header.proforma_invoice_no} is already in use by another document.`);

            const updateSql = `UPDATE sales_quote SET
                invoice_type=?,
                expo_id=?,
                exporter=?,
                e_phone=?,
                e_fax=?,
                is_consignee_same_as_buyer=?,
                consignee_id=?,
                buyer_id=?,
                buyer_address=?,
                b_phone=?,
                b_fax=?,
                consignee_name=?,
                consignee_address=?,
                c_phone=?,
                c_fax=?,
                port_loading=?,
                port_discharge=?,
                port_entry=?,
                country_destination=?,
                mode_of_transport=?,
                incoterms=?,
                partial_shipment=?,
                transhipment=?,
                proforma_invoice_no=?,
                date_issue=?,
                date_expiry=?,
                sub_total=?,
                vat_total=?,
                grand_total=?,
                contract_reference=?,
                contract_date=?,
                currency_sale=?,
                exchange_rate=?,
                status_id=?,
                user_id=?,
                payment_terms_id=?,
                tenor=?,
                payment_description=?,
                bank_id=?,
                documents_provided=?,
                terms_conditions=?,
                other_terms=?,
                delivery_schedule=?,
                buyer_reference=?
            WHERE id=?`;
            const updateValues = [
                'sales_quote',
                v(header.expo_id),
                v(header.exporter),
                v(header.e_phone),
                v(header.e_fax),
                header.is_consignee_same_as_buyer ? 1 : 0,
                v(header.consignee_id),
                v(header.buyer_id ?? header.buyer?.id),
                v(header.buyer_address, ""),
                v(header.b_phone ?? header.buyer?.bill_phone ?? header.buyer?.ship_phone ?? ""),
                v(header.b_fax ?? header.buyer?.bill_fax ?? header.buyer?.ship_fax ?? ""),
                !header.is_consignee_same_as_buyer ? v(header.consignee_name) : 'Same as Buyer',
                !header.is_consignee_same_as_buyer ? v(header.consignee_address, "") : 'Same as Buyer',
                !header.is_consignee_same_as_buyer ? v(header.c_phone, "") : null,
                !header.is_consignee_same_as_buyer ? v(header.c_fax, "") : null,
                v(header.port_loading),
                v(header.port_discharge),
                v(header.port_entry),
                v(header.country_destination),
                v(header.mode_of_transport),
                v(header.incoterms),
                v(header.partial_shipment),
                v(header.transhipment),
                v(header.proforma_invoice_no),
                d(header.date_issue),
                d(header.date_expiry),
                n(totals?.sub_total),
                n(totals?.vat_total),
                n(totals?.grand_total),
                v(header.contract_reference, ""),
                d(header.contract_date),
                v(header.currency_sale),
                v(header.exchange_rate),
                v(header.status_id, oldHeader.status_id ?? 'SQ_DRAFT'),
                v(header.user_id ?? userId),
                v(payment?.payment_terms_id),
                v(payment?.tenor),
                v(payment?.description),
                v(bank?.bank_id),
                v(texts?.documents_provided),
                v(texts?.terms_conditions),
                v(texts?.other_terms),
                v(header.delivery_schedule),
                v(header.buyer_reference),
                quoteId
            ];
            await conn.execute(updateSql, updateValues);

            await conn.execute("DELETE FROM sales_quote_items WHERE sales_quote_id=?", [quoteId]);

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
                        quoteId,
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
                    `INSERT INTO sales_quote_items
             (sales_quote_id, product_id, product_name, description, hscode, quantity, uom_id, uom_name, unit_price, vat_id, vat_rate, origin, packing_id)
           VALUES ?`,
                    [itemRows]
                );
            }

            if (Array.isArray(deletedAttachmentIds) && deletedAttachmentIds.length > 0) {
                const [filesToDelete] = await conn.query(
                    `SELECT id, file_path FROM sales_quote_attachments WHERE id IN (?) AND sales_quote_id = ?`,
                    [deletedAttachmentIds, quoteId]
                );

                for (const file of filesToDelete) {
                    if (file.file_path) {
                        const fullPath = path.resolve(file.file_path);
                        await fs.promises.unlink(fullPath).catch(e => console.warn(`Failed to delete file from disk: ${fullPath}`, e));
                    }
                }

                await conn.query(`DELETE FROM sales_quote_attachments WHERE id IN (?)`, [deletedAttachmentIds]);
            }

            if (req.files?.length) {
                const attRows = req.files.map((f) => [
                    quoteId,
                    f.originalname,
                    path.relative(path.resolve(), f.path).replace(/\\/g, "/"),
                    f.mimetype.startsWith('image/') ? 'image' : 'document',
                    f.mimetype,
                    f.size,
                    new Date(),
                ]);
                await conn.query(
                    `INSERT INTO sales_quote_attachments
             (sales_quote_id, file_name, file_path, category, mime_type, size_bytes, created_at)
           VALUES ?`,
                    [attRows]
                );
            }

            await addHistory(conn, {
                module: 'sales_quote',
                moduleId: quoteId,
                userId: userId,
                action: 'UPDATED',
                details: { from: oldHeader.proforma_invoice_no, to: header.proforma_invoice_no }
            });
        });

        res.json({ success: true, message: "Sales quote updated" });
    } catch (e) {
        console.error("--- SALES QUOTE UPDATE FAILED ---");
        console.error(e);
        console.error("------------------------------");
        res.status(500).json({
            error: "Failed to update sales quote",
            detail: e.message,
            code: e.code,
            sqlMessage: e.sqlMessage,
        });
    }
});

/* ============================================================================
   GET /api/sales-quotes/:id
============================================================================ */
router.get("/:id", async (req, res) => {
    const { id } = req.params;
    try {
        const [[header]] = await db.promise().query(`
            SELECT 
                sq.*,
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
                curr.currency_fullname as currency_name,
                curr.name as currency_code,
                curr.label as currency_label
            FROM sales_quote sq
            LEFT JOIN delivery_place p_load ON p_load.id = sq.port_loading
            LEFT JOIN delivery_place p_discharge ON p_discharge.id = sq.port_discharge
            LEFT JOIN delivery_place p_entry ON p_entry.id = sq.port_entry
            LEFT JOIN country c_dest ON c_dest.id = sq.country_destination
            LEFT JOIN payment_terms pt ON pt.id = sq.payment_terms_id
            LEFT JOIN vendor c ON c.id = sq.buyer_id
            LEFT JOIN vendor consignee_details ON consignee_details.id = sq.consignee_id
            LEFT JOIN mode_of_shipment mot ON mot.id = sq.mode_of_transport
            LEFT JOIN inco_terms inc ON inc.id = sq.incoterms
            LEFT JOIN partial_shipment ps ON ps.id = sq.partial_shipment
            LEFT JOIN partial_shipment ts ON ts.id = sq.transhipment
            LEFT JOIN acc_bank_details b ON b.id = sq.bank_id
            LEFT JOIN status s ON s.id = sq.status_id
            LEFT JOIN currency curr ON curr.id = sq.currency_sale
            WHERE sq.uniqid=?
        `, [id]);

        if (!header) return res.status(404).json({ error: "Not found" });

        const [items] = await db.promise().query(
            `SELECT 
                it.id,
                it.product_id,
                it.product_name,
                it.description,
                it.hscode,
                it.quantity,
                it.uom_id,
                it.uom_name,
                it.unit_price,
                it.vat_id,
                it.vat_rate,
                it.origin,
                it.packing_id
            FROM sales_quote_items it
            WHERE it.sales_quote_id = ?
        `, [header.id]);

        const [attachments] = await db.promise().query(
            `SELECT 
                att.id,
                att.file_name,
                att.file_path,
                att.category,
                att.mime_type,
                att.size_bytes,
                att.created_at
            FROM sales_quote_attachments att
            WHERE att.sales_quote_id = ?
        `, [header.id]);

        res.json({ header, items, attachments });
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch sales quote", detail: e.message });
    }
});

/* ============================================================================
   POST /api/sales-quotes/:id/actions
============================================================================ */
router.post("/:id/actions", async (req, res) => {
    const { id } = req.params;
    const { action, reason = null } = req.body || {};
    const userId = req.session?.user?.id;

    if (!action) return res.status(400).json({ error: "Action is required" });

    try {
        const result = await tx(async (conn) => {
            const [[quote]] = await conn.query("SELECT id, status_id FROM sales_quote WHERE uniqid=? LIMIT 1", [id]);
            if (!quote) throw new Error("Sales quote not found");

            const updates = [];
            let newStatus = quote.status_id;
            const details = { from: quote.status_id };

            const now = new Date();

            const setStatus = (status) => {
                newStatus = status;
                updates.push(["status_id", status]);
            };

            const pushUpdate = (field, value) => updates.push([field, value]);

            switch (action) {
                case "submit": {
                    if (!["SQ_DRAFT"].includes(quote.status_id)) throw new Error("Only draft quotes can be submitted");
                    setStatus("SQ_PENDING_MANAGER_APPROVAL");
                    details.action = "SUBMITTED";
                    break;
                }
                case "approve": {
                    if (!["SQ_PENDING_MANAGER_APPROVAL"].includes(quote.status_id)) throw new Error("Quote is not pending approval");
                    setStatus("SQ_APPROVED");
                    pushUpdate("manager_id", userId || null);
                    pushUpdate("approved_at", now);
                    pushUpdate("rejection_reason", null);
                    details.action = "APPROVED";
                    break;
                }
                case "reject": {
                    if (!["SQ_PENDING_MANAGER_APPROVAL"].includes(quote.status_id)) throw new Error("Quote is not pending approval");
                    setStatus("SQ_REJECTED");
                    pushUpdate("manager_id", userId || null);
                    pushUpdate("approved_at", now);
                    pushUpdate("rejection_reason", v(reason, "No reason provided"));
                    details.action = "REJECTED_MANAGER";
                    details.reason = reason;
                    break;
                }
                case "send": {
                    if (!["SQ_APPROVED", "SQ_NEGOTIATION"].includes(quote.status_id)) throw new Error("Quote must be approved or in negotiation before sending");
                    setStatus("SQ_SENT");
                    pushUpdate("sent_at", now);
                    details.action = "SENT_TO_CUSTOMER";
                    break;
                }
                case "negotiate": {
                    if (!["SQ_SENT"].includes(quote.status_id)) throw new Error("Only sent quotes can be marked for negotiation");
                    setStatus("SQ_NEGOTIATION");
                    details.action = "NEGOTIATION";
                    pushUpdate("customer_decision", "NEGOTIATION");
                    pushUpdate("customer_decision_reason", v(reason));
                    pushUpdate("customer_decision_at", now);
                    break;
                }
                case "accept": {
                    if (!["SQ_SENT", "SQ_NEGOTIATION"].includes(quote.status_id)) throw new Error("Quote must be sent or in negotiation before acceptance");
                    setStatus("SQ_ACCEPTED");
                    pushUpdate("customer_decision", "ACCEPTED");
                    pushUpdate("customer_decision_reason", v(reason));
                    pushUpdate("customer_decision_at", now);
                    pushUpdate("closed_at", now);
                    details.action = "ACCEPTED";
                    details.reason = reason;
                    break;
                }
                case "reject-customer": {
                    if (!["SQ_SENT", "SQ_NEGOTIATION"].includes(quote.status_id)) throw new Error("Quote must be sent or in negotiation to record customer rejection");
                    setStatus("SQ_REJECTED");
                    pushUpdate("customer_decision", "REJECTED");
                    pushUpdate("customer_decision_reason", v(reason));
                    pushUpdate("customer_decision_at", now);
                    pushUpdate("closed_at", now);
                    details.action = "REJECTED_CUSTOMER";
                    details.reason = reason;
                    break;
                }
                case "lost": {
                    if (!["SQ_SENT", "SQ_NEGOTIATION"].includes(quote.status_id)) throw new Error("Quote must be sent or in negotiation to mark lost");
                    setStatus("SQ_LOST");
                    pushUpdate("lost_reason", v(reason));
                    pushUpdate("customer_decision", "LOST");
                    pushUpdate("customer_decision_reason", v(reason));
                    pushUpdate("customer_decision_at", now);
                    pushUpdate("closed_at", now);
                    details.action = "LOST";
                    details.reason = reason;
                    break;
                }
                case "expire": {
                    if (!["SQ_SENT", "SQ_APPROVED", "SQ_NEGOTIATION"].includes(quote.status_id)) throw new Error("Quote must be active to expire");
                    setStatus("SQ_EXPIRED");
                    pushUpdate("closed_at", now);
                    details.action = "EXPIRED";
                    break;
                }
                default:
                    throw new Error(`Unsupported action: ${action}`);
            }

            if (!updates.length) throw new Error("Nothing to update");

            const setClause = updates.map(([field]) => `${field}=?`).join(", ");
            const values = updates.map(([, value]) => value);
            await conn.query(`UPDATE sales_quote SET ${setClause} WHERE id=?`, [...values, quote.id]);

            await addHistory(conn, {
                module: "sales_quote",
                moduleId: quote.id,
                userId: userId,
                action: `STATUS_${action.toUpperCase()}`,
                details: { ...details, to: newStatus }
            });

            return { status: newStatus };
        });

        res.json({ success: true, status: result.status });
    } catch (e) {
        res.status(400).json({ error: e.message || "Failed to update status" });
    }
});

/* ============================================================================
   GET /api/sales-quotes/:id/history
============================================================================ */
router.get("/:id/history", async (req, res) => {
    const { id } = req.params;
    try {
        const [[quote]] = await db.promise().query("SELECT id FROM sales_quote WHERE uniqid=? LIMIT 1", [id]);
        if (!quote) return res.status(404).json({ error: "Not found" });

        const [history] = await db.promise().query(`
            SELECT h.id, h.action, h.details, h.created_at, u.name as user_name
            FROM history h
            LEFT JOIN user u ON u.id = h.user_id
            WHERE h.module = 'sales_quote' AND h.module_id = ?
            ORDER BY h.created_at DESC
        `, [quote.id]);

        res.json((history || []).map((h) => ({
            ...h,
            details: h.details ? JSON.parse(h.details) : {}
        })));
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch history", detail: e.message });
    }
});

export default router;

