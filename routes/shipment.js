import express from "express";
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import mysql from 'mysql2/promise';
import sharp from 'sharp';
import crypto from 'crypto';
import db from "../db.js";

const router = express.Router();
const errPayload = (message, type = "APP_ERROR", hint) => ({ error: { message, type, hint } });
const UPLOAD_ROOT = path.resolve();

/* ---------- storage for uploads ---------- */
const UP_DIR = path.resolve("uploads/shipment");
const THUMB_DIR = path.join(UP_DIR, 'thumbnail');
fs.mkdirSync(THUMB_DIR, { recursive: true });
fs.mkdirSync(UP_DIR, { recursive: true });
const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UP_DIR),
    filename: (_req, file, cb) =>
        cb(null, crypto.randomBytes(12).toString("hex") + path.extname(file.originalname || "")),
});
const upload = multer({ storage });

const addHistory = async (conn, { module, moduleId, userId, action, details }) => {
    if (!module || !moduleId || !userId || !action) return;
    await conn.query(
        'INSERT INTO history (module, module_id, user_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
        [module, moduleId, userId, action, JSON.stringify(details || {})]
    );
};


/* ---------- 1) Get configured docs for a stage (e.g., 1 = To Do List) ---------- */
router.get("/stages/:stageId/documents", async (req, res) => {
    try {
        const stageId = Number(req.params.stageId || 0);
        const [rows] = await db.promise().query(
            `SELECT sd.id as config_id, sd.is_required,
              dt.id AS document_type_id, dt.code, dt.name
       FROM shipment_document sd
       JOIN document_type dt ON dt.id = sd.document_type_id
       WHERE sd.shipment_stage = ?
       ORDER BY dt.name`,
            [stageId]
        );
        res.json(rows || []);
    } catch (e) {
        res.status(500).json({ error: "Failed to load stage documents" });
    }
});

// --- list stages (from your shipment_stage table)
router.get("/stages", async (_req, res) => {
    try {
        const [rows] = await db.promise().query(
            `SELECT id, name, sort_order FROM shipment_stage WHERE is_inactive = 0 ORDER BY sort_order, id`
        );
        res.json(rows || []);
    } catch (e) {
        res.status(500).json({ error: { message: "Failed to load stages", type: "DB_ERROR", hint: e.message } });
    }
});

// --- board: all shipments with their current stage (from purchase_orders.shipment_stage_id)
router.get("/board", async (req, res) => {
    try {
        const limit = Number(req.query.limit) || 0;
        const limitClause = limit > 0
            ? `AND s.id IN (SELECT id FROM shipment WHERE po_id IN (SELECT id FROM purchase_orders WHERE shipment_stage_id = 1) ORDER BY id DESC LIMIT ${limit})`
            : '';
        const [rows] = await db.promise().query(
            `
      SELECT
        s.ship_uniqid,
        s.id AS shipment_id,
        s.vessel_name,
        po.po_number,
        po.vendor_id,        
        po.id AS po_id,
        po.mode_shipment_id,
        po.no_containers,
        po.confirmation_type,
        v.display_name as vendor_name,
        c.display_name as customer_name,
        po.shipment_stage_id AS stage_id,        
        po.po_uniqid AS po_uniqid,
        dpl.name as loading_name,
        dpd.name as discharge_name,
        GROUP_CONCAT(CONCAT(poi.item_name, ' (', poi.quantity, ')') SEPARATOR ' : ') as products
      FROM shipment s
      JOIN purchase_orders po ON po.id = s.po_id
      LEFT JOIN vendor v ON v.id = s.vendor_id
      LEFT JOIN vendor c ON c.id = po.confirmation_customer_id
      LEFT JOIN delivery_place dpl ON dpl.id=po.port_loading
      LEFT JOIN delivery_place dpd ON dpd.id=po.port_discharge
      LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
      WHERE po.shipment_stage_id > 0 AND s.is_inactive = 0
      GROUP BY s.id
      ORDER BY po.shipment_stage_id, s.id DESC
      `
        );
        res.json(rows || []);
    } catch (e) {
        res.status(500).json({
            error: { message: "Failed to load board", type: "DB_ERROR", hint: e.message }
        });
    }
});

// PUT /api/shipment/:shipUniqid/update
// routes/shipment.js
// shipment.js

// GET /api/shipment/:shipUniqid
// Return joined shipment info (vendor, stage name, ports, dates, EIR/Token/charges)
router.get("/:shipUniqid", async (req, res) => {
    const id = req.params.shipUniqid;
    const [[row]] = await db.promise().query(`
    SELECT s.*, po.po_number, po.po_uniqid, 
           po.shipment_stage_id AS stage_id, 
           po.mode_shipment_id, po.no_containers,
           st.name AS stage_name,
           v.display_name AS vendor_name, 
           dpl.name AS loading_name, 
           dpd.name AS discharge_name,
           ms.name AS mode_shipment_name,
           ct.name AS container_type_name,
           cl.name AS container_load_name
      FROM shipment s
      JOIN purchase_orders po ON po.id = s.po_id      
      LEFT JOIN mode_of_shipment ms ON ms.id = po.mode_shipment_id
      LEFT JOIN shipment_stage st ON st.id = po.shipment_stage_id
      LEFT JOIN vendor v ON v.id = s.vendor_id
      LEFT JOIN delivery_place dpl ON dpl.id = po.port_loading
      LEFT JOIN delivery_place dpd ON dpd.id = po.port_discharge
      LEFT JOIN container_type ct ON ct.id = po.container_type_id
      LEFT JOIN container_load cl ON cl.id = po.container_load_id
     WHERE s.ship_uniqid = ? LIMIT 1`, [id]);
    if (!row) return res.status(404).json({ error: { message: "Not found" } });

    // Also fetch container details if they exist
    const [containers] = await db.promise().query(`SELECT * FROM shipment_container WHERE shipment_id = ?`, [row.id]);

    if (containers.length > 0) {
        const containerIds = containers.map(c => c.id);
        const [images] = await db.promise().query(`SELECT * FROM shipment_container_file WHERE container_id IN (?)`, [containerIds]);
        const [items] = await db.promise().query(`
            SELECT sci.*, 
                   (SELECT pi.file_path 
                    FROM product_images pi 
                    WHERE pi.product_id = sci.product_id 
                    ORDER BY pi.is_primary DESC, pi.id ASC LIMIT 1) as image_url
            FROM shipment_container_item sci WHERE container_id IN (?) ORDER BY id ASC
        `, [containerIds]);

        const imagesByContainer = images.reduce((acc, img) => {
            if (!acc[img.container_id]) acc[img.container_id] = [];
            acc[img.container_id].push(img);
            return acc;
        }, {});

        // Group items by container_id
        const itemsByContainer = items.reduce((acc, item) => {
            if (!acc[item.container_id]) acc[item.container_id] = [];
            acc[item.container_id].push(item);
            return acc;
        }, {});

        containers.forEach(c => {
            c.items = itemsByContainer[c.id] || [];
            c.images = imagesByContainer[c.id] || [];
        });
    }

    // Also fetch common files for the shipment
    const [commonFiles] = await db.promise().query(`
        SELECT sf.*, dt.name as document_type_name, dt.code as document_type_code
        FROM shipment_file sf
        JOIN document_type dt ON dt.id = sf.document_type_id
        WHERE sf.shipment_id = ?`, [row.id]);

    res.json({ ...row, containers: containers || [], commonFiles: commonFiles || [] });
});

