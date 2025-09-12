import express from "express";
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import mysql from 'mysql2/promise';
import crypto from 'crypto';
import db from "../db.js";

const router = express.Router();
const errPayload = (message, type = "APP_ERROR", hint) => ({ error: { message, type, hint } });

/* ---------- storage for uploads ---------- */
const UP_DIR = path.resolve("uploads/shipment");
fs.mkdirSync(UP_DIR, { recursive: true });
const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UP_DIR),
    filename: (_req, file, cb) =>
        cb(null, crypto.randomBytes(12).toString("hex") + path.extname(file.originalname || "")),
});
const upload = multer({ storage });

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
router.get("/board", async (_req, res) => {
    try {
        const [rows] = await db.promise().query(
            `
      SELECT
        s.ship_uniqid,
        s.id AS shipment_id,
        s.vessel_name,
        po.po_number,
        po.vendor_id,
        v.display_name as vendor_name,
        po.shipment_stage_id AS stage_id,
        po.po_uniqid   AS po_uniqid,
        dpl.name as loading_name,dpd.name as discharge_name
      FROM shipment s
      JOIN purchase_orders po ON po.id = s.po_id
      LEFT JOIN vendor v ON v.id = s.vendor_id
      LEFT JOIN delivery_place dpl ON dpl.id=po.port_loading
      LEFT JOIn delivery_place dpd ON dpd.id=po.port_discharge
      WHERE po.shipment_stage_id > 0
      ORDER BY po.shipment_stage_id, s.id DESC
      `
        );
        res.json(rows || []);
    } catch (e) {
        res.status(500).json({ error: { message: "Failed to load board", type: "DB_ERROR", hint: e.message } });
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
    SELECT s.*, po.shipment_stage_id AS stage_id, st.name AS stage_name,
           v.display_name AS vendor_name, dpl.name AS loading_name, dpd.name AS discharge_name
      FROM shipment s
      JOIN purchase_orders po ON po.id = s.po_id
 LEFT JOIN shipment_stage st ON st.id = po.shipment_stage_id
 LEFT JOIN vendor v ON v.id = s.vendor_id
 LEFT JOIN delivery_place dpl ON dpl.id = po.port_loading
 LEFT JOIN delivery_place dpd ON dpd.id = po.port_discharge
     WHERE s.ship_uniqid = ? LIMIT 1`, [id]);
    if (!row) return res.status(404).json({ error: { message: "Not found" } });
    res.json(row);
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


// GET /api/shipment/files/:fileId
router.get("/files/:fileId", async (req, res) => {
    try {
        const fileId = req.params.fileId;
        const [[f]] = await db.promise().query(
            `SELECT file_path, file_name, mime_type FROM shipment_file WHERE id=? LIMIT 1`,
            [fileId]
        );
        if (!f) return res.status(404).json({ error: { message: "File not found" } });

        const abs = path.isAbsolute(f.file_path) ? f.file_path : path.join(UPLOAD_ROOT, f.file_path);
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

        const current = Number(row.shipment_stage_id || 0);
         // Disallow backwards
             if (toStageId < current) {
               return res.status(400).json({ error: { message: "Cannot move backwards" } });
             }
             if (toStageId === current) {
               return res.json({ ok: true, updated: { from_stage_id: current } });
             }
         // Enforce one-at-a-time forward
             if (toStageId > current + 1) {
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

        // write history
        await db.promise().query(
            `INSERT INTO shipment_stage_history
         (shipment_id, from_stage_id, to_stage_id, changed_at, changed_by, payload_json)
       VALUES (?, ?, ?, NOW(), ?, JSON_OBJECT('fields', JSON_OBJECT(${Object.keys(fields).map(k=> `'${k}', ?`).join(",")})))`,
            [row.shipment_id, current, toStageId, userId, ...Object.values(fields)]
        );

        res.json({ ok: true, updated: { from_stage_id: current } });
    } catch (e) {
        res.status(500).json({ error: { message: "Failed to move stage", type: "DB_ERROR", hint: e.message } });
    }
});

/* ---------------- create shipment from PO ---------------- */

router.post("/create-from-po/:poUniqid", async (req, res) => {
    try {
        const userId = req.session?.user?.id ?? null;
        if (!userId) {
            return res.status(401).json({ error: { message: "Unauthorized", type: "AUTH" } });
        }

        const poUniqid = req.params.poUniqid;
        const newShipUniq = () =>
            "SHP-" + crypto.randomBytes(6).toString("hex").toUpperCase();

        // 1) find PO
        const [[po]] = await db.promise().query(
            `SELECT id, vendor_id, po_number, po_uniqid
         FROM purchase_orders
        WHERE po_uniqid = ?
        LIMIT 1`,
            [poUniqid]
        );
        if (!po) return res.status(404).json(errPayload("Purchase order not found"));

        // 2) create shipment
        const ship_uniqid = newShipUniq();
        const {
            vessel_name = null,
            etd_date = null,
            eta_date = null,
            sailed_date = null,
            is_transhipment = 0,
        } = req.body || {};

        const [ins] = await db.promise().query(
            `INSERT INTO shipment
         (ship_uniqid, po_id, vendor_id, vessel_name, etd_date, eta_date, sailing_date, confirm_sailing_date, is_transhipment, created_by, created_date)
       VALUES (?,?,?,?,?,?,?,NULL,?, ?, NOW())`,
            [ship_uniqid, po.id, po.vendor_id, vessel_name, etd_date, eta_date, sailed_date, Number(is_transhipment) ? 1 : 0, userId,]
        );
        const shipmentId = ins.insertId;

        // 3) transshipment ports (optional)
        const ports = Array.isArray(req.body.ports) ? req.body.ports : [];
        for (const p of ports) {
            const portId = Number(p.port_id || 0) || null;
            const orderNo = Number(p.order_no || 0) || null;
            if (portId && orderNo) {
                await db.promise().query(
                    `INSERT INTO shipment_transhipment (shipment_id, transhipment_port_id, order_no) VALUES (?,?,?)`,
                    [shipmentId, portId, orderNo]
                );
            }
        }

        // 4) mark PO stage = 1 and write history
        await db.promise().query(`UPDATE purchase_orders SET shipment_stage_id = 1 WHERE id = ?`, [po.id]);
        await db.promise().query(
            `INSERT INTO shipment_stage_history
         (shipment_id, from_stage_id, to_stage_id, changed_at, changed_by, payload_json)
       VALUES (?, 0, 1, NOW(),?, JSON_OBJECT('po_id', ?, 'po_number', ?))`,
            [shipmentId, userId, po.id, po.po_number]
        );

        res.json({ id: shipmentId, ship_uniqid });
    } catch (e) {
        res.status(500).json(errPayload("Failed to create shipment", "DB_ERROR", e.message));
    }
});

/* ---------- upload shipment files ---------- */
router.post("/:shipUniqid/upload", upload.array("files", 20), async (req, res) => {
    try {
        const shipUniqid = req.params.shipUniqid;
        const docTypeId = Number(req.body.document_type_id || 0) || null;
        const refNo   = req.body.ref_no || null;
        const refDate = req.body.ref_date || null;

        const [[sh]] = await db.promise().query(
            `SELECT id FROM shipment WHERE ship_uniqid = ? LIMIT 1`,
            [shipUniqid]
        );
        if (!sh) return res.status(404).json(errPayload("Shipment not found"));

        const files = req.files || [];
        for (const f of files) {
            const relPath = path.posix.join("uploads", "shipment", path.basename(f.path));
            await db.promise().query(
                `INSERT INTO shipment_file
           (shipment_id, document_type_id, file_name, file_path, mime_type, size_bytes, uploaded_at, ref_no, ref_date)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ?)`,
                [sh.id, docTypeId, f.originalname, relPath, f.mimetype, f.size, refNo, refDate]
            );
        }
        res.json({ ok: true, count: files.length });
    } catch (e) {
        res.status(500).json(errPayload("Failed to upload files", "UPLOAD_ERROR", e.message));
    }
});

export default router;