import { Router } from "express";
import db from "../db.js";
import multer from "multer";
import path from "path";
import fs from "fs";
import { authenticateMobile } from "../middleware/mobileAuth.js";

const router = Router();

const qcStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = "uploads/quality-check";
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = `${Date.now()}-${Math.random().toString(36).substring(7)}${ext}`;
    cb(null, name);
  }
});

const upload = multer({ storage: qcStorage });
const loggerUploads = upload.fields([
  { name: "tds_file", maxCount: 1 },
  { name: "photos", maxCount: 20 }
]);

router.get("/qc/lots", authenticateMobile, async (req, res) => {
  const status = String(req.query.status || "awaiting");
  const search = String(req.query.search || "");
  const page = Math.max(parseInt(String(req.query.page || "1"), 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || "20"), 10) || 20, 1), 100);
  const offset = (page - 1) * limit;
  const like = `%${search}%`;

  try {
    const where = [];
    const params = [];
    if (status === "awaiting") {
      where.push("ql.status = 'AWAITING_QC'");
    }
    if (status === "in_progress") {
      where.push("ql.status IN ('UNDER_REGRADING')");
    }
    if (status === "completed") {
      where.push("ql.status IN ('QC_COMPLETED','REGRADED_COMPLETED')");
    }
    if (search) {
      where.push("(ql.lot_number LIKE ? OR ql.container_number LIKE ? OR qli.product_name LIKE ?)");
      params.push(like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [countRows] = await db.promise().query(
      `
      SELECT COUNT(DISTINCT ql.id) as total
      FROM qc_lots ql
      LEFT JOIN qc_lot_items qli ON qli.qc_lot_id = ql.id
      ${whereSql}
      `,
      params
    );
    const total = countRows?.[0]?.total || 0;
    const [rows] = await db.promise().query(
      `
      SELECT
        ql.id as lot_id,
        ql.lot_number as lot_no,
        ql.shipment_id,
        ql.container_number as container_no,
        MIN(qli.product_name) as product_name,
        SUM(qli.declared_quantity_units) as qty,
        ql.status,
        ql.created_at
      FROM qc_lots ql
      LEFT JOIN qc_lot_items qli ON qli.qc_lot_id = ql.id
      ${whereSql}
      GROUP BY ql.id
      ORDER BY ql.created_at DESC
      LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );
    res.json({ lots: rows || [], total, page, limit });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to load QC lots" });
  }
});

router.get("/qc/lots/:id", authenticateMobile, async (req, res) => {
  const { id } = req.params;
  try {
    const [[lot]] = await db.promise().query(
      `
      SELECT 
        ql.id as lot_id,
        ql.lot_number as lot_no,
        ql.shipment_id,
        ql.container_number as container_no,
        ql.po_number,
        ql.status,
        ql.created_at,
        s.arrival_date,
        s.confirm_arrival_date,
        s.eta_date,
        s.ship_uniqid,
        s.supplier_logger_installed,
        s.logger_count,
        po.mode_shipment_id,
        v.display_name as vendor_name
      FROM qc_lots ql
      LEFT JOIN shipment s ON s.id = ql.shipment_id
      LEFT JOIN purchase_orders po ON po.id = s.po_id
      LEFT JOIN vendor v ON v.id = s.vendor_id
      WHERE ql.id = ?
      `,
      [id]
    );
    if (!lot) {
      return res.status(404).json({ success: false, message: "QC lot not found" });
    }
    const [items] = await db.promise().query(
      `
      SELECT
        qli.id as item_id,
        qli.qc_lot_id,
        qli.container_id,
        qli.container_no,
        qli.product_id,
        qli.product_name,
        qli.declared_quantity_units,
        qli.declared_quantity_net_weight,
        um.name as uom,
        qi_latest.id as inspection_id,
        qi_latest.decision as inspection_decision,
        qi_latest.status_id as inspection_status_id
      FROM qc_lot_items qli
      LEFT JOIN uom_master um ON um.id = qli.uom_id
      LEFT JOIN qc_inspections qi_latest ON qi_latest.id = (
        SELECT qi.id
        FROM qc_inspections qi
        WHERE qi.qc_lot_item_id = qli.id
        ORDER BY qi.created_at DESC
        LIMIT 1
      )
      WHERE qli.qc_lot_id = ?
      ORDER BY qli.id
      `,
      [id]
    );
    const [[summary]] = await db.promise().query(
      `
      SELECT
        (SELECT COALESCE(SUM(qli.declared_quantity_units), 0) FROM qc_lot_items qli WHERE qli.qc_lot_id = ?) as declared_units,
        (SELECT COALESCE(SUM(qli.declared_quantity_net_weight), 0) FROM qc_lot_items qli WHERE qli.qc_lot_id = ?) as declared_weight,
        (SELECT COUNT(*) FROM qc_inspections qi WHERE qi.qc_lot_id = ?) as inspections_count,
        (SELECT COUNT(*) FROM qc_media qm WHERE qm.qc_lot_id = ?) as media_count,
        (SELECT COALESCE(SUM(qi.accepted_quantity_net_weight), 0) FROM qc_inspections qi WHERE qi.qc_lot_id = ?) as accepted_kg,
        (SELECT COALESCE(SUM(qi.regrade_quantity_net_weight), 0) FROM qc_inspections qi WHERE qi.qc_lot_id = ?) as regrade_kg,
        (SELECT COALESCE(SUM(qi.rejected_quantity_net_weight), 0) FROM qc_inspections qi WHERE qi.qc_lot_id = ?) as rejected_kg
      `,
      [id, id, id, id, id, id, id]
    );
    const [media] = await db.promise().query(
      `
      SELECT id, qc_lot_id, qc_inspection_id, media_type, file_name, file_path, mime_type, size_bytes, created_at
      FROM qc_media
      WHERE qc_lot_id = ?
      ORDER BY created_at DESC
      `,
      [id]
    );
    const [inspections] = await db.promise().query(
      `
      SELECT id, qc_lot_id, qc_lot_item_id, decision, status_id, inspection_date,
             accepted_quantity_units, rejected_quantity_units, regrade_quantity_units,
             accepted_quantity_net_weight, rejected_quantity_net_weight, regrade_quantity_net_weight,
             comments, created_at
      FROM qc_inspections
      WHERE qc_lot_id = ?
      ORDER BY created_at DESC
      `,
      [id]
    );
    const [history] = await db.promise().query(
      `
      SELECT 
        h.id,
        h.module,
        h.module_id,
        h.user_id,
        h.action,
        h.details,
        h.created_at,
        u.name as user_name,
        u.email as user_email
      FROM history h
      LEFT JOIN user u ON u.id = h.user_id
      WHERE (
        (h.module = 'qc_lot' AND h.module_id = ?)
        OR (h.module = 'qc_inspection' AND JSON_EXTRACT(h.details, '$.qc_lot_id') = ?)
      )
      ORDER BY h.created_at DESC
      `,
      [id, id]
    );
    const loggerEnabled = lot?.supplier_logger_installed === "YES";
    const [logger] = loggerEnabled
      ? await db.promise().query(
          `
          SELECT id, serial_no, installation_place FROM shipment_temperature_loggers
          WHERE shipment_id = ? ORDER BY id ASC
          `,
          [lot.shipment_id]
        )
      : [[]];
    const [loggerFiles] = loggerEnabled
      ? await db.promise().query(
          `SELECT id, shipment_logger_id, container_id, file_name, file_path, mime_type, size_bytes, created_at
           FROM qc_lot_logger_files
           WHERE qc_lot_id = ?
           ORDER BY created_at DESC`,
          [id]
        )
      : [[]];
    const [loggerPhotos] = loggerEnabled
      ? await db.promise().query(
          `SELECT id, shipment_logger_id, container_id, file_name, file_path, mime_type, size_bytes, created_at
           FROM qc_lot_logger_photos
           WHERE qc_lot_id = ?
           ORDER BY created_at DESC`,
          [id]
        )
      : [[]];
    const tabsCount = {
      items: items.length,
      media: media.length,
      inspections: inspections.length,
      logger: loggerEnabled ? (logger?.length || 0) : 0,
      history: history.length
    };
    res.json({
      lot,
      summary: {
        declaredUnits: summary?.declared_units || 0,
        declaredWeight: summary?.declared_weight || 0,
        itemsCount: items.length,
        inspectionsCount: summary?.inspections_count || 0,
        mediaCount: summary?.media_count || 0,
        acceptedKg: summary?.accepted_kg || 0,
        regradeKg: summary?.regrade_kg || 0,
        rejectedKg: summary?.rejected_kg || 0
      },
      tabsCount,
      items: items.map((row) => ({
        itemId: row.item_id,
        productName: row.product_name,
        container: row.container_no,
        declaredQtyUnits: row.declared_quantity_units,
        declaredQtyWeight: row.declared_quantity_net_weight,
        uom: row.uom,
        status: row.inspection_decision || row.inspection_status_id || null,
        hasInspection: !!row.inspection_id,
        inspectionId: row.inspection_id || null
      })),
      media: media || [],
      inspections: inspections || [],
      logger: {
        enabled: loggerEnabled,
        supplier_logger_installed: lot?.supplier_logger_installed,
        logger_count: lot?.logger_count,
        loggers: logger || [],
        files: loggerFiles || [],
        photos: loggerPhotos || []
      },
      history: history || []
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to load QC lot details" });
  }
});

router.post("/qc/inspections", authenticateMobile, async (req, res) => {
  const userId = req.mobileUser?.id;
  const {
    qc_lot_id,
    qc_lot_item_id,
    decision,
    remarks,
    accepted_quantity_units,
    rejected_quantity_units,
    regrade_quantity_units
  } = req.body;

  if (!qc_lot_id || !decision) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }

  try {
    const [result] = await db.promise().query(
      `
      INSERT INTO qc_inspections (
        qc_lot_id, qc_lot_item_id, inspection_date, inspected_by, place_of_inspection, decision, status_id,
        accepted_quantity_units, rejected_quantity_units, regrade_quantity_units, comments, created_by
      ) VALUES (?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        qc_lot_id,
        qc_lot_item_id || null,
        userId,
        "Mobile",
        decision,
        3,
        accepted_quantity_units || 0,
        rejected_quantity_units || 0,
        regrade_quantity_units || 0,
        remarks || "",
        userId
      ]
    );
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to create inspection" });
  }
});