/* ---------- update planned details (from wizard edit) ---------- */
router.put("/:shipUniqid/planned-details", upload.array('bl_instruction_files', 10), async (req, res) => {
    const { shipUniqid } = req.params;
    const userId = req.session?.user?.id;
    const userName = req.session?.user?.name || 'System';
    const connection = await db.promise().getConnection();

    try {
        await connection.beginTransaction();

        const {
            bl_description, free_time,
            discharge_port_local_charges, discharge_port_agent, freight_charges, payable_by, freight_payment_terms, freight_amount_if_payable,
            etd_date, vessel_name, shipping_line_name, shipper, consignee, notify_party
        } = req.body;

        // Find the shipment
        const [[oldShipment]] = await connection.query(`SELECT * FROM shipment WHERE ship_uniqid = ? LIMIT 1`, [shipUniqid]);
        if (!oldShipment) return res.status(404).json(errPayload("Shipment not found."));

        // --- Compare old and new values to find changes ---
        const changes = {};
        const fieldsToCompare = {
            bl_description: 'BL Description', free_time: 'Free Time',
            discharge_port_local_charges: 'POD Local Charges', discharge_port_agent: 'POD Agent',
            freight_charges: 'Freight Charges', payable_by: 'Payable By', freight_payment_terms: 'Freight Terms',
            freight_amount_if_payable: 'Freight Amount', etd_date: 'ETD', vessel_name: 'Vessel Name',
            shipping_line_name: 'Shipping Line', shipper: 'Shipper', consignee: 'Consignee', notify_party: 'Notify Party'
        };

        const formatDate = (d) => d ? new Date(d).toISOString().split('T')[0] : null;

        for (const key in fieldsToCompare) {
            const oldValue = key === 'etd_date' ? formatDate(oldShipment[key]) : (oldShipment[key] || '');
            const newValue = req.body[key] || '';
            if (String(oldValue) !== String(newValue)) {
                changes[fieldsToCompare[key]] = {
                    from: oldValue || 'empty',
                    to: newValue || 'empty'
                };
            }
        }

        await connection.query(
            `UPDATE shipment SET
                bl_description = ?, free_time = ?, discharge_port_local_charges = ?,
                discharge_port_agent = ?, freight_charges = ?, payable_by = ?, freight_payment_terms = ?, freight_amount_if_payable = ?,
                etd_date = ?, vessel_name = ?, shipping_line_name = ?, shipper = ?, consignee = ?, notify_party = ?,
                updated_date = NOW()
            WHERE id = ?`,
            [bl_description || null, free_time || null, discharge_port_local_charges || null, discharge_port_agent || null, freight_charges || null, payable_by || null, freight_payment_terms || null, freight_amount_if_payable || null, etd_date || null, vessel_name || null, shipping_line_name || null, shipper || null, consignee || null, notify_party || null, oldShipment.id]
        );

        // Handle BL Instruction file uploads (same logic as create-from-po)
        const files = req.files || [];
        if (files.length > 0) {
            const [[docType]] = await connection.query(`SELECT id FROM document_type WHERE code = 'bl_instruction' LIMIT 1`);
            const docTypeId = docType ? docType.id : null;
            for (const file of files) {
                if (docTypeId) {
                    const relPath = path.posix.join("uploads", "shipment", path.basename(file.path));
                    await connection.query(
                        `INSERT INTO shipment_file (shipment_id, document_type_id, file_name, file_path, mime_type, size_bytes, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, NOW())`,
                        [oldShipment.id, docTypeId, file.originalname, relPath, file.mimetype, file.size]
                    );
                }
            }
        }

        // Add history for the update
        await addHistory(connection, {
            module: 'shipment',
            moduleId: oldShipment.id,
            userId: userId,
            action: 'PLANNED_DETAILS_UPDATED',
            details: { changes: changes }
        });

        await connection.commit();
        res.json({ ok: true, shipUniqid: shipUniqid });

    } catch (e) {
        await connection.rollback();
        res.status(500).json(errPayload("Failed to update planned shipment details", "DB_ERROR", e.message));
    } finally {
        connection.release();
    }
});

// GET /api/shipment/:shipUniqid/history (automated logs)
router.get("/:shipUniqid/history", async (req, res) => {
    const { shipUniqid } = req.params;
    const [[shipment]] = await db.promise().query(`SELECT id FROM shipment WHERE ship_uniqid = ?`, [shipUniqid]);
    if (!shipment) return res.status(404).json(errPayload("Shipment not found"));

    const [rows] = await db.promise().query(
        `SELECT h.action, h.details, h.created_at, u.name as user_name, u.photo_path as profile_image_path
         FROM history h
         LEFT JOIN user u ON u.id = h.user_id
         WHERE h.module = 'shipment' AND h.module_id = ?
         ORDER BY h.created_at DESC`,
        [shipment.id]
    );
    res.json(rows || []);
});

