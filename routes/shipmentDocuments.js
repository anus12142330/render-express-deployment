import express from "express";
import db from "../db.js";

const router = express.Router();



const errPayload = (message, type = "APP_ERROR", hint) => ({ error: { message, type, hint } });
const toInt = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const bool01 = (v) => (v ? 1 : 0);

/* ------------------------- LIST (with search & paging) ------------------------- */
/*
  GET /api/shipment-documents?limit=25&offset=0&q=plan
  Returns: { data, total }
  q matches:
    - shipment_stage number (exact when numeric)
    - document_type.code / document_type.name (LIKE)
*/
router.get("/", async (req, res) => {
    try {
        const limit  = Math.min(Math.max(toInt(req.query.limit, 25), 1), 500);
        const offset = Math.max(toInt(req.query.offset, 0), 0);
        const q      = String(req.query.q || req.query.search || "").trim();

        const params = [];
        let where = "1=1";

        if (q) {
            if (/^\d+$/.test(q)) {
                where += " AND (sd.shipment_stage = ? OR dt.code LIKE ? OR dt.name LIKE ? OR ss.name LIKE ?)";
                params.push(Number(q), `%${q}%`, `%${q}%`, `%${q}%`);
            } else {
                where += " AND (dt.code LIKE ? OR dt.name LIKE ? OR ss.name LIKE ?)";
                params.push(`%${q}%`, `%${q}%`, `%${q}%`);
            }
        }

        const [rows] = await db.promise().query(
            `
      SELECT
        sd.id,
        sd.shipment_stage,
        sd.document_type_id,
        sd.is_required + 0 AS is_required,
        dt.code AS doc_code,
        dt.name AS doc_name,
        ss.name AS stage_name
      FROM shipment_document sd
      JOIN document_type  dt ON dt.id = sd.document_type_id
      JOIN shipment_stage ss ON ss.id = sd.shipment_stage
      WHERE ${where}
      ORDER BY ss.sort_order ASC, sd.shipment_stage ASC, dt.name ASC, dt.code ASC
      LIMIT ? OFFSET ?
      `,
            [...params, limit, offset]
        );

        const [[{ total }]] = await db.promise().query(
            `
      SELECT COUNT(*) AS total
      FROM shipment_document sd
      JOIN document_type  dt ON dt.id = sd.document_type_id
      JOIN shipment_stage ss ON ss.id = sd.shipment_stage
      WHERE ${where}
      `,
            params
        );

        res.json({ data: rows, total });
    } catch (e) {
        res.status(500).json(errPayload("Failed to list shipment documents", "DB_ERROR", e.message));
    }
});


/* ------------------------------- GET by id ----------------------------------- */
router.get("/:id", async (req, res) => {
    try {
        const id = toInt(req.params.id);
        const [rows] = await db.promise().query(
            `SELECT id, shipment_stage, document_type_id, is_required, is_received
       FROM shipment_document WHERE id = ?`,
            [id]
        );
        if (!rows.length) return res.status(404).json(errPayload("Not found", "NOT_FOUND"));
        res.json(rows[0]);
    } catch (e) {
        res.status(500).json(errPayload("Failed to fetch shipment document", "DB_ERROR", e.message));
    }
});

/* --------------------------------- CREATE ----------------------------------- */
router.post("/", async (req, res) => {
    try {
        const payload = sanitize(req.body);
        const err = validate(payload);
        if (err) return res.status(400).json(errPayload("Validation failed", "VALIDATION", err));

        await db.promise().query(
            `INSERT INTO shipment_document (shipment_stage, document_type_id, is_required, is_received)
       VALUES (?, ?, ?, ?)`,
            [
                payload.shipment_stage,
                payload.document_type_id,
                bool01(payload.is_required),
                bool01(payload.is_received),
            ]
        );
        res.status(201).json({ ok: true });
    } catch (e) {
        if (e && e.code === "ER_DUP_ENTRY") {
            return res
                .status(409)
                .json(errPayload("Duplicate", "DUPLICATE", "This stage already contains that document type"));
        }
        res.status(500).json(errPayload("Failed to create shipment document", "DB_ERROR", e.message));
    }
});

/* ---------------------------------- UPDATE ---------------------------------- */
router.put("/:id", async (req, res) => {
    try {
        const id = toInt(req.params.id);
        const payload = sanitize(req.body);
        const err = validate(payload);
        if (err) return res.status(400).json(errPayload("Validation failed", "VALIDATION", err));

        const [r] = await db.promise().query(
            `UPDATE shipment_document
       SET shipment_stage = ?, document_type_id = ?, is_required = ?, is_received = ?
       WHERE id = ?`,
            [
                payload.shipment_stage,
                payload.document_type_id,
                bool01(payload.is_required),
                bool01(payload.is_received),
                id,
            ]
        );
        if (!r.affectedRows) return res.status(404).json(errPayload("Not found", "NOT_FOUND"));
        res.json({ ok: true });
    } catch (e) {
        if (e && e.code === "ER_DUP_ENTRY") {
            return res
                .status(409)
                .json(errPayload("Duplicate", "DUPLICATE", "This stage already contains that document type"));
        }
        res.status(500).json(errPayload("Failed to update shipment document", "DB_ERROR", e.message));
    }
});

/* --------------------------------- DELETE ----------------------------------- */
router.delete("/:id", async (req, res) => {
    try {
        const id = toInt(req.params.id);
        const [r] = await db.promise().query(`DELETE FROM shipment_document WHERE id = ?`, [id]);
        if (!r.affectedRows) return res.status(404).json(errPayload("Not found", "NOT_FOUND"));
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json(errPayload("Failed to delete shipment document", "DB_ERROR", e.message));
    }
});

/* ------------------------------- utilities ---------------------------------- */
function sanitize(b) {
    return {
        shipment_stage: toInt(b.shipment_stage),
        document_type_id: toInt(b.document_type_id),
        is_required: b.is_required ? 1 : 0,
        is_received: b.is_received ? 1 : 0,
    };
}
function validate(p) {
    if (!p.shipment_stage) return "shipment_stage is required";
    if (!p.document_type_id) return "document_type_id is required";
    return null;
}

export default router;