router.get("/qc/inspections/:id", authenticateMobile, async (req, res) => {
  const { id } = req.params;
  try {
    const [[inspection]] = await db.promise().query(
      `
      SELECT id, qc_lot_id, qc_lot_item_id, decision, status_id, inspection_date,
             accepted_quantity_units, rejected_quantity_units, regrade_quantity_units,
             accepted_quantity_net_weight, rejected_quantity_net_weight, regrade_quantity_net_weight,
             comments, created_at
      FROM qc_inspections
      WHERE id = ?
      `,
      [id]
    );
    if (!inspection) {
      return res.status(404).json({ success: false, message: "Inspection not found" });
    }
    res.json(inspection);
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to load inspection" });
  }
});

router.put("/qc/inspections/:id", authenticateMobile, async (req, res) => {
  const { id } = req.params;
  const {
    decision,
    remarks,
    accepted_quantity_units,
    rejected_quantity_units,
    regrade_quantity_units,
    accepted_quantity_net_weight,
    rejected_quantity_net_weight,
    regrade_quantity_net_weight
  } = req.body;
  try {
    await db.promise().query(
      `
      UPDATE qc_inspections
      SET decision = ?, comments = ?, accepted_quantity_units = ?, rejected_quantity_units = ?,
          regrade_quantity_units = ?, accepted_quantity_net_weight = ?, rejected_quantity_net_weight = ?,
          regrade_quantity_net_weight = ?
      WHERE id = ?
      `,
      [
        decision,
        remarks || "",
        accepted_quantity_units || 0,
        rejected_quantity_units || 0,
        regrade_quantity_units || 0,
        accepted_quantity_net_weight || null,
        rejected_quantity_net_weight || null,
        regrade_quantity_net_weight || null,
        id
      ]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to update inspection" });
  }
});

router.post("/qc/inspections/:id/media", authenticateMobile, upload.array("media", 10), async (req, res) => {
  const userId = req.mobileUser?.id;
  const { id } = req.params;
  const files = req.files || [];
  if (!files.length) {
    return res.status(400).json({ success: false, message: "No media uploaded" });
  }

  try {
    const [[inspection]] = await db.promise().query(
      "SELECT id, qc_lot_id FROM qc_inspections WHERE id = ?",
      [id]
    );
    if (!inspection) {
      return res.status(404).json({ success: false, message: "Inspection not found" });
    }

    const values = files.map((file) => ([
      inspection.qc_lot_id,
      inspection.id,
      "PHOTO",
      file.originalname,
      `uploads/quality-check/${file.filename}`,
      null,
      file.mimetype,
      file.size,
      userId
    ]));

    await db.promise().query(
      `
      INSERT INTO qc_media (
        qc_lot_id, qc_inspection_id, media_type, file_name, file_path,
        thumbnail_path, mime_type, size_bytes, created_by
      ) VALUES ?
      `,
      [values]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to upload media" });
  }
});

router.get("/qc/inspections", authenticateMobile, async (req, res) => {
  const qcLotId = req.query.qc_lot_id;
  if (!qcLotId) {
    return res.status(400).json({ success: false, message: "qc_lot_id is required" });
  }
  try {
    const [rows] = await db.promise().query(
      `
      SELECT id, qc_lot_id, decision, status_id, inspection_date,
             accepted_quantity_units, rejected_quantity_units, regrade_quantity_units,
             comments, created_at
      FROM qc_inspections
      WHERE qc_lot_id = ?
      ORDER BY created_at DESC
      `,
      [qcLotId]
    );
    res.json(rows || []);
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to load inspections" });
  }
});

router.get("/qc/media", authenticateMobile, async (req, res) => {
  const qcLotId = req.query.qc_lot_id;
  const inspectionId = req.query.qc_inspection_id;
  if (!qcLotId && !inspectionId) {
    return res.status(400).json({ success: false, message: "qc_lot_id or qc_inspection_id is required" });
  }
  try {
    const where = [];
    const params = [];
    if (qcLotId) {
      where.push("qc_lot_id = ?");
      params.push(qcLotId);
    }
    if (inspectionId) {
      where.push("qc_inspection_id = ?");
      params.push(inspectionId);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await db.promise().query(
      `
      SELECT id, qc_lot_id, qc_inspection_id, media_type, file_name, file_path, mime_type, size_bytes, created_at
      FROM qc_media
      ${whereSql}
      ORDER BY created_at DESC
      `,
      params
    );
    res.json(rows || []);
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to load media" });
  }
});

router.get("/qc/lots/:id/history", authenticateMobile, async (req, res) => {
  try {
    const { id } = req.params;
    const [history] = await db.promise().query(
      `
      SELECT 
        h.id,
        h.module,
        h.module_id,
        h.user_id,
        h.action,
        h.details,
        h.created_at,
        u.name as user_name,
        u.email as user_email
      FROM history h
      LEFT JOIN user u ON u.id = h.user_id
      WHERE (
        (h.module = 'qc_lot' AND h.module_id = ?)
        OR (h.module = 'qc_inspection' AND JSON_EXTRACT(h.details, '$.qc_lot_id') = ?)
        OR (h.module = 'qc_regrading_job' AND EXISTS (
          SELECT 1 FROM qc_regrading_jobs rj WHERE rj.id = h.module_id AND rj.qc_lot_id = ?
        ))
        OR (h.module = 'qc_regrading_daily_log' AND EXISTS (
          SELECT 1 FROM qc_regrading_daily_logs rdl 
          JOIN qc_regrading_jobs rj ON rj.id = rdl.qc_regrading_job_id
          WHERE rdl.id = h.module_id AND rj.qc_lot_id = ?
        ))
      )
      ORDER BY h.created_at DESC
      `,
      [id, id, id, id]
    );
    res.json(history || []);
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to fetch lot history" });
  }
});

router.get("/qc/lots/:id/logger-details", authenticateMobile, async (req, res) => {
  try {
    const { id } = req.params;
    const [[lot]] = await db.promise().query("SELECT id, shipment_id FROM qc_lots WHERE id = ?", [id]);
    if (!lot) {
      return res.status(404).json({ success: false, message: "QC lot not found" });
    }
    if (!lot.shipment_id) {
      return res.json({ enabled: false });
    }
    const [[shipment]] = await db
      .promise()
      .query("SELECT id, ship_uniqid, supplier_logger_installed, logger_count FROM shipment WHERE id = ?", [
        lot.shipment_id
      ]);
    if (!shipment || shipment.supplier_logger_installed !== "YES") {
      return res.json({
        enabled: false,
        supplier_logger_installed: shipment?.supplier_logger_installed || null
      });
    }
    const [loggers] = await db
      .promise()
      .query("SELECT id, serial_no, installation_place FROM shipment_temperature_loggers WHERE shipment_id = ? ORDER BY id ASC", [
        shipment.id
      ]);
    const [containers] = await db
      .promise()
      .query("SELECT DISTINCT container_id, container_no FROM qc_lot_items WHERE qc_lot_id = ? ORDER BY container_no", [
        lot.id
      ]);
    const [files] = await db.promise().query(
      `SELECT id, shipment_logger_id, container_id, file_name, file_path, mime_type, size_bytes, created_at
       FROM qc_lot_logger_files
       WHERE qc_lot_id = ?
       ORDER BY created_at DESC`,
      [lot.id]
    );
    const [photos] = await db.promise().query(
      `SELECT id, shipment_logger_id, container_id, file_name, file_path, mime_type, size_bytes, created_at
       FROM qc_lot_logger_photos
       WHERE qc_lot_id = ?
       ORDER BY created_at DESC`,
      [lot.id]
    );
    res.json({
      enabled: true,
      shipment_id: shipment.id,
      qc_lot_id: lot.id,
      supplier_logger_installed: shipment.supplier_logger_installed,
      logger_count: shipment.logger_count,
      loggers: loggers || [],
      containers: containers || [],
      files: files || [],
      photos: photos || []
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to load logger details" });
  }
});

router.post("/qc/lots/:id/logger-attachments", authenticateMobile, loggerUploads, async (req, res) => {
  const userId = req.mobileUser?.id;
  const { id } = req.params;
  const { shipment_logger_id, container_id } = req.body;
  const loggerId = shipment_logger_id ? parseInt(shipment_logger_id, 10) : null;
  const containerId = container_id ? parseInt(container_id, 10) : null;
  const tdsFile = req.files?.tds_file?.[0] || null;
  const photos = req.files?.photos || [];
  if (!tdsFile && photos.length === 0) {
    return res.status(400).json({ success: false, message: "No files uploaded" });
  }
  try {
    const [[lot]] = await db.promise().query("SELECT id, shipment_id FROM qc_lots WHERE id = ?", [id]);
    if (!lot) {
      return res.status(404).json({ success: false, message: "QC lot not found" });
    }
    if (loggerId) {
      const [[loggerRow]] = await db
        .promise()
        .query("SELECT id FROM shipment_temperature_loggers WHERE id = ? AND shipment_id = ?", [loggerId, lot.shipment_id]);
      if (!loggerRow) {
        return res.status(400).json({ success: false, message: "Invalid shipment logger" });
      }
    }
    if (tdsFile) {
      await db.promise().query(
        `INSERT INTO qc_lot_logger_files (qc_lot_id, shipment_logger_id, container_id, file_name, file_path, mime_type, size_bytes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, loggerId, containerId, tdsFile.originalname, `uploads/quality-check/${tdsFile.filename}`, tdsFile.mimetype, tdsFile.size, userId]
      );
    }
    if (photos.length) {
      const values = photos.map((photo) => ([
        id,
        loggerId,
        containerId,
        photo.originalname,
        `uploads/quality-check/${photo.filename}`,
        photo.mimetype,
        photo.size,
        userId
      ]));
      await db.promise().query(
        `INSERT INTO qc_lot_logger_photos (qc_lot_id, shipment_logger_id, container_id, file_name, file_path, mime_type, size_bytes, created_by)
         VALUES ?`,
        [values]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to upload logger attachments" });
  }
});

router.delete("/qc/lots/:id/logger-attachments", authenticateMobile, async (req, res) => {
  const { fileId, photoId } = req.body || {};
  if (!fileId && !photoId) {
    return res.status(400).json({ success: false, message: "fileId or photoId is required" });
  }
  try {
    if (fileId) {
      await db.promise().query("DELETE FROM qc_lot_logger_files WHERE id = ?", [fileId]);
    }
    if (photoId) {
      await db.promise().query("DELETE FROM qc_lot_logger_photos WHERE id = ?", [photoId]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to delete logger attachment" });
  }
});

export default router;