// GET /api/shipment/:shipUniqid/logs (custom logs/chat)
router.get("/:shipUniqid/logs", async (req, res) => {
    const { shipUniqid } = req.params;
    const userId = req.session?.user?.id;
    const [[shipment]] = await db.promise().query(`SELECT id FROM shipment WHERE ship_uniqid = ?`, [shipUniqid]);
    if (!shipment) return res.status(404).json(errPayload("Shipment not found"));

    const [logs] = await db.promise().query(
        `SELECT sl.id, sl.message, sl.created_at, sl.user_id, u.name as user_name, u.photo_path as profile_image_path
         FROM shipment_log sl
         JOIN user u ON u.id = sl.user_id
         WHERE sl.shipment_id = ? ORDER BY sl.created_at ASC`,
        [shipment.id]
    );

    const [[readStatus]] = await db.promise().query(
        `SELECT last_read_log_id FROM shipment_log_read_status WHERE shipment_id = ? AND user_id = ?`,
        [shipment.id, userId]
    );

    res.json({ logs: logs || [], last_read_log_id: readStatus?.last_read_log_id || 0 });
});

// POST /api/shipment/:shipUniqid/logs (add a custom log)
router.post("/:shipUniqid/logs", async (req, res) => {
    const { shipUniqid } = req.params;
    const { message } = req.body;
    const userId = req.session?.user?.id;
    if (!message) return res.status(400).json(errPayload("Message is required."));

    const [[shipment]] = await db.promise().query(`SELECT id FROM shipment WHERE ship_uniqid = ?`, [shipUniqid]);
    if (!shipment) return res.status(404).json(errPayload("Shipment not found"));

    await db.promise().query(`INSERT INTO shipment_log (shipment_id, user_id, message, created_at) VALUES (?, ?, ?, NOW())`, [shipment.id, userId, message]);
    res.status(201).json({ ok: true });
});

// POST /api/shipment/:shipUniqid/logs/mark-as-read
router.post("/:shipUniqid/logs/mark-as-read", async (req, res) => {
    const { shipUniqid } = req.params;
    const { last_log_id } = req.body;
    const userId = req.session?.user?.id;
    const [[shipment]] = await db.promise().query(`SELECT id FROM shipment WHERE ship_uniqid = ?`, [shipUniqid]);
    if (!shipment) return res.status(404).json(errPayload("Shipment not found"));

    await db.promise().query(
        `INSERT INTO shipment_log_read_status (shipment_id, user_id, last_read_log_id, updated_at) VALUES (?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE last_read_log_id = VALUES(last_read_log_id), updated_at = NOW()`,
        [shipment.id, userId, last_log_id]
    );
    res.json({ ok: true });
      
});

// GET /api/shipment/:shipUniqid/files
router.get("/:shipUniqid/files", async (req, res) => {
    const id = req.params.shipUniqid;
    const [[s]] = await db.promise().query(`SELECT id FROM shipment WHERE ship_uniqid=? LIMIT 1`, [id]);
    if (!s) return res.status(404).json({ error: { message: "Not found" } });
    const [rows] = await db.promise().query(`
    SELECT sf.id, sf.document_type_id, dt.name AS document_type_name,
           sf.file_name, sf.file_path, sf.ref_no, sf.ref_date
      FROM shipment_file sf
      JOIN document_type dt ON dt.id = sf.document_type_id
     WHERE sf.shipment_id = ?
     ORDER BY sf.id DESC`, [s.id]);
    res.json(rows);
});

// DELETE /api/shipment/files/:fileId
router.delete("/files/:fileId", async (req, res) => {
    const fileId = Number(req.params.fileId);
    const userId = req.session?.user?.id;
    const userName = req.session?.user?.name || 'System';
    if (!fileId) return res.status(400).json(errPayload("Invalid file ID."));

    const conn = await db.promise().getConnection();
    try {
        const [[file]] = await conn.query(`SELECT id, file_path, shipment_id, file_name FROM shipment_file WHERE id = ?`, [fileId]);
        if (!file) return res.status(404).json(errPayload("File not found."));

        await conn.beginTransaction();
        await conn.query(`DELETE FROM shipment_file WHERE id = ?`, [fileId]);

        // Also delete from filesystem
        if (file.file_path) {
            const absPath = path.resolve(UPLOAD_ROOT, file.file_path);
            await fs.promises.unlink(absPath).catch(e => console.warn(`Failed to delete file from disk: ${absPath}`, e));
        }

        // Add history for the deletion
        await addHistory(conn, {
            module: 'shipment',
            moduleId: file.shipment_id,
            userId: userId,
            action: 'FILE_DELETED',
            details: { file_name: file.file_name }
        });

        await conn.commit();
        res.json({ ok: true, message: "File deleted successfully." });
    } catch (e) {
        await conn.rollback();
        res.status(500).json(errPayload("Failed to delete file.", "DB_ERROR", e.message));
    } finally {
        conn.release();
    }
});

// GET /api/shipment/files/:fileId
router.get("/files/:fileId", async (req, res) => {
    try {
        const fileId = req.params.fileId;
        const [[f]] = await db.promise().query(
            `SELECT file_path, file_name, mime_type FROM shipment_file WHERE id=? LIMIT 1`,
            [fileId]
        );
        if (!f) return res.status(404).json({ error: { message: "File not found" } });

        const abs = path.isAbsolute(f.file_path) ? f.file_path : path.resolve(UPLOAD_ROOT, f.file_path);
        if (!fs.existsSync(abs)) return res.status(404).json({ error: { message: "Missing file on disk" } });

        res.setHeader("Content-Type", f.mime_type || "application/octet-stream");
        // 'inline' lets the browser preview PDFs/images; change to 'attachment' to force download
        res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(f.file_name || "file")}"`);
        fs.createReadStream(abs).pipe(res);
    } catch (e) {
        res.status(500).json({ error: { message: "Failed to serve file", hint: e.message } });
    }
});



router.put("/:shipUniqid/update", async (req, res) => {
    try {
        const shipUniqid = req.params.shipUniqid;
        const [[sh]] = await db.promise().query(
            `SELECT s.id AS shipment_id, s.po_id
         FROM shipment s
        WHERE s.ship_uniqid = ? LIMIT 1`,
            [shipUniqid]
        );
        if (!sh) return res.status(404).json(errPayload("Shipment not found"));

        const {
            vessel_name = null,
            etd_date = null,
            eta_date = null,
            sailed_date = null,
            is_transhipment = 0,
            ports = []
        } = req.body || {};

        // update shipment fields
        await db.promise().query(
            `UPDATE shipment
          SET vessel_name=?, etd_date=?, eta_date=?, sailing_date=?, is_transhipment=?
        WHERE id=?`,
            [vessel_name, etd_date, eta_date, sailed_date, Number(is_transhipment)?1:0, sh.shipment_id]
        );

        // refresh transshipment ports
        await db.promise().query(`DELETE FROM shipment_transhipment WHERE shipment_id=?`, [sh.shipment_id]);
        for (const p of ports) {
            if (p.port_id && p.order_no) {
                await db.promise().query(
                    `INSERT INTO shipment_transhipment (shipment_id, transhipment_port_id, order_no)
           VALUES (?,?,?)`,
                    [sh.shipment_id, p.port_id, p.order_no]
                );
            }
        }

        // 🚀 bump PO to stage 2
        await db.promise().query(
            `UPDATE purchase_orders SET shipment_stage_id=2 WHERE id=?`,
            [sh.po_id]
        );

        res.json({ ok: true, shipment_id: sh.shipment_id });
    } catch (e) {
        res.status(500).json(errPayload("Failed to update shipment", "DB_ERROR", e.message));
    }
});

// If requireMeta=true, only counts files that have ref_no and ref_date filled.
async function getMissingRequiredDocs(shipmentId, stage, { requireMeta = false } = {}) {
    const metaFilter = requireMeta
        ? "AND NULLIF(TRIM(sf.ref_no), '') IS NOT NULL AND sf.ref_date IS NOT NULL"
        : "";

    const [rows] = await db.promise().query(
        `
    SELECT dt.name
    FROM shipment_document sd
    JOIN document_type dt ON dt.id = sd.document_type_id
    LEFT JOIN (
      SELECT document_type_id,
             MAX(NULLIF(TRIM(ref_no), '')) AS ref_no,
             MAX(ref_date) AS ref_date
        FROM shipment_file
       WHERE shipment_id = ?
       GROUP BY document_type_id
    ) sf ON sf.document_type_id = dt.id
    WHERE sd.shipment_stage = ?
      AND sd.is_required = 1
      ${metaFilter}
      AND sf.document_type_id IS NULL
    `,
        [shipmentId, stage]
    );

    return rows.map(r => r.name);
}

// --- move a shipment to next stage (no file upload here)
router.put("/:shipUniqid/move", async (req, res) => {
    try {
        const shipUniqid = req.params.shipUniqid;
        const toStageId = Number(req.body?.to_stage_id);
        const fields = req.body?.fields || {};
        const userId = req.session?.user?.id ?? null;
        const userName = req.session?.user?.name ?? 'System';

        const [[row]] = await db.promise().query(
            `SELECT s.id AS shipment_id, s.po_id, po.shipment_stage_id,
             dpl.name as loading_name,dpd.name as discharge_name
         FROM shipment s JOIN purchase_orders po ON po.id = s.po_id
         LEFT JOIN vendor v ON v.id=s.vendor_id
         LEFT JOIN delivery_place dpl ON dpl.id=po.port_loading
         LEFT JOIn delivery_place dpd ON dpd.id=po.port_discharge
        WHERE s.ship_uniqid = ? LIMIT 1`,
            [shipUniqid]
        );
        if (!row) return res.status(404).json({ error: { message: "Shipment not found" } });

        const fromStageId = Number(row.shipment_stage_id || 0);
         // Disallow backwards
             if (toStageId < fromStageId) {
               return res.status(400).json({ error: { message: "Cannot move backwards" } });
             }
             if (toStageId === fromStageId) {
               return res.json({ ok: true, updated: { from_stage_id: fromStageId } });
             }
         // Enforce one-at-a-time forward
             if (toStageId > fromStageId + 1) {
               return res.status(400).json({ error: { message: "Only forward one stage is allowed" } });
             }

        // apply stage-specific field updates
        if (toStageId === 2) { // Planned
            const { planned_sailing_date, planned_arrival_date, vessel_name } = fields;
            await db.promise().query(
                `UPDATE shipment SET confirm_sailing_date=?, eta_date=?, vessel_name=? WHERE id=?`,
                [planned_sailing_date || null, planned_arrival_date || null, vessel_name || null, row.shipment_id]
            );

        }  else if (toStageId === 3) { // Sailed
        const { sailed_date, confirm_sailing_date, reason_diff_sailing } = fields;

        // fetch current confirm date
        const [[curr]] = await db.promise().query(
            `SELECT confirm_sailing_date FROM shipment WHERE id=? LIMIT 1`,
            [row.shipment_id]
        );
        const existingConfirm = curr?.confirm_sailing_date || null;

        // set confirm date if not set yet
        if (!existingConfirm && confirm_sailing_date) {
            await db.promise().query(
                `UPDATE shipment SET confirm_sailing_date=? WHERE id=?`,
                [confirm_sailing_date, row.shipment_id]
            );
        }

        // use the value that should be considered the confirm date now
        const effectiveConfirm = existingConfirm || confirm_sailing_date || null;

        if (sailed_date && effectiveConfirm && sailed_date === effectiveConfirm) {
            // sailed matches confirm → set actual sailing_date, clear reason
            await db.promise().query(
                `UPDATE shipment SET sailing_date=?, reason_diff_sailing=NULL WHERE id=?`,
                [sailed_date, row.shipment_id]
            );
        } else if (sailed_date && effectiveConfirm && sailed_date !== effectiveConfirm) {
            // sailed differs from confirm → require and SAVE reason, do not change sailing_date
            if (!reason_diff_sailing || !String(reason_diff_sailing).trim()) {
                return res.status(400).json(
                    errPayload("Reason required when Sailed Date differs from Confirm Sailing Date")
                );
            }
            await db.promise().query(
                `UPDATE shipment SET reason_diff_sailing=? WHERE id=?`,
                [String(reason_diff_sailing).trim(), row.shipment_id]
            );
        } else {
            // No sailed date or no confirm date to compare; if a reason was provided, persist it
            if (reason_diff_sailing && String(reason_diff_sailing).trim()) {
                await db.promise().query(
                    `UPDATE shipment SET reason_diff_sailing=? WHERE id=?`,
                    [String(reason_diff_sailing).trim(), row.shipment_id]
                );
            }
        }
    }
    else if (toStageId === 4) { // Discharge
            const { discharge_date } = fields;
            if (!discharge_date) {
                return res.status(400).json(errPayload("Discharge Date is required"));
            }

            // Files must already exist for required Stage-4 docs (presence only)
            const missing = await getMissingRequiredDocs(row.shipment_id, 4, { requireMeta: false });
            if (missing.length) {
                return res.status(400).json(
                    errPayload(`Attach required documents before Discharge: ${missing.join(", ")}`)
                );
            }

            await db.promise().query(
                `UPDATE shipment SET discharge_date=? WHERE id=?`,
                [discharge_date, row.shipment_id]
            );

        } else if (toStageId === 5) { // Cleared
            const { cleared_date } = fields;
            if (!cleared_date) {
                return res.status(400).json(errPayload("Cleared Date is required"));
            }

            // Optional: ensure discharge was already set
            const [[prev]] = await db.promise().query(
                `SELECT discharge_date FROM shipment WHERE id=? LIMIT 1`,
                [row.shipment_id]
            );
            if (!prev?.discharge_date) {
                return res.status(400).json(errPayload("Set Discharge Date (Stage 4) before Clearance"));
            }

            // For Stage-5, be stricter: require ref_no + ref_date
            const missing = await getMissingRequiredDocs(row.shipment_id, 5, { requireMeta: true });
            if (missing.length) {
                return res.status(400).json(
                    errPayload(`Attach required documents before Cleared: ${missing.join(", ")}`)
                );
            }

            await db.promise().query(
                `UPDATE shipment SET cleared_date=? WHERE id=?`,
                [cleared_date, row.shipment_id]
            );
        }else if (toStageId === 6) { // Returned
            const {eir_no, token_no, transportation_charges, returned_date} = fields;

            if (!eir_no) return res.status(400).json(errPayload("EIR No is required"));
            if (!token_no) return res.status(400).json(errPayload("Token No is required"));

            const charges = transportation_charges === 0 ? 0 : parseFloat(transportation_charges);
            if (Number.isNaN(charges) || charges < 0) {
                return res.status(400).json(errPayload("Transportation Charges must be a non-negative number"));
            }

            // Require all Stage-6 required docs (with ref_no & ref_date)
            const missing = await getMissingRequiredDocs(row.shipment_id, 6, {requireMeta: true});
            if (missing.length) {
                return res.status(400).json(
                    errPayload(`Attach required documents before Returned: ${missing.join(", ")}`)
                );
            }

            // Save fields (returned_date optional)
            await db.promise().query(
                `UPDATE shipment
                 SET eir_no = ?,
                     token_no = ?,
                     transportation_charges = ?,
                     returned_date = ?
                 WHERE id = ?`,
                [eir_no, token_no, charges.toFixed(2), returned_date || null, row.shipment_id]
            );
        }
        else {
            // other stages: keep payload in history only
        }

        // update PO stage
        await db.promise().query(`UPDATE purchase_orders SET shipment_stage_id = ? WHERE id = ?`, [toStageId, row.po_id]);

        // Get stage names for history
        const [[fromStage]] = await db.promise().query(`SELECT name FROM shipment_stage WHERE id = ?`, [fromStageId]);
        const [[toStage]] = await db.promise().query(`SELECT name FROM shipment_stage WHERE id = ?`, [toStageId]);

        // Add to history
        await addHistory(db, {
            module: 'shipment',
            moduleId: row.shipment_id,
            userId: userId,
            action: 'STAGE_CHANGED',
            details: {
                from: fromStage?.name || `Stage ${fromStageId}`,
                to: toStage?.name || `Stage ${toStageId}`,
                payload: fields
            }
        });

        res.json({ ok: true, updated: { from_stage_id: fromStageId } });
    } catch (e) {
        res.status(500).json({ error: { message: "Failed to move stage", type: "DB_ERROR", hint: e.message } });
    }
});

/* ---------- upload shipment files ---------- */
router.post("/:shipUniqid/upload", upload.array("files", 20), async (req, res) => {
    const conn = await db.promise().getConnection();
    try {
        const shipUniqid = req.params.shipUniqid;
        const docTypeId = Number(req.body.document_type_id || 0) || null;
        const refNo   = req.body.ref_no || null;
        const refDate = req.body.ref_date || null;
        const userId = req.session?.user?.id;
        const userName = req.session?.user?.name || 'System';

        await conn.beginTransaction();

        const [[sh]] = await conn.query(
            `SELECT id FROM shipment WHERE ship_uniqid = ? LIMIT 1`,
            [shipUniqid]
        );
        if (!sh) return res.status(404).json(errPayload("Shipment not found"));

        const files = req.files || [];
        for (const file of files) {
            const relPath = path.posix.join("uploads", "shipment", path.basename(file.path));
            await conn.query(
                `INSERT INTO shipment_file
           (shipment_id, document_type_id, file_name, file_path, mime_type, size_bytes, uploaded_at, ref_no, ref_date)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ?)`,
                [sh.id, docTypeId, file.originalname, relPath, file.mimetype, file.size, refNo, refDate]
            );

            // Add history for the upload
            await addHistory(conn, {
                module: 'shipment',
                moduleId: sh.id,
                userId: userId,
                action: 'FILE_UPLOADED',
                details: { file_name: file.originalname }
            });
        }

        await conn.commit();
        res.json({ ok: true, count: files.length });
    } catch (e) {
        res.status(500).json(errPayload("Failed to upload files", "UPLOAD_ERROR", e.message));
    } finally {
        conn.release();
    }
});

/* ---------- create a shipment from a PO (wizard) ---------- */
router.post("/create-from-po", upload.array('bl_instruction_files', 10), async (req, res) => {
    const connection = await db.promise().getConnection();
    try {
        const userId = req.session?.user?.id;
        const userName = req.session?.user?.name || 'System';
        await connection.beginTransaction();

        const {
            po_id, // This is the purchase_order.id
            bl_description, free_time,
            discharge_port_local_charges, discharge_port_agent, freight_charges, payable_by, freight_payment_terms, freight_amount_if_payable,
            etd_date, vessel_name, shipping_line_name, shipper, consignee, notify_party
        } = req.body;

        // Find the existing shipment record linked to the Purchase Order
        // The frontend sends shipment.id as po_id, so we find by shipment.id
        const [[shipment]] = await connection.query(
            `SELECT s.id, s.ship_uniqid, s.po_id FROM shipment s JOIN purchase_orders po ON s.po_id = po.id WHERE s.id = ? AND po.shipment_stage_id = 1`,
            [po_id]
        );

        if (!shipment) {
            return res.status(404).json(errPayload("Shipment not found or it is not in the 'To Do List' stage."));
        }

        // UPDATE the existing shipment record with the details from the wizard
        await connection.query(
            `UPDATE shipment SET
                bl_description = ?, free_time = ?, discharge_port_local_charges = ?,
                discharge_port_agent = ?, freight_charges = ?, payable_by = ?, freight_payment_terms = ?, freight_amount_if_payable = ?,
                etd_date = ?, vessel_name = ?, shipping_line_name = ?, shipper = ?, consignee = ?, notify_party = ?
            WHERE id = ?`,
            [
                bl_description || null, free_time || null, discharge_port_local_charges || null,
                discharge_port_agent || null, freight_charges || null, payable_by || null, freight_payment_terms || null, freight_amount_if_payable || null,
                etd_date || null, vessel_name || null, shipping_line_name || null, shipper || null, consignee || null, notify_party || null,
                shipment.id
            ]
        );
        const shipmentId = shipment.id;

        // Handle BL Instruction file uploads
        const files = req.files || [];
        if (files.length > 0) {
            // Assuming 'bl_instruction' is the code for the document type
            const [[docType]] = await connection.query(`SELECT id FROM document_type WHERE code = 'bl_instruction' LIMIT 1`);
            const docTypeId = docType ? docType.id : null;

            for (const file of files) {
                if (docTypeId) {
                    const relPath = path.posix.join("uploads", "shipment", path.basename(file.path));
                    await connection.query(
                        `INSERT INTO shipment_file (shipment_id, document_type_id, file_name, file_path, mime_type, size_bytes, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, NOW())`,
                        [shipmentId, docTypeId, file.originalname, relPath, file.mimetype, file.size]
                    );
                }
            }
        }

        // Move PO to Stage 2 (Planned)
        await connection.query(`UPDATE purchase_orders SET shipment_stage_id = 2 WHERE id = ?`, [shipment.po_id]);

        // Add to history
        await addHistory(connection, {
            module: 'shipment',
            moduleId: shipmentId,
            userId: userId,
            action: 'STAGE_CHANGED',
            details: {
                from: 'To Do List',
                to: 'Planned',
                payload: req.body
            }
        });

        await connection.commit();
        res.json({ ok: true, shipUniqid: shipment.ship_uniqid, from_stage_id: 1 });

    } catch (e) {
        await connection.rollback();
        res.status(500).json(errPayload("Failed to create shipment from wizard", "DB_ERROR", e.message));
    } finally {
        connection.release();
    }
});

/* ---------- save underloading details (SEA) and move to stage 3 ---------- */
router.post("/:shipUniqid/underloading-sea", upload.any(), async (req, res) => {
    const { shipUniqid } = req.params;
    const { pickup_date } = req.body;
    const keptCommonImagesJson = req.body.keptCommonImages || '[]'; // Safely get kept images
    const containers = JSON.parse(req.body.containers || '[]');
    const files = req.files || [];
    const userId = req.session?.user?.id;
    const userName = req.session?.user?.name || 'System';

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        const [[shipment]] = await conn.query(`SELECT s.id, s.po_id, po.shipment_stage_id FROM shipment s JOIN purchase_orders po ON s.po_id = po.id WHERE s.ship_uniqid = ?`, [shipUniqid]);
        if (!shipment) throw new Error("Shipment not found.");

        const isEditing = shipment.shipment_stage_id >= 3;
        const [[commonDocType]] = await conn.query(`SELECT id FROM document_type WHERE code = 'underloading_common_photo' LIMIT 1`);

         const keptCommonImages = JSON.parse(keptCommonImagesJson || '[]');

        // --- Handle Image Deletions (if editing) ---
        if (isEditing) {
            // Common Images
            if (commonDocType) {
                const [existingCommonImageRows] = await conn.query(
                    `SELECT id FROM shipment_file WHERE shipment_id = ? AND document_type_id = ?`,
                    [shipment.id, commonDocType.id]
                );
                const existingCommonImageIds = existingCommonImageRows.map(f => f.id);
                const keptCommonImageIds = keptCommonImages.map(img => Number(img.id)).filter(Boolean);
                const commonImagesToDelete = existingCommonImageIds.filter(id => !keptCommonImageIds.includes(id));
                if (commonImagesToDelete.length > 0) {
                    await conn.query(`DELETE FROM shipment_file WHERE id IN (?)`, [commonImagesToDelete]);
                }
            }

            // Container Images - Corrected Deletion Logic
            const keptContainerImageIds = containers.flatMap(c => (c.images || []).map(img => img.id)).filter(Boolean);
            // Get only the container IDs that actually exist in the database for this shipment
            const [existingContainerIds] = await conn.query(`SELECT id FROM shipment_container WHERE shipment_id = ?`, [shipment.id]);
            const containerIdsForQuery = existingContainerIds.map(c => c.id);
            if (containerIdsForQuery.length > 0) {
                await conn.query(`DELETE FROM shipment_container_file WHERE container_id IN (?) AND id NOT IN (?)`, [containerIdsForQuery, keptContainerImageIds.length > 0 ? keptContainerImageIds : [0]]);
            }
        }

        // Save common images
        const commonImages = files.filter(f => f.fieldname === 'common_images');
        for (const file of commonImages) {
            if (commonDocType) {
                const thumbName = `thumb_${path.basename(file.path)}`;
                const thumbDiskPath = path.join(THUMB_DIR, thumbName);
                await sharp(file.path).resize(200, 200, { fit: 'inside', withoutEnlargement: true }).toFile(thumbDiskPath);
                const originalPath = path.posix.join("uploads", "shipment", path.basename(file.path));
                const thumbPath = path.posix.join("uploads", "shipment", "thumbnail", thumbName);
                await conn.query(
                    `INSERT INTO shipment_file (shipment_id, document_type_id, file_name, file_path, thumbnail_path, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [shipment.id, commonDocType.id, file.originalname, originalPath, thumbPath, file.mimetype, file.size]
                );
            }
        }

        // --- For Edit History ---
        const oldContainers = {};
        if (isEditing) {
            const [existing] = await conn.query(`SELECT * FROM shipment_container WHERE shipment_id = ?`, [shipment.id]);
            existing.forEach(c => {
                oldContainers[c.id] = { container_no: c.container_no, seal_no: c.seal_no };
            });
        }
        const changes = [];

       

        for (const container of containers) {
            let containerId;
            // Check if it's an existing container by checking for a numeric ID
            if (container.id && !isNaN(Number(container.id))) {
                containerId = container.id;
                // UPDATE existing container
                await conn.query(
                    `UPDATE shipment_container SET container_no = ?, seal_no = ?, pickup_date = ? WHERE id = ? AND shipment_id = ?`,
                    [container.container_no, container.seal_no, pickup_date || null, containerId, shipment.id]
                );
                // Log changes for history
                const old = oldContainers[containerId];
                if (old) {
                    if (old.container_no !== container.container_no) changes.push(`Container No for ${old.container_no} changed to ${container.container_no}`);
                    if (old.seal_no !== container.seal_no) changes.push(`Seal No for ${container.container_no} changed from ${old.seal_no} to ${container.seal_no}`);
                } else {
                    changes.push(`Added new container: ${container.container_no}`);
                }
                // Clear out old items before inserting new/updated ones
                await conn.query(`DELETE FROM shipment_container_item WHERE container_id = ?`, [containerId]);
            } else {
                // INSERT new container
                const [containerResult] = await conn.query(
                    `INSERT INTO shipment_container (shipment_id, container_no, seal_no, pickup_date) VALUES (?, ?, ?, ?)`,
                    [shipment.id, container.container_no, container.seal_no, pickup_date || null]
                );
                containerId = containerResult.insertId;
            }

            // Save container-specific images
            const containerImages = files.filter(f => f.fieldname === `container_images_${container.id}`);
            for (const file of containerImages) {
                const thumbName = `thumb_${path.basename(file.path)}`;
                const thumbDiskPath = path.join(THUMB_DIR, thumbName);
                await sharp(file.path)
                    .resize(200, 200, { fit: 'inside', withoutEnlargement: true })
                    .toFile(thumbDiskPath);

                const originalPath = path.posix.join("uploads", "shipment", path.basename(file.path));
                const thumbPath = path.posix.join("uploads", "shipment", "thumbnail", thumbName);
                await conn.query(
                    `INSERT INTO shipment_container_file (container_id, file_name, file_path, thumbnail_path, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?, ?)`,
                    [containerId, file.originalname, originalPath, thumbPath, file.mimetype, file.size]
                );
            }


            const itemValues = (container.items || []).map(it => {
                // Destructure to include product_id and exclude product_option
                const { product_id, product_name, package_type, package_count, net_weight, gross_weight, hscode } = it;
                return [containerId, product_id || null, product_name, package_type, package_count, net_weight, gross_weight, hscode];
            });

            if (itemValues.length > 0) {
                await conn.query(
                    `INSERT INTO shipment_container_item (container_id, product_id, product_name, package_type, package_count, net_weight, gross_weight, hscode) VALUES ?`,
                    [itemValues]
                );
            }
        }

        if (isEditing) {
            // We are editing, so just log the specific changes.
            if (changes.length > 0) {
                await addHistory(conn, {
                    module: 'shipment', moduleId: shipment.id, userId: userId,
                    action: 'UNDERLOADING_DETAILS_UPDATED',
                    details: { changes: changes.join('; ') }
                });
            }
        } else {
            // This is a new entry, so move the stage and log the stage change.
            await conn.query(`UPDATE purchase_orders SET shipment_stage_id = 3 WHERE id = ?`, [shipment.po_id]);
            await addHistory(conn, {
                module: 'shipment',
                moduleId: shipment.id,
                userId: userId,
                action: 'STAGE_CHANGED',
                details: {
                    from: 'Planned',
                    to: 'Underloading',
                    user: userName // Add user name for the template
                }
            });
        }

        await conn.commit();
        res.json({ ok: true, shipUniqid, from_stage_id: 2 });
    } catch (e) {
        await conn.rollback();
        res.status(500).json(errPayload("Failed to save underloading details", "DB_ERROR", e.message));
    } finally {
        conn.release();
    }
});

/* ---------- save underloading details (AIR) and move to stage 3 ---------- */
router.post("/:shipUniqid/underloading-air", upload.any(), async (req, res) => {
    const { shipUniqid } = req.params;
   //  const { airway_bill_no, flight_no } = req.body;
    const { airway_bill_no, flight_no, keptCommonImages: keptCommonImagesJson, items: itemsJson } = req.body;
    const items = JSON.parse(itemsJson || '[]');
    const files = req.files || [];
    const userId = req.session?.user?.id;
    const userName = req.session?.user?.name || 'System';

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        const [[shipment]] = await conn.query(`SELECT s.id, s.po_id, s.airway_bill_no, s.flight_no, po.shipment_stage_id FROM shipment s JOIN purchase_orders po ON s.po_id = po.id WHERE s.ship_uniqid = ?`, [shipUniqid]);
        if (!shipment) throw new Error("Shipment not found.");

        const isEditing = shipment.shipment_stage_id >= 3;

        // Update shipment with Airway Bill and Flight No
        await conn.query(
            `UPDATE shipment SET airway_bill_no = ?, flight_no = ? WHERE id = ?`,
            [airway_bill_no, flight_no, shipment.id]
        );

        // For Air, we create/update a single "dummy" container to hold the items, reusing the sea-freight tables.
        const [[existingContainer]] = await conn.query(`SELECT id FROM shipment_container WHERE shipment_id = ? LIMIT 1`, [shipment.id]);
        let containerId;
        if (existingContainer) {
            containerId = existingContainer.id;
            await conn.query(`UPDATE shipment_container SET container_no = ?, seal_no = ? WHERE id = ?`, [airway_bill_no, flight_no, containerId]);
            await conn.query(`DELETE FROM shipment_container_item WHERE container_id = ?`, [containerId]); // Clear old items
        } else {
            const [cResult] = await conn.query(`INSERT INTO shipment_container (shipment_id, container_no, seal_no) VALUES (?, ?, ?)`, [shipment.id, airway_bill_no, flight_no]);
            containerId = cResult.insertId;
        }

        // Insert items for the air shipment's container
        if (items.length > 0) {
            const itemValues = items.map(it => [containerId, it.product_id || null, it.product_name, it.package_type, it.package_count, it.net_weight, it.gross_weight, it.hscode]);
            await conn.query(`INSERT INTO shipment_container_item (container_id, product_id, product_name, package_type, package_count, net_weight, gross_weight, hscode) VALUES ?`, [itemValues]);
        }

        // Get document type for common images
        const [[commonDocType]] = await conn.query(`SELECT id FROM document_type WHERE code = 'underloading_common_photo' LIMIT 1`);

        // Handle deletion of common images if editing
        if (isEditing && commonDocType) {
            const existingCommonImageIds = (await conn.query(`SELECT id FROM shipment_file WHERE shipment_id = ? AND document_type_id = ?`, [shipment.id, commonDocType.id]))[0].map(f => f.id);
            const keptCommonImages = JSON.parse(keptCommonImagesJson || '[]');
            const keptCommonImageIds = keptCommonImages.map(img => Number(img.id)).filter(Boolean);
            const commonImagesToDelete = existingCommonImageIds.filter(id => !keptCommonImageIds.includes(id));

            if (commonImagesToDelete.length > 0) {
                await conn.query(`DELETE FROM shipment_file WHERE id IN (?)`, [commonImagesToDelete]);
            }
        }

        // Filter for common images specifically
        const commonImagesToSave = files.filter(f => f.fieldname === 'common_images');
        for (const file of commonImagesToSave) {
            if (commonDocType) {
                const thumbName = `thumb_${path.basename(file.path)}`;
                const thumbDiskPath = path.join(THUMB_DIR, thumbName);
                await sharp(file.path).resize(200, 200, { fit: 'inside', withoutEnlargement: true }).toFile(thumbDiskPath);
                const originalPath = path.posix.join("uploads", "shipment", path.basename(file.path));
                const thumbPath = path.posix.join("uploads", "shipment", "thumbnail", thumbName);
                await conn.query(
                    `INSERT INTO shipment_file (shipment_id, document_type_id, file_name, file_path, thumbnail_path, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [shipment.id, commonDocType.id, file.originalname, originalPath, thumbPath, file.mimetype, file.size]
                );
            }
        }

        if (isEditing) {
            // We are editing, so just log the specific changes.
            const changes = [];
            if (shipment.airway_bill_no !== airway_bill_no) changes.push(`Airway Bill changed from '${shipment.airway_bill_no || ''}' to '${airway_bill_no}'`);
            if (shipment.flight_no !== flight_no) changes.push(`Flight No changed from '${shipment.flight_no || ''}' to '${flight_no}'`);
            // You could add item change detection here if needed in the future.

            await addHistory(conn, {
                module: 'shipment', moduleId: shipment.id, userId: userId,
                action: 'UNDERLOADING_DETAILS_UPDATED',
                details: { changes: changes.join('; ') || 'Product details updated.' }
            });
        } else {
            // This is a new entry, so move the stage and log the stage change.
            await conn.query(`UPDATE purchase_orders SET shipment_stage_id = 3 WHERE id = ?`, [shipment.po_id]);
            await addHistory(conn, {
                module: 'shipment',
                moduleId: shipment.id,
                userId: userId,
                action: 'STAGE_CHANGED',
                details: {
                    from: 'Planned',
                    to: 'Underloading',
                    payload: { airway_bill_no, flight_no },
                    user: userName
                }
            });
        }

        await conn.commit();
        res.json({ ok: true, shipUniqid, from_stage_id: 2 });
    } catch (e) {
        await conn.rollback();
        res.status(500).json(errPayload("Failed to save air freight details", "DB_ERROR", e.message));
    } finally {
        conn.release();
    }
});

export default router;