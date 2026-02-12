// server/routes/qualityCheck.js
import { Router } from 'express';
import db from '../db.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { requireAuth, requirePerm } from '../middleware/authz.js';
import { isInventoryMovementEnabled } from '../src/utils/inventoryHelper.js';

const require = createRequire(import.meta.url);
const inventoryService = require('../src/modules/inventory/inventory.service.cjs');

const router = Router();

// Multer configuration for QC media uploads
const qcStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/quality-check';
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

// Helper function for error responses
const errPayload = (message, code, details) => ({
  error: { message, code, details }
});

// Helper function for queries
const q = async (sql, p = []) => (await db.promise().query(sql, p))[0];

// Helper function to add history
const addHistory = async (conn, { module, moduleId, userId, action, details }) => {
  if (!module || !moduleId || !userId || !action) return;
  await conn.query(
    'INSERT INTO history (module, module_id, user_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
    [module, moduleId, userId, action, JSON.stringify(details || {})]
  );
};

// Helper function to check if user is active
const checkUserActive = async (userId) => {
  if (!userId) return false;
  const [[user]] = await db.promise().query('SELECT is_inactive FROM `user` WHERE id = ?', [userId]);
  return user && user.is_inactive === 0;
};

// ============================================================
// QC LOTS ENDPOINTS
// ============================================================

// GET /api/quality-check/lots - List all QC lots with filters and pagination
router.get('/lots', requireAuth, async (req, res) => {
  try {
    const {
      status,
      container_number,
      origin_country,
      po_number,
      date_from,
      date_to,
      search,
      page = '1',
      pageSize = '25'
    } = req.query;

    // Parse pagination parameters
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const pageSizeNum = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 200);
    const offset = (pageNum - 1) * pageSizeNum;

    let whereClauses = ['1=1'];
    const params = [];

    if (status) {
      whereClauses.push('ql.status = ?');
      params.push(status);
    }

    if (container_number) {
      whereClauses.push('ql.container_number LIKE ?');
      params.push(`%${container_number}%`);
    }

    if (origin_country) {
      whereClauses.push('ql.origin_country LIKE ?');
      params.push(`%${origin_country}%`);
    }

    if (po_number) {
      whereClauses.push('ql.po_number LIKE ?');
      params.push(`%${po_number}%`);
    }

    if (date_from) {
      whereClauses.push('DATE(ql.created_at) >= ?');
      params.push(date_from);
    }

    if (date_to) {
      whereClauses.push('DATE(ql.created_at) <= ?');
      params.push(date_to);
    }

    if (search) {
      whereClauses.push(`(
        ql.lot_number LIKE ? OR
        ql.container_number LIKE ? OR
        ql.po_number LIKE ? OR
        ql.origin_country LIKE ?
      )`);
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    // Get total count
    const [countRows] = await db.promise().query(`
      SELECT COUNT(DISTINCT ql.id) as total
      FROM qc_lots ql
      LEFT JOIN shipment s ON s.id = ql.shipment_id
      LEFT JOIN vendor v ON v.id = s.vendor_id
      LEFT JOIN qc_lot_items qli ON qli.qc_lot_id = ql.id
      WHERE ${whereClauses.join(' AND ')}
    `, params);

    const total = countRows[0]?.total || 0;

    // Get paginated rows
    const [rows] = await db.promise().query(`
      SELECT 
        ql.id,
        ql.lot_number,
        ql.container_number,
        ql.origin_country,
        ql.origin_farm_market,
        ql.po_number,
        ql.arrival_date_time,
        ql.status,
        ql.created_at,
        ql.updated_at,
        s.ship_uniqid,
        s.arrival_date,
        s.confirm_arrival_date,
        s.eta_date,
        po.mode_shipment_id,
        v.display_name as vendor_name,
        COUNT(DISTINCT qli.id) as item_count,
        SUM(qli.declared_quantity_units) as total_quantity_units,
        SUM(qli.declared_quantity_net_weight) as total_quantity_net_weight,
        GROUP_CONCAT(DISTINCT p.product_name ORDER BY p.product_name SEPARATOR ', ') as products
      FROM qc_lots ql
      LEFT JOIN shipment s ON s.id = ql.shipment_id
      LEFT JOIN purchase_orders po ON po.id = s.po_id
      LEFT JOIN vendor v ON v.id = s.vendor_id
      LEFT JOIN qc_lot_items qli ON qli.qc_lot_id = ql.id
      LEFT JOIN products p ON p.id = qli.product_id
      WHERE ${whereClauses.join(' AND ')}
      GROUP BY ql.id
      ORDER BY ql.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, pageSizeNum, offset]);

    res.json({
      rows: rows || [],
      total: total,
      page: pageNum,
      pageSize: pageSizeNum
    });
  } catch (e) {
    console.error('Error fetching QC lots:', e);
    res.status(500).json(errPayload('Failed to fetch QC lots', 'DB_ERROR', e.message));
  }
});

// GET /api/quality-check/lots/:id - Get single QC lot with items
router.get('/lots/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const [lots] = await db.promise().query(`
      SELECT 
        ql.*,
        s.ship_uniqid,
        s.arrival_date,
        s.confirm_arrival_date,
        s.eta_date,
        po.mode_shipment_id,
        v.display_name as vendor_name,
        u1.name as created_by_name,
        u2.name as updated_by_name
      FROM qc_lots ql
      LEFT JOIN shipment s ON s.id = ql.shipment_id
      LEFT JOIN purchase_orders po ON po.id = s.po_id
      LEFT JOIN vendor v ON v.id = s.vendor_id
      LEFT JOIN \`user\` u1 ON u1.id = ql.created_by
      LEFT JOIN \`user\` u2 ON u2.id = ql.updated_by
      WHERE ql.id = ?
    `, [id]);

    if (lots.length === 0) {
      return res.status(404).json(errPayload('QC lot not found', 'NOT_FOUND'));
    }

    const [items] = await db.promise().query(`
      SELECT 
        qli.*,
        um.name as uom_name,
        (SELECT pd.packing_alias
         FROM product_details pd
         WHERE pd.product_id = qli.product_id
         ORDER BY pd.id ASC
         LIMIT 1) as packing_alias
      FROM qc_lot_items qli
      LEFT JOIN uom_master um ON um.id = qli.uom_id
      WHERE qli.qc_lot_id = ?
      ORDER BY qli.id
    `, [id]);

    res.json({
      ...lots[0],
      items
    });
  } catch (e) {
    console.error('Error fetching QC lot:', e);
    res.status(500).json(errPayload('Failed to fetch QC lot', 'DB_ERROR', e.message));
  }
});

// GET /api/quality-check/lots/:id/logger-details - Get shipment logger details + QC logger attachments
router.get('/lots/:id/logger-details', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const [[lot]] = await db.promise().query(
      'SELECT id, shipment_id FROM qc_lots WHERE id = ?',
      [id]
    );

    if (!lot) {
      return res.status(404).json(errPayload('QC lot not found', 'NOT_FOUND'));
    }

    if (!lot.shipment_id) {
      return res.json({ enabled: false });
    }

    const [[shipment]] = await db.promise().query(
      'SELECT id, ship_uniqid, supplier_logger_installed, logger_count FROM shipment WHERE id = ?',
      [lot.shipment_id]
    );

    if (!shipment || shipment.supplier_logger_installed !== 'YES') {
      return res.json({
        enabled: false,
        supplier_logger_installed: shipment?.supplier_logger_installed || null
      });
    }

    const [loggers] = await db.promise().query(
      'SELECT id, serial_no, installation_place FROM shipment_temperature_loggers WHERE shipment_id = ? ORDER BY id ASC',
      [shipment.id]
    );

    const [containers] = await db.promise().query(
      'SELECT DISTINCT container_id, container_no FROM qc_lot_items WHERE qc_lot_id = ? ORDER BY container_no',
      [lot.id]
    );

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
  } catch (e) {
    console.error('Error fetching logger details:', e);
    res.status(500).json(errPayload('Failed to load logger details', 'DB_ERROR', e.message));
  }
});

const loggerUploads = upload.fields([
  { name: 'tds_file', maxCount: 1 },
  { name: 'photos', maxCount: 20 }
]);

// POST /api/quality-check/lots/:id/logger-attachments - Upload logger TDS + photos
router.post('/lots/:id/logger-attachments', requireAuth, requirePerm('QualityCheck', 'edit'), loggerUploads, async (req, res) => {
  const userId = req.session?.user?.id;
  const conn = await db.promise().getConnection();

  try {
    const { id } = req.params;
    const { shipment_logger_id, container_id } = req.body;

    const loggerId = shipment_logger_id ? parseInt(shipment_logger_id, 10) : null;
    const containerId = container_id ? parseInt(container_id, 10) : null;

    const [[lot]] = await conn.query(
      'SELECT id, shipment_id FROM qc_lots WHERE id = ?',
      [id]
    );

    if (!lot) {
      return res.status(404).json(errPayload('QC lot not found', 'NOT_FOUND'));
    }

    if (!lot.shipment_id) {
      return res.status(400).json(errPayload('Shipment not linked to this lot', 'VALIDATION_ERROR'));
    }

    if (loggerId) {
      const [[loggerRow]] = await conn.query(
        'SELECT id FROM shipment_temperature_loggers WHERE id = ? AND shipment_id = ?',
        [loggerId, lot.shipment_id]
      );
      if (!loggerRow) {
        return res.status(400).json(errPayload('Invalid shipment logger', 'VALIDATION_ERROR'));
      }
    }

    const tdsFile = req.files?.tds_file?.[0] || null;
    const photos = req.files?.photos || [];

    if (!tdsFile && photos.length === 0) {
      return res.status(400).json(errPayload('No files uploaded', 'VALIDATION_ERROR'));
    }

    await conn.beginTransaction();

    if (tdsFile) {
      const loggerCondition = loggerId ? 'shipment_logger_id = ?' : 'shipment_logger_id IS NULL';
      const containerCondition = containerId ? 'container_id = ?' : 'container_id IS NULL';
      const deleteParams = [id];
      if (loggerId) deleteParams.push(loggerId);
      if (containerId) deleteParams.push(containerId);

      await conn.query(
        `DELETE FROM qc_lot_logger_files WHERE qc_lot_id = ? AND ${loggerCondition} AND ${containerCondition}`,
        deleteParams
      );

      await conn.query(
        `INSERT INTO qc_lot_logger_files (
          qc_lot_id, shipment_id, shipment_logger_id, container_id,
          file_name, file_path, mime_type, size_bytes, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          lot.id,
          lot.shipment_id,
          loggerId,
          containerId,
          tdsFile.originalname,
          `uploads/quality-check/${tdsFile.filename}`,
          tdsFile.mimetype,
          tdsFile.size,
          userId || null
        ]
      );
    }

    if (photos.length > 0) {
      const photoValues = photos.map(file => ([
        lot.id,
        lot.shipment_id,
        loggerId,
        containerId,
        file.originalname,
        `uploads/quality-check/${file.filename}`,
        file.mimetype,
        file.size,
        userId || null
      ]));

      await conn.query(
        `INSERT INTO qc_lot_logger_photos (
          qc_lot_id, shipment_id, shipment_logger_id, container_id,
          file_name, file_path, mime_type, size_bytes, created_by
        ) VALUES ?`,
        [photoValues]
      );
    }

    await conn.commit();
    res.json({ message: 'Logger attachments saved' });
  } catch (e) {
    await conn.rollback();
    console.error('Error saving logger attachments:', e);
    res.status(500).json(errPayload('Failed to save logger attachments', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// DELETE /api/quality-check/lots/:id/logger-attachments - Delete logger TDS or photo
router.delete('/lots/:id/logger-attachments', requireAuth, requirePerm('QualityCheck', 'edit'), async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    const { id } = req.params;
    const { file_id, photo_id } = req.body || {};

    const [[lot]] = await conn.query(
      'SELECT id FROM qc_lots WHERE id = ?',
      [id]
    );
    if (!lot) {
      return res.status(404).json(errPayload('QC lot not found', 'NOT_FOUND'));
    }

    if (file_id) {
      const [result] = await conn.query(
        'DELETE FROM qc_lot_logger_files WHERE id = ? AND qc_lot_id = ?',
        [file_id, id]
      );
      if (result.affectedRows === 0) {
        return res.status(404).json(errPayload('Logger file not found', 'NOT_FOUND'));
      }
    } else if (photo_id) {
      const [result] = await conn.query(
        'DELETE FROM qc_lot_logger_photos WHERE id = ? AND qc_lot_id = ?',
        [photo_id, id]
      );
      if (result.affectedRows === 0) {
        return res.status(404).json(errPayload('Logger photo not found', 'NOT_FOUND'));
      }
    } else {
      return res.status(400).json(errPayload('Missing file_id or photo_id', 'VALIDATION_ERROR'));
    }

    res.json({ message: 'Logger attachment deleted' });
  } catch (e) {
    console.error('Error deleting logger attachment:', e);
    res.status(500).json(errPayload('Failed to delete logger attachment', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// POST /api/quality-check/lots - Create new QC lot (manual creation)
router.post('/lots', requireAuth, requirePerm('QualityCheck', 'create'), async (req, res) => {
  const userId = req.session?.user?.id;
  const conn = await db.promise().getConnection();

  try {
    await conn.beginTransaction();

    const {
      lot_number,
      shipment_id,
      container_number,
      origin_country,
      origin_farm_market,
      po_id,
      po_number,
      grn_reference,
      invoice_reference,
      arrival_date_time,
      items
    } = req.body;

    // Check if lot_number already exists
    const [existing] = await conn.query('SELECT id FROM qc_lots WHERE lot_number = ?', [lot_number]);
    if (existing.length > 0) {
      await conn.rollback();
      return res.status(400).json(errPayload('Lot number already exists', 'DUPLICATE'));
    }

    // Insert QC lot
    const [result] = await conn.query(`
      INSERT INTO qc_lots (
        lot_number, shipment_id, container_number, origin_country, origin_farm_market,
        po_id, po_number, grn_reference, invoice_reference, arrival_date_time,
        status, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?)
    `, [
      lot_number, shipment_id || null, container_number || null, origin_country || null,
      origin_farm_market || null, po_id || null, po_number || null,
      grn_reference || null, invoice_reference || null, arrival_date_time || null, userId
    ]);

    const qcLotId = result.insertId;

    // Insert lot items
    if (items && Array.isArray(items) && items.length > 0) {
      const itemValues = items.map(item => [
        qcLotId,
        item.container_id || null,
        item.container_no || null,
        item.product_id || null,
        item.product_name || '',
        item.variety || null,
        item.packaging_type || null,
        item.declared_quantity_units || null,
        item.declared_quantity_net_weight || null,
        item.uom_id || null
      ]);

      await conn.query(`
        INSERT INTO qc_lot_items (
          qc_lot_id, container_id, container_no, product_id, product_name, variety, packaging_type,
          declared_quantity_units, declared_quantity_net_weight, uom_id
        ) VALUES ?
      `, [itemValues]);
    }

    await conn.commit();
    res.json({ id: qcLotId, message: 'QC lot created successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error creating QC lot:', e);
    res.status(500).json(errPayload('Failed to create QC lot', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// PUT /api/quality-check/lots/:id - Update QC lot
router.put('/lots/:id', requireAuth, requirePerm('QualityCheck', 'edit'), async (req, res) => {
  const userId = req.session?.user?.id;
  const { id } = req.params;
  const conn = await db.promise().getConnection();

  try {
    await conn.beginTransaction();

    const {
      container_number,
      origin_country,
      origin_farm_market,
      arrival_date_time,
      status,
      notes
    } = req.body;

    await conn.query(`
      UPDATE qc_lots SET
        container_number = ?,
        origin_country = ?,
        origin_farm_market = ?,
        arrival_date_time = ?,
        status = ?,
        notes = ?,
        updated_by = ?
      WHERE id = ?
    `, [
      container_number || null,
      origin_country || null,
      origin_farm_market || null,
      arrival_date_time || null,
      status || 'DRAFT',
      notes || null,
      userId,
      id
    ]);

    await conn.commit();
    res.json({ message: 'QC lot updated successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error updating QC lot:', e);
    res.status(500).json(errPayload('Failed to update QC lot', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// PUT /api/quality-check/lots/:id/status - Change QC lot status manually
router.put('/lots/:id/status', requireAuth, requirePerm('QualityCheck', 'edit'), async (req, res) => {
  const userId = req.session?.user?.id;
  const { id } = req.params;
  const { status, reason } = req.body;
  const conn = await db.promise().getConnection();

  if (!status) {
    return res.status(400).json(errPayload('Status is required', 'VALIDATION_ERROR'));
  }

  // Valid QC lot statuses
  const validStatuses = ['DRAFT', 'AWAITING_QC', 'QC_COMPLETED', 'UNDER_REGRADING', 'REGRADED_COMPLETED', 'REJECTED', 'CLOSED'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json(errPayload(`Invalid status. Must be one of: ${validStatuses.join(', ')}`, 'VALIDATION_ERROR'));
  }

  try {
    await conn.beginTransaction();

    // Get current lot status
    const [[lot]] = await conn.query('SELECT id, status FROM qc_lots WHERE id = ?', [id]);
    if (!lot) {
      await conn.rollback();
      return res.status(404).json(errPayload('QC lot not found', 'NOT_FOUND'));
    }

    const oldStatus = lot.status;

    // Update status
    await conn.query(`
      UPDATE qc_lots SET
        status = ?,
        updated_by = ?,
        updated_at = NOW()
      WHERE id = ?
    `, [status, userId, id]);

    // Log history for status change
    await addHistory(conn, {
      module: 'qc_lot',
      moduleId: id,
      userId,
      action: 'STATUS_CHANGED',
      details: {
        from: oldStatus,
        to: status,
        reason: reason || 'Manual status change'
      }
    });

    await conn.commit();
    res.json({
      message: 'Status changed successfully',
      status,
      oldStatus
    });
  } catch (e) {
    await conn.rollback();
    console.error('Error changing QC lot status:', e);
    res.status(500).json(errPayload('Failed to change status', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// ============================================================
// QC INSPECTIONS ENDPOINTS
// ============================================================

// GET /api/quality-check/inspections - List inspections (with optional qc_lot_id filter and pagination)
router.get('/inspections', requireAuth, async (req, res) => {
  try {
    const { qc_lot_id, page, pageSize, decision, status_id, date_from, date_to, search } = req.query;

    // Build WHERE clause
    let whereConditions = [];
    let queryParams = [];

    if (qc_lot_id) {
      whereConditions.push('qi.qc_lot_id = ?');
      queryParams.push(qc_lot_id);
    }

    if (decision) {
      whereConditions.push('qi.decision = ?');
      queryParams.push(decision);
    }

    if (status_id) {
      whereConditions.push('qi.status_id = ?');
      queryParams.push(status_id);
    }

    if (date_from) {
      whereConditions.push('DATE(qi.inspection_date) >= ?');
      queryParams.push(date_from);
    }

    if (date_to) {
      whereConditions.push('DATE(qi.inspection_date) <= ?');
      queryParams.push(date_to);
    }

    if (search) {
      whereConditions.push('(ql.lot_number LIKE ? OR qi.comments LIKE ? OR u1.name LIKE ? OR qli.product_name LIKE ?)');
      const searchParam = `%${search}%`;
      queryParams.push(searchParam, searchParam, searchParam, searchParam);
    }

    const whereClause = whereConditions.length > 0
      ? `WHERE ${whereConditions.join(' AND ')}`
      : '';

    // Count total rows
    const [countResult] = await db.promise().query(`
      SELECT COUNT(DISTINCT qi.id) as total
      FROM qc_inspections qi
      LEFT JOIN qc_lots ql ON ql.id = qi.qc_lot_id
      LEFT JOIN \`user\` u1 ON u1.id = qi.inspected_by
      LEFT JOIN qc_lot_items qli ON qli.id = qi.qc_lot_item_id
      ${whereClause}
    `, queryParams);

    const total = countResult[0]?.total || 0;

    // Build pagination
    let limitClause = '';
    if (page && pageSize) {
      const offset = (parseInt(page) - 1) * parseInt(pageSize);
      limitClause = `LIMIT ${parseInt(pageSize)} OFFSET ${offset}`;
    }

    // Fetch inspections
    const [rows] = await db.promise().query(`
      SELECT 
        qi.*,
        u1.name as inspected_by_name,
        u2.name as created_by_name,
        ql.lot_number,
        ql.container_number,
        qli.id as qc_lot_item_id,
        qli.product_name as lot_item_product_name,
        qli.product_id as lot_item_product_id,
        qli.declared_quantity_units as lot_item_declared_units,
        qli.declared_quantity_net_weight as lot_item_declared_weight,
        (SELECT pd.packing_alias
         FROM product_details pd
         WHERE pd.product_id = qli.product_id
         ORDER BY pd.id ASC
         LIMIT 1) as lot_item_packing_alias,
        s.name as status_name,
        COUNT(DISTINCT qm.id) as media_count,
        rj.status as regrade_job_status,
        rc.status as reject_case_status
      FROM qc_inspections qi
      LEFT JOIN qc_lots ql ON ql.id = qi.qc_lot_id
      LEFT JOIN \`user\` u1 ON u1.id = qi.inspected_by
      LEFT JOIN \`user\` u2 ON u2.id = qi.created_by
      LEFT JOIN qc_lot_items qli ON qli.id = qi.qc_lot_item_id
      LEFT JOIN status s ON s.id = qi.status_id
      LEFT JOIN qc_media qm ON qm.qc_inspection_id = qi.id
      LEFT JOIN qc_regrading_jobs rj ON rj.qc_inspection_id = qi.id
      LEFT JOIN qc_reject_cases rc ON rc.qc_inspection_id = qi.id
      ${whereClause}
      GROUP BY qi.id
      ORDER BY qi.inspection_date DESC
      ${limitClause}
    `, queryParams);

    // If qc_lot_id is provided and no pagination, return array (for backward compatibility)
    if (qc_lot_id && !page && !pageSize) {
      return res.json(rows);
    }

    // Otherwise return paginated response
    res.json({
      rows,
      total
    });
  } catch (e) {
    console.error('Error fetching inspections:', e);
    res.status(500).json(errPayload('Failed to fetch inspections', 'DB_ERROR', e.message));
  }
});

// GET /api/quality-check/inspections/:id - Get single inspection with media
router.get('/inspections/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const [inspections] = await db.promise().query(`
      SELECT 
        qi.*,
        u1.name as inspected_by_name,
        u2.name as created_by_name,
        ql.lot_number,
        ql.container_number,
        qli.id as qc_lot_item_id,
        qli.container_id as lot_item_container_id,
        qli.container_no as lot_item_container_no,
        qli.product_name as lot_item_product_name,
        qli.product_id as lot_item_product_id,
        qli.declared_quantity_units as lot_item_declared_units,
        qli.declared_quantity_net_weight as lot_item_declared_weight,
        (SELECT pd.packing_alias
         FROM product_details pd
         WHERE pd.product_id = qli.product_id
         ORDER BY pd.id ASC
         LIMIT 1) as lot_item_packing_alias,
        (SELECT pd.packing_alias
         FROM product_details pd
         WHERE pd.product_id = qli.product_id
         ORDER BY pd.id ASC
         LIMIT 1) as product_packing_alias,
        s.name as status_name
      FROM qc_inspections qi
      LEFT JOIN qc_lots ql ON ql.id = qi.qc_lot_id
      LEFT JOIN \`user\` u1 ON u1.id = qi.inspected_by
      LEFT JOIN \`user\` u2 ON u2.id = qi.created_by
      LEFT JOIN qc_lot_items qli ON qli.id = qi.qc_lot_item_id
      LEFT JOIN status s ON s.id = qi.status_id
      WHERE qi.id = ?
    `, [id]);

    if (inspections.length === 0) {
      return res.status(404).json(errPayload('Inspection not found', 'NOT_FOUND'));
    }

    // Fetch media grouped by defect_type_id (null for common media)
    // Check if defect_type_id column exists (for backward compatibility)
    let media;
    let mediaByDefect = { common: [], defects: {} };

    try {
      // Try to fetch with defect_type_id column (new structure)
      const [mediaResult] = await db.promise().query(`
        SELECT 
          id, qc_lot_id, qc_inspection_id, defect_type_id,
          qc_regrading_job_id, qc_regrading_daily_log_id, qc_reject_case_id,
          media_type, file_name, file_path, thumbnail_path, mime_type, size_bytes,
          created_at, created_by
        FROM qc_media 
        WHERE qc_inspection_id = ? 
        ORDER BY defect_type_id IS NULL DESC, defect_type_id, created_at
      `, [id]);
      media = mediaResult;

      // Group media by defect_type_id for easier frontend consumption
      if (media && Array.isArray(media)) {
        media.forEach(m => {
          if (m.defect_type_id === null || m.defect_type_id === undefined) {
            mediaByDefect.common.push(m);
          } else {
            if (!mediaByDefect.defects[m.defect_type_id]) {
              mediaByDefect.defects[m.defect_type_id] = [];
            }
            mediaByDefect.defects[m.defect_type_id].push(m);
          }
        });
      }
    } catch (columnError) {
      // Fallback: defect_type_id column doesn't exist yet (migration not run)
      // Fetch all media as common media
      console.warn('defect_type_id column not found, using fallback query:', columnError.message);
      try {
        const [mediaResult] = await db.promise().query(`
          SELECT 
            id, qc_lot_id, qc_inspection_id,
            qc_regrading_job_id, qc_regrading_daily_log_id, qc_reject_case_id,
            media_type, file_name, file_path, thumbnail_path, mime_type, size_bytes,
            created_at, created_by
          FROM qc_media 
          WHERE qc_inspection_id = ? 
          ORDER BY created_at
        `, [id]);
        media = mediaResult;

        // All media is treated as common media (defect_type_id = null)
        mediaByDefect.common = media || [];
      } catch (fallbackError) {
        console.error('Error in fallback query:', fallbackError);
        media = [];
        mediaByDefect.common = [];
      }
    }

    res.json({
      ...inspections[0],
      media: media, // Keep flat array for backward compatibility
      mediaByDefect: mediaByDefect // New grouped structure
    });
  } catch (e) {
    console.error('Error fetching inspection:', e);
    res.status(500).json(errPayload('Failed to fetch inspection', 'DB_ERROR', e.message));
  }
});

// GET /api/quality-check/inspections/:id/history - Get inspection history
router.get('/inspections/:id/history', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await db.promise().query(`
      SELECT h.*, u.name as user_name
      FROM history h
      LEFT JOIN \`user\` u ON u.id = h.user_id
      WHERE h.module = 'qc_inspection' AND h.module_id = ?
      ORDER BY h.created_at DESC
    `, [id]);
    res.json(rows);
  } catch (e) {
    console.error('Error fetching inspection history:', e);
    res.status(500).json(errPayload('Failed to fetch inspection history', 'DB_ERROR', e.message));
  }
});

// PUT /api/quality-check/inspections/:id/approve - Approve an inspection
router.put('/inspections/:id/approve', requireAuth, requirePerm('QualityCheck', 'approve'), async (req, res) => {
  const userId = req.session?.user?.id;
  const { id } = req.params;
  const { notes } = req.body;
  const conn = await db.promise().getConnection();

  try {
    await conn.beginTransaction();

    // Update inspection status to 1 (Approved)
    await conn.query('UPDATE qc_inspections SET status_id = 1, updated_by = ?, updated_at = NOW() WHERE id = ?', [userId, id]);

    // Log history
    await addHistory(conn, {
      module: 'qc_inspection',
      moduleId: id,
      userId,
      action: 'APPROVED',
      details: { notes: notes || 'Inspection approved' }
    });

    await conn.commit();
    res.json({ message: 'Inspection approved successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error approving inspection:', e);
    res.status(500).json(errPayload('Failed to approve inspection', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// PUT /api/quality-check/inspections/:id/reject - Reject an inspection
router.put('/inspections/:id/reject', requireAuth, requirePerm('QualityCheck', 'approve'), async (req, res) => {
  const userId = req.session?.user?.id;
  const { id } = req.params;
  const { notes } = req.body;
  const conn = await db.promise().getConnection();

  try {
    await conn.beginTransaction();

    // Update inspection status to 2 (Rejected)
    await conn.query('UPDATE qc_inspections SET status_id = 2, updated_by = ?, updated_at = NOW() WHERE id = ?', [userId, id]);

    // Log history
    await addHistory(conn, {
      module: 'qc_inspection',
      moduleId: id,
      userId,
      action: 'REJECTED',
      details: { notes: notes || 'Inspection rejected' }
    });

    await conn.commit();
    res.json({ message: 'Inspection rejected successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error rejecting inspection:', e);
    res.status(500).json(errPayload('Failed to reject inspection', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// POST /api/quality-check/inspections - Create new inspection
// Multer configuration supports common media and defect-specific media
// Defect media field names: defect_photos_<defect_type_id>, defect_videos_<defect_type_id>
// Using upload.any() to accept dynamic field names, then filtering in route handler
const inspectionUploads = upload.any();

router.post('/inspections', requireAuth, requirePerm('QualityCheck', 'create'), inspectionUploads, async (req, res) => {
  const userId = req.session?.user?.id;
  const conn = await db.promise().getConnection();

  try {
    await conn.beginTransaction();

    const {
      qc_lot_id,
      qc_lot_item_id,
      inspection_date,
      inspected_by,
      place_of_inspection,
      decision,
      status_id,
      accepted_quantity_units,
      accepted_quantity_net_weight,
      regrade_quantity_units,
      regrade_quantity_net_weight,
      rejected_quantity_units,
      rejected_quantity_net_weight,
      comments,
      checklist_appearance,
      checklist_damage,
      checklist_decay_mold,
      checklist_size_consistency,
      checklist_packaging_integrity,
      checklist_odor,
      checklist_foreign_matter,
      checklist_moisture,
      defects
    } = req.body;

    // Convert qc_lot_item_id to integer if provided
    const qcLotItemIdInt = qc_lot_item_id ? parseInt(qc_lot_item_id) : null;

    // Validate required fields
    if (!qc_lot_id || !inspection_date || !qcLotItemIdInt) {
      await conn.rollback();
      return res.status(400).json(errPayload('Missing required fields: qc_lot_id, inspection_date, and qc_lot_item_id', 'VALIDATION_ERROR'));
    }

    // Set default decision if not provided
    const finalDecision = decision || 'ACCEPT';

    // Set default status_id if not provided (3 = Draft)
    const finalStatusId = status_id ? parseInt(status_id) : 3;

    // Parse files from req.files array (using upload.any())
    // Separate common media from defect-specific media
    const photos = [];
    const videos = [];
    const defectMedia = {}; // { defectTypeId: { photos: [], videos: [] } }
    if (req.files && Array.isArray(req.files)) {
      req.files.forEach(file => {
        // Check if this is defect-specific media
        const defectMatch = file.fieldname.match(/^defect_(photos|videos)_(\d+)$/);
        if (defectMatch) {
          const mediaType = defectMatch[1]; // 'photos' or 'videos'
          const defectTypeId = parseInt(defectMatch[2]);

          if (!defectMedia[defectTypeId]) {
            defectMedia[defectTypeId] = { photos: [], videos: [] };
          }

          if (mediaType === 'photos') {
            defectMedia[defectTypeId].photos.push(file);
          } else {
            defectMedia[defectTypeId].videos.push(file);
          }
        } else if (file.fieldname === 'photos') {
          photos.push(file);
        } else if (file.fieldname === 'videos') {
          videos.push(file);
        }
      });
    }

    // Validate media requirements: at least 3 photos OR 1 video + 1 photo (for common media)
    // Note: Defect-specific media validation is handled per defect in frontend
    if (photos.length < 3 && !(videos.length >= 1 && photos.length >= 1)) {
      await conn.rollback();
      return res.status(400).json(errPayload('Media requirement: at least 3 photos OR 1 video + 1 photo', 'VALIDATION_ERROR'));
    }

    // Get lot details for validation
    const [lots] = await conn.query('SELECT * FROM qc_lots WHERE id = ?', [qc_lot_id]);
    if (lots.length === 0) {
      await conn.rollback();
      return res.status(404).json(errPayload('QC lot not found', 'NOT_FOUND'));
    }
    const lot = lots[0];

    // Validate quantities don't exceed declared
    const [lotItems] = await conn.query(`
      SELECT 
        SUM(declared_quantity_units) as total_units,
        SUM(declared_quantity_net_weight) as total_weight
      FROM qc_lot_items WHERE qc_lot_id = ?
    `, [qc_lot_id]);

    const totalDeclaredUnits = parseFloat(lotItems[0]?.total_units || 0);
    const totalDeclaredWeight = parseFloat(lotItems[0]?.total_weight || 0);

    const acceptedUnits = parseFloat(accepted_quantity_units || 0);
    const regradeUnits = parseFloat(regrade_quantity_units || 0);
    const rejectedUnits = parseFloat(rejected_quantity_units || 0);
    const acceptedWeight = parseFloat(accepted_quantity_net_weight || 0);
    const regradeWeight = parseFloat(regrade_quantity_net_weight || 0);
    const rejectedWeight = parseFloat(rejected_quantity_net_weight || 0);

    if (totalDeclaredUnits > 0) {
      if (acceptedUnits + regradeUnits + rejectedUnits > totalDeclaredUnits) {
        await conn.rollback();
        return res.status(400).json(errPayload('Total quantities exceed declared quantity', 'VALIDATION_ERROR'));
      }
    }

    if (totalDeclaredWeight > 0) {
      if (acceptedWeight + regradeWeight + rejectedWeight > totalDeclaredWeight) {
        await conn.rollback();
        return res.status(400).json(errPayload('Total weights exceed declared weight', 'VALIDATION_ERROR'));
      }
    }

    // Parse defects JSON if provided
    let defectsJson = null;
    if (defects) {
      try {
        const defectsData = typeof defects === 'string' ? JSON.parse(defects) : defects;
        defectsJson = JSON.stringify(defectsData);
      } catch (e) {
        console.error('Error parsing defects JSON:', e);
      }
    }

    // Insert inspection - now linked to QC lot item
    const [inspectionResult] = await conn.query(`
      INSERT INTO qc_inspections (
        qc_lot_id, qc_lot_item_id, inspection_date, inspected_by, place_of_inspection, decision, status_id,
        accepted_quantity_units, accepted_quantity_net_weight,
        regrade_quantity_units, regrade_quantity_net_weight,
        rejected_quantity_units, rejected_quantity_net_weight,
        comments,
        checklist_appearance, checklist_damage, checklist_decay_mold,
        checklist_size_consistency, checklist_packaging_integrity,
        checklist_odor, checklist_foreign_matter, checklist_moisture,
        defects_json,
        created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      qc_lot_id,
      qcLotItemIdInt,
      inspection_date,
      inspected_by || userId,
      place_of_inspection || null,
      finalDecision,
      finalStatusId,
      accepted_quantity_units || null,
      accepted_quantity_net_weight || null,
      regrade_quantity_units || null,
      regrade_quantity_net_weight || null,
      rejected_quantity_units || null,
      rejected_quantity_net_weight || null,
      comments,
      checklist_appearance === 'true' || checklist_appearance === true || checklist_appearance === '1' ? 1 : 0,
      checklist_damage === 'true' || checklist_damage === true || checklist_damage === '1' ? 1 : 0,
      checklist_decay_mold === 'true' || checklist_decay_mold === true || checklist_decay_mold === '1' ? 1 : 0,
      checklist_size_consistency === 'true' || checklist_size_consistency === true || checklist_size_consistency === '1' ? 1 : 0,
      checklist_packaging_integrity === 'true' || checklist_packaging_integrity === true || checklist_packaging_integrity === '1' ? 1 : 0,
      checklist_odor === 'true' || checklist_odor === true || checklist_odor === '1' ? 1 : 0,
      checklist_foreign_matter === 'true' || checklist_foreign_matter === true || checklist_foreign_matter === '1' ? 1 : 0,
      checklist_moisture === 'true' || checklist_moisture === true || checklist_moisture === '1' ? 1 : 0,
      defectsJson,
      userId
    ]);

    const inspectionId = inspectionResult.insertId;

    // Log history for inspection creation
    await addHistory(conn, {
      module: 'qc_inspection',
      moduleId: inspectionId,
      userId,
      action: 'CREATED',
      details: {
        qc_lot_id,
        qc_lot_item_id: qcLotItemIdInt,
        decision: finalDecision,
        inspection_date,
        accepted_quantity_units,
        regrade_quantity_units,
        rejected_quantity_units
      }
    });

    // Log history for lot (inspection created)
    await addHistory(conn, {
      module: 'qc_lot',
      moduleId: qc_lot_id,
      userId,
      action: 'INSPECTION_CREATED',
      details: { inspection_id: inspectionId, decision }
    });

    // Save media files
    const mediaInserts = [];

    // Save common photos (no defect_type_id)
    for (const photo of photos) {
      const relPath = `uploads/quality-check/${photo.filename}`;
      mediaInserts.push([
        qc_lot_id,
        inspectionId,
        null, // defect_type_id (null for common media)
        null, // regrading_job_id
        null, // regrading_daily_log_id
        null, // reject_case_id
        'PHOTO',
        photo.originalname,
        relPath,
        null, // thumbnail_path
        photo.mimetype,
        photo.size
      ]);
    }

    // Save common videos (no defect_type_id)
    for (const video of videos) {
      const relPath = `uploads/quality-check/${video.filename}`;
      mediaInserts.push([
        qc_lot_id,
        inspectionId,
        null, // defect_type_id (null for common media)
        null,
        null,
        null,
        'VIDEO',
        video.originalname,
        relPath,
        null,
        video.mimetype,
        video.size
      ]);
    }

    // Save defect-specific media (already parsed into defectMedia object above)
    for (const [defectTypeId, media] of Object.entries(defectMedia)) {
      const defectTypeIdInt = parseInt(defectTypeId);

      // Add photos for this defect
      for (const file of media.photos) {
        const relPath = `uploads/quality-check/${file.filename}`;
        mediaInserts.push([
          qc_lot_id,
          inspectionId,
          defectTypeIdInt, // defect_type_id for defect-specific media
          null, // regrading_job_id
          null, // regrading_daily_log_id
          null, // reject_case_id
          'PHOTO',
          file.originalname,
          relPath,
          null, // thumbnail_path
          file.mimetype,
          file.size
        ]);
      }

      // Add videos for this defect
      for (const file of media.videos) {
        const relPath = `uploads/quality-check/${file.filename}`;
        mediaInserts.push([
          qc_lot_id,
          inspectionId,
          defectTypeIdInt, // defect_type_id for defect-specific media
          null, // regrading_job_id
          null, // regrading_daily_log_id
          null, // reject_case_id
          'VIDEO',
          file.originalname,
          relPath,
          null, // thumbnail_path
          file.mimetype,
          file.size
        ]);
      }
    }

    if (mediaInserts.length > 0) {
      const mediaValues = mediaInserts.map(m => [...m, userId]);
      await conn.query(`
        INSERT INTO qc_media (
          qc_lot_id, qc_inspection_id, defect_type_id, qc_regrading_job_id, qc_regrading_daily_log_id, qc_reject_case_id,
          media_type, file_name, file_path, thumbnail_path, mime_type, size_bytes, created_by
        ) VALUES ?
      `, [mediaValues]);
    }

    // Handle status transitions based on decision
    // NOTE: Automatic status updates disabled as per user request. 
    // Status changes should be manual via the "Change Status" action.
    if (finalDecision === 'ACCEPT') {
      // const [[oldLot]] = await conn.query('SELECT status FROM qc_lots WHERE id = ?', [qc_lot_id]);
      // await conn.query(`UPDATE qc_lots SET status = 'QC_COMPLETED', updated_by = ? WHERE id = ?`, [userId, qc_lot_id]);
      // Log lot status change
      /*
      await addHistory(conn, {
        module: 'qc_lot',
        moduleId: qc_lot_id,
        userId,
        action: 'STATUS_CHANGED',
        details: { from: oldLot?.status, to: 'QC_COMPLETED', reason: 'Inspection accepted' }
      });
      */
    } else if (finalDecision === 'REGRADE') {
      // Create regrading job
      const jobNumber = `RG${new Date().getFullYear().toString().slice(-2)}${String(new Date().getMonth() + 1).padStart(2, '0')}${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`;
      const [jobResult] = await conn.query(`
        INSERT INTO qc_regrading_jobs (
          qc_lot_id, qc_inspection_id, qc_lot_item_id, job_number, status,
          total_quantity_units, total_quantity_net_weight, created_by
        ) VALUES (?, ?, ?, ?, 'PLANNED', ?, ?, ?)
      `, [qc_lot_id, inspectionId, qcLotItemIdInt, jobNumber, regrade_quantity_units || null, regrade_quantity_net_weight || null, userId]);

      // Log regrading job creation
      await addHistory(conn, {
        module: 'qc_regrading_job',
        moduleId: jobResult.insertId,
        userId,
        action: 'CREATED',
        details: { qc_lot_id, qc_inspection_id: inspectionId, job_number: jobNumber }
      });

      // const [[oldLot]] = await conn.query('SELECT status FROM qc_lots WHERE id = ?', [qc_lot_id]);
      // await conn.query(`UPDATE qc_lots SET status = 'UNDER_REGRADING', updated_by = ? WHERE id = ?`, [userId, qc_lot_id]);
      // Log lot status change
      /*
      await addHistory(conn, {
        module: 'qc_lot',
        moduleId: qc_lot_id,
        userId,
        action: 'STATUS_CHANGED',
        details: { from: oldLot?.status, to: 'UNDER_REGRADING', reason: 'Inspection requires regrading', regrading_job_id: jobResult.insertId }
      });
      */
    } else if (finalDecision === 'REJECT') {
      // Create reject case
      const caseNumber = `RC${new Date().getFullYear().toString().slice(-2)}${String(new Date().getMonth() + 1).padStart(2, '0')}${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`;
      await conn.query(`
        INSERT INTO qc_reject_cases (
          qc_lot_id, qc_inspection_id, qc_lot_item_id, case_number, status,
          rejected_quantity_units, rejected_quantity_net_weight,
          rejection_reason, created_by
        ) VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)
      `, [qc_lot_id, inspectionId, qcLotItemIdInt, caseNumber, rejected_quantity_units || null, rejected_quantity_net_weight || null, comments, userId]);

      // const [[oldLot]] = await conn.query('SELECT status FROM qc_lots WHERE id = ?', [qc_lot_id]);
      // await conn.query(`UPDATE qc_lots SET status = 'REJECTED', updated_by = ? WHERE id = ?`, [userId, qc_lot_id]);
      // Log lot status change
      /*
      await addHistory(conn, {
        module: 'qc_lot',
        moduleId: qc_lot_id,
        userId,
        action: 'STATUS_CHANGED',
        details: { from: oldLot?.status, to: 'REJECTED', reason: 'Inspection rejected', reject_case_number: caseNumber }
      });
      */
    } else if (finalDecision === 'SELL_RECHECK') {
      // Record SELL & RECHECK entry from single inspection endpoint
      const qtyUnits = accepted_quantity_units || 0;
      const qtyWeight = accepted_quantity_net_weight || 0;

      await conn.query(`
        INSERT INTO qc_sell_recheck_entries (
          qc_lot_id, qc_lot_item_id, qc_inspection_id,
          check_no, quantity_units, quantity_net_weight, notes, created_by
        )
        SELECT
          ?,
          ?,
          ?,
          COALESCE(MAX(check_no), 0) + 1,
          ?, ?, ?, ?
        FROM qc_sell_recheck_entries
        WHERE qc_inspection_id = ?
      `, [
        qc_lot_id,
        qcLotItemIdInt,
        inspectionId,
        qtyUnits,
        qtyWeight,
        comments || null,
        userId,
        inspectionId
      ]);
    }

    // Update purchase bill inventory movements based on QC decision
    // Get product_id from QC lot item
    const [[lotItemForPB]] = await conn.query(`
      SELECT product_id FROM qc_lot_items WHERE id = ?
    `, [qcLotItemIdInt]);

    if (lotItemForPB && lotItemForPB.product_id) {
      await updatePurchaseBillInventoryFromQCDecision(conn, {
        qc_lot_id,
        qc_lot_item_id: qcLotItemIdInt,
        qc_inspection_id: inspectionId,
        product_id: lotItemForPB.product_id,
        decision: finalDecision,
        accepted_qty: accepted_quantity_units || 0,
        accepted_weight: accepted_quantity_net_weight || 0,
        rejected_qty: rejected_quantity_units || 0,
        rejected_weight: rejected_quantity_net_weight || 0,
        regrade_qty: regrade_quantity_units || 0,
        regrade_weight: regrade_quantity_net_weight || 0
      });
    }

    await conn.commit();
    res.json({ id: inspectionId, message: 'Inspection created successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error creating inspection:', e);
    res.status(500).json(errPayload('Failed to create inspection', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// POST /api/quality-check/inspections/bulk-from-po - Create inspections for all items in a purchase order
router.post('/inspections/bulk-from-po', requireAuth, requirePerm('QualityCheck', 'create'), inspectionUploads, async (req, res) => {
  const userId = req.session?.user?.id;
  const conn = await db.promise().getConnection();

  try {
    await conn.beginTransaction();

    const {
      qc_lot_id,
      inspection_date,
      inspections // Array of inspection data per QC lot item: [{ qc_lot_item_id, decision, quantities, comments, checklist, defects }]
    } = req.body;

    // Validate required fields
    if (!qc_lot_id || !inspection_date || !Array.isArray(inspections) || inspections.length === 0) {
      await conn.rollback();
      return res.status(400).json(errPayload('Missing required fields: qc_lot_id, inspection_date, and inspections array', 'VALIDATION_ERROR'));
    }

    // Get lot details for validation
    const [lots] = await conn.query('SELECT * FROM qc_lots WHERE id = ?', [qc_lot_id]);
    if (lots.length === 0) {
      await conn.rollback();
      return res.status(404).json(errPayload('QC lot not found', 'NOT_FOUND'));
    }

    // Get QC lot items for validation
    const [lotItems] = await conn.query(`
      SELECT id, product_id, product_name, declared_quantity_units, declared_quantity_net_weight
      FROM qc_lot_items
      WHERE qc_lot_id = ?
    `, [qc_lot_id]);

    if (lotItems.length === 0) {
      await conn.rollback();
      return res.status(404).json(errPayload('QC lot has no items', 'NOT_FOUND'));
    }

    // Validate media requirements: at least 3 photos OR 1 video + 1 photo (shared across all inspections)
    const photos = req.files?.photos || [];
    const videos = req.files?.videos || [];
    if (photos.length < 3 && !(videos.length >= 1 && photos.length >= 1)) {
      await conn.rollback();
      return res.status(400).json(errPayload('Media requirement: at least 3 photos OR 1 video + 1 photo', 'VALIDATION_ERROR'));
    }

    const createdInspections = [];

    // Create one inspection per QC lot item
    for (const inspectionData of inspections) {
      const {
        qc_lot_item_id,
        decision,
        accepted_quantity_units,
        accepted_quantity_net_weight,
        regrade_quantity_units,
        regrade_quantity_net_weight,
        rejected_quantity_units,
        rejected_quantity_net_weight,
        comments,
        checklist_appearance,
        checklist_damage,
        checklist_decay_mold,
        checklist_size_consistency,
        checklist_packaging_integrity,
        checklist_odor,
        checklist_foreign_matter,
        checklist_moisture,
        defects
      } = inspectionData;

      // Validate qc_lot_item_id exists in the QC lot
      const lotItem = lotItems.find(item => item.id === Number(qc_lot_item_id));
      if (!lotItem) {
        await conn.rollback();
        return res.status(400).json(errPayload(`QC lot item ${qc_lot_item_id} not found in QC lot ${qc_lot_id}`, 'VALIDATION_ERROR'));
      }

      // Validate quantities don't exceed declared for this lot item
      const acceptedUnits = parseFloat(accepted_quantity_units || 0);
      const regradeUnits = parseFloat(regrade_quantity_units || 0);
      const rejectedUnits = parseFloat(rejected_quantity_units || 0);
      const totalUnits = acceptedUnits + regradeUnits + rejectedUnits;
      const declaredUnits = parseFloat(lotItem.declared_quantity_units || 0);

      if (declaredUnits > 0 && totalUnits > declaredUnits) {
        await conn.rollback();
        return res.status(400).json(errPayload(`Total quantities (${totalUnits}) exceed declared quantity (${declaredUnits}) for QC lot item ${qc_lot_item_id}`, 'VALIDATION_ERROR'));
      }

      // Validate required fields for each inspection
      if (!decision || !comments) {
        await conn.rollback();
        return res.status(400).json(errPayload(`Missing required fields for QC lot item ${qc_lot_item_id}: decision and comments`, 'VALIDATION_ERROR'));
      }

      // Parse defects JSON if provided
      let defectsJson = null;
      if (defects) {
        try {
          const defectsData = typeof defects === 'string' ? JSON.parse(defects) : defects;
          defectsJson = JSON.stringify(defectsData);
        } catch (e) {
          console.error('Error parsing defects JSON:', e);
        }
      }

      // Insert inspection for this QC lot item
      const [inspectionResult] = await conn.query(`
        INSERT INTO qc_inspections (
          qc_lot_id, qc_lot_item_id, inspection_date, inspected_by, place_of_inspection, decision,
          accepted_quantity_units, accepted_quantity_net_weight,
          regrade_quantity_units, regrade_quantity_net_weight,
          rejected_quantity_units, rejected_quantity_net_weight,
          comments,
          checklist_appearance, checklist_damage, checklist_decay_mold,
          checklist_size_consistency, checklist_packaging_integrity,
          checklist_odor, checklist_foreign_matter, checklist_moisture,
          defects_json,
          created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        qc_lot_id,
        qc_lot_item_id,
        inspection_date,
        userId,
        null, // place_of_inspection - not used in bulk endpoint
        decision,
        accepted_quantity_units || null,
        accepted_quantity_net_weight || null,
        regrade_quantity_units || null,
        regrade_quantity_net_weight || null,
        rejected_quantity_units || null,
        rejected_quantity_net_weight || null,
        comments,
        checklist_appearance === 'true' || checklist_appearance === true || checklist_appearance === '1' ? 1 : 0,
        checklist_damage === 'true' || checklist_damage === true || checklist_damage === '1' ? 1 : 0,
        checklist_decay_mold === 'true' || checklist_decay_mold === true || checklist_decay_mold === '1' ? 1 : 0,
        checklist_size_consistency === 'true' || checklist_size_consistency === true || checklist_size_consistency === '1' ? 1 : 0,
        checklist_packaging_integrity === 'true' || checklist_packaging_integrity === true || checklist_packaging_integrity === '1' ? 1 : 0,
        checklist_odor === 'true' || checklist_odor === true || checklist_odor === '1' ? 1 : 0,
        checklist_foreign_matter === 'true' || checklist_foreign_matter === true || checklist_foreign_matter === '1' ? 1 : 0,
        checklist_moisture === 'true' || checklist_moisture === true || checklist_moisture === '1' ? 1 : 0,
        defectsJson,
        userId
      ]);

      const inspectionId = inspectionResult.insertId;
      createdInspections.push({ id: inspectionId, qc_lot_item_id });

      // Log history for inspection creation
      await addHistory(conn, {
        module: 'qc_inspection',
        moduleId: inspectionId,
        userId,
        action: 'CREATED',
        details: {
          qc_lot_id,
          qc_lot_item_id,
          decision,
          inspection_date,
          accepted_quantity_units,
          regrade_quantity_units,
          rejected_quantity_units
        }
      });

      // Save media files for this inspection (distribute media across inspections)
      // For now, we'll associate all media with the first inspection
      // In a more sophisticated implementation, you might want to distribute media per item
      if (inspectionId === createdInspections[0].id) {
        const mediaInserts = [];

        // Process photos
        (photos || []).forEach((photo) => {
          const relPath = `uploads/quality-check/${photo.filename}`;
          mediaInserts.push([
            qc_lot_id,
            inspectionId,
            null, // regrading_job_id
            null, // regrading_daily_log_id
            null, // reject_case_id
            'PHOTO',
            photo.originalname,
            relPath,
            null, // thumbnail_path
            photo.mimetype,
            photo.size
          ]);
        });

        // Process videos
        (videos || []).forEach((video) => {
          const relPath = `uploads/quality-check/${video.filename}`;
          mediaInserts.push([
            qc_lot_id,
            inspectionId,
            null, // regrading_job_id
            null, // regrading_daily_log_id
            null, // reject_case_id
            'VIDEO',
            video.originalname,
            relPath,
            null, // thumbnail_path
            video.mimetype,
            video.size
          ]);
        });

        if (mediaInserts.length > 0) {
          await conn.query(`
            INSERT INTO qc_media (
              qc_lot_id, qc_inspection_id, regrading_job_id, regrading_daily_log_id, reject_case_id,
              media_type, original_name, file_path, thumbnail_path, mime_type, size_bytes
            ) VALUES ?
          `, [mediaInserts]);
        }
      }

      // Handle decision-based actions (regrading, rejection, completion, sell & recheck)
      if (decision === 'ACCEPT') {
        // Check if all inspections are accepted to mark lot as completed
        // This logic can be enhanced to check all items
      } else if (decision === 'REGRADE') {
        const jobNumber = `RG${new Date().getFullYear().toString().slice(-2)}${String(new Date().getMonth() + 1).padStart(2, '0')}${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`;
        await conn.query(`
          INSERT INTO qc_regrading_jobs (
            qc_lot_id, qc_inspection_id, qc_lot_item_id, job_number, status,
            total_quantity_units, total_quantity_net_weight, created_by
          ) VALUES (?, ?, ?, ?, 'PLANNED', ?, ?, ?)
        `, [qc_lot_id, inspectionId, qc_lot_item_id, jobNumber, regrade_quantity_units || null, regrade_quantity_net_weight || null, userId]);
      } else if (decision === 'REJECT') {
        const caseNumber = `RC${new Date().getFullYear().toString().slice(-2)}${String(new Date().getMonth() + 1).padStart(2, '0')}${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`;
        await conn.query(`
          INSERT INTO qc_reject_cases (
            qc_lot_id, qc_inspection_id, qc_lot_item_id, case_number, status,
            rejected_quantity_units, rejected_quantity_net_weight,
            rejection_reason, created_by
          ) VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)
        `, [qc_lot_id, inspectionId, qc_lot_item_id, caseNumber, rejected_quantity_units || null, rejected_quantity_net_weight || null, comments, userId]);
      } else if (decision === 'SELL_RECHECK') {
        // Record SELL & RECHECK entry from bulk endpoint
        const qtyUnits = accepted_quantity_units || 0;
        const qtyWeight = accepted_quantity_net_weight || 0;

        await conn.query(`
          INSERT INTO qc_sell_recheck_entries (
            qc_lot_id, qc_lot_item_id, qc_inspection_id,
            check_no, quantity_units, quantity_net_weight, notes, created_by
          )
          SELECT
            ?,
            ?,
            ?,
            COALESCE(MAX(check_no), 0) + 1,
            ?, ?, ?, ?
          FROM qc_sell_recheck_entries
          WHERE qc_inspection_id = ?
        `, [
          qc_lot_id,
          qc_lot_item_id,
          inspectionId,
          qtyUnits,
          qtyWeight,
          comments || null,
          userId,
          inspectionId
        ]);
      }
    }

    // Log history for lot (inspections created)
    await addHistory(conn, {
      module: 'qc_lot',
      moduleId: qc_lot_id,
      userId,
      action: 'INSPECTIONS_CREATED',
      details: {
        inspection_count: createdInspections.length,
        inspection_ids: createdInspections.map(i => i.id),
        qc_lot_item_ids: createdInspections.map(i => i.qc_lot_item_id)
      }
    });

    await conn.commit();
    res.json({
      message: `Successfully created ${createdInspections.length} inspection(s) for QC lot items`,
      inspections: createdInspections
    });
  } catch (e) {
    await conn.rollback();
    console.error('Error creating bulk inspections:', e);
    res.status(500).json(errPayload('Failed to create inspections', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// PUT /api/quality-check/inspections/:id - Update existing inspection
router.put('/inspections/:id', requireAuth, requirePerm('QualityCheck', 'edit'), inspectionUploads, async (req, res) => {
  const userId = req.session?.user?.id;
  const { id: inspectionId } = req.params;
  const conn = await db.promise().getConnection();

  try {
    await conn.beginTransaction();

    // Check if user is active
    const isActive = await checkUserActive(userId);
    if (!isActive) {
      await conn.rollback();
      return res.status(403).json(errPayload('Only active users can edit inspections', 'PERMISSION_DENIED'));
    }

    // Check if inspection exists and get old values for history
    const [[existingInspection]] = await conn.query(`
      SELECT qi.*, ql.status as lot_status
      FROM qc_inspections qi
      LEFT JOIN qc_lots ql ON ql.id = qi.qc_lot_id
      WHERE qi.id = ?
    `, [inspectionId]);

    if (!existingInspection) {
      await conn.rollback();
      return res.status(404).json(errPayload('Inspection not found', 'NOT_FOUND'));
    }

    // Check if lot status prevents editing - editing not allowed only for truly final states
    // QC_COMPLETED and REGRADED_COMPLETED are allowed for editing (user can manually change status if needed)
    const restrictedStatuses = ['REJECTED', 'CLOSED'];
    if (restrictedStatuses.includes(existingInspection.lot_status)) {
      await conn.rollback();
      return res.status(403).json(errPayload(`Cannot edit inspection: Lot status is ${existingInspection.lot_status}`, 'VALIDATION_ERROR'));
    }

    const {
      qc_lot_item_id,
      inspection_date,
      inspected_by,
      place_of_inspection,
      decision,
      status_id,
      accepted_quantity_units,
      accepted_quantity_net_weight,
      regrade_quantity_units,
      regrade_quantity_net_weight,
      rejected_quantity_units,
      rejected_quantity_net_weight,
      comments,
      checklist_appearance,
      checklist_damage,
      checklist_decay_mold,
      checklist_size_consistency,
      checklist_packaging_integrity,
      checklist_odor,
      checklist_foreign_matter,
      checklist_moisture,
      defects,
      action_notes
    } = req.body;

    // Parse status_id if provided (used for Draft / Submitted for Approval)
    const parsedStatusId = status_id !== undefined && status_id !== null && status_id !== ''
      ? parseInt(status_id, 10)
      : undefined;

    // Validate required fields
    // If action_notes is provided (approval/rejection scenario), comments can be optional (will preserve existing)
    // Otherwise, comments is required
    if (!inspection_date || !decision || (!comments && !action_notes)) {
      await conn.rollback();
      return res.status(400).json(errPayload('Missing required fields', 'VALIDATION_ERROR'));
    }

    // Parse defects JSON if provided
    // Only update defects_json if defects are explicitly provided in the request
    // Otherwise, preserve the existing defects_json
    let defectsJson = undefined; // undefined means don't update this field
    if (defects !== undefined && defects !== null) {
      try {
        const defectsData = typeof defects === 'string' ? JSON.parse(defects) : defects;
        defectsJson = JSON.stringify(defectsData);
      } catch (e) {
        console.error('Error parsing defects JSON:', e);
        // If parsing fails, don't update defects_json (keep existing)
        defectsJson = undefined;
      }
    }

    // Track changes for history - compare all fields
    const changes = [];

    // Helper to normalize values for comparison
    const compareField = (fieldName, oldVal, newVal) => {
      // Handle null/undefined/empty values
      const oldIsEmpty = oldVal === null || oldVal === undefined || oldVal === '';
      const newIsEmpty = newVal === null || newVal === undefined || newVal === '';

      if (oldIsEmpty && newIsEmpty) return; // Both empty, no change

      // Strict numeric check
      const nOld = Number(oldVal);
      const nNew = Number(newVal);
      // Check if they are valid numbers and not empty strings (Number('') is 0)
      // Also ensure not boolean
      const isOldNum = !isNaN(nOld) && oldVal !== '' && oldVal !== null && oldVal !== undefined && typeof oldVal !== 'boolean';
      const isNewNum = !isNaN(nNew) && newVal !== '' && newVal !== null && newVal !== undefined && typeof newVal !== 'boolean';

      if (isOldNum && isNewNum) {
        if (nOld !== nNew) {
          changes.push({
            field: fieldName,
            from: nOld,
            to: nNew
          });
        }
        return;
      }

      // String comparison
      const oldStr = String(oldVal !== null && oldVal !== undefined ? oldVal : '').trim();
      const newStr = String(newVal !== null && newVal !== undefined ? newVal : '').trim();

      if (oldStr !== newStr) {
        changes.push({
          field: fieldName,
          from: oldIsEmpty ? null : oldStr,
          to: newIsEmpty ? null : newStr
        });
      }
    };

    // Compare all fields
    compareField('inspection_date', existingInspection.inspection_date, inspection_date);
    if (inspected_by !== undefined) {
      compareField('inspected_by', existingInspection.inspected_by, inspected_by);
    }
    if (place_of_inspection !== undefined) {
      compareField('place_of_inspection', existingInspection.place_of_inspection, place_of_inspection);
    }
    compareField('decision', existingInspection.decision, decision);
    if (parsedStatusId !== undefined) {
      compareField('status_id', existingInspection.status_id, parsedStatusId);
    }
    compareField('accepted_quantity_units', existingInspection.accepted_quantity_units, accepted_quantity_units);
    compareField('accepted_quantity_net_weight', existingInspection.accepted_quantity_net_weight, accepted_quantity_net_weight);
    compareField('regrade_quantity_units', existingInspection.regrade_quantity_units, regrade_quantity_units);
    compareField('regrade_quantity_net_weight', existingInspection.regrade_quantity_net_weight, regrade_quantity_net_weight);
    compareField('rejected_quantity_units', existingInspection.rejected_quantity_units, rejected_quantity_units);
    compareField('rejected_quantity_net_weight', existingInspection.rejected_quantity_net_weight, rejected_quantity_net_weight);

    // Only track comments change if action_notes is NOT provided (normal edit)
    // If action_notes is provided, we're preserving comments, so don't track it as a change
    if (!action_notes) {
      compareField('comments', existingInspection.comments, comments);
    }

    // Compare checklist fields (convert to boolean for comparison)
    const checklistAppearance = checklist_appearance === 'true' || checklist_appearance === true || checklist_appearance === '1' ? 1 : 0;
    const checklistDamage = checklist_damage === 'true' || checklist_damage === true || checklist_damage === '1' ? 1 : 0;
    const checklistDecayMold = checklist_decay_mold === 'true' || checklist_decay_mold === true || checklist_decay_mold === '1' ? 1 : 0;
    const checklistSizeConsistency = checklist_size_consistency === 'true' || checklist_size_consistency === true || checklist_size_consistency === '1' ? 1 : 0;
    const checklistPackagingIntegrity = checklist_packaging_integrity === 'true' || checklist_packaging_integrity === true || checklist_packaging_integrity === '1' ? 1 : 0;
    const checklistOdor = checklist_odor === 'true' || checklist_odor === true || checklist_odor === '1' ? 1 : 0;
    const checklistForeignMatter = checklist_foreign_matter === 'true' || checklist_foreign_matter === true || checklist_foreign_matter === '1' ? 1 : 0;
    const checklistMoisture = checklist_moisture === 'true' || checklist_moisture === true || checklist_moisture === '1' ? 1 : 0;

    compareField('checklist_appearance', existingInspection.checklist_appearance, checklistAppearance);
    compareField('checklist_damage', existingInspection.checklist_damage, checklistDamage);
    compareField('checklist_decay_mold', existingInspection.checklist_decay_mold, checklistDecayMold);
    compareField('checklist_size_consistency', existingInspection.checklist_size_consistency, checklistSizeConsistency);
    compareField('checklist_packaging_integrity', existingInspection.checklist_packaging_integrity, checklistPackagingIntegrity);
    compareField('checklist_odor', existingInspection.checklist_odor, checklistOdor);
    compareField('checklist_foreign_matter', existingInspection.checklist_foreign_matter, checklistForeignMatter);
    compareField('checklist_moisture', existingInspection.checklist_moisture, checklistMoisture);

    // Compare defects_json only if it's being updated
    if (defectsJson !== undefined) {
      const existingDefects = existingInspection.defects_json ? JSON.parse(existingInspection.defects_json) : null;
      const newDefects = defectsJson ? JSON.parse(defectsJson) : null;
      if (JSON.stringify(existingDefects) !== JSON.stringify(newDefects)) {
        changes.push({
          field: 'defects_json',
          from: existingDefects ? JSON.stringify(existingDefects) : 'null',
          to: newDefects ? JSON.stringify(newDefects) : 'null'
        });
      }
    }

    // Track qc_lot_item_id change if provided
    if (qc_lot_item_id !== undefined) {
      compareField('qc_lot_item_id', existingInspection.qc_lot_item_id, qc_lot_item_id);
    }

    // Build dynamic UPDATE query - only include defects_json if it's being updated
    const updateFields = [];
    const updateValues = [];

    if (qc_lot_item_id !== undefined) {
      updateFields.push('qc_lot_item_id = ?');
      updateValues.push(qc_lot_item_id || null);
    }
    updateFields.push('inspection_date = ?');
    updateValues.push(inspection_date || existingInspection.inspection_date);

    if (inspected_by !== undefined) {
      updateFields.push('inspected_by = ?');
      updateValues.push(inspected_by);
    }
    if (place_of_inspection !== undefined) {
      updateFields.push('place_of_inspection = ?');
      updateValues.push(place_of_inspection || null);
    }
    updateFields.push('decision = ?');
    updateValues.push(decision);

    if (parsedStatusId !== undefined) {
      updateFields.push('status_id = ?');
      updateValues.push(parsedStatusId);
    }

    updateFields.push('accepted_quantity_units = ?');
    updateValues.push(accepted_quantity_units || null);
    updateFields.push('accepted_quantity_net_weight = ?');
    updateValues.push(accepted_quantity_net_weight || null);
    updateFields.push('regrade_quantity_units = ?');
    updateValues.push(regrade_quantity_units || null);
    updateFields.push('regrade_quantity_net_weight = ?');
    updateValues.push(regrade_quantity_net_weight || null);
    updateFields.push('rejected_quantity_units = ?');
    updateValues.push(rejected_quantity_units || null);
    updateFields.push('rejected_quantity_net_weight = ?');
    updateValues.push(rejected_quantity_net_weight || null);

    // If action_notes is provided (approval/rejection scenario), DO NOT update comments at all
    // Otherwise, update comments if provided
    if (!action_notes) {
      // Normal update - use provided comments
      updateFields.push('comments = ?');
      updateValues.push(comments);
    }
    // When action_notes is provided, skip comments field entirely to preserve original

    updateFields.push('checklist_appearance = ?');
    updateValues.push(checklist_appearance === 'true' || checklist_appearance === true || checklist_appearance === '1' ? 1 : 0);
    updateFields.push('checklist_damage = ?');
    updateValues.push(checklist_damage === 'true' || checklist_damage === true || checklist_damage === '1' ? 1 : 0);
    updateFields.push('checklist_decay_mold = ?');
    updateValues.push(checklist_decay_mold === 'true' || checklist_decay_mold === true || checklist_decay_mold === '1' ? 1 : 0);
    updateFields.push('checklist_size_consistency = ?');
    updateValues.push(checklist_size_consistency === 'true' || checklist_size_consistency === true || checklist_size_consistency === '1' ? 1 : 0);
    updateFields.push('checklist_packaging_integrity = ?');
    updateValues.push(checklist_packaging_integrity === 'true' || checklist_packaging_integrity === true || checklist_packaging_integrity === '1' ? 1 : 0);
    updateFields.push('checklist_odor = ?');
    updateValues.push(checklist_odor === 'true' || checklist_odor === true || checklist_odor === '1' ? 1 : 0);
    updateFields.push('checklist_foreign_matter = ?');
    updateValues.push(checklist_foreign_matter === 'true' || checklist_foreign_matter === true || checklist_foreign_matter === '1' ? 1 : 0);
    updateFields.push('checklist_moisture = ?');
    updateValues.push(checklist_moisture === 'true' || checklist_moisture === true || checklist_moisture === '1' ? 1 : 0);

    // Only update defects_json if it's explicitly provided
    if (defectsJson !== undefined) {
      updateFields.push('defects_json = ?');
      updateValues.push(defectsJson);
    }

    updateFields.push('updated_by = ?');
    updateValues.push(userId);
    updateFields.push('updated_at = NOW()');
    updateValues.push(inspectionId);

    await conn.query(`
      UPDATE qc_inspections SET
        ${updateFields.join(', ')}
      WHERE id = ?
    `, updateValues);

    // Calculate if any media is being uploaded
    const hasMedia = req.files && Array.isArray(req.files) && req.files.length > 0;

    // Log history ONLY if there are changes or new media
    if (changes.length > 0 || hasMedia) {
      // If there's a status_id change, fetch the status names
      let updatedChanges = [...changes];
      const statusChange = changes.find(change => change.field === 'status_id');

      if (statusChange) {
        try {
          // Fetch status names from status table
          const [fromStatusRows] = await conn.query(`SELECT name FROM status WHERE id = ? LIMIT 1`, [statusChange.from]);
          const [toStatusRows] = await conn.query(`SELECT name FROM status WHERE id = ? LIMIT 1`, [statusChange.to]);

          const fromStatusName = fromStatusRows.length > 0 ? fromStatusRows[0].name : `Status ${statusChange.from}`;
          const toStatusName = toStatusRows.length > 0 ? toStatusRows[0].name : `Status ${statusChange.to}`;

          // Update the change to use status names instead of IDs
          updatedChanges = changes.map(change => {
            if (change.field === 'status_id') {
              return {
                ...change,
                from: fromStatusName,
                to: toStatusName
              };
            }
            return change;
          });
        } catch (statusError) {
          console.error('Error fetching status names:', statusError);
          // If there's an error, keep the original IDs
        }
      }

      // Determine the action type based on status change and action_notes
      let historyAction = 'UPDATED';
      if (action_notes) {
        // If status is changing to Approved (1), it's an approval
        const statusChange = changes.find(change => change.field === 'status_id');
        if (statusChange && statusChange.to === 1) {
          historyAction = 'APPROVED';
        } else if (statusChange && statusChange.to === 2) {
          historyAction = 'REJECTED';
        }
      }

      await addHistory(conn, {
        module: 'qc_inspection',
        moduleId: inspectionId,
        userId,
        action: historyAction,
        details: {
          changes: updatedChanges,
          qc_lot_id: existingInspection.qc_lot_id,
          change_count: changes.length,
          new_media_count: hasMedia ? req.files.length : 0,
          approval_comment: action_notes || null,
          reason: action_notes || null
        }
      });
    }

    // Handle Regrade/Reject/Accept logic (create/update corresponding jobs/cases)
    const finalQcLotItemId = qc_lot_item_id !== undefined ? (qc_lot_item_id ? parseInt(qc_lot_item_id) : null) : existingInspection.qc_lot_item_id;

    if (decision === 'REGRADE') {
      // Check if regrade job exists
      const [[existingJob]] = await conn.query('SELECT id, status FROM qc_regrading_jobs WHERE qc_inspection_id = ?', [inspectionId]);

      if (existingJob) {
        // Update existing job quantities
        await conn.query(`
          UPDATE qc_regrading_jobs SET 
            total_quantity_units = ?, 
            total_quantity_net_weight = ?,
            qc_lot_item_id = ?,
            updated_by = ?,
            updated_at = NOW()
          WHERE id = ?
        `, [
          regrade_quantity_units || null,
          regrade_quantity_net_weight || null,
          finalQcLotItemId,
          userId,
          existingJob.id
        ]);
      } else {
        // Create new regrade job
        const jobNumber = `RG${new Date().getFullYear().toString().slice(-2)}${String(new Date().getMonth() + 1).padStart(2, '0')}${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`;
        await conn.query(`
          INSERT INTO qc_regrading_jobs (
            qc_lot_id, qc_inspection_id, qc_lot_item_id, job_number, status,
            total_quantity_units, total_quantity_net_weight, created_by
          ) VALUES (?, ?, ?, ?, 'PLANNED', ?, ?, ?)
        `, [
          existingInspection.qc_lot_id,
          inspectionId,
          finalQcLotItemId,
          jobNumber,
          regrade_quantity_units || null,
          regrade_quantity_net_weight || null,
          userId
        ]);
      }
    } else if (decision === 'REJECT') {
      // Check if reject case exists
      const [[existingCase]] = await conn.query('SELECT id, status FROM qc_reject_cases WHERE qc_inspection_id = ?', [inspectionId]);

      if (existingCase) {
        // Update existing case
        await conn.query(`
          UPDATE qc_reject_cases SET 
            rejected_quantity_units = ?, 
            rejected_quantity_net_weight = ?,
            qc_lot_item_id = ?,
            rejection_reason = ?,
            updated_by = ?,
            updated_at = NOW()
          WHERE id = ?
        `, [
          rejected_quantity_units || null,
          rejected_quantity_net_weight || null,
          finalQcLotItemId,
          comments, // Update reason with comments
          userId,
          existingCase.id
        ]);
      } else {
        // Create new reject case
        const caseNumber = `RC${new Date().getFullYear().toString().slice(-2)}${String(new Date().getMonth() + 1).padStart(2, '0')}${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`;
        await conn.query(`
          INSERT INTO qc_reject_cases (
            qc_lot_id, qc_inspection_id, qc_lot_item_id, case_number, status,
            rejected_quantity_units, rejected_quantity_net_weight,
            rejection_reason, created_by
          ) VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)
        `, [
          existingInspection.qc_lot_id,
          inspectionId,
          finalQcLotItemId,
          caseNumber,
          rejected_quantity_units || null,
          rejected_quantity_net_weight || null,
          comments,
          userId
        ]);
      }
    } else if (decision === 'SELL_RECHECK') {
      // Record SELL & RECHECK entry (multiple entries allowed per inspection)
      // Use accepted quantities as "sell" quantities for this check
      const qtyUnits = accepted_quantity_units || 0;
      const qtyWeight = accepted_quantity_net_weight || 0;

      await conn.query(`
        INSERT INTO qc_sell_recheck_entries (
          qc_lot_id, qc_lot_item_id, qc_inspection_id,
          check_no, quantity_units, quantity_net_weight, notes, created_by
        )
        SELECT
          ?,
          ?,
          ?,
          COALESCE(MAX(check_no), 0) + 1,
          ?, ?, ?, ?
        FROM qc_sell_recheck_entries
        WHERE qc_inspection_id = ?
      `, [
        existingInspection.qc_lot_id,
        finalQcLotItemId,
        inspectionId,
        qtyUnits,
        qtyWeight,
        comments || null,
        userId,
        inspectionId
      ]);

      // Update purchase bill inventory: SELL_RECHECK keeps quantity in IN TRANSIT (movement_type_id = 3)
      // Get product_id from QC lot item
      const [[lotItem]] = await conn.query(`
        SELECT product_id FROM qc_lot_items WHERE id = ?
      `, [finalQcLotItemId]);

      if (lotItem && lotItem.product_id) {
        await updatePurchaseBillInventoryFromQCDecision(conn, {
          qc_lot_id: existingInspection.qc_lot_id,
          qc_lot_item_id: finalQcLotItemId,
          qc_inspection_id: inspectionId,
          product_id: lotItem.product_id,
          decision: 'SELL_RECHECK',
          accepted_qty: qtyUnits,
          accepted_weight: qtyWeight
        });
      }
    }

    // Update purchase bill inventory movements based on QC decision
    // Get product_id from QC lot item
    const [[lotItemForPB]] = await conn.query(`
      SELECT product_id FROM qc_lot_items WHERE id = ?
    `, [finalQcLotItemId || existingInspection.qc_lot_item_id]);

    if (lotItemForPB && lotItemForPB.product_id && decision !== 'SELL_RECHECK') {
      await updatePurchaseBillInventoryFromQCDecision(conn, {
        qc_lot_id: existingInspection.qc_lot_id,
        qc_lot_item_id: finalQcLotItemId || existingInspection.qc_lot_item_id,
        qc_inspection_id: inspectionId,
        product_id: lotItemForPB.product_id,
        decision: decision,
        accepted_qty: accepted_quantity_units || 0,
        accepted_weight: accepted_quantity_net_weight || 0,
        rejected_qty: rejected_quantity_units || 0,
        rejected_weight: rejected_quantity_net_weight || 0,
        regrade_qty: regrade_quantity_units || 0,
        regrade_weight: regrade_quantity_net_weight || 0
      });
    }

    // Handle new media uploads (existing media is not deleted, only new ones are added)
    if (req.files && Array.isArray(req.files)) {
      const mediaValues = [];
      const defectMedia = {}; // { defectTypeId: { photos: [], videos: [] } }

      // Parse files from req.files array
      req.files.forEach(file => {
        // Check if this is defect-specific media
        const defectMatch = file.fieldname.match(/^defect_(photos|videos)_(\d+)$/);
        if (defectMatch) {
          const mediaType = defectMatch[1]; // 'photos' or 'videos'
          const defectTypeId = parseInt(defectMatch[2]);

          if (!defectMedia[defectTypeId]) {
            defectMedia[defectTypeId] = { photos: [], videos: [] };
          }

          if (mediaType === 'photos') {
            defectMedia[defectTypeId].photos.push(file);
          } else {
            defectMedia[defectTypeId].videos.push(file);
          }
        } else if (file.fieldname === 'photos') {
          // Common photos (no defect_type_id)
          mediaValues.push([
            existingInspection.qc_lot_id,
            inspectionId,
            null, // defect_type_id (null for common media)
            null, // qc_regrading_job_id
            null, // qc_regrading_daily_log_id
            null, // qc_reject_case_id
            'PHOTO',
            file.originalname,
            `uploads/quality-check/${file.filename}`,
            null, // thumbnail_path
            file.mimetype,
            file.size,
            userId
          ]);
        } else if (file.fieldname === 'videos') {
          // Common videos (no defect_type_id)
          mediaValues.push([
            existingInspection.qc_lot_id,
            inspectionId,
            null, // defect_type_id (null for common media)
            null,
            null,
            null,
            'VIDEO',
            file.originalname,
            `uploads/quality-check/${file.filename}`,
            null,
            file.mimetype,
            file.size,
            userId
          ]);
        }
      });

      // Handle defect-specific media
      for (const [defectTypeId, media] of Object.entries(defectMedia)) {
        const defectTypeIdInt = parseInt(defectTypeId);

        // Add photos for this defect
        for (const file of media.photos) {
          mediaValues.push([
            existingInspection.qc_lot_id,
            inspectionId,
            defectTypeIdInt, // defect_type_id for defect-specific media
            null, // qc_regrading_job_id
            null, // qc_regrading_daily_log_id
            null, // qc_reject_case_id
            'PHOTO',
            file.originalname,
            `uploads/quality-check/${file.filename}`,
            null, // thumbnail_path
            file.mimetype,
            file.size,
            userId
          ]);
        }

        // Add videos for this defect
        for (const file of media.videos) {
          mediaValues.push([
            existingInspection.qc_lot_id,
            inspectionId,
            defectTypeIdInt, // defect_type_id for defect-specific media
            null, // qc_regrading_job_id
            null, // qc_regrading_daily_log_id
            null, // qc_reject_case_id
            'VIDEO',
            file.originalname,
            `uploads/quality-check/${file.filename}`,
            null, // thumbnail_path
            file.mimetype,
            file.size,
            userId
          ]);
        }
      }

      if (mediaValues.length > 0) {
        await conn.query(`
          INSERT INTO qc_media (
            qc_lot_id, qc_inspection_id, defect_type_id, qc_regrading_job_id, qc_regrading_daily_log_id, qc_reject_case_id,
            media_type, file_name, file_path, thumbnail_path, mime_type, size_bytes, created_by
          ) VALUES ?
        `, [mediaValues]);
      }
    }

    await conn.commit();
    res.json({ id: inspectionId, message: 'Inspection updated successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error updating inspection:', e);
    res.status(500).json(errPayload('Failed to update inspection', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// ============================================================
// QC MEDIA ENDPOINTS
// ============================================================

// GET /api/quality-check/media - Get media for a lot/inspection
// GET /api/quality-check/media - Get media for a specific entity (lot, inspection, etc.)
router.get('/media', requireAuth, async (req, res) => {
  try {
    const { qc_lot_id, qc_inspection_id, qc_regrading_job_id, qc_regrading_daily_log_id, qc_reject_case_id } = req.query;

    let whereClause = '1=0';
    const params = [];

    if (qc_lot_id) {
      whereClause = 'qc_lot_id = ?';
      params.push(qc_lot_id);
    } else if (qc_inspection_id) {
      whereClause = 'qc_inspection_id = ?';
      params.push(qc_inspection_id);
    } else if (qc_regrading_job_id) {
      whereClause = 'qc_regrading_job_id = ?';
      params.push(qc_regrading_job_id);
    } else if (qc_regrading_daily_log_id) {
      whereClause = 'qc_regrading_daily_log_id = ?';
      params.push(qc_regrading_daily_log_id);
    } else if (qc_reject_case_id) {
      whereClause = 'qc_reject_case_id = ?';
      params.push(qc_reject_case_id);
    }

    const [rows] = await db.promise().query(`
      SELECT * FROM qc_media WHERE ${whereClause} ORDER BY created_at
    `, params);

    res.json(rows);
  } catch (e) {
    console.error('Error fetching media:', e);
    res.status(500).json(errPayload('Failed to fetch media', 'DB_ERROR', e.message));
  }
});

// DELETE /api/quality-check/media/:id - Delete media file and record (Super Admin only)
router.delete('/media/:id', requireAuth, async (req, res) => {
  const userId = req.session?.user?.id;
  const { id } = req.params;
  const conn = await db.promise().getConnection();

  try {
    // Check if user is Super Admin
    const [[user]] = await conn.query('SELECT roles FROM `user` WHERE id = ?', [userId]);
    const roles = user?.roles || '';
    if (!roles.includes('Super Admin')) {
      return res.status(403).json(errPayload('Only Super Admins can delete media files', 'PERMISSION_DENIED'));
    }

    // Get media details before deletion
    const [[media]] = await conn.query('SELECT file_path, original_name FROM qc_media WHERE id = ?', [id]);
    if (!media) {
      return res.status(404).json(errPayload('Media file not found', 'NOT_FOUND'));
    }

    await conn.beginTransaction();

    // Delete from database
    await conn.query('DELETE FROM qc_media WHERE id = ?', [id]);

    // Delete physical file
    const filePath = path.join(process.cwd(), media.file_path);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (fsErr) {
        console.warn('File deletion failed but DB record was removed:', fsErr);
      }
    }

    await conn.commit();
    res.json({ message: 'Media file deleted successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error deleting media:', e);
    res.status(500).json(errPayload('Failed to delete media', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// ============================================================
// QC DEFECT TYPES ENDPOINTS
// ============================================================

// GET /api/quality-check/defect-types - Get all defect types
router.get('/defect-types', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.promise().query(`
      SELECT * FROM qc_defect_types WHERE is_active = 1 ORDER BY sort_order, name
    `);
    res.json(rows);
  } catch (e) {
    console.error('Error fetching defect types:', e);
    res.status(500).json(errPayload('Failed to fetch defect types', 'DB_ERROR', e.message));
  }
});

// ============================================================
// PLACEHOLDER ENDPOINTS (to be implemented in later phases)
// ============================================================

// QC Dashboard
router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const conn = await db.promise().getConnection();

    // Get total lots count
    const [[totalLots]] = await conn.query(`
      SELECT COUNT(*) as count FROM qc_lots
    `);

    // Get lots by status
    const [statusCounts] = await conn.query(`
      SELECT 
        status,
        COUNT(*) as count
      FROM qc_lots
      GROUP BY status
    `);

    // Create status map
    const statusMap = {};
    statusCounts.forEach(row => {
      statusMap[row.status] = parseInt(row.count) || 0;
    });

    // Get inspection statistics
    const [[inspectionStats]] = await conn.query(`
      SELECT 
        COUNT(*) as total_inspections,
        SUM(CASE WHEN decision = 'ACCEPT' THEN 1 ELSE 0 END) as accepted_count,
        SUM(CASE WHEN decision = 'REGRADE' THEN 1 ELSE 0 END) as regrade_count,
        SUM(CASE WHEN decision = 'REJECT' THEN 1 ELSE 0 END) as rejected_count
      FROM qc_inspections
    `);

    // Get regrading job statistics
    const [[regradingStats]] = await conn.query(`
      SELECT 
        COUNT(*) as total_jobs,
        SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) as active_jobs,
        SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as completed_jobs
      FROM qc_regrading_jobs
    `);

    // Get reject cases statistics
    const [[rejectStats]] = await conn.query(`
      SELECT 
        COUNT(*) as total_reject_cases,
        SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) as open_cases,
        SUM(CASE WHEN status = 'CLOSED' THEN 1 ELSE 0 END) as closed_cases
      FROM qc_reject_cases
    `);

    conn.release();

    res.json({
      total_lots: parseInt(totalLots.count) || 0,
      awaiting_qc: statusMap['AWAITING_QC'] || 0,
      under_regrading: statusMap['UNDER_REGRADING'] || 0,
      rejected: statusMap['REJECTED'] || 0,
      completed: statusMap['QC_COMPLETED'] || 0,
      regraded_completed: statusMap['REGRADED_COMPLETED'] || 0,
      inspections: {
        total: parseInt(inspectionStats.total_inspections) || 0,
        accepted: parseInt(inspectionStats.accepted_count) || 0,
        regrade: parseInt(inspectionStats.regrade_count) || 0,
        rejected: parseInt(inspectionStats.rejected_count) || 0
      },
      regrading: {
        total_jobs: parseInt(regradingStats.total_jobs) || 0,
        active: parseInt(regradingStats.active_jobs) || 0,
        completed: parseInt(regradingStats.completed_jobs) || 0
      },
      reject_cases: {
        total: parseInt(rejectStats.total_reject_cases) || 0,
        open: parseInt(rejectStats.open_cases) || 0,
        closed: parseInt(rejectStats.closed_cases) || 0
      }
    });
  } catch (e) {
    console.error('Error fetching dashboard data:', e);
    res.status(500).json(errPayload('Failed to fetch dashboard data', 'DB_ERROR', e.message));
  }
});

// ============================================================
// REGRADING JOBS API
// ============================================================

// GET /api/quality-check/regrading - List regrading jobs with pagination
router.get('/regrading', requireAuth, async (req, res) => {
  try {
    const { page, pageSize, status, qc_lot_id, search } = req.query;

    let whereConditions = [];
    let queryParams = [];

    if (status) {
      whereConditions.push('rj.status = ?');
      queryParams.push(status);
    }

    if (qc_lot_id) {
      whereConditions.push('rj.qc_lot_id = ?');
      queryParams.push(qc_lot_id);
    }

    if (search) {
      whereConditions.push('(rj.job_number LIKE ? OR ql.lot_number LIKE ?)');
      const searchParam = `%${search}%`;
      queryParams.push(searchParam, searchParam);
    }

    const whereClause = whereConditions.length > 0
      ? `WHERE ${whereConditions.join(' AND ')}`
      : '';

    // Count total
    const [countResult] = await db.promise().query(`
      SELECT COUNT(*) as total
      FROM qc_regrading_jobs rj
      LEFT JOIN qc_lots ql ON ql.id = rj.qc_lot_id
      ${whereClause}
    `, queryParams);

    const total = countResult[0]?.total || 0;

    // Build pagination
    let limitClause = '';
    if (page && pageSize) {
      const offset = (parseInt(page) - 1) * parseInt(pageSize);
      limitClause = `LIMIT ${parseInt(pageSize)} OFFSET ${offset}`;
    }

    // Fetch jobs with cumulative totals
    const [rows] = await db.promise().query(`
      SELECT 
        rj.*,
        ql.lot_number,
        ql.container_number,
        ql.status as lot_status,
        u1.name as created_by_name,
        u2.name as updated_by_name,
        COALESCE(SUM(rdl.taken_for_regrading_units), 0) as total_taken_units,
        COALESCE(SUM(rdl.taken_for_regrading_net_weight), 0) as total_taken_weight,
        COALESCE(SUM(rdl.sellable_units), 0) as total_sellable_units,
        COALESCE(SUM(rdl.sellable_net_weight), 0) as total_sellable_weight,
        COALESCE(SUM(rdl.discount_units), 0) as total_discount_units,
        COALESCE(SUM(rdl.discount_net_weight), 0) as total_discount_weight,
        COALESCE(SUM(rdl.discarded_units), 0) as total_discarded_units,
        COALESCE(SUM(rdl.discarded_net_weight), 0) as total_discarded_weight,
        qli.product_name as item_name
      FROM qc_regrading_jobs rj
      LEFT JOIN qc_lots ql ON ql.id = rj.qc_lot_id
      LEFT JOIN qc_inspections qi ON qi.id = rj.qc_inspection_id
      LEFT JOIN qc_lot_items qli ON qli.id = COALESCE(rj.qc_lot_item_id, qi.qc_lot_item_id)
      LEFT JOIN \`user\` u1 ON u1.id = rj.created_by
      LEFT JOIN \`user\` u2 ON u2.id = rj.updated_by
      LEFT JOIN qc_regrading_daily_logs rdl ON rdl.qc_regrading_job_id = rj.id
      ${whereClause}
      GROUP BY rj.id
      ORDER BY rj.created_at DESC
      ${limitClause}
    `, queryParams);

    res.json({
      rows,
      total
    });
  } catch (e) {
    console.error('Error fetching regrading jobs:', e);
    res.status(500).json(errPayload('Failed to fetch regrading jobs', 'DB_ERROR', e.message));
  }
});

// GET /api/quality-check/regrading/:id - Get single regrading job with daily logs
router.get('/regrading/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Get job details
    const [jobs] = await db.promise().query(`
      SELECT 
        rj.*,
        ql.lot_number,
        ql.container_number,
        ql.status as lot_status,
        qi.decision as inspection_decision,
        u1.name as created_by_name,
        u2.name as updated_by_name,
        u3.name as assigned_supervisor_name,
        qli.product_name as item_name
      FROM qc_regrading_jobs rj
      LEFT JOIN qc_lots ql ON ql.id = rj.qc_lot_id 
      LEFT JOIN qc_inspections qi ON qi.id = rj.qc_inspection_id
      LEFT JOIN qc_lot_items qli ON qli.id = COALESCE(rj.qc_lot_item_id, qi.qc_lot_item_id)
      LEFT JOIN \`user\` u1 ON u1.id = rj.created_by
      LEFT JOIN \`user\` u2 ON u2.id = rj.updated_by
      LEFT JOIN \`user\` u3 ON u3.id = rj.assigned_supervisor
      WHERE rj.id = ?
    `, [id]);

    if (jobs.length === 0) {
      return res.status(404).json(errPayload('Regrading job not found', 'NOT_FOUND'));
    }

    const job = jobs[0];

    // Get daily logs
    const [logs] = await db.promise().query(`
      SELECT 
        rdl.*,
        u1.name as created_by_name,
        u2.name as updated_by_name
      FROM qc_regrading_daily_logs rdl
      LEFT JOIN \`user\` u1 ON u1.id = rdl.created_by
      LEFT JOIN \`user\` u2 ON u2.id = rdl.updated_by
      WHERE rdl.qc_regrading_job_id = ?
      ORDER BY rdl.log_date ASC
    `, [id]);

    // Calculate cumulative totals
    const totalQuantityUnits = parseFloat(job.total_quantity_units) || 0;
    const totalQuantityWeight = parseFloat(job.total_quantity_net_weight) || 0;

    let cumulativeTakenUnits = 0;
    let cumulativeTakenWeight = 0;
    let cumulativeSellableUnits = 0;
    let cumulativeSellableWeight = 0;
    let cumulativeDiscountUnits = 0;
    let cumulativeDiscountWeight = 0;
    let cumulativeDiscardedUnits = 0;
    let cumulativeDiscardedWeight = 0;

    const logsWithCumulative = logs.map(log => {
      cumulativeTakenUnits += parseFloat(log.taken_for_regrading_units) || 0;
      cumulativeTakenWeight += parseFloat(log.taken_for_regrading_net_weight) || 0;
      cumulativeSellableUnits += parseFloat(log.sellable_units) || 0;
      cumulativeSellableWeight += parseFloat(log.sellable_net_weight) || 0;
      cumulativeDiscountUnits += parseFloat(log.discount_units) || 0;
      cumulativeDiscountWeight += parseFloat(log.discount_net_weight) || 0;
      cumulativeDiscardedUnits += parseFloat(log.discarded_units) || 0;
      cumulativeDiscardedWeight += parseFloat(log.discarded_net_weight) || 0;

      const openingUnits = totalQuantityUnits - cumulativeTakenUnits + (parseFloat(log.taken_for_regrading_units) || 0);
      const openingWeight = totalQuantityWeight - cumulativeTakenWeight + (parseFloat(log.taken_for_regrading_net_weight) || 0);
      const closingUnits = openingUnits - (parseFloat(log.taken_for_regrading_units) || 0);
      const closingWeight = openingWeight - (parseFloat(log.taken_for_regrading_net_weight) || 0);

      return {
        ...log,
        opening_balance_units: openingUnits,
        opening_balance_weight: openingWeight,
        closing_balance_units: closingUnits,
        closing_balance_weight: closingWeight,
        cumulative_taken_units: cumulativeTakenUnits,
        cumulative_taken_weight: cumulativeTakenWeight,
        cumulative_sellable_units: cumulativeSellableUnits,
        cumulative_sellable_weight: cumulativeSellableWeight,
        cumulative_discount_units: cumulativeDiscountUnits,
        cumulative_discount_weight: cumulativeDiscountWeight,
        cumulative_discarded_units: cumulativeDiscardedUnits,
        cumulative_discarded_weight: cumulativeDiscardedWeight
      };
    });

    const remainingUnits = totalQuantityUnits - cumulativeTakenUnits;
    const remainingWeight = totalQuantityWeight - cumulativeTakenWeight;

    res.json({
      ...job,
      daily_logs: logsWithCumulative,
      totals: {
        opening_units: totalQuantityUnits,
        opening_weight: totalQuantityWeight,
        total_taken_units: cumulativeTakenUnits,
        total_taken_weight: cumulativeTakenWeight,
        total_sellable_units: cumulativeSellableUnits,
        total_sellable_weight: cumulativeSellableWeight,
        total_discount_units: cumulativeDiscountUnits,
        total_discount_weight: cumulativeDiscountWeight,
        total_discarded_units: cumulativeDiscardedUnits,
        total_discarded_weight: cumulativeDiscardedWeight,
        remaining_units: remainingUnits,
        remaining_weight: remainingWeight
      }
    });
  } catch (e) {
    console.error('Error fetching regrading job:', e);
    res.status(500).json(errPayload('Failed to fetch regrading job', 'DB_ERROR', e.message));
  }
});

// POST /api/quality-check/regrading/:id/daily-logs - Create daily log
router.post('/regrading/:id/daily-logs', upload.array('media', 20), requireAuth, async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();
    const userId = req.session?.user?.id;
    const { id: jobId } = req.params;
    const {
      log_date,
      taken_for_regrading_units,
      taken_for_regrading_net_weight,
      sellable_units,
      sellable_net_weight,
      discount_units,
      discount_net_weight,
      discarded_units,
      discarded_net_weight,
      notes
    } = req.body;

    // Get job details to calculate opening balance
    const [[job]] = await conn.query(`
      SELECT total_quantity_units, total_quantity_net_weight, status
      FROM qc_regrading_jobs WHERE id = ?
    `, [jobId]);

    if (!job) {
      return res.status(404).json(errPayload('Regrading job not found', 'NOT_FOUND'));
    }

    // Check if log already exists for this date
    const [[existingLog]] = await conn.query(`
      SELECT id FROM qc_regrading_daily_logs 
      WHERE qc_regrading_job_id = ? AND log_date = ?
    `, [jobId, log_date]);

    if (existingLog) {
      return res.status(400).json(errPayload('Daily log already exists for this date', 'VALIDATION_ERROR'));
    }

    // Calculate opening balance from previous logs
    const [previousLogs] = await conn.query(`
      SELECT 
        COALESCE(SUM(taken_for_regrading_units), 0) as total_taken_units,
        COALESCE(SUM(taken_for_regrading_net_weight), 0) as total_taken_weight
      FROM qc_regrading_daily_logs
      WHERE qc_regrading_job_id = ? AND log_date < ?
    `, [jobId, log_date]);

    const totalTakenUnits = parseFloat(previousLogs[0]?.total_taken_units || 0);
    const totalTakenWeight = parseFloat(previousLogs[0]?.total_taken_weight || 0);
    const openingUnits = (parseFloat(job.total_quantity_units) || 0) - totalTakenUnits;
    const openingWeight = (parseFloat(job.total_quantity_net_weight) || 0) - totalTakenWeight;

    // Validations
    const takenUnits = parseFloat(taken_for_regrading_units) || 0;
    const takenWeight = parseFloat(taken_for_regrading_net_weight) || 0;

    // Require at least one quantity
    if (takenUnits === 0 && takenWeight === 0) {
      return res.status(400).json(errPayload('At least one taken quantity (units or weight) is required', 'VALIDATION_ERROR'));
    }

    // Validate taken doesn't exceed opening balance
    if (takenUnits > openingUnits || takenWeight > openingWeight) {
      return res.status(400).json(errPayload('Taken quantity cannot exceed opening balance', 'VALIDATION_ERROR'));
    }

    const sellableUnits = parseFloat(sellable_units) || 0;
    const sellableWeight = parseFloat(sellable_net_weight) || 0;
    const discountUnits = parseFloat(discount_units) || 0;
    const discountWeight = parseFloat(discount_net_weight) || 0;
    const discardedUnits = parseFloat(discarded_units) || 0;
    const discardedWeight = parseFloat(discarded_net_weight) || 0;

    const totalOutputUnits = sellableUnits + discountUnits + discardedUnits;
    const totalOutputWeight = sellableWeight + discountWeight + discardedWeight;

    if (totalOutputUnits > takenUnits || totalOutputWeight > takenWeight) {
      return res.status(400).json(errPayload('Total outputs cannot exceed taken quantity', 'VALIDATION_ERROR'));
    }

    // Require comments if discarded > 0
    if ((discardedUnits > 0 || discardedWeight > 0) && (!notes || notes.trim().length === 0)) {
      return res.status(400).json(errPayload('Comments are required when discarded quantity > 0', 'VALIDATION_ERROR'));
    }

    // Require media (at least one photo or video)
    if (!req.files || req.files.length === 0) {
      return res.status(400).json(errPayload('At least one photo or video is required for daily log', 'VALIDATION_ERROR'));
    }

    // Create daily log
    const [logResult] = await conn.query(`
      INSERT INTO qc_regrading_daily_logs (
        qc_regrading_job_id, log_date,
        taken_for_regrading_units, taken_for_regrading_net_weight,
        sellable_units, sellable_net_weight,
        discount_units, discount_net_weight,
        discarded_units, discarded_net_weight,
        notes, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      jobId, log_date,
      takenUnits || null, takenWeight || null,
      sellableUnits || null, sellableWeight || null,
      discountUnits || null, discountWeight || null,
      discardedUnits || null, discardedWeight || null,
      notes || null, userId
    ]);

    const logId = logResult.insertId;

    // Log history for daily log creation
    await addHistory(conn, {
      module: 'qc_regrading_daily_log',
      moduleId: logId,
      userId,
      action: 'CREATED',
      details: {
        qc_regrading_job_id: jobId,
        log_date,
        taken_for_regrading_units: takenUnits,
        sellable_units: sellableUnits,
        discount_units: discountUnits,
        discarded_units: discardedUnits
      }
    });

    // Log history for regrading job
    await addHistory(conn, {
      module: 'qc_regrading_job',
      moduleId: jobId,
      userId,
      action: 'DAILY_LOG_CREATED',
      details: { daily_log_id: logId, log_date }
    });

    // Handle media uploads
    if (req.files && req.files.length > 0) {
      const mediaValues = req.files.map(file => [
        null, // qc_lot_id
        null, // qc_inspection_id
        jobId, // qc_regrading_job_id
        logId, // qc_regrading_daily_log_id
        null, // qc_reject_case_id
        file.mimetype.startsWith('image/') ? 'PHOTO' : 'VIDEO',
        file.originalname,
        file.path.replace(/\\/g, '/'),
        null, // thumbnail_path (can be added later)
        file.mimetype,
        file.size,
        null, // caption
        userId
      ]);

      await conn.query(`
        INSERT INTO qc_media (
          qc_lot_id, qc_inspection_id, qc_regrading_job_id, qc_regrading_daily_log_id, qc_reject_case_id,
          media_type, file_name, file_path, thumbnail_path, mime_type, size_bytes, caption, created_by
        ) VALUES ?
      `, [mediaValues]);
    }

    // Update job status to ACTIVE if it was PLANNED
    if (job.status === 'PLANNED') {
      await conn.query(`
        UPDATE qc_regrading_jobs 
        SET status = 'ACTIVE', start_date = COALESCE(start_date, NOW()), updated_by = ?
        WHERE id = ?
      `, [userId, jobId]);
    }

    await conn.commit();
    res.json({ id: logId, message: 'Daily log created successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error creating daily log:', e);
    res.status(500).json(errPayload('Failed to create daily log', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// PUT /api/quality-check/regrading/:id - Update regrading job
router.put('/regrading/:id', requireAuth, async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();
    const userId = req.session?.user?.id;
    const { id: jobId } = req.params;
    const { planned_start, assigned_supervisor, notes } = req.body;

    // Check if job exists
    const [[job]] = await conn.query(`SELECT id FROM qc_regrading_jobs WHERE id = ?`, [jobId]);
    if (!job) {
      return res.status(404).json(errPayload('Regrading job not found', 'NOT_FOUND'));
    }

    // Update job
    await conn.query(`
      UPDATE qc_regrading_jobs 
      SET planned_start = ?, assigned_supervisor = ?, notes = ?, updated_by = ?, updated_at = NOW()
      WHERE id = ?
    `, [
      planned_start || null,
      assigned_supervisor || null,
      notes || null,
      userId,
      jobId
    ]);

    await conn.commit();
    res.json({ message: 'Regrading job updated successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error updating regrading job:', e);
    res.status(500).json(errPayload('Failed to update regrading job', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// PUT /api/quality-check/regrading/:id - Update regrading job
router.put('/regrading/:id', requireAuth, async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();
    const userId = req.session?.user?.id;
    const { id: jobId } = req.params;
    const { planned_start, assigned_supervisor, notes } = req.body;

    // Check if job exists
    const [[job]] = await conn.query(`SELECT id FROM qc_regrading_jobs WHERE id = ?`, [jobId]);
    if (!job) {
      return res.status(404).json(errPayload('Regrading job not found', 'NOT_FOUND'));
    }

    // Update job
    await conn.query(`
      UPDATE qc_regrading_jobs 
      SET planned_start = ?, assigned_supervisor = ?, notes = ?, updated_by = ?, updated_at = NOW()
      WHERE id = ?
    `, [
      planned_start || null,
      assigned_supervisor || null,
      notes || null,
      userId,
      jobId
    ]);

    await conn.commit();
    res.json({ message: 'Regrading job updated successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error updating regrading job:', e);
    res.status(500).json(errPayload('Failed to update regrading job', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// PUT /api/quality-check/regrading/:id/daily-logs/:logId - Update daily log
router.put('/regrading/:id/daily-logs/:logId', upload.array('media', 20), requireAuth, async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();
    const userId = req.session?.user?.id;
    const { id: jobId, logId } = req.params;

    // Check if user is active
    const isActive = await checkUserActive(userId);
    if (!isActive) {
      await conn.rollback();
      return res.status(403).json(errPayload('Only active users can edit daily logs', 'PERMISSION_DENIED'));
    }
    const {
      log_date,
      taken_for_regrading_units,
      taken_for_regrading_net_weight,
      sellable_units,
      sellable_net_weight,
      discount_units,
      discount_net_weight,
      discarded_units,
      discarded_net_weight,
      notes
    } = req.body;

    // Get job and existing log
    const [[job]] = await conn.query(`SELECT total_quantity_units, total_quantity_net_weight FROM qc_regrading_jobs WHERE id = ?`, [jobId]);
    if (!job) {
      return res.status(404).json(errPayload('Regrading job not found', 'NOT_FOUND'));
    }

    const [[existingLog]] = await conn.query(`SELECT * FROM qc_regrading_daily_logs WHERE id = ? AND qc_regrading_job_id = ?`, [logId, jobId]);
    if (!existingLog) {
      return res.status(404).json(errPayload('Daily log not found', 'NOT_FOUND'));
    }

    // Calculate opening balance (excluding current log)
    const [previousLogs] = await conn.query(`
      SELECT 
        COALESCE(SUM(taken_for_regrading_units), 0) as total_taken_units,
        COALESCE(SUM(taken_for_regrading_net_weight), 0) as total_taken_weight
      FROM qc_regrading_daily_logs
      WHERE qc_regrading_job_id = ? AND id != ? AND log_date < ?
    `, [jobId, logId, log_date || existingLog.log_date]);

    const totalTakenUnits = parseFloat(previousLogs[0]?.total_taken_units || 0);
    const totalTakenWeight = parseFloat(previousLogs[0]?.total_taken_weight || 0);
    const openingUnits = (parseFloat(job.total_quantity_units) || 0) - totalTakenUnits;
    const openingWeight = (parseFloat(job.total_quantity_net_weight) || 0) - totalTakenWeight;

    // Validations
    const takenUnits = parseFloat(taken_for_regrading_units) || 0;
    const takenWeight = parseFloat(taken_for_regrading_net_weight) || 0;

    if (takenUnits > openingUnits || takenWeight > openingWeight) {
      return res.status(400).json(errPayload('Taken quantity cannot exceed opening balance', 'VALIDATION_ERROR'));
    }

    const sellableUnits = parseFloat(sellable_units) || 0;
    const sellableWeight = parseFloat(sellable_net_weight) || 0;
    const discountUnits = parseFloat(discount_units) || 0;
    const discountWeight = parseFloat(discount_net_weight) || 0;
    const discardedUnits = parseFloat(discarded_units) || 0;
    const discardedWeight = parseFloat(discarded_net_weight) || 0;

    const totalOutputUnits = sellableUnits + discountUnits + discardedUnits;
    const totalOutputWeight = sellableWeight + discountWeight + discardedWeight;

    if (totalOutputUnits > takenUnits || totalOutputWeight > takenWeight) {
      return res.status(400).json(errPayload('Total outputs cannot exceed taken quantity', 'VALIDATION_ERROR'));
    }

    if ((discardedUnits > 0 || discardedWeight > 0) && (!notes || notes.trim().length === 0)) {
      return res.status(400).json(errPayload('Comments are required when discarded quantity > 0', 'VALIDATION_ERROR'));
    }

    // Track changes for history
    const changes = [];
    if (existingLog.log_date !== (log_date || existingLog.log_date)) {
      changes.push({ field: 'log_date', from: existingLog.log_date, to: log_date });
    }
    if (existingLog.taken_for_regrading_units != takenUnits) {
      changes.push({ field: 'taken_for_regrading_units', from: existingLog.taken_for_regrading_units, to: takenUnits });
    }
    if (existingLog.sellable_units != sellableUnits) {
      changes.push({ field: 'sellable_units', from: existingLog.sellable_units, to: sellableUnits });
    }

    // Update daily log
    await conn.query(`
      UPDATE qc_regrading_daily_logs 
      SET log_date = ?,
          taken_for_regrading_units = ?,
          taken_for_regrading_net_weight = ?,
          sellable_units = ?,
          sellable_net_weight = ?,
          discount_units = ?,
          discount_net_weight = ?,
          discarded_units = ?,
          discarded_net_weight = ?,
          notes = ?,
          updated_by = ?,
          updated_at = NOW()
      WHERE id = ?
    `, [
      log_date || existingLog.log_date,
      takenUnits || null,
      takenWeight || null,
      sellableUnits || null,
      sellableWeight || null,
      discountUnits || null,
      discountWeight || null,
      discardedUnits || null,
      discardedWeight || null,
      notes || null,
      userId,
      logId
    ]);

    // Log history for daily log update
    await addHistory(conn, {
      module: 'qc_regrading_daily_log',
      moduleId: logId,
      userId,
      action: 'UPDATED',
      details: { changes, qc_regrading_job_id: jobId }
    });

    // Log history for regrading job
    await addHistory(conn, {
      module: 'qc_regrading_job',
      moduleId: jobId,
      userId,
      action: 'DAILY_LOG_UPDATED',
      details: { daily_log_id: logId, changes }
    });

    // Handle deleted media
    let deletedMediaIds = [];
    if (req.body.deleted_media_ids) {
      try {
        deletedMediaIds = typeof req.body.deleted_media_ids === 'string'
          ? JSON.parse(req.body.deleted_media_ids)
          : req.body.deleted_media_ids;
      } catch (e) {
        console.error('Error parsing deleted_media_ids:', e);
      }
    }

    if (deletedMediaIds.length > 0) {
      // Delete media records (soft delete or hard delete based on your preference)
      await conn.query(`
        DELETE FROM qc_media 
        WHERE id IN (?) AND qc_regrading_daily_log_id = ?
      `, [deletedMediaIds, logId]);
    }

    // Handle new media uploads
    if (req.files && req.files.length > 0) {
      const mediaValues = req.files.map(file => [
        null, null, jobId, logId, null,
        file.mimetype.startsWith('image/') ? 'PHOTO' : 'VIDEO',
        file.originalname,
        file.path.replace(/\\/g, '/'),
        null, file.mimetype, file.size, null, userId
      ]);

      await conn.query(`
        INSERT INTO qc_media (
          qc_lot_id, qc_inspection_id, qc_regrading_job_id, qc_regrading_daily_log_id, qc_reject_case_id,
          media_type, file_name, file_path, thumbnail_path, mime_type, size_bytes, caption, created_by
        ) VALUES ?
      `, [mediaValues]);
    }

    await conn.commit();
    res.json({ id: logId, message: 'Daily log updated successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error updating daily log:', e);
    res.status(500).json(errPayload('Failed to update daily log', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// PUT /api/quality-check/regrading/:id/status - Change regrading job status
router.put('/regrading/:id/status', requireAuth, requirePerm('QualityCheck', 'edit'), async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();
    const userId = req.session?.user?.id;
    const { id: jobId } = req.params;
    const { status, reason } = req.body;

    if (!status) {
      await conn.rollback();
      return res.status(400).json(errPayload('Status is required', 'VALIDATION_ERROR'));
    }

    // Valid regrading job statuses
    const validStatuses = ['PLANNED', 'ACTIVE', 'COMPLETED', 'CLOSED'];
    if (!validStatuses.includes(status)) {
      await conn.rollback();
      return res.status(400).json(errPayload(`Invalid status. Must be one of: ${validStatuses.join(', ')}`, 'VALIDATION_ERROR'));
    }

    // Get current job status
    const [[job]] = await conn.query('SELECT id, status, qc_lot_id FROM qc_regrading_jobs WHERE id = ?', [jobId]);
    if (!job) {
      await conn.rollback();
      return res.status(404).json(errPayload('Regrading job not found', 'NOT_FOUND'));
    }

    const oldStatus = job.status;

    // Update status
    await conn.query(`
      UPDATE qc_regrading_jobs SET
        status = ?,
        ${status === 'COMPLETED' ? 'completed_date = NOW(),' : ''}
        ${status === 'CLOSED' ? 'completed_date = COALESCE(completed_date, NOW()),' : ''}
        updated_by = ?,
        updated_at = NOW()
      WHERE id = ?
    `, [status, userId, jobId]);

    // Log history for status change
    await addHistory(conn, {
      module: 'qc_regrading_job',
      moduleId: jobId,
      userId,
      action: 'STATUS_CHANGED',
      details: {
        from: oldStatus,
        to: status,
        reason: reason || 'Manual status change'
      }
    });

    await conn.commit();
    res.json({
      message: 'Status changed successfully',
      status,
      oldStatus
    });
  } catch (e) {
    await conn.rollback();
    console.error('Error changing regrading job status:', e);
    res.status(500).json(errPayload('Failed to change status', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// PUT /api/quality-check/regrading/:id/complete - Complete regrading job
router.put('/regrading/:id/complete', requireAuth, async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();
    const userId = req.session?.user?.id;
    const { id: jobId } = req.params;

    // Get job and calculate remaining
    const [[job]] = await conn.query(`
      SELECT 
        rj.*,
        ql.id as lot_id
      FROM qc_regrading_jobs rj
      LEFT JOIN qc_lots ql ON ql.id = rj.qc_lot_id
      WHERE rj.id = ?
    `, [jobId]);

    if (!job) {
      return res.status(404).json(errPayload('Regrading job not found', 'NOT_FOUND'));
    }

    // Calculate totals from daily logs
    const [totals] = await conn.query(`
      SELECT 
        COALESCE(SUM(taken_for_regrading_units), 0) as total_taken_units,
        COALESCE(SUM(taken_for_regrading_net_weight), 0) as total_taken_weight
      FROM qc_regrading_daily_logs
      WHERE qc_regrading_job_id = ?
    `, [jobId]);

    const totalTakenUnits = parseFloat(totals[0]?.total_taken_units || 0);
    const totalTakenWeight = parseFloat(totals[0]?.total_taken_weight || 0);
    const totalQuantityUnits = parseFloat(job.total_quantity_units) || 0;
    const totalQuantityWeight = parseFloat(job.total_quantity_net_weight) || 0;
    const remainingUnits = totalQuantityUnits - totalTakenUnits;
    const remainingWeight = totalQuantityWeight - totalTakenWeight;

    // Only allow completion if remaining is 0 or very close (within 0.01)
    if (remainingUnits > 0.01 || remainingWeight > 0.01) {
      return res.status(400).json(errPayload('Cannot complete job: remaining quantity must be 0', 'VALIDATION_ERROR'));
    }

    // Get old lot status before update
    const [[oldLot]] = await conn.query('SELECT status FROM qc_lots WHERE id = ?', [job.lot_id]);

    // Update job status
    await conn.query(`
      UPDATE qc_regrading_jobs 
      SET status = 'COMPLETED', completed_date = NOW(), updated_by = ?
      WHERE id = ?
    `, [userId, jobId]);

    // Update lot status to REGRADED_COMPLETED
    await conn.query(`
      UPDATE qc_lots 
      SET status = 'REGRADED_COMPLETED', updated_by = ?
      WHERE id = ?
    `, [userId, job.lot_id]);

    // Log lot status change
    await addHistory(conn, {
      module: 'qc_lot',
      moduleId: job.lot_id,
      userId,
      action: 'STATUS_CHANGED',
      details: { from: oldLot?.status, to: 'REGRADED_COMPLETED', reason: 'Regrading job completed', regrading_job_id: jobId }
    });

    // Log regrading job completion
    await addHistory(conn, {
      module: 'qc_regrading_job',
      moduleId: jobId,
      userId,
      action: 'COMPLETED',
      details: { qc_lot_id: job.lot_id }
    });

    await conn.commit();
    res.json({ message: 'Regrading job completed successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error completing regrading job:', e);
    res.status(500).json(errPayload('Failed to complete regrading job', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// =====================================================
// REJECT CASES API
// =====================================================

// GET /api/quality-check/rejects - List all reject cases with pagination and filters
router.get('/rejects', requireAuth, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, status, case_number, lot_number, container_number } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(pageSize);

    let whereClauses = [];
    const params = [];

    if (status) {
      whereClauses.push('rc.status = ?');
      params.push(status);
    }

    if (case_number) {
      whereClauses.push('rc.case_number LIKE ?');
      params.push(`%${case_number}%`);
    }

    if (lot_number) {
      whereClauses.push('ql.lot_number LIKE ?');
      params.push(`%${lot_number}%`);
    }

    if (container_number) {
      whereClauses.push('ql.container_number LIKE ?');
      params.push(`%${container_number}%`);
    }

    const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Get total count
    const [countResult] = await db.promise().query(`
      SELECT COUNT(*) as total
      FROM qc_reject_cases rc
      LEFT JOIN qc_lots ql ON ql.id = rc.qc_lot_id
      ${whereClause}
    `, params);

    const total = countResult[0]?.total || 0;

    // Get paginated results
    const [rows] = await db.promise().query(`
      SELECT 
        rc.*,
        ql.lot_number,
        ql.container_number,
        ql.origin_country,
        ql.arrival_date_time,
        qi.inspection_date,
        qi.decision,
        u1.name as created_by_name,
        u2.name as action_owner_name,
        qli.product_name as item_name
      FROM qc_reject_cases rc
      LEFT JOIN qc_lots ql ON ql.id = rc.qc_lot_id
      LEFT JOIN qc_lot_items qli ON qli.id = rc.qc_lot_item_id
      LEFT JOIN qc_inspections qi ON qi.id = rc.qc_inspection_id
      LEFT JOIN user u1 ON u1.id = rc.created_by
      LEFT JOIN user u2 ON u2.id = rc.action_owner
      ${whereClause}
      ORDER BY rc.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(pageSize), offset]);

    res.json({
      data: rows,
      totalRows: total,
      page: parseInt(page),
      pageSize: parseInt(pageSize)
    });
  } catch (e) {
    console.error('Error fetching reject cases:', e);
    res.status(500).json(errPayload('Failed to fetch reject cases', 'DB_ERROR', e.message));
  }
});

// GET /api/quality-check/rejects/:id - Get reject case details
router.get('/rejects/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const [[rejectCase]] = await db.promise().query(`
      SELECT 
        rc.*,
        ql.lot_number,
        ql.container_number,
        ql.origin_country,
        ql.origin_farm_market,
        ql.arrival_date_time,
        (SELECT COALESCE(SUM(declared_quantity_units), 0) FROM qc_lot_items WHERE qc_lot_id = ql.id) as declared_quantity_units,
        (SELECT COALESCE(SUM(declared_quantity_net_weight), 0) FROM qc_lot_items WHERE qc_lot_id = ql.id) as declared_quantity_net_weight,
        qi.id as inspection_id,
        qi.inspection_date,
        qi.decision,
        qi.comments as inspection_comments,
        qi.defects_json,
        u1.name as created_by_name,
        u2.name as action_owner_name,
        qli.product_name as item_name
      FROM qc_reject_cases rc
      LEFT JOIN qc_lots ql ON ql.id = rc.qc_lot_id
      LEFT JOIN qc_lot_items qli ON qli.id = rc.qc_lot_item_id
      LEFT JOIN qc_inspections qi ON qi.id = rc.qc_inspection_id
      LEFT JOIN user u1 ON u1.id = rc.created_by
      LEFT JOIN user u2 ON u2.id = rc.action_owner
      WHERE rc.id = ?
    `, [id]);

    if (!rejectCase) {
      return res.status(404).json(errPayload('Reject case not found', 'NOT_FOUND'));
    }

    // Get media for this reject case
    const [media] = await db.promise().query(`
      SELECT * FROM qc_media 
      WHERE qc_reject_case_id = ? 
      ORDER BY created_at
    `, [id]);

    rejectCase.media = media || [];

    res.json(rejectCase);
  } catch (e) {
    console.error('Error fetching reject case:', e);
    res.status(500).json(errPayload('Failed to fetch reject case', 'DB_ERROR', e.message));
  }
});

// PUT /api/quality-check/rejects/:id - Update reject case
router.put('/rejects/:id', requireAuth, requirePerm('QualityCheck', 'update'), async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();
    const userId = req.session?.user?.id;
    const { id } = req.params;
    const {
      disposition,
      action_owner,
      deadline,
      notes,
      supplier_response,
      claim_reference,
      recovered_amount,
      credit_note_number
    } = req.body;

    await conn.query(`
      UPDATE qc_reject_cases 
      SET 
        disposition = ?,
        action_owner = ?,
        deadline = ?,
        notes = ?,
        supplier_response = ?,
        claim_reference = ?,
        recovered_amount = ?,
        credit_note_number = ?,
        updated_by = ?,
        updated_at = NOW()
      WHERE id = ?
    `, [
      disposition || null,
      action_owner || null,
      deadline || null,
      notes || null,
      supplier_response || null,
      claim_reference || null,
      recovered_amount || null,
      credit_note_number || null,
      userId,
      id
    ]);

    await conn.commit();
    res.json({ message: 'Reject case updated successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error updating reject case:', e);
    res.status(500).json(errPayload('Failed to update reject case', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// POST /api/quality-check/rejects/:id/mark-returned - Mark case as returned with proof media
router.post('/rejects/:id/mark-returned', requireAuth, requirePerm('QualityCheck', 'update'), upload.array('media', 10), async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();
    const userId = req.session?.user?.id;
    const { id } = req.params;
    const { notes } = req.body;

    // Validate media is provided
    if (!req.files || req.files.length === 0) {
      await conn.rollback();
      return res.status(400).json(errPayload('Proof media is required when marking as returned', 'VALIDATION_ERROR'));
    }

    // Update reject case
    await conn.query(`
      UPDATE qc_reject_cases 
      SET 
        status = 'ACTIONING',
        returned_date = NOW(),
        notes = COALESCE(?, notes),
        updated_by = ?,
        updated_at = NOW()
      WHERE id = ?
    `, [notes || null, userId, id]);

    // Save media
    const mediaValues = req.files.map(file => [
      null, null, null, null, id,
      file.mimetype.startsWith('image/') ? 'PHOTO' : 'VIDEO',
      file.originalname,
      file.path.replace(/\\/g, '/'),
      null,
      file.mimetype,
      file.size,
      'Return Proof',
      userId
    ]);

    await conn.query(`
      INSERT INTO qc_media (
        qc_lot_id, qc_inspection_id, qc_regrading_job_id, qc_regrading_daily_log_id, qc_reject_case_id,
        media_type, file_name, file_path, thumbnail_path, mime_type, size_bytes, caption, created_by
      ) VALUES ?
    `, [mediaValues]);

    await conn.commit();
    res.json({ message: 'Reject case marked as returned successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error marking reject case as returned:', e);
    res.status(500).json(errPayload('Failed to mark as returned', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// POST /api/quality-check/rejects/:id/mark-disposed - Mark case as disposed with proof media
router.post('/rejects/:id/mark-disposed', requireAuth, requirePerm('QualityCheck', 'update'), upload.array('media', 10), async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();
    const userId = req.session?.user?.id;
    const { id } = req.params;
    const { notes } = req.body;

    // Validate media is provided
    if (!req.files || req.files.length === 0) {
      await conn.rollback();
      return res.status(400).json(errPayload('Disposal proof media is required when marking as disposed', 'VALIDATION_ERROR'));
    }

    // Update reject case
    await conn.query(`
      UPDATE qc_reject_cases 
      SET 
        status = 'ACTIONING',
        disposed_date = NOW(),
        notes = COALESCE(?, notes),
        updated_by = ?,
        updated_at = NOW()
      WHERE id = ?
    `, [notes || null, userId, id]);

    // Save media
    const mediaValues = req.files.map(file => [
      null, null, null, null, id,
      file.mimetype.startsWith('image/') ? 'PHOTO' : 'VIDEO',
      file.originalname,
      file.path.replace(/\\/g, '/'),
      null,
      file.mimetype,
      file.size,
      'Disposal Proof',
      userId
    ]);

    await conn.query(`
      INSERT INTO qc_media (
        qc_lot_id, qc_inspection_id, qc_regrading_job_id, qc_regrading_daily_log_id, qc_reject_case_id,
        media_type, file_name, file_path, thumbnail_path, mime_type, size_bytes, caption, created_by
      ) VALUES ?
    `, [mediaValues]);

    await conn.commit();
    res.json({ message: 'Reject case marked as disposed successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error marking reject case as disposed:', e);
    res.status(500).json(errPayload('Failed to mark as disposed', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// POST /api/quality-check/rejects/:id/close - Close reject case
router.post('/rejects/:id/close', requireAuth, requirePerm('QualityCheck', 'update'), async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();
    const userId = req.session?.user?.id;
    const { id } = req.params;
    const { notes } = req.body;

    // Update reject case
    await conn.query(`
      UPDATE qc_reject_cases 
      SET 
        status = 'CLOSED',
        resolved_date = NOW(),
        notes = COALESCE(?, notes),
        updated_by = ?,
        updated_at = NOW()
      WHERE id = ?
    `, [notes || null, userId, id]);

    await conn.commit();
    res.json({ message: 'Reject case closed successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error closing reject case:', e);
    res.status(500).json(errPayload('Failed to close reject case', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// GET /api/quality-check/media - Get all QC media with optional filters
// GET /api/quality-check/media-library - Get all media with pagination and filters (Media Library page)
router.get('/media-library', requireAuth, async (req, res) => {
  try {
    const {
      start_date,
      end_date,
      media_type,
      search,
      page = 1,
      pageSize = 50
    } = req.query;

    console.log('[Media Library] Request params:', { start_date, end_date, media_type, search, page, pageSize });

    // First, let's verify we can query the table at all
    const [testQuery] = await db.promise().query(`SELECT COUNT(*) as count FROM qc_media`);
    console.log('[Media Library] Direct count from qc_media table:', testQuery[0]?.count);

    const offset = (parseInt(page) - 1) * parseInt(pageSize);

    // Get total count with filters applied
    let countWhereClause = 'WHERE 1=1';
    const countParams = [];

    // Date filters for count
    if (start_date && end_date) {
      countWhereClause += ' AND DATE(qm.created_at) BETWEEN ? AND ?';
      countParams.push(start_date, end_date);
    } else if (start_date) {
      countWhereClause += ' AND DATE(qm.created_at) >= ?';
      countParams.push(start_date);
    } else if (end_date) {
      countWhereClause += ' AND DATE(qm.created_at) <= ?';
      countParams.push(end_date);
    }

    // Media type filter for count
    if (media_type && (media_type === 'PHOTO' || media_type === 'VIDEO')) {
      countWhereClause += ' AND qm.media_type = ?';
      countParams.push(media_type);
    }

    // Build count query with JOINs if search is needed
    let countQuery = `SELECT COUNT(*) as total FROM qc_media qm`;
    if (search && search.trim()) {
      countQuery += `
        LEFT JOIN qc_lots ql_count ON ql_count.id = qm.qc_lot_id
        LEFT JOIN qc_reject_cases rc_count ON rc_count.id = qm.qc_reject_case_id
      `;
      countWhereClause += ` AND (
        ql_count.lot_number LIKE ? OR 
        ql_count.container_number LIKE ? OR 
        rc_count.case_number LIKE ?
      )`;
      const searchPattern = `%${search.trim()}%`;
      countParams.push(searchPattern, searchPattern, searchPattern);
    }
    countQuery += ` ${countWhereClause}`;
    const [countRows] = await db.promise().query(countQuery, countParams);
    const total = countRows[0]?.total || 0;
    console.log('[Media Library] Total count query result:', total);

    // Get media with related entity info
    // TEMPORARILY COMMENTED OUT ALL WHERE CONDITIONS TO SHOW ALL MEDIA
    let query = `
      SELECT 
        qm.*,
        ql.lot_number,
        ql.container_number,
        qi.inspection_date,
        rj.id as regrading_job_id,
        ql2.lot_number as regrading_lot_number,
        rc.case_number,
        u.name as created_by_name,
        CASE 
          WHEN qm.qc_lot_id IS NOT NULL THEN 'Lot'
          WHEN qm.qc_inspection_id IS NOT NULL THEN 'Inspection'
          WHEN qm.qc_regrading_job_id IS NOT NULL THEN 'Regrading Job'
          WHEN qm.qc_regrading_daily_log_id IS NOT NULL THEN 'Daily Log'
          WHEN qm.qc_reject_case_id IS NOT NULL THEN 'Reject Case'
          ELSE 'Unknown'
        END as entity_type_name
      FROM qc_media qm
      LEFT JOIN qc_lots ql ON ql.id = qm.qc_lot_id
      LEFT JOIN qc_inspections qi ON qi.id = qm.qc_inspection_id
      LEFT JOIN qc_regrading_jobs rj ON rj.id = qm.qc_regrading_job_id
      LEFT JOIN qc_lots ql2 ON ql2.id = rj.qc_lot_id
      LEFT JOIN qc_reject_cases rc ON rc.id = qm.qc_reject_case_id
      LEFT JOIN user u ON u.id = qm.created_by
    `;

    // Build WHERE conditions with proper parameter handling
    const queryParams = [];
    let queryWhere = 'WHERE 1=1';

    // Date filters
    if (start_date && end_date) {
      queryWhere += ' AND DATE(qm.created_at) BETWEEN ? AND ?';
      queryParams.push(start_date, end_date);
    } else if (start_date) {
      queryWhere += ' AND DATE(qm.created_at) >= ?';
      queryParams.push(start_date);
    } else if (end_date) {
      queryWhere += ' AND DATE(qm.created_at) <= ?';
      queryParams.push(end_date);
    }

    // Media type filter
    if (media_type && (media_type === 'PHOTO' || media_type === 'VIDEO')) {
      queryWhere += ' AND qm.media_type = ?';
      queryParams.push(media_type);
    }

    // Search filter (requires JOINs which are already in the query)
    if (search && search.trim()) {
      queryWhere += ` AND (
        ql.lot_number LIKE ? OR 
        ql.container_number LIKE ? OR 
        rc.case_number LIKE ?
      )`;
      const searchPattern = `%${search.trim()}%`;
      queryParams.push(searchPattern, searchPattern, searchPattern);
    }

    query += ` ${queryWhere} ORDER BY qm.created_at DESC LIMIT ? OFFSET ?`;
    queryParams.push(parseInt(pageSize), offset);

    // Log the actual MySQL query for debugging
    console.log('[Media Library] ====== MYSQL QUERY ======');
    console.log(query);
    console.log('[Media Library] Query Parameters:', queryParams);
    console.log('[Media Library] ========================');

    const [rows] = await db.promise().query(query, queryParams);

    console.log(`[Media Library] Fetched ${rows.length} media items (total: ${total})`);

    // Check total media count regardless of filters
    const [allMediaCount] = await db.promise().query(`SELECT COUNT(*) as count FROM qc_media`);
    console.log(`[Media Library] Total media in database (unfiltered): ${allMediaCount[0]?.count || 0}`);

    if (rows.length > 0) {
      console.log(`[Media Library] Sample media item:`, {
        id: rows[0].id,
        file_path: rows[0].file_path,
        media_type: rows[0].media_type,
        entity_type: rows[0].entity_type_name,
        qc_lot_id: rows[0].qc_lot_id,
        qc_inspection_id: rows[0].qc_inspection_id,
        qc_regrading_job_id: rows[0].qc_regrading_job_id,
        qc_regrading_daily_log_id: rows[0].qc_regrading_daily_log_id,
        qc_reject_case_id: rows[0].qc_reject_case_id
      });
    } else if (allMediaCount[0]?.count > 0) {
      // If there's media in DB but query returned nothing, there might be a filter issue
      console.log(`[Media Library] WARNING: Database has ${allMediaCount[0].count} media but query returned 0. Check filters.`);
    }

    // Ensure file_path starts with / for frontend
    const processedRows = rows.map(row => ({
      ...row,
      file_path: row.file_path?.startsWith('/') ? row.file_path : `/${row.file_path}`,
      thumbnail_path: row.thumbnail_path ? (row.thumbnail_path.startsWith('/') ? row.thumbnail_path : `/${row.thumbnail_path}`) : null
    }));

    const responseData = {
      data: processedRows,
      total: total,
      page: parseInt(page),
      pageSize: parseInt(pageSize),
      totalPages: Math.ceil(total / parseInt(pageSize))
    };

    console.log('[Media Library] Response being sent:');
    console.log('  - data array length:', responseData.data.length);
    console.log('  - total:', responseData.total);
    console.log('  - page:', responseData.page);
    console.log('  - pageSize:', responseData.pageSize);

    if (responseData.data.length > 0) {
      console.log('  - First item in response:', {
        id: responseData.data[0].id,
        file_path: responseData.data[0].file_path,
        media_type: responseData.data[0].media_type
      });
    }

    res.json(responseData);
  } catch (e) {
    console.error('Error fetching media library:', e);
    res.status(500).json(errPayload('Failed to fetch media library', 'DB_ERROR', e.message));
  }
});

// ============================================================
// REPORTS API
// ============================================================

// GET /api/quality-check/reports/summary - QC Summary by date range
router.get('/reports/summary', requireAuth, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    if (!start_date || !end_date) {
      return res.status(400).json(errPayload('start_date and end_date are required', 'VALIDATION_ERROR'));
    }

    const [rows] = await db.promise().query(`
      SELECT 
        COUNT(DISTINCT ql.id) as total_lots,
        COUNT(DISTINCT CASE WHEN qi.decision = 'ACCEPT' THEN ql.id END) as accepted_lots,
        COUNT(DISTINCT CASE WHEN qi.decision = 'REGRADE' THEN ql.id END) as regraded_lots,
        COUNT(DISTINCT CASE WHEN qi.decision = 'REJECT' THEN ql.id END) as rejected_lots,
        COUNT(DISTINCT CASE WHEN qi.decision = 'ACCEPT' THEN qi.id END) as accepted_inspections,
        COUNT(DISTINCT CASE WHEN qi.decision = 'REGRADE' THEN qi.id END) as regraded_inspections,
        COUNT(DISTINCT CASE WHEN qi.decision = 'REJECT' THEN qi.id END) as rejected_inspections,
        COALESCE(SUM(CASE WHEN qi.decision = 'ACCEPT' THEN qi.accepted_quantity_units END), 0) as accepted_quantity_units,
        COALESCE(SUM(CASE WHEN qi.decision = 'ACCEPT' THEN qi.accepted_quantity_net_weight END), 0) as accepted_quantity_weight,
        COALESCE(SUM(CASE WHEN qi.decision = 'REGRADE' THEN qi.regrade_quantity_units END), 0) as regraded_quantity_units,
        COALESCE(SUM(CASE WHEN qi.decision = 'REGRADE' THEN qi.regrade_quantity_net_weight END), 0) as regraded_quantity_weight,
        COALESCE(SUM(CASE WHEN qi.decision = 'REJECT' THEN qi.rejected_quantity_units END), 0) as rejected_quantity_units,
        COALESCE(SUM(CASE WHEN qi.decision = 'REJECT' THEN qi.rejected_quantity_net_weight END), 0) as rejected_quantity_weight
      FROM qc_lots ql
      LEFT JOIN qc_inspections qi ON qi.qc_lot_id = ql.id
      WHERE DATE(ql.arrival_date_time) BETWEEN ? AND ?
    `, [start_date, end_date]);

    const result = rows[0] || {};
    const totalLots = parseInt(result.total_lots) || 0;
    const acceptedLots = parseInt(result.accepted_lots) || 0;
    const regradedLots = parseInt(result.regraded_lots) || 0;
    const rejectedLots = parseInt(result.rejected_lots) || 0;

    res.json({
      ...result,
      accepted_count: acceptedLots,
      regraded_count: regradedLots,
      rejected_count: rejectedLots,
      accepted_percent: totalLots > 0 ? ((acceptedLots / totalLots) * 100).toFixed(2) : 0,
      regraded_percent: totalLots > 0 ? ((regradedLots / totalLots) * 100).toFixed(2) : 0,
      rejected_percent: totalLots > 0 ? ((rejectedLots / totalLots) * 100).toFixed(2) : 0
    });
  } catch (e) {
    console.error('Error fetching QC summary:', e);
    res.status(500).json(errPayload('Failed to fetch QC summary', 'DB_ERROR', e.message));
  }
});

// GET /api/quality-check/reports/waste - Waste % by product and supplier
router.get('/reports/waste', requireAuth, async (req, res) => {
  try {
    const { start_date, end_date, product_id, supplier_id } = req.query;

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (start_date && end_date) {
      whereClause += ' AND DATE(ql.arrival_date_time) BETWEEN ? AND ?';
      params.push(start_date, end_date);
      console.log('[Waste Report] Using date filter:', start_date, 'to', end_date);
    } else {
      // If no date filter, show all data (no date restriction)
      console.log('[Waste Report] No date filter provided - showing all data');
    }

    if (product_id) {
      whereClause += ' AND qli.product_id = ?';
      params.push(product_id);
    }

    if (supplier_id) {
      whereClause += ' AND ql.po_id IN (SELECT id FROM purchase_orders WHERE vendor_id = ?)';
      params.push(supplier_id);
    }

    const query = `
      SELECT 
        qli.product_id,
        qli.product_name,
        v.id as supplier_id,
        v.display_name as supplier_name,
        COUNT(DISTINCT ql.id) as total_lots,
        COALESCE(SUM(qli.declared_quantity_units), 0) as total_declared_units,
        COALESCE(SUM(qli.declared_quantity_net_weight), 0) as total_declared_weight,
        COALESCE(SUM(CASE WHEN qi.decision = 'REJECT' THEN qi.rejected_quantity_units ELSE 0 END), 0) as rejected_units,
        COALESCE(SUM(CASE WHEN qi.decision = 'REJECT' THEN qi.rejected_quantity_net_weight ELSE 0 END), 0) as rejected_weight,
        COALESCE(SUM(CASE WHEN rj.status IN ('COMPLETED', 'CLOSED') THEN rdl.discarded_units ELSE 0 END), 0) as discarded_units,
        COALESCE(SUM(CASE WHEN rj.status IN ('COMPLETED', 'CLOSED') THEN rdl.discarded_net_weight ELSE 0 END), 0) as discarded_weight
      FROM qc_lot_items qli
      INNER JOIN qc_lots ql ON ql.id = qli.qc_lot_id
      LEFT JOIN purchase_orders po ON po.id = ql.po_id
      LEFT JOIN vendor v ON v.id = po.vendor_id
      LEFT JOIN qc_inspections qi ON qi.qc_lot_id = ql.id AND qi.decision = 'REJECT'
      LEFT JOIN qc_regrading_jobs rj ON rj.qc_lot_id = ql.id AND rj.status IN ('COMPLETED', 'CLOSED')
      LEFT JOIN qc_regrading_daily_logs rdl ON rdl.qc_regrading_job_id = rj.id
      ${whereClause}
      GROUP BY qli.product_id, qli.product_name, v.id, v.display_name
      HAVING (COALESCE(SUM(CASE WHEN qi.decision = 'REJECT' THEN qi.rejected_quantity_units ELSE 0 END), 0) > 0 
              OR COALESCE(SUM(CASE WHEN rj.status IN ('COMPLETED', 'CLOSED') THEN rdl.discarded_units ELSE 0 END), 0) > 0)
      ORDER BY (COALESCE(SUM(CASE WHEN qi.decision = 'REJECT' THEN qi.rejected_quantity_units ELSE 0 END), 0) + 
                COALESCE(SUM(CASE WHEN rj.status IN ('COMPLETED', 'CLOSED') THEN rdl.discarded_units ELSE 0 END), 0)) DESC
    `;

    console.log('[Waste Report] Query:', query.replace(/\s+/g, ' '));
    console.log('[Waste Report] Params:', params);

    const [rows] = await db.promise().query(query, params);

    console.log('[Waste Report] Rows returned:', rows.length);

    if (rows.length === 0) {
      // Diagnostic queries to understand why no data
      // Extract the conditions after "WHERE 1=1" for reuse, removing leading AND
      const conditionsOnly = whereClause.replace(/^WHERE\s+1=1\s*/, '').trim();
      const conditionsWithoutAnd = conditionsOnly.replace(/^\s*AND\s+/, '');
      const diagnosticWhere = conditionsWithoutAnd ? `WHERE ${conditionsWithoutAnd}` : '';
      const diagnosticAnd = conditionsWithoutAnd ? `AND ${conditionsWithoutAnd}` : '';

      const [lotCheck] = await db.promise().query(`
        SELECT COUNT(*) as count FROM qc_lots ql ${diagnosticWhere}
      `, params);
      console.log('[Waste Report] Total lots matching date filter:', lotCheck[0]?.count || 0);

      const [rejectedCheck] = await db.promise().query(`
        SELECT COUNT(*) as count, SUM(rejected_quantity_units) as total_rejected
        FROM qc_inspections qi
        INNER JOIN qc_lots ql ON ql.id = qi.qc_lot_id
        WHERE qi.decision = 'REJECT' ${diagnosticAnd}
      `, params);
      console.log('[Waste Report] Rejected inspections:', rejectedCheck[0]?.count || 0, 'Total rejected units:', rejectedCheck[0]?.total_rejected || 0);

      const [discardedCheck] = await db.promise().query(`
        SELECT COUNT(*) as count, SUM(rdl.discarded_units) as total_discarded
        FROM qc_regrading_jobs rj
        INNER JOIN qc_lots ql ON ql.id = rj.qc_lot_id
        INNER JOIN qc_regrading_daily_logs rdl ON rdl.qc_regrading_job_id = rj.id
        WHERE rj.status IN ('COMPLETED', 'CLOSED') 
        AND rdl.discarded_units > 0
        ${diagnosticAnd}
      `, params);
      console.log('[Waste Report] Regrading jobs with discarded:', discardedCheck[0]?.count || 0, 'Total discarded units:', discardedCheck[0]?.total_discarded || 0);
    }

    const results = rows.map(row => {
      const total_units = parseFloat(row.total_declared_units) || 0;
      const total_weight = parseFloat(row.total_declared_weight) || 0;
      const waste_units = parseFloat(row.rejected_units) + parseFloat(row.discarded_units);
      const waste_weight = parseFloat(row.rejected_weight) + parseFloat(row.discarded_weight);

      return {
        ...row,
        waste_units,
        waste_weight,
        waste_percent_units: total_units > 0 ? ((waste_units / total_units) * 100).toFixed(2) : 0,
        waste_percent_weight: total_weight > 0 ? ((waste_weight / total_weight) * 100).toFixed(2) : 0
      };
    });

    res.json(results);
  } catch (e) {
    console.error('Error fetching waste report:', e);
    res.status(500).json(errPayload('Failed to fetch waste report', 'DB_ERROR', e.message));
  }
});

// GET /api/quality-check/reports/recovery - Regrading recovery rate
router.get('/reports/recovery', requireAuth, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    let whereClause = 'WHERE rj.status IN (\'COMPLETED\', \'CLOSED\')';
    const params = [];

    if (start_date && end_date) {
      whereClause += ' AND (DATE(rj.completed_date) BETWEEN ? AND ? OR (rj.completed_date IS NULL AND DATE(rj.start_date) BETWEEN ? AND ?))';
      params.push(start_date, end_date, start_date, end_date);
      console.log('[Recovery Report] Using date filter:', start_date, 'to', end_date);
    } else {
      // If no date filter, show all completed/closed jobs (no date restriction)
      console.log('[Recovery Report] No date filter provided - showing all completed/closed jobs');
    }

    const query = `
      SELECT 
        rj.id as job_id,
        ql.lot_number,
        ql.container_number,
        rj.start_date,
        rj.completed_date,
        COALESCE(SUM(rdl.taken_for_regrading_units), 0) as total_taken_units,
        COALESCE(SUM(rdl.taken_for_regrading_net_weight), 0) as total_taken_weight,
        COALESCE(SUM(rdl.sellable_units), 0) as total_sellable_units,
        COALESCE(SUM(rdl.sellable_net_weight), 0) as total_sellable_weight,
        COALESCE(SUM(rdl.discount_units), 0) as total_discount_units,
        COALESCE(SUM(rdl.discount_net_weight), 0) as total_discount_weight,
        COALESCE(SUM(rdl.discarded_units), 0) as total_discarded_units,
        COALESCE(SUM(rdl.discarded_net_weight), 0) as total_discarded_weight
      FROM qc_regrading_jobs rj
      INNER JOIN qc_lots ql ON ql.id = rj.qc_lot_id
      LEFT JOIN qc_regrading_daily_logs rdl ON rdl.qc_regrading_job_id = rj.id
      ${whereClause}
      GROUP BY rj.id, ql.lot_number, ql.container_number, rj.start_date, rj.completed_date
      HAVING COALESCE(SUM(rdl.taken_for_regrading_units), 0) > 0 OR COALESCE(SUM(rdl.taken_for_regrading_net_weight), 0) > 0
      ORDER BY COALESCE(rj.completed_date, rj.start_date) DESC
    `;

    console.log('[Recovery Report] Query:', query.replace(/\s+/g, ' '));
    console.log('[Recovery Report] Params:', params);

    const [rows] = await db.promise().query(query, params);

    console.log('[Recovery Report] Rows returned:', rows.length);
    if (rows.length > 0) {
      console.log('[Recovery Report] Sample row:', rows[0]);
    } else {
      // Check if there are any completed/closed jobs
      const [checkRows] = await db.promise().query(`
        SELECT COUNT(*) as total_jobs FROM qc_regrading_jobs WHERE status IN ('COMPLETED', 'CLOSED')
      `);
      console.log('[Recovery Report] Total completed/closed jobs:', checkRows[0]?.total_jobs || 0);
    }

    const results = rows.map(row => {
      const taken_units = parseFloat(row.total_taken_units) || 0;
      const taken_weight = parseFloat(row.total_taken_weight) || 0;
      const sellable_units = parseFloat(row.total_sellable_units) || 0;
      const sellable_weight = parseFloat(row.total_sellable_weight) || 0;

      return {
        ...row,
        recovery_percent_units: taken_units > 0 ? ((sellable_units / taken_units) * 100).toFixed(2) : 0,
        recovery_percent_weight: taken_weight > 0 ? ((sellable_weight / taken_weight) * 100).toFixed(2) : 0
      };
    });

    res.json(results);
  } catch (e) {
    console.error('Error fetching recovery report:', e);
    res.status(500).json(errPayload('Failed to fetch recovery report', 'DB_ERROR', e.message));
  }
});

// GET /api/quality-check/reports/defects - Defect frequency
router.get('/reports/defects', requireAuth, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    let dateFilter = '';
    let dateFilterForJoin = '';
    const queryParams = [];

    if (start_date && end_date) {
      dateFilter = 'AND DATE(inspection_date) BETWEEN ? AND ?';
      dateFilterForJoin = 'AND DATE(qi.inspection_date) BETWEEN ? AND ?';
      queryParams.push(start_date, end_date);
      console.log('[Defects Report] Using date filter:', start_date, 'to', end_date);
    } else {
      // If no date filter provided, show all data (no date restriction)
      console.log('[Defects Report] No date filter provided - showing all defects');
    }

    // First, let's check if there are any inspections with defects
    const checkQuery = `SELECT COUNT(*) as count FROM qc_inspections WHERE defects_json IS NOT NULL AND defects_json != '' AND defects_json != '[]' ${dateFilter}`;
    const [checkResult] = await db.promise().query(checkQuery, queryParams);
    console.log('[Defects Report] Inspections with defects:', checkResult[0]?.count || 0);

    // Query to count defect occurrences from JSON array
    // Use pattern matching to find defect_type_id in JSON (works with MySQL 5.7+)
    // The defect_type_id can be stored as string ("1") or number (1) in JSON
    const query = `
      SELECT 
        dt.id as defect_type_id,
        dt.code,
        dt.name as defect_name,
        dt.severity,
        COUNT(DISTINCT qi.id) as occurrence_count,
        COUNT(DISTINCT ql.id) as affected_lots,
        0 as total_affected_quantity_units
      FROM qc_defect_types dt
      LEFT JOIN qc_inspections qi ON (
        qi.defects_json IS NOT NULL 
        AND qi.defects_json != '' 
        AND qi.defects_json != '[]'
        AND (
          -- Match defect_type_id as string: "defect_type_id":"1"
          qi.defects_json LIKE CONCAT('%"defect_type_id":"', dt.id, '"%')
          -- Match defect_type_id as number: "defect_type_id":1 (followed by comma, }, or ])
          OR qi.defects_json REGEXP CONCAT('"defect_type_id":', dt.id, '([,\\]}])')
        )
        ${dateFilterForJoin}
      )
      LEFT JOIN qc_lots ql ON ql.id = qi.qc_lot_id
      WHERE dt.is_active = 1
      GROUP BY dt.id, dt.code, dt.name, dt.severity
      HAVING COUNT(DISTINCT qi.id) > 0
      ORDER BY occurrence_count DESC, dt.severity DESC
    `;

    console.log('[Defects Report] Query:', query.replace(/\s+/g, ' '));
    console.log('[Defects Report] Params:', queryParams);

    console.log('[Defects Report] Executing query with params:', queryParams);
    const [rows] = await db.promise().query(query, queryParams);

    console.log('[Defects Report] Rows returned:', rows.length);
    if (rows.length > 0) {
      console.log('[Defects Report] Sample row:', rows[0]);
    } else {
      console.log('[Defects Report] No defects found. Check if inspections have defects_json populated.');
      // Additional diagnostic: check if there are any defect types
      const [defectTypesCheck] = await db.promise().query(`SELECT COUNT(*) as count FROM qc_defect_types WHERE is_active = 1`);
      console.log('[Defects Report] Active defect types in database:', defectTypesCheck[0]?.count || 0);
    }

    console.log('[Defects Report] Sending response with', rows.length, 'rows');
    res.json(rows);
  } catch (e) {
    console.error('[Defects Report] Error:', e);
    console.error('[Defects Report] Error message:', e.message);
    console.error('[Defects Report] Error stack:', e.stack);
    res.status(500).json(errPayload('Failed to fetch defects report', 'DB_ERROR', e.message));
  }
});

// GET /api/quality-check/reports/export - Export report as CSV
router.get('/reports/export', requireAuth, async (req, res) => {
  try {
    const { report_type, start_date, end_date, ...filters } = req.query;

    let data = [];
    let filename = 'qc_report';
    let headers = [];

    // Fetch data directly from database instead of making HTTP calls
    switch (report_type) {
      case 'summary':
        const [summaryRows] = await db.promise().query(`
          SELECT 
            COUNT(DISTINCT ql.id) as total_lots,
            COUNT(DISTINCT CASE WHEN qi.decision = 'ACCEPT' THEN qi.id END) as accepted_count,
            COUNT(DISTINCT CASE WHEN qi.decision = 'REGRADE' THEN qi.id END) as regraded_count,
            COUNT(DISTINCT CASE WHEN qi.decision = 'REJECT' THEN qi.id END) as rejected_count
          FROM qc_lots ql
          LEFT JOIN qc_inspections qi ON qi.qc_lot_id = ql.id
          WHERE DATE(ql.arrival_date_time) BETWEEN ? AND ?
        `, [start_date, end_date]);

        const summary = summaryRows[0] || {};
        const total = summary.accepted_count + summary.regraded_count + summary.rejected_count;
        data = [{
          ...summary,
          accepted_percent: total > 0 ? ((summary.accepted_count / total) * 100).toFixed(2) : 0,
          regraded_percent: total > 0 ? ((summary.regraded_count / total) * 100).toFixed(2) : 0,
          rejected_percent: total > 0 ? ((summary.rejected_count / total) * 100).toFixed(2) : 0
        }];
        filename = `qc_summary_${start_date}_to_${end_date}`;
        headers = ['total_lots', 'accepted_count', 'regraded_count', 'rejected_count', 'accepted_percent', 'regraded_percent', 'rejected_percent'];
        break;

      case 'waste':
        let wasteWhere = 'WHERE 1=1';
        const wasteParams = [];
        if (start_date && end_date) {
          wasteWhere += ' AND DATE(ql.arrival_date_time) BETWEEN ? AND ?';
          wasteParams.push(start_date, end_date);
        }
        if (filters.product_id) {
          wasteWhere += ' AND qli.product_id = ?';
          wasteParams.push(filters.product_id);
        }
        if (filters.supplier_id) {
          wasteWhere += ' AND ql.po_id IN (SELECT id FROM purchase_orders WHERE vendor_id = ?)';
          wasteParams.push(filters.supplier_id);
        }

        const [wasteRows] = await db.promise().query(`
          SELECT 
            qli.product_name,
            v.display_name as supplier_name,
            COUNT(DISTINCT ql.id) as total_lots,
            COALESCE(SUM(CASE WHEN qi.decision = 'REJECT' THEN qi.rejected_quantity_units END), 0) + 
            COALESCE(SUM(CASE WHEN rj.status = 'COMPLETED' THEN rdl.discarded_units END), 0) as waste_units
          FROM qc_lot_items qli
          INNER JOIN qc_lots ql ON ql.id = qli.qc_lot_id
          LEFT JOIN purchase_orders po ON po.id = ql.po_id
          LEFT JOIN vendor v ON v.id = po.vendor_id
          LEFT JOIN qc_inspections qi ON qi.qc_lot_id = ql.id
          LEFT JOIN qc_regrading_jobs rj ON rj.qc_lot_id = ql.id
          LEFT JOIN qc_regrading_daily_logs rdl ON rdl.qc_regrading_job_id = rj.id
          ${wasteWhere}
          GROUP BY qli.product_name, v.display_name
          HAVING waste_units > 0
        `, wasteParams);
        data = wasteRows;
        filename = `qc_waste_${start_date}_to_${end_date}`;
        headers = ['product_name', 'supplier_name', 'total_lots', 'waste_units'];
        break;

      case 'recovery':
        let recoveryWhere = 'WHERE rj.status = "COMPLETED"';
        const recoveryParams = [];
        if (start_date && end_date) {
          recoveryWhere += ' AND DATE(rj.completed_date) BETWEEN ? AND ?';
          recoveryParams.push(start_date, end_date);
        }

        const [recoveryRows] = await db.promise().query(`
          SELECT 
            ql.lot_number,
            ql.container_number,
            COALESCE(SUM(rdl.taken_for_regrading_units), 0) as total_taken_units,
            COALESCE(SUM(rdl.sellable_units), 0) as total_sellable_units
          FROM qc_regrading_jobs rj
          INNER JOIN qc_lots ql ON ql.id = rj.qc_lot_id
          LEFT JOIN qc_regrading_daily_logs rdl ON rdl.qc_regrading_job_id = rj.id
          ${recoveryWhere}
          GROUP BY rj.id, ql.lot_number, ql.container_number
        `, recoveryParams);

        data = recoveryRows.map(row => ({
          ...row,
          recovery_percent_units: row.total_taken_units > 0 ? ((row.total_sellable_units / row.total_taken_units) * 100).toFixed(2) : 0
        }));
        filename = `qc_recovery_${start_date}_to_${end_date}`;
        headers = ['lot_number', 'container_number', 'total_taken_units', 'total_sellable_units', 'recovery_percent_units'];
        break;

      case 'defects':
        let defectsWhere = 'WHERE 1=1';
        const defectsParams = [];
        if (start_date && end_date) {
          defectsWhere += ' AND DATE(qi.inspection_date) BETWEEN ? AND ?';
          defectsParams.push(start_date, end_date);
        }

        const [defectsRows] = await db.promise().query(`
          SELECT 
            dt.name as defect_name,
            dt.severity,
            COUNT(DISTINCT qi.id) as occurrence_count,
            COUNT(DISTINCT ql.id) as affected_lots
          FROM qc_defect_types dt
          LEFT JOIN qc_inspections qi ON JSON_CONTAINS(qi.defects_json, JSON_OBJECT('defect_type_id', dt.id))
          LEFT JOIN qc_lots ql ON ql.id = qi.qc_lot_id
          ${defectsWhere}
          GROUP BY dt.id, dt.name, dt.severity
          HAVING occurrence_count > 0
          ORDER BY occurrence_count DESC
        `, defectsParams);
        data = defectsRows;
        filename = `qc_defects_${start_date}_to_${end_date}`;
        headers = ['defect_name', 'severity', 'occurrence_count', 'affected_lots'];
        break;

      default:
        return res.status(400).json(errPayload('Invalid report_type', 'VALIDATION_ERROR'));
    }

    // Convert to CSV
    const csvRows = [];
    csvRows.push(headers.join(','));

    data.forEach(row => {
      const values = headers.map(header => {
        const value = row[header] || '';
        return typeof value === 'string' && value.includes(',') ? `"${value}"` : value;
      });
      csvRows.push(values.join(','));
    });

    const csv = csvRows.join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    res.send(csv);
  } catch (e) {
    console.error('Error exporting report:', e);
    res.status(500).json(errPayload('Failed to export report', 'DB_ERROR', e.message));
  }
});

// ============================================================
// ADMIN SETUP API
// ============================================================

// GET /api/quality-check/settings - Get all settings
router.get('/settings', requireAuth, async (req, res) => {
  try {
    // Fetch defect types (handle if table doesn't exist)
    let defectTypes = [];
    try {
      const [result] = await db.promise().query(`
        SELECT * FROM qc_defect_types ORDER BY sort_order, name
      `);
      defectTypes = result;
    } catch (e) {
      console.warn('qc_defect_types table not found or error:', e.message);
      defectTypes = [];
    }

    // Fetch product specs (handle if table doesn't exist)
    let productSpecs = [];
    try {
      const [result] = await db.promise().query(`
        SELECT ps.*, p.product_name as product_name_full
        FROM qc_product_specs ps
        LEFT JOIN products p ON p.id = ps.product_id
        ORDER BY ps.product_name, ps.spec_name
      `);
      productSpecs = result;
    } catch (e) {
      console.warn('qc_product_specs table not found or error:', e.message);
      productSpecs = [];
    }

    // Fetch config rules (handle if table doesn't exist)
    let config = [];
    try {
      const [result] = await db.promise().query(`
        SELECT * FROM qc_config WHERE is_active = 1 ORDER BY config_key
      `);
      config = result;
    } catch (e) {
      console.warn('qc_config table not found or error:', e.message);
      config = [];
    }

    res.json({
      defect_types: defectTypes,
      product_specs: productSpecs,
      config: config
    });
  } catch (e) {
    console.error('Error fetching settings:', e);
    res.status(500).json(errPayload('Failed to fetch settings', 'DB_ERROR', e.message));
  }
});

// Defect Types CRUD
router.post('/defect-types', requireAuth, requirePerm('QualityCheck', 'create'), async (req, res) => {
  try {
    const { code, name, description, severity, sort_order } = req.body;
    const userId = req.session?.user?.id;

    if (!code || !name) {
      return res.status(400).json(errPayload('code and name are required', 'VALIDATION_ERROR'));
    }

    const [result] = await db.promise().query(`
      INSERT INTO qc_defect_types (code, name, description, severity, sort_order, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [code, name, description || null, severity || 'MEDIUM', sort_order || 0, userId, userId]);

    res.json({ id: result.insertId, message: 'Defect type created successfully' });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(400).json(errPayload('Defect type code already exists', 'DUPLICATE_ERROR'));
    }
    console.error('Error creating defect type:', e);
    res.status(500).json(errPayload('Failed to create defect type', 'DB_ERROR', e.message));
  }
});

router.put('/defect-types/:id', requireAuth, requirePerm('QualityCheck', 'update'), async (req, res) => {
  try {
    const { id } = req.params;
    const { code, name, description, severity, sort_order, is_active } = req.body;
    const userId = req.session?.user?.id;

    await db.promise().query(`
      UPDATE qc_defect_types 
      SET code = ?, name = ?, description = ?, severity = ?, sort_order = ?, is_active = ?, updated_by = ?, updated_at = NOW()
      WHERE id = ?
    `, [code, name, description || null, severity, sort_order || 0, is_active !== undefined ? is_active : 1, userId, id]);

    res.json({ message: 'Defect type updated successfully' });
  } catch (e) {
    console.error('Error updating defect type:', e);
    res.status(500).json(errPayload('Failed to update defect type', 'DB_ERROR', e.message));
  }
});

router.delete('/defect-types/:id', requireAuth, requirePerm('QualityCheck', 'delete'), async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.session?.user?.id;

    // Soft delete
    await db.promise().query(`
      UPDATE qc_defect_types 
      SET is_active = 0, updated_by = ?, updated_at = NOW()
      WHERE id = ?
    `, [userId, id]);

    res.json({ message: 'Defect type deleted successfully' });
  } catch (e) {
    console.error('Error deleting defect type:', e);
    res.status(500).json(errPayload('Failed to delete defect type', 'DB_ERROR', e.message));
  }
});

// Product Specs CRUD
router.post('/product-specs', requireAuth, requirePerm('QualityCheck', 'create'), async (req, res) => {
  try {
    const { product_id, product_name, spec_name, spec_value, tolerance_min, tolerance_max, unit, notes } = req.body;
    const userId = req.session?.user?.id;

    if (!spec_name) {
      return res.status(400).json(errPayload('spec_name is required', 'VALIDATION_ERROR'));
    }

    const [result] = await db.promise().query(`
      INSERT INTO qc_product_specs (product_id, product_name, spec_name, spec_value, tolerance_min, tolerance_max, unit, notes, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [product_id || null, product_name || null, spec_name, spec_value || null, tolerance_min || null, tolerance_max || null, unit || null, notes || null, userId, userId]);

    res.json({ id: result.insertId, message: 'Product spec created successfully' });
  } catch (e) {
    console.error('Error creating product spec:', e);
    res.status(500).json(errPayload('Failed to create product spec', 'DB_ERROR', e.message));
  }
});

router.put('/product-specs/:id', requireAuth, requirePerm('QualityCheck', 'update'), async (req, res) => {
  try {
    const { id } = req.params;
    const { product_id, product_name, spec_name, spec_value, tolerance_min, tolerance_max, unit, notes, is_active } = req.body;
    const userId = req.session?.user?.id;

    await db.promise().query(`
      UPDATE qc_product_specs 
      SET product_id = ?, product_name = ?, spec_name = ?, spec_value = ?, tolerance_min = ?, tolerance_max = ?, unit = ?, notes = ?, is_active = ?, updated_by = ?, updated_at = NOW()
      WHERE id = ?
    `, [product_id || null, product_name || null, spec_name, spec_value || null, tolerance_min || null, tolerance_max || null, unit || null, notes || null, is_active !== undefined ? is_active : 1, userId, id]);

    res.json({ message: 'Product spec updated successfully' });
  } catch (e) {
    console.error('Error updating product spec:', e);
    res.status(500).json(errPayload('Failed to update product spec', 'DB_ERROR', e.message));
  }
});

router.delete('/product-specs/:id', requireAuth, requirePerm('QualityCheck', 'delete'), async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.session?.user?.id;

    // Soft delete
    await db.promise().query(`
      UPDATE qc_product_specs 
      SET is_active = 0, updated_by = ?, updated_at = NOW()
      WHERE id = ?
    `, [userId, id]);

    res.json({ message: 'Product spec deleted successfully' });
  } catch (e) {
    console.error('Error deleting product spec:', e);
    res.status(500).json(errPayload('Failed to delete product spec', 'DB_ERROR', e.message));
  }
});

// Config CRUD
router.put('/config/:key', requireAuth, requirePerm('QualityCheck', 'update'), async (req, res) => {
  try {
    const { key } = req.params;
    const { config_value, description } = req.body;
    const userId = req.session?.user?.id;

    await db.promise().query(`
      INSERT INTO qc_config (config_key, config_value, description, updated_by)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE 
        config_value = VALUES(config_value),
        description = COALESCE(VALUES(description), description),
        updated_by = VALUES(updated_by),
        updated_at = NOW()
    `, [key, config_value, description || null, userId]);

    res.json({ message: 'Config updated successfully' });
  } catch (e) {
    console.error('Error updating config:', e);
    res.status(500).json(errPayload('Failed to update config', 'DB_ERROR', e.message));
  }
});

// ============================================================
// INVENTORY POSTING API
// ============================================================

// Helper function to create inventory transaction with QC references
const createQCInventoryTransaction = async (conn, {
  txn_date,
  movement, // 'IN' or 'OUT'
  txn_type, // 'QC_ACCEPT', 'QC_REGRADE_SELLABLE', 'QC_REGRADE_DISCOUNT', 'QC_REGRADE_WASTE', 'QC_REJECT'
  product_id,
  warehouse_id,
  qty,
  unit_cost = 0,
  uom_id,
  qc_lot_id,
  qc_inspection_id = null,
  qc_regrading_job_id = null,
  qc_regrading_daily_log_id = null,
  qc_posting_type,
  currency_id = null,
  exchange_rate = 1
}) => {
  // Check if inventory movement is enabled
  const movementEnabled = await isInventoryMovementEnabled();
  if (!movementEnabled) {
    console.log('[QC Inventory] Inventory movement is disabled. Skipping inventory transaction creation.');
    return null;
  }

  const amount = parseFloat(qty) * parseFloat(unit_cost);
  const foreign_amount = amount;
  const total_amount = exchange_rate && exchange_rate > 0 ? amount * parseFloat(exchange_rate) : amount;

  const [result] = await conn.query(`
    INSERT INTO inventory_transactions 
    (txn_date, movement, txn_type, source_type, source_id, source_line_id,
     product_id, warehouse_id, batch_id, qty, unit_cost, amount,
     currency_id, exchange_rate, foreign_amount, total_amount, uom_id,
     qc_lot_id, qc_inspection_id, qc_regrading_job_id, qc_regrading_daily_log_id, qc_posting_type, is_posted)
    VALUES (?, ?, ?, 'QC_POSTING', ?, ?,
            ?, ?, NULL, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, 1)
  `, [
    txn_date, movement, txn_type, qc_lot_id, qc_inspection_id,
    product_id, warehouse_id, qty, unit_cost, amount,
    currency_id, exchange_rate, foreign_amount, total_amount, uom_id,
    qc_lot_id, qc_inspection_id, qc_regrading_job_id, qc_regrading_daily_log_id, qc_posting_type
  ]);

  return result.insertId;
};

// Helper function to update purchase bill inventory movements based on QC decision
// This function creates lot-based inventory transactions with qc_lot_id
// and keeps remaining PO quantity in IN TRANSIT (without qc_lot_id)
const updatePurchaseBillInventoryFromQCDecision = async (conn, {
  qc_lot_id,
  qc_lot_item_id,
  qc_inspection_id,
  product_id,
  decision, // 'ACCEPT', 'REJECT', 'REGRADE', 'SELL_RECHECK'
  accepted_qty = 0,
  accepted_weight = 0,
  rejected_qty = 0,
  rejected_weight = 0,
  regrade_qty = 0,
  regrade_weight = 0,
  warehouse_id = null
}) => {
  // Check if inventory movement is enabled
  const movementEnabled = await isInventoryMovementEnabled();
  if (!movementEnabled) {
    console.log('[QC Inventory] Inventory movement is disabled. Skipping inventory updates.');
    return;
  }

  // Find purchase bill linked to QC lot through shipment
  const [lotShipment] = await conn.query(`
    SELECT s.purchase_bill_id, s.vendor_id, ql.shipment_id
    FROM qc_lots ql
    LEFT JOIN shipment s ON s.id = ql.shipment_id
    WHERE ql.id = ?
  `, [qc_lot_id]);

  if (!lotShipment.length || !lotShipment[0].purchase_bill_id) {
    // No purchase bill linked, skip
    return;
  }

  // Handle multiple purchase bills (comma-separated IDs)
  const purchaseBillIdsStr = String(lotShipment[0].purchase_bill_id || '').trim();
  if (!purchaseBillIdsStr) {
    return;
  }

  // Parse comma-separated purchase bill IDs
  const purchaseBillIds = purchaseBillIdsStr.split(',').map(id => id.trim()).filter(id => id && /^\d+$/.test(id));

  if (purchaseBillIds.length === 0) {
    return;
  }

  // Get lot item's declared quantity (loaded quantity for this lot)
  const [[lotItem]] = await conn.query(`
    SELECT declared_quantity_units, declared_quantity_net_weight, uom_id
    FROM qc_lot_items
    WHERE id = ? AND qc_lot_id = ?
  `, [qc_lot_item_id, qc_lot_id]);

  if (!lotItem) {
    console.warn(`QC lot item ${qc_lot_item_id} not found for lot ${qc_lot_id}`);
    return;
  }

  // Use declared quantity as the lot's loaded quantity
  // Prefer units if available, otherwise use weight
  const lotLoadedQty = parseFloat(lotItem.declared_quantity_units) || parseFloat(lotItem.declared_quantity_net_weight) || 0;
  const lotUomId = lotItem.uom_id;

  if (lotLoadedQty <= 0) {
    console.warn(`Lot ${qc_lot_id} item ${qc_lot_item_id} has no declared quantity`);
    return;
  }

  // Process each purchase bill - distribute lot quantity across all purchase bills
  // First, collect all IN TRANSIT transactions from all purchase bills
  const placeholders = purchaseBillIds.map(() => '?').join(',');
  const [allPbTransactions] = await conn.query(`
    SELECT it.*, abl.id as bill_line_id, ab.bill_date, ab.currency_id as bill_currency_id, ab.id as purchase_bill_id
    FROM inventory_transactions it
    LEFT JOIN ap_bill_lines abl ON abl.id = it.source_line_id
    LEFT JOIN ap_bills ab ON ab.id = it.source_id
    WHERE it.source_type = 'AP_BILL'
      AND it.source_id IN (${placeholders})
      AND it.product_id = ?
      AND it.movement_type_id = 3
      AND (it.is_deleted = 0 OR it.is_deleted IS NULL)
      AND it.qc_lot_id IS NULL
    ORDER BY it.source_id ASC, it.id ASC
  `, [...purchaseBillIds, product_id]);

  if (allPbTransactions.length === 0) {
    // No IN TRANSIT transactions found - cannot get reference data
    console.warn(`No purchase bill IN TRANSIT transaction found for bills [${purchaseBillIds.join(', ')}], product ${product_id}`);
    return;
  }

  // Calculate total PO quantity in transit across all purchase bills
  const totalPOQty = allPbTransactions.reduce((sum, txn) => sum + parseFloat(txn.qty || 0), 0);

  // Group transactions by purchase bill ID for easier processing
  const transactionsByBill = {};
  for (const txn of allPbTransactions) {
    const billId = String(txn.purchase_bill_id || txn.source_id);
    if (!transactionsByBill[billId]) {
      transactionsByBill[billId] = [];
    }
    transactionsByBill[billId].push(txn);
  }

  // Special handling for REGRADE:
  // Split declared quantity into sellable (IN) and discard (DISCARD) immediately at inspection approval time.
  if (decision === 'REGRADE') {
    const sellableQty = regrade_qty || regrade_weight || 0;
    const discardQty = rejected_qty || rejected_weight || 0;
    const declaredTotal = lotLoadedQty;
    const totalRequested = sellableQty + discardQty;

    if (totalRequested <= 0) {
      console.warn(`REGRADE decision for lot ${qc_lot_id} item ${qc_lot_item_id} has no quantities to process`);
      return;
    }

    // Ensure we don't consume more than available IN TRANSIT quantity
    const totalToProcess = Math.min(totalRequested, totalPOQty);

    // Process sellable and discard quantities across all purchase bills
    let remainingSellableQty = Math.min(sellableQty, totalToProcess);
    let remainingDiscardQty = Math.min(discardQty, totalToProcess);
    let remainingToReduce = totalToProcess;

    // Process transactions sequentially across all purchase bills
    for (const txn of allPbTransactions) {
      if (remainingToReduce <= 0) break;

      const txnQty = parseFloat(txn.qty) || 0;
      const txnUnitCost = parseFloat(txn.unit_cost) || 0;
      const txnExchangeRate = parseFloat(txn.exchange_rate) || 1;
      const txnDate = txn.txn_date || new Date().toISOString().split('T')[0];
      const purchaseBillId = String(txn.purchase_bill_id || txn.source_id);
      const qtyToReduce = Math.min(remainingToReduce, txnQty);

      if (qtyToReduce <= 0) continue;

      // Calculate proportions for sellable and discard
      const sellablePortion = remainingSellableQty > 0 ? Math.min(remainingSellableQty, qtyToReduce) : 0;
      const discardPortion = remainingDiscardQty > 0 ? Math.min(remainingDiscardQty, qtyToReduce - sellablePortion) : 0;

      // --- Sellable portion: IN (Regular Stock), movement_type_id = 1, txn_type = 'QC_REGRADE_SELL'
      if (sellablePortion > 0) {
        const sellAmount = sellablePortion * txnUnitCost;
        const sellForeignAmount = sellAmount;
        const sellTotalAmount = txnExchangeRate > 0 ? sellAmount * txnExchangeRate : sellAmount;

        await conn.query(`
          INSERT INTO inventory_transactions 
          (txn_date, movement, txn_type, source_type, source_id, source_line_id,
           product_id, warehouse_id, batch_id, qty, unit_cost, amount,
           currency_id, exchange_rate, foreign_amount, total_amount, uom_id, movement_type_id,
           qc_lot_id, qc_inspection_id, qc_posting_type, is_posted)
          VALUES (?, 'IN', 'QC_REGRADE_SELL', 'AP_BILL', ?, ?,
                  ?, ?, ?, ?, ?, ?,
                  ?, ?, ?, ?, ?, ?,
                  ?, ?, 'REGRADE_SELL', 1)
        `, [
          txnDate, purchaseBillId, txn.source_line_id || null,
          product_id, warehouse_id || txn.warehouse_id, txn.batch_id, sellablePortion, txnUnitCost, sellAmount,
          txn.currency_id, txnExchangeRate, sellForeignAmount, sellTotalAmount, lotUomId || txn.uom_id, 1, // REGULAR_IN
          qc_lot_id, qc_inspection_id || null
        ]);

        // Update inventory_stock_batches for sellable quantity (stock on hand)
        await inventoryService.updateInventoryStock(
          conn,
          product_id,
          warehouse_id || txn.warehouse_id,
          txn.batch_id,
          sellablePortion,
          txnUnitCost,
          true,
          txn.currency_id,
          lotUomId || txn.uom_id
        );

        remainingSellableQty -= sellablePortion;
      }

      // --- Discard portion: DISCARD, movement_type_id = 5, txn_type = 'QC_REGRADE_DISCARD'
      if (discardPortion > 0) {
        const discAmount = discardPortion * txnUnitCost;
        const discForeignAmount = discAmount;
        const discTotalAmount = txnExchangeRate > 0 ? discAmount * txnExchangeRate : discAmount;

        await conn.query(`
          INSERT INTO inventory_transactions 
          (txn_date, movement, txn_type, source_type, source_id, source_line_id,
           product_id, warehouse_id, batch_id, qty, unit_cost, amount,
           currency_id, exchange_rate, foreign_amount, total_amount, uom_id, movement_type_id,
           qc_lot_id, qc_inspection_id, qc_posting_type, is_posted)
          VALUES (?, 'DISCARD', 'QC_REGRADE_DISCARD', 'AP_BILL', ?, ?,
                  ?, ?, ?, ?, ?, ?,
                  ?, ?, ?, ?, ?, ?,
                  ?, ?, 'REGRADE_DISCARD', 1)
        `, [
          txnDate, purchaseBillId, txn.source_line_id || null,
          product_id, warehouse_id || txn.warehouse_id, txn.batch_id, discardPortion, txnUnitCost, discAmount,
          txn.currency_id, txnExchangeRate, discForeignAmount, discTotalAmount, lotUomId || txn.uom_id, 5, // DISCARD
          qc_lot_id, qc_inspection_id || null
        ]);
        // NOTE: DISCARD does NOT change inventory_stock_batches (waste)

        remainingDiscardQty -= discardPortion;
      }

      // Reduce purchase bill IN TRANSIT quantity
      const newQty = txnQty - qtyToReduce;
      if (newQty > 0) {
        const newAmount = newQty * txnUnitCost;
        const newForeignAmount = newAmount;
        const newTotalAmount = txnExchangeRate > 0 ? newAmount * txnExchangeRate : newAmount;

        await conn.query(`
          UPDATE inventory_transactions
          SET qty = ?, amount = ?, foreign_amount = ?, total_amount = ?
          WHERE id = ?
        `, [newQty, newAmount, newForeignAmount, newTotalAmount, txn.id]);
      } else {
        await conn.query(`
          UPDATE inventory_transactions
          SET qty = 0, amount = 0, foreign_amount = 0, total_amount = 0, is_deleted = 1
          WHERE id = ?
        `, [txn.id]);
      }

      remainingToReduce -= qtyToReduce;
    }

    return; // REGRADE handled completely here
  }

  // Determine lot quantity to process based on decision
  // Use lot's loaded quantity (declared quantity from shipment)
  let lotQtyToProcess = 0;
  let movementTypeId = 3; // Default: IN TRANSIT
  let movement = 'IN TRANSIT';
  let txnType = 'QC_POSTING'; // Default, will be set based on decision

  if (decision === 'ACCEPT') {
    // Lot's loaded quantity → IN (Regular Stock) with qc_lot_id
    lotQtyToProcess = accepted_qty || accepted_weight || lotLoadedQty;
    movementTypeId = 1; // REGULAR_IN
    movement = 'IN';
    txnType = 'QC_ACCEPT';
  } else if (decision === 'REJECT') {
    // Lot's loaded quantity → DISCARD with qc_lot_id
    lotQtyToProcess = rejected_qty || rejected_weight || lotLoadedQty;
    movementTypeId = 5; // DISCARD
    movement = 'DISCARD';
    txnType = 'QC_REJECT';
  } else if (decision === 'SELL_RECHECK') {
    // SELL & RECHECK should behave like ACCEPT for inventory at approval time:
    // Full lot quantity becomes available stock (IN, movement_type_id = 1).
    lotQtyToProcess = accepted_qty || accepted_weight || lotLoadedQty;
    movementTypeId = 1; // REGULAR_IN (same as ACCEPT)
    movement = 'IN';
    txnType = 'QC_SELL_RECHECK';
  }

  if (lotQtyToProcess <= 0) {
    return;
  }

  // Ensure lot quantity doesn't exceed available PO quantity
  lotQtyToProcess = Math.min(lotQtyToProcess, totalPOQty);

  // Process lot quantity across all purchase bills sequentially
  let remainingLotQty = lotQtyToProcess;

  for (const txn of allPbTransactions) {
    if (remainingLotQty <= 0) break;

    const txnQty = parseFloat(txn.qty) || 0;
    const txnUnitCost = parseFloat(txn.unit_cost) || 0;
    const txnExchangeRate = parseFloat(txn.exchange_rate) || 1;
    const txnDate = txn.txn_date || new Date().toISOString().split('T')[0];
    const purchaseBillId = String(txn.purchase_bill_id || txn.source_id);
    const qtyToProcess = Math.min(remainingLotQty, txnQty);

    if (qtyToProcess <= 0) continue;

    // Calculate amounts correctly based on quantity to process
    const amount = qtyToProcess * txnUnitCost; // qty * unit_cost = amount
    const foreignAmount = amount; // Foreign amount is same as amount (in transaction currency)
    const totalAmount = txnExchangeRate > 0 ? amount * txnExchangeRate : amount; // Convert to AED using exchange rate

    const finalWarehouseId = warehouse_id || txn.warehouse_id;

    // Create lot-based inventory transaction (shipment loaded quantity)
    // source_id and source_line_id reference purchase bill (AP_BILL)
    // qc_lot_id is kept separately to track which QC lot this transaction belongs to
    // Ensure txn_type is always set (not NULL)
    await conn.query(`
      INSERT INTO inventory_transactions 
      (txn_date, movement, txn_type, source_type, source_id, source_line_id,
       product_id, warehouse_id, batch_id, qty, unit_cost, amount,
       currency_id, exchange_rate, foreign_amount, total_amount, uom_id, movement_type_id,
       qc_lot_id, qc_inspection_id, qc_posting_type, is_posted)
      VALUES (?, ?, ?, 'AP_BILL', ?, ?,
              ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?,
              ?, ?, ?, 1)
    `, [
      txnDate, movement, txnType, purchaseBillId, txn.source_line_id || null,
      product_id, finalWarehouseId, txn.batch_id, qtyToProcess, txnUnitCost, amount,
      txn.currency_id, txnExchangeRate, foreignAmount, totalAmount, lotUomId || txn.uom_id, movementTypeId,
      qc_lot_id, qc_inspection_id || null, decision
    ]);

    // Update inventory stock only for REGULAR_IN movements (ACCEPT or SELL_RECHECK decisions)
    // DISCARD (REJECT) should NOT add to regular stock on hand - it's waste/discarded stock
    // REGRADE stays in IN TRANSIT, so it doesn't affect stock on hand yet
    if (movementTypeId === 1) {
      // ACCEPT and SELL_RECHECK (REGULAR_IN) add to inventory_stock_batches
      await inventoryService.updateInventoryStock(
        conn,
        product_id,
        finalWarehouseId,
        txn.batch_id,
        qtyToProcess,
        txnUnitCost,
        true, // isIn = true (adds to regular stock)
        txn.currency_id,
        lotUomId || txn.uom_id
      );
    }
    // DISCARD (movementTypeId === 5) creates transaction record but does NOT update inventory_stock_batches
    // The transaction is tracked for reporting but doesn't affect available stock

    // Reduce purchase bill transaction quantity by processed quantity
    // Remaining PO quantity stays in IN TRANSIT (without qc_lot_id)
    // Also recalculate amounts (amount, foreign_amount, total_amount) based on remaining quantity
    const newQty = txnQty - qtyToProcess;

    if (newQty > 0) {
      // Recalculate amounts based on remaining quantity
      const newAmount = newQty * txnUnitCost; // qty * unit_cost = amount
      const newForeignAmount = newAmount; // Foreign amount is same as amount (in transaction currency)
      const newTotalAmount = txnExchangeRate > 0 ? newAmount * txnExchangeRate : newAmount; // Convert to AED

      // Update transaction quantity and amounts (remaining stays IN TRANSIT)
      await conn.query(`
        UPDATE inventory_transactions
        SET qty = ?, amount = ?, foreign_amount = ?, total_amount = ?
        WHERE id = ?
      `, [newQty, newAmount, newForeignAmount, newTotalAmount, txn.id]);
    } else {
      // Mark transaction as deleted (fully consumed by lot)
      await conn.query(`
        UPDATE inventory_transactions
        SET qty = 0, amount = 0, foreign_amount = 0, total_amount = 0, is_deleted = 1
        WHERE id = ?
      `, [txn.id]);
    }

    remainingLotQty -= qtyToProcess;
  }
};

// Helper to check if lot/job has already been posted
const checkAlreadyPosted = async (conn, qc_lot_id, qc_regrading_job_id = null) => {
  let whereClause = 'qc_lot_id = ? AND is_posted = 1';
  let params = [qc_lot_id];

  if (qc_regrading_job_id) {
    whereClause += ' AND qc_regrading_job_id = ?';
    params.push(qc_regrading_job_id);
  }

  const [rows] = await conn.query(`
    SELECT COUNT(*) as count FROM inventory_transactions WHERE ${whereClause}
  `, params);

  return (rows[0]?.count || 0) > 0;
};

// POST /api/quality-check/lots/:id/post-accept - Post accepted quantities to Sellable inventory
router.post('/lots/:id/post-accept', requireAuth, requirePerm('QualityCheck', 'post'), async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();
    const userId = req.session?.user?.id;
    const { id: lotId } = req.params;
    const { warehouse_id, currency_id = null, exchange_rate = 1 } = req.body;

    if (!warehouse_id) {
      return res.status(400).json(errPayload('warehouse_id is required', 'VALIDATION_ERROR'));
    }

    // Get lot details
    const [[lot]] = await conn.query(`
      SELECT id, status, lot_number FROM qc_lots WHERE id = ?
    `, [lotId]);

    if (!lot) {
      return res.status(404).json(errPayload('QC lot not found', 'NOT_FOUND'));
    }

    if (lot.status !== 'QC_COMPLETED') {
      return res.status(400).json(errPayload('Lot must be in QC_COMPLETED status to post', 'VALIDATION_ERROR'));
    }

    // Check if already posted
    if (await checkAlreadyPosted(conn, lotId)) {
      return res.status(400).json(errPayload('This lot has already been posted to inventory', 'DUPLICATE_POSTING'));
    }

    // Get latest ACCEPT inspection
    const [inspections] = await conn.query(`
      SELECT id, accepted_quantity_units, accepted_quantity_net_weight
      FROM qc_inspections
      WHERE qc_lot_id = ? AND decision = 'ACCEPT'
      ORDER BY inspection_date DESC
      LIMIT 1
    `, [lotId]);

    if (inspections.length === 0) {
      return res.status(400).json(errPayload('No ACCEPT inspection found for this lot', 'VALIDATION_ERROR'));
    }

    const inspection = inspections[0];

    // Get lot items
    const [items] = await conn.query(`
      SELECT id, product_id, product_name, uom_id, declared_quantity_units, declared_quantity_net_weight
      FROM qc_lot_items
      WHERE qc_lot_id = ?
    `, [lotId]);

    if (items.length === 0) {
      return res.status(400).json(errPayload('No items found for this lot', 'VALIDATION_ERROR'));
    }

    const txn_date = new Date().toISOString().split('T')[0];
    const transactionIds = [];

    // Validate that we have accepted quantities
    if (!inspection.accepted_quantity_units && !inspection.accepted_quantity_net_weight) {
      return res.status(400).json(errPayload('No accepted quantities found in the inspection. Please ensure the inspection has accepted quantities set.', 'VALIDATION_ERROR'));
    }

    // Post each item proportionally
    const totalDeclaredUnits = items.reduce((sum, item) => sum + (parseFloat(item.declared_quantity_units) || 0), 0);
    const totalDeclaredWeight = items.reduce((sum, item) => sum + (parseFloat(item.declared_quantity_net_weight) || 0), 0);

    if (totalDeclaredUnits === 0 && totalDeclaredWeight === 0) {
      return res.status(400).json(errPayload('No declared quantities found for lot items', 'VALIDATION_ERROR'));
    }

    let hasValidItems = false;
    for (const item of items) {
      if (!item.product_id) {
        continue; // Skip items without product_id
      }

      let qty = 0;
      if (inspection.accepted_quantity_units && totalDeclaredUnits > 0) {
        const proportion = (parseFloat(item.declared_quantity_units) || 0) / totalDeclaredUnits;
        qty = parseFloat(inspection.accepted_quantity_units) * proportion;
      } else if (inspection.accepted_quantity_net_weight && totalDeclaredWeight > 0) {
        const proportion = (parseFloat(item.declared_quantity_net_weight) || 0) / totalDeclaredWeight;
        qty = parseFloat(inspection.accepted_quantity_net_weight) * proportion;
      }

      if (qty > 0) {
        hasValidItems = true;
        const txnId = await createQCInventoryTransaction(conn, {
          txn_date,
          movement: 'IN',
          txn_type: 'QC_ACCEPT',
          product_id: item.product_id,
          warehouse_id,
          qty,
          unit_cost: 0, // Can be updated later from PO cost
          uom_id: item.uom_id,
          qc_lot_id: lotId,
          qc_inspection_id: inspection.id,
          qc_posting_type: 'ACCEPT',
          currency_id,
          exchange_rate
        });
        transactionIds.push(txnId);
      }
    }

    if (!hasValidItems) {
      return res.status(400).json(errPayload('No valid items with product_id found to post. Please ensure lot items have products assigned.', 'VALIDATION_ERROR'));
    }

    if (transactionIds.length === 0) {
      return res.status(400).json(errPayload('No transactions were created. Please check that accepted quantities are greater than 0.', 'VALIDATION_ERROR'));
    }

    // Update lot to mark as posted (optional: add a posted flag)
    await conn.query(`
      UPDATE qc_lots SET updated_by = ?, updated_at = NOW() WHERE id = ?
    `, [userId, lotId]);

    await conn.commit();
    res.json({
      message: 'Accepted quantities posted to inventory successfully',
      transaction_ids: transactionIds,
      lot_id: lotId
    });
  } catch (e) {
    await conn.rollback();
    console.error('Error posting accept to inventory:', e);
    res.status(500).json(errPayload('Failed to post to inventory', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// POST /api/quality-check/regrading/:id/post - Post regrading outputs to inventory
router.post('/regrading/:id/post', requireAuth, requirePerm('QualityCheck', 'post'), async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();
    const userId = req.session?.user?.id;
    const { id: jobId } = req.params;
    const {
      sellable_quantity_units = 0,
      sellable_quantity_net_weight = 0,
      discarded_quantity_units = 0,
      discarded_quantity_net_weight = 0,
      warehouse_id,
      currency_id = null,
      exchange_rate = 1
    } = req.body;

    if (!warehouse_id) {
      return res.status(400).json(errPayload('warehouse_id is required', 'VALIDATION_ERROR'));
    }

    // Check if inventory movement is enabled
    const movementEnabled = await isInventoryMovementEnabled();
    if (!movementEnabled) {
      await conn.rollback();
      return res.status(400).json(errPayload('Inventory movement is disabled. Cannot post regrading job to inventory.', 'INVENTORY_DISABLED'));
    }

    // Validate that quantities are provided
    const sellableQty = parseFloat(sellable_quantity_units) || parseFloat(sellable_quantity_net_weight) || 0;
    const discardedQty = parseFloat(discarded_quantity_units) || parseFloat(discarded_quantity_net_weight) || 0;

    if (sellableQty <= 0 && discardedQty <= 0) {
      return res.status(400).json(errPayload('At least one quantity (sellable or discarded) must be provided', 'VALIDATION_ERROR'));
    }

    // Get job details
    const [[job]] = await conn.query(`
      SELECT rj.*, ql.id as lot_id, ql.lot_number
      FROM qc_regrading_jobs rj
      LEFT JOIN qc_lots ql ON ql.id = rj.qc_lot_id
      WHERE rj.id = ?
    `, [jobId]);

    if (!job) {
      return res.status(404).json(errPayload('Regrading job not found', 'NOT_FOUND'));
    }

    if (job.status !== 'COMPLETED') {
      return res.status(400).json(errPayload('Job must be COMPLETED to post', 'VALIDATION_ERROR'));
    }

    // Check if already posted
    if (await checkAlreadyPosted(conn, job.lot_id, jobId)) {
      return res.status(400).json(errPayload('This regrading job has already been posted to inventory', 'DUPLICATE_POSTING'));
    }

    // Get lot item details (product_id, uom_id, and purchase bill reference for cost)
    const [[lotItem]] = await conn.query(`
      SELECT qli.product_id, qli.uom_id, qli.declared_quantity_units, qli.declared_quantity_net_weight
      FROM qc_lot_items qli
      WHERE qli.qc_lot_id = ? AND qli.product_id IS NOT NULL
      LIMIT 1
    `, [job.lot_id]);

    if (!lotItem || !lotItem.product_id) {
      return res.status(400).json(errPayload('No product found for this regrading job lot', 'VALIDATION_ERROR'));
    }

    // Find purchase bill linked to QC lot through shipment to get cost reference
    const [lotShipment] = await conn.query(`
      SELECT s.purchase_bill_id
      FROM qc_lots ql
      LEFT JOIN shipment s ON s.id = ql.shipment_id
      WHERE ql.id = ?
    `, [job.lot_id]);

    if (!lotShipment.length || !lotShipment[0].purchase_bill_id) {
      return res.status(400).json(errPayload('No purchase bill linked to this QC lot', 'VALIDATION_ERROR'));
    }

    const purchaseBillId = lotShipment[0].purchase_bill_id;

    // Get purchase bill transaction for cost reference
    const [[pbTxn]] = await conn.query(`
      SELECT it.*
      FROM inventory_transactions it
      WHERE it.source_type = 'AP_BILL'
        AND it.source_id = ?
        AND it.product_id = ?
        AND it.movement_type_id = 3
        AND (it.is_deleted = 0 OR it.is_deleted IS NULL)
      ORDER BY it.id ASC
      LIMIT 1
    `, [purchaseBillId, lotItem.product_id]);

    if (!pbTxn) {
      return res.status(400).json(errPayload('No purchase bill transaction found for cost reference', 'VALIDATION_ERROR'));
    }

    const unitCost = parseFloat(pbTxn.unit_cost) || 0;
    const txnExchangeRate = parseFloat(pbTxn.exchange_rate) || 1;
    const txnDate = new Date().toISOString().split('T')[0];
    const transactionIds = [];

    // Post sellable quantity - IN (Regular Stock) with txn_type = 'QC_REGRADE_SELL'
    if (sellableQty > 0) {
      const sellableAmount = sellableQty * unitCost;
      const sellableForeignAmount = sellableAmount;
      const sellableTotalAmount = txnExchangeRate > 0 ? sellableAmount * txnExchangeRate : sellableAmount;

      const [sellableTxn] = await conn.query(`
        INSERT INTO inventory_transactions 
        (txn_date, movement, txn_type, source_type, source_id, source_line_id,
         product_id, warehouse_id, batch_id, qty, unit_cost, amount,
         currency_id, exchange_rate, foreign_amount, total_amount, uom_id, movement_type_id,
         qc_lot_id, qc_inspection_id, qc_regrading_job_id, qc_posting_type, is_posted)
        VALUES (?, 'IN', 'QC_REGRADE_SELL', 'AP_BILL', ?, ?,
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?, 'REGRADE_SELL', 1)
      `, [
        txnDate, purchaseBillId, pbTxn.source_line_id || null,
        lotItem.product_id, warehouse_id, pbTxn.batch_id, sellableQty, unitCost, sellableAmount,
        pbTxn.currency_id, txnExchangeRate, sellableForeignAmount, sellableTotalAmount, lotItem.uom_id, 1, // movement_type_id = 1 (REGULAR_IN)
        job.lot_id, job.qc_inspection_id || null, jobId
      ]);

      transactionIds.push(sellableTxn.insertId);

      // Update inventory stock (add to regular stock)
      await inventoryService.updateInventoryStock(
        conn,
        lotItem.product_id,
        warehouse_id,
        pbTxn.batch_id,
        sellableQty,
        unitCost,
        true, // isIn = true
        pbTxn.currency_id,
        lotItem.uom_id
      );
    }

    // Post discarded quantity - DISCARD with txn_type = 'QC_REGRADE_DISCARD'
    if (discardedQty > 0) {
      const discardedAmount = discardedQty * unitCost;
      const discardedForeignAmount = discardedAmount;
      const discardedTotalAmount = txnExchangeRate > 0 ? discardedAmount * txnExchangeRate : discardedAmount;

      const [discardedTxn] = await conn.query(`
        INSERT INTO inventory_transactions 
        (txn_date, movement, txn_type, source_type, source_id, source_line_id,
         product_id, warehouse_id, batch_id, qty, unit_cost, amount,
         currency_id, exchange_rate, foreign_amount, total_amount, uom_id, movement_type_id,
         qc_lot_id, qc_inspection_id, qc_regrading_job_id, qc_posting_type, is_posted)
        VALUES (?, 'DISCARD', 'QC_REGRADE_DISCARD', 'AP_BILL', ?, ?,
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?, 'REGRADE_DISCARD', 1)
      `, [
        txnDate, purchaseBillId, pbTxn.source_line_id || null,
        lotItem.product_id, warehouse_id, pbTxn.batch_id, discardedQty, unitCost, discardedAmount,
        pbTxn.currency_id, txnExchangeRate, discardedForeignAmount, discardedTotalAmount, lotItem.uom_id, 5, // movement_type_id = 5 (DISCARD)
        job.lot_id, job.qc_inspection_id || null, jobId
      ]);

      transactionIds.push(discardedTxn.insertId);
      // Note: DISCARD does NOT update inventory_stock_batches (waste/discarded stock)
    }

    if (transactionIds.length === 0) {
      return res.status(400).json(errPayload('No transactions were created. Please ensure there are valid quantities to post and items have products assigned.', 'VALIDATION_ERROR'));
    }

    // Update job status to CLOSED after posting (job is completed and posted)
    await conn.query(`
      UPDATE qc_regrading_jobs 
      SET status = 'CLOSED', updated_by = ?, updated_at = NOW()
      WHERE id = ?
    `, [userId, jobId]);

    await conn.commit();
    res.json({
      message: 'Regrading outputs posted to inventory successfully',
      transaction_ids: transactionIds,
      job_id: jobId
    });
  } catch (e) {
    await conn.rollback();
    console.error('Error posting regrading to inventory:', e);
    res.status(500).json(errPayload('Failed to post to inventory', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// POST /api/quality-check/lots/:id/post-reject - Post rejected quantities to Rejected location
router.post('/lots/:id/post-reject', requireAuth, requirePerm('QualityCheck', 'post'), async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();
    const userId = req.session?.user?.id;
    const { id: lotId } = req.params;
    const { warehouse_rejected_id, currency_id = null, exchange_rate = 1 } = req.body;

    if (!warehouse_rejected_id) {
      return res.status(400).json(errPayload('warehouse_rejected_id is required', 'VALIDATION_ERROR'));
    }

    // Get lot details
    const [[lot]] = await conn.query(`
      SELECT id, status, lot_number FROM qc_lots WHERE id = ?
    `, [lotId]);

    if (!lot) {
      return res.status(404).json(errPayload('QC lot not found', 'NOT_FOUND'));
    }

    if (lot.status !== 'REJECTED') {
      return res.status(400).json(errPayload('Lot must be in REJECTED status to post', 'VALIDATION_ERROR'));
    }

    // Check if already posted
    if (await checkAlreadyPosted(conn, lotId)) {
      return res.status(400).json(errPayload('This lot has already been posted to inventory', 'DUPLICATE_POSTING'));
    }

    // Get latest REJECT inspection
    const [inspections] = await conn.query(`
      SELECT id, rejected_quantity_units, rejected_quantity_net_weight
      FROM qc_inspections
      WHERE qc_lot_id = ? AND decision = 'REJECT'
      ORDER BY inspection_date DESC
      LIMIT 1
    `, [lotId]);

    if (inspections.length === 0) {
      return res.status(400).json(errPayload('No REJECT inspection found for this lot', 'VALIDATION_ERROR'));
    }

    const inspection = inspections[0];

    // Get lot items
    const [items] = await conn.query(`
      SELECT id, product_id, product_name, uom_id, declared_quantity_units, declared_quantity_net_weight
      FROM qc_lot_items
      WHERE qc_lot_id = ?
    `, [lotId]);

    if (items.length === 0) {
      return res.status(400).json(errPayload('No items found for this lot', 'VALIDATION_ERROR'));
    }

    const txn_date = new Date().toISOString().split('T')[0];
    const transactionIds = [];

    // Post each item proportionally to rejected location
    const totalDeclaredUnits = items.reduce((sum, item) => sum + (parseFloat(item.declared_quantity_units) || 0), 0);
    const totalDeclaredWeight = items.reduce((sum, item) => sum + (parseFloat(item.declared_quantity_net_weight) || 0), 0);

    for (const item of items) {
      let qty = 0;
      if (inspection.rejected_quantity_units && totalDeclaredUnits > 0) {
        const proportion = (parseFloat(item.declared_quantity_units) || 0) / totalDeclaredUnits;
        qty = parseFloat(inspection.rejected_quantity_units) * proportion;
      } else if (inspection.rejected_quantity_net_weight && totalDeclaredWeight > 0) {
        const proportion = (parseFloat(item.declared_quantity_net_weight) || 0) / totalDeclaredWeight;
        qty = parseFloat(inspection.rejected_quantity_net_weight) * proportion;
      }

      if (qty > 0 && item.product_id) {
        const txnId = await createQCInventoryTransaction(conn, {
          txn_date,
          movement: 'IN',
          txn_type: 'QC_REJECT',
          product_id: item.product_id,
          warehouse_id: warehouse_rejected_id,
          qty,
          unit_cost: 0,
          uom_id: item.uom_id,
          qc_lot_id: lotId,
          qc_inspection_id: inspection.id,
          qc_posting_type: 'REJECT',
          currency_id,
          exchange_rate
        });
        transactionIds.push(txnId);
      }
    }

    await conn.commit();
    res.json({
      message: 'Rejected quantities posted to inventory successfully',
      transaction_ids: transactionIds,
      lot_id: lotId
    });
  } catch (e) {
    await conn.rollback();
    console.error('Error posting reject to inventory:', e);
    res.status(500).json(errPayload('Failed to post to inventory', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// GET /api/quality-check/lots/:id/history - Get history for a QC lot
router.get('/lots/:id/history', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Get all history entries related to this lot (lot, inspections, regrading jobs, etc.)
    const [history] = await db.promise().query(`
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
    `, [id, id, id, id]);

    res.json(history || []);
  } catch (e) {
    console.error('Error fetching lot history:', e);
    res.status(500).json(errPayload('Failed to fetch lot history', 'DB_ERROR', e.message));
  }
});

// GET /api/quality-check/lots/:id/posting-status - Check if lot has been posted
router.get('/lots/:id/posting-status', requireAuth, async (req, res) => {
  try {
    const { id: lotId } = req.params;

    const [rows] = await db.promise().query(`
      SELECT 
        COUNT(*) as posted_count,
        GROUP_CONCAT(DISTINCT qc_posting_type) as posting_types
      FROM inventory_transactions
      WHERE qc_lot_id = ? AND is_posted = 1
    `, [lotId]);

    res.json({
      is_posted: (rows[0]?.posted_count || 0) > 0,
      posted_count: rows[0]?.posted_count || 0,
      posting_types: rows[0]?.posting_types ? rows[0].posting_types.split(',') : []
    });
  } catch (e) {
    console.error('Error checking posting status:', e);
    res.status(500).json(errPayload('Failed to check posting status', 'DB_ERROR', e.message));
  }
});

// GET /api/quality-check/sell-recheck - List Sell & Recheck entries
router.get('/sell-recheck', requireAuth, async (req, res) => {
  try {
    const { qc_lot_id, qc_lot_item_id, search, status } = req.query;

    const whereClauses = ['1=1'];
    const params = [];

    if (qc_lot_id) {
      whereClauses.push('sr.qc_lot_id = ?');
      params.push(qc_lot_id);
    }
    if (qc_lot_item_id) {
      whereClauses.push('sr.qc_lot_item_id = ?');
      params.push(qc_lot_item_id);
    }
    if (search && search.trim()) {
      const like = `%${search.trim()}%`;
      whereClauses.push(`
        (
          ql.lot_number LIKE ? OR
          qli.product_name LIKE ? OR
          qi.id LIKE ?
        )
      `);
      params.push(like, like, like);
    }
    if (status === 'PENDING') {
      whereClauses.push('sr.is_completed = 0');
    } else if (status === 'COMPLETED') {
      whereClauses.push('sr.is_completed = 1');
    }

    const [rows] = await db.promise().query(
      `
      SELECT 
        sr.*,
        ql.lot_number,
        COALESCE(qli.product_id, qi_lot_item.product_id) as product_id,
        COALESCE(
          NULLIF(qli.product_name, ''),
          NULLIF(qi_lot_item.product_name, ''),
          (SELECT product_name FROM qc_lot_items WHERE qc_lot_id = sr.qc_lot_id AND product_name IS NOT NULL AND product_name != '' LIMIT 1)
        ) as product_name,
        COALESCE(qli.variety, qi_lot_item.variety) as variety,
        COALESCE(qli.packaging_type, qi_lot_item.packaging_type) as packaging_type,
        ql.origin_farm_market,
        ql.origin_country,
        qi.inspection_date,
        u.name as inspected_by_name,
        u2.name as created_by_name
      FROM qc_sell_recheck_entries sr
      LEFT JOIN qc_lots ql ON ql.id = sr.qc_lot_id
      LEFT JOIN qc_lot_items qli ON qli.id = sr.qc_lot_item_id
      LEFT JOIN qc_inspections qi ON qi.id = sr.qc_inspection_id
      LEFT JOIN qc_lot_items qi_lot_item ON qi_lot_item.id = qi.qc_lot_item_id
      LEFT JOIN user u ON u.id = qi.inspected_by
      LEFT JOIN user u2 ON u2.id = sr.created_by
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY sr.created_at DESC, sr.id DESC
      `,
      params
    );

    res.json(rows || []);
  } catch (e) {
    console.error('Error fetching Sell & Recheck entries:', e);
    res.status(500).json(errPayload('Failed to fetch Sell & Recheck entries', 'DB_ERROR', e.message));
  }
});

// GET /api/quality-check/sell-recheck/:id - Get single Sell & Recheck entry detail
router.get('/sell-recheck/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const [[entry]] = await db.promise().query(
      `
      SELECT 
        sr.*,
        ql.lot_number,
        ql.shipment_id,
        qli.product_id,
        qli.product_name,
        qli.variety,
        qli.declared_quantity_units,
        qli.declared_quantity_net_weight,
        qli.uom_id,
        um.name as uom_name,
        ql.origin_farm_market,
        ql.origin_country,
        qi.inspection_date,
        qi.decision,
        u.name as inspected_by_name,
        u2.name as created_by_name
      FROM qc_sell_recheck_entries sr
      LEFT JOIN qc_lots ql ON ql.id = sr.qc_lot_id
      LEFT JOIN qc_lot_items qli ON qli.id = sr.qc_lot_item_id
      LEFT JOIN qc_inspections qi ON qi.id = sr.qc_inspection_id
      LEFT JOIN user u ON u.id = qi.inspected_by
      LEFT JOIN user u2 ON u2.id = sr.created_by
      LEFT JOIN uom_master um ON um.id = qli.uom_id
      WHERE sr.id = ?
      `,
      [id]
    );

    if (!entry) {
      return res.status(404).json(errPayload('Sell & Recheck entry not found', 'NOT_FOUND'));
    }

    res.json(entry);
  } catch (e) {
    console.error('Error fetching Sell & Recheck entry:', e);
    res.status(500).json(errPayload('Failed to fetch Sell & Recheck entry', 'DB_ERROR', e.message));
  }
});

// PUT /api/quality-check/sell-recheck/:id/status - Change Sell & Recheck entry status
router.put('/sell-recheck/:id/status', requireAuth, requirePerm('QualityCheck', 'edit'), async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();
    const userId = req.session?.user?.id;
    const { id } = req.params;
    const { status, reason } = req.body;

    if (!status) {
      await conn.rollback();
      return res.status(400).json(errPayload('Status is required', 'VALIDATION_ERROR'));
    }

    // Valid sell & recheck statuses: 'PENDING' (is_completed=0) or 'COMPLETED' (is_completed=1)
    const validStatuses = ['PENDING', 'COMPLETED'];
    if (!validStatuses.includes(status)) {
      await conn.rollback();
      return res.status(400).json(errPayload(`Invalid status. Must be one of: ${validStatuses.join(', ')}`, 'VALIDATION_ERROR'));
    }

    // Get current entry status
    const [[entry]] = await conn.query('SELECT id, is_completed FROM qc_sell_recheck_entries WHERE id = ?', [id]);
    if (!entry) {
      await conn.rollback();
      return res.status(404).json(errPayload('Sell & Recheck entry not found', 'NOT_FOUND'));
    }

    const oldStatus = entry.is_completed ? 'COMPLETED' : 'PENDING';
    const isCompleted = status === 'COMPLETED' ? 1 : 0;

    // Update status
    // Note: qc_sell_recheck_entries table may not have updated_by and updated_at columns
    await conn.query(`
      UPDATE qc_sell_recheck_entries SET
        is_completed = ?
      WHERE id = ?
    `, [isCompleted, id]);

    // Log history for status change
    await addHistory(conn, {
      module: 'qc_sell_recheck_entry',
      moduleId: id,
      userId,
      action: 'STATUS_CHANGED',
      details: {
        from: oldStatus,
        to: status,
        reason: reason || 'Manual status change'
      }
    });

    await conn.commit();
    res.json({
      message: 'Status changed successfully',
      status,
      oldStatus
    });
  } catch (e) {
    await conn.rollback();
    console.error('Error changing Sell & Recheck entry status:', e);
    res.status(500).json(errPayload('Failed to change status', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// PUT /api/quality-check/sell-recheck/:id/status - Change Sell & Recheck entry status
router.put('/sell-recheck/:id/status', requireAuth, requirePerm('QualityCheck', 'edit'), async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();
    const userId = req.session?.user?.id;
    const { id } = req.params;
    const { status, reason } = req.body;

    if (!status) {
      await conn.rollback();
      return res.status(400).json(errPayload('Status is required', 'VALIDATION_ERROR'));
    }

    // Valid sell & recheck statuses: 'PENDING' (is_completed=0) or 'COMPLETED' (is_completed=1)
    const validStatuses = ['PENDING', 'COMPLETED'];
    if (!validStatuses.includes(status)) {
      await conn.rollback();
      return res.status(400).json(errPayload(`Invalid status. Must be one of: ${validStatuses.join(', ')}`, 'VALIDATION_ERROR'));
    }

    // Get current entry status
    const [[entry]] = await conn.query('SELECT id, is_completed FROM qc_sell_recheck_entries WHERE id = ?', [id]);
    if (!entry) {
      await conn.rollback();
      return res.status(404).json(errPayload('Sell & Recheck entry not found', 'NOT_FOUND'));
    }

    const oldStatus = entry.is_completed ? 'COMPLETED' : 'PENDING';
    const isCompleted = status === 'COMPLETED' ? 1 : 0;

    // Update status
    // Note: qc_sell_recheck_entries table may not have updated_by and updated_at columns
    await conn.query(`
      UPDATE qc_sell_recheck_entries SET
        is_completed = ?
      WHERE id = ?
    `, [isCompleted, id]);

    // Log history for status change
    await addHistory(conn, {
      module: 'qc_sell_recheck_entry',
      moduleId: id,
      userId,
      action: 'STATUS_CHANGED',
      details: {
        from: oldStatus,
        to: status,
        reason: reason || 'Manual status change'
      }
    });

    await conn.commit();
    res.json({
      message: 'Status changed successfully',
      status,
      oldStatus
    });
  } catch (e) {
    await conn.rollback();
    console.error('Error changing Sell & Recheck entry status:', e);
    res.status(500).json(errPayload('Failed to change status', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// PUT /api/quality-check/sell-recheck/:id - Update Sell & Recheck entry
router.put('/sell-recheck/:id', requireAuth, requirePerm('QualityCheck', 'edit'), async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();
    const userId = req.session?.user?.id;
    const { id } = req.params;
    const { quantity_units, quantity_net_weight, notes, is_completed, status_id } = req.body;

    // Check if entry exists
    const [[entry]] = await conn.query(`
      SELECT sr.*, qli.product_id, qli.declared_quantity_units, qli.declared_quantity_net_weight
      FROM qc_sell_recheck_entries sr
      LEFT JOIN qc_lot_items qli ON qli.id = sr.qc_lot_item_id
      WHERE sr.id = ?
    `, [id]);

    if (!entry) {
      await conn.rollback();
      return res.status(404).json(errPayload('Sell & Recheck entry not found', 'NOT_FOUND'));
    }

    // Update entry
    const updateFields = [];
    const updateParams = [];

    if (quantity_units !== undefined) {
      updateFields.push('quantity_units = ?');
      updateParams.push(quantity_units || null);
    }
    if (quantity_net_weight !== undefined) {
      updateFields.push('quantity_net_weight = ?');
      updateParams.push(quantity_net_weight || null);
    }
    if (notes !== undefined) {
      updateFields.push('notes = ?');
      updateParams.push(notes || null);
    }
    if (status_id !== undefined) {
      updateFields.push('status_id = ?');
      updateParams.push(status_id || null);
    }
    if (is_completed !== undefined) {
      updateFields.push('is_completed = ?');
      updateFields.push('completed_at = ?');
      updateParams.push(is_completed ? 1 : 0);
      updateParams.push(is_completed ? new Date() : null);
    }

    if (updateFields.length > 0) {
      updateFields.push('updated_by = ?');
      updateFields.push('updated_at = NOW()');
      updateParams.push(userId);
      updateParams.push(id);

      await conn.query(`
        UPDATE qc_sell_recheck_entries
        SET ${updateFields.join(', ')}
        WHERE id = ?
      `, updateParams);

      const isCompletedBool =
        is_completed === true ||
        is_completed === 1 ||
        is_completed === '1';

      const isRequestOnly =
        is_completed === false ||
        is_completed === 0 ||
        is_completed === '0' ||
        is_completed === undefined;

      // If this is just a discard request (not completed yet), mark inspection as Submitted for Approval (status_id = 8)
      if (isRequestOnly && entry.qc_inspection_id) {
        await conn.query(`
          UPDATE qc_inspections
          SET status_id = 8, updated_at = NOW()
          WHERE id = ?
        `, [entry.qc_inspection_id]);
      }

      // If marked as completed, treat quantity_units as DISCARD quantity to move from IN to DISCARD
      if (isCompletedBool && entry.product_id) {
        // Check if inventory movement is enabled
        const movementEnabled = await isInventoryMovementEnabled();
        if (!movementEnabled) {
          console.log('[Sell & Recheck] Inventory movement is disabled. Skipping inventory updates.');
        } else {
          const discardQty =
            (quantity_units !== undefined && quantity_units !== null
              ? parseFloat(quantity_units) || 0
              : parseFloat(entry.quantity_units || 0) || 0);

          if (discardQty > 0) {
            // Find regular IN transaction(s) created for SELL_RECHECK for this lot & product
            const [inTransactions] = await conn.query(`
            SELECT *
            FROM inventory_transactions
            WHERE qc_lot_id = ?
              AND product_id = ?
              AND movement = 'IN'
              AND movement_type_id = 1
              AND qc_posting_type = 'SELL_RECHECK'
              AND (is_deleted = 0 OR is_deleted IS NULL)
            ORDER BY id ASC
          `, [entry.qc_lot_id, entry.product_id]);

            if (!inTransactions.length) {
              console.warn(
                `No regular IN transaction found for SELL_RECHECK discard (qc_lot_id=${entry.qc_lot_id}, product_id=${entry.product_id})`
              );
            } else {
              let remainingToDiscard = discardQty;

              for (const txn of inTransactions) {
                if (remainingToDiscard <= 0) break;

                const txnQty = parseFloat(txn.qty) || 0;
                if (txnQty <= 0) continue;

                const qtyFromThisTxn = Math.min(remainingToDiscard, txnQty);
                if (qtyFromThisTxn <= 0) continue;

                const unitCost = parseFloat(txn.unit_cost) || 0;
                const baseAmount = qtyFromThisTxn * unitCost;
                const exchangeRate = parseFloat(txn.exchange_rate) || 1;
                const foreignAmount = baseAmount;
                const totalAmount = exchangeRate > 0 ? baseAmount * exchangeRate : baseAmount;

                // Insert DISCARD transaction for discarded quantity
                await conn.query(`
                INSERT INTO inventory_transactions
                  (txn_date, movement, txn_type, source_type, source_id, source_line_id,
                   product_id, warehouse_id, batch_id, qty, unit_cost, amount,
                   currency_id, exchange_rate, foreign_amount, total_amount, uom_id, movement_type_id,
                   qc_lot_id, qc_inspection_id, qc_posting_type, is_posted)
                VALUES
                  (?, 'DISCARD', 'QC_SELL_RECHECK_DISCARD', ?, ?, ?,
                   ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, ?, ?, 5,
                   ?, ?, 'SELL_RECHECK_DISCARD', 1)
              `, [
                  txn.txn_date || new Date().toISOString().split('T')[0],
                  txn.source_type,
                  txn.source_id,
                  txn.source_line_id || null,
                  txn.product_id,
                  txn.warehouse_id,
                  txn.batch_id,
                  qtyFromThisTxn,
                  unitCost,
                  baseAmount,
                  txn.currency_id,
                  exchangeRate,
                  foreignAmount,
                  totalAmount,
                  txn.uom_id,
                  entry.qc_lot_id,
                  entry.qc_inspection_id || null
                ]);

                // Reduce qty and amounts on original IN transaction
                const remainingQty = txnQty - qtyFromThisTxn;
                if (remainingQty > 0) {
                  const newAmount = remainingQty * unitCost;
                  const newForeignAmount = newAmount;
                  const newTotalAmount = exchangeRate > 0 ? newAmount * exchangeRate : newAmount;

                  await conn.query(`
                  UPDATE inventory_transactions
                  SET qty = ?, amount = ?, foreign_amount = ?, total_amount = ?
                  WHERE id = ?
                `, [remainingQty, newAmount, newForeignAmount, newTotalAmount, txn.id]);
                } else {
                  await conn.query(`
                  UPDATE inventory_transactions
                  SET qty = 0, amount = 0, foreign_amount = 0, total_amount = 0, is_deleted = 1
                  WHERE id = ?
                `, [txn.id]);
                }

                // Update inventory stock: reduce on-hand by discarded quantity
                await inventoryService.updateInventoryStock(
                  conn,
                  txn.product_id,
                  txn.warehouse_id,
                  txn.batch_id,
                  qtyFromThisTxn,
                  unitCost,
                  false, // isIn = false (reduces stock)
                  txn.currency_id,
                  txn.uom_id
                );

                remainingToDiscard -= qtyFromThisTxn;
              }
            }
          }
        }
      }
    }

    await conn.commit();
    res.json({ id, message: 'Sell & Recheck entry updated successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error updating Sell & Recheck entry:', e);
    res.status(500).json(errPayload('Failed to update Sell & Recheck entry', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// ============================================================
// QC DISCARD REQUESTS ENDPOINTS
// ============================================================

// POST /api/quality-check/discard-requests - Create a new discard request
router.post('/discard-requests', requireAuth, requirePerm('QualityCheck', 'edit'), async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();
    const userId = req.session?.user?.id;
    const { sell_recheck_id, discard_quantity, discard_quantity_weight, remark, status_id } = req.body;

    if (!sell_recheck_id || !discard_quantity) {
      await conn.rollback();
      return res.status(400).json(errPayload('sell_recheck_id and discard_quantity are required', 'VALIDATION_ERROR'));
    }

    // Get sell recheck entry details including shipment_id
    const [[sellRecheckEntry]] = await conn.query(`
      SELECT sr.*, ql.shipment_id
      FROM qc_sell_recheck_entries sr
      LEFT JOIN qc_lots ql ON ql.id = sr.qc_lot_id
      WHERE sr.id = ?
    `, [sell_recheck_id]);

    if (!sellRecheckEntry) {
      await conn.rollback();
      return res.status(404).json(errPayload('Sell & Recheck entry not found', 'NOT_FOUND'));
    }

    // Insert discard request
    const [result] = await conn.query(`
      INSERT INTO qc_discard_requests (
        shipment_id, sell_recheck_id, discard_quantity, discard_quantity_weight,
        remark, applied_by, status_id, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      sellRecheckEntry.shipment_id || null,
      sell_recheck_id,
      parseFloat(discard_quantity) || 0,
      discard_quantity_weight ? parseFloat(discard_quantity_weight) : null,
      remark || null,
      userId,
      status_id || 8, // Default to 8 (Submitted for Approval)
      userId
    ]);

    await conn.commit();
    res.json({ id: result.insertId, message: 'Discard request created successfully' });
  } catch (e) {
    await conn.rollback();
    console.error('Error creating discard request:', e);
    res.status(500).json(errPayload('Failed to create discard request', 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

// GET /api/quality-check/discard-requests - List all discard requests
router.get('/discard-requests', requireAuth, async (req, res) => {
  try {
    const { search, status_id, is_approved, sell_recheck_id, status, page = '1', pageSize = '25' } = req.query;

    const whereClauses = ['1=1'];
    const params = [];

    if (search && search.trim()) {
      const like = `%${search.trim()}%`;
      whereClauses.push(`
        (
          ql.lot_number LIKE ? OR
          qli.product_name LIKE ? OR
          s.ship_uniqid LIKE ? OR
          dr.remark LIKE ?
        )
      `);
      params.push(like, like, like, like);
    }

    // Handle status filter (pending, approved, rejected)
    if (status === 'pending') {
      whereClauses.push('dr.is_approved = 0 AND (dr.status_id = 8 OR dr.status_id IS NULL)');
    } else if (status === 'approved') {
      whereClauses.push('dr.is_approved = 1');
    } else if (status === 'rejected') {
      whereClauses.push('dr.status_id = 10');
    }

    if (status_id) {
      whereClauses.push('dr.status_id = ?');
      params.push(status_id);
    }

    if (is_approved !== undefined) {
      whereClauses.push('dr.is_approved = ?');
      params.push(is_approved === '1' || is_approved === 1 ? 1 : 0);
    }

    if (sell_recheck_id) {
      whereClauses.push('dr.sell_recheck_id = ?');
      params.push(sell_recheck_id);
    }

    // Parse pagination parameters
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const pageSizeNum = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 200);
    const offset = (pageNum - 1) * pageSizeNum;

    // Get total count
    const [countRows] = await db.promise().query(`
      SELECT COUNT(*) as total
      FROM qc_discard_requests dr
      LEFT JOIN qc_sell_recheck_entries sr ON sr.id = dr.sell_recheck_id
      LEFT JOIN qc_lots ql ON ql.id = sr.qc_lot_id
      LEFT JOIN qc_lot_items qli ON qli.id = sr.qc_lot_item_id
      LEFT JOIN shipment s ON s.id = dr.shipment_id
      WHERE ${whereClauses.join(' AND ')}
    `, params);

    const total = countRows[0]?.total || 0;

    // Get paginated rows
    const [rows] = await db.promise().query(`
      SELECT 
        dr.*,
        sr.check_no,
        sr.quantity_units as sell_recheck_quantity_units,
        sr.quantity_net_weight as sell_recheck_quantity_net_weight,
        ql.lot_number,
        ql.shipment_id,
        qli.product_name,
        qli.variety,
        qli.product_id,
        s.ship_uniqid,
        u1.name as applied_by_name,
        u2.name as created_by_name,
        u3.name as approved_by_name
      FROM qc_discard_requests dr
      LEFT JOIN qc_sell_recheck_entries sr ON sr.id = dr.sell_recheck_id
      LEFT JOIN qc_lots ql ON ql.id = sr.qc_lot_id
      LEFT JOIN qc_lot_items qli ON qli.id = sr.qc_lot_item_id
      LEFT JOIN shipment s ON s.id = dr.shipment_id
      LEFT JOIN user u1 ON u1.id = dr.applied_by
      LEFT JOIN user u2 ON u2.id = dr.created_by
      LEFT JOIN user u3 ON u3.id = dr.approved_by
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY dr.created_at DESC, dr.id DESC
      LIMIT ? OFFSET ?
    `, [...params, pageSizeNum, offset]);

    // If no pagination params, return array for backward compatibility
    if (!page && !pageSize) {
      res.json(rows || []);
    } else {
      res.json({
        rows: rows || [],
        total: total,
        page: pageNum,
        pageSize: pageSizeNum
      });
    }
  } catch (e) {
    console.error('Error fetching discard requests:', e);
    res.status(500).json(errPayload('Failed to fetch discard requests', 'DB_ERROR', e.message));
  }
});

// GET /api/quality-check/discard-requests/:id - Get single discard request detail
router.get('/discard-requests/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const [[row]] = await db.promise().query(`
      SELECT 
        dr.*,
        sr.check_no,
        sr.quantity_units as sell_recheck_quantity_units,
        sr.quantity_net_weight as sell_recheck_quantity_net_weight,
        sr.notes as sell_recheck_notes,
        ql.lot_number,
        ql.shipment_id,
        qli.product_name,
        qli.variety,
        qli.product_id,
        qli.declared_quantity_units,
        qli.declared_quantity_net_weight,
        s.ship_uniqid,
        u1.name as applied_by_name,
        u2.name as created_by_name,
        u3.name as approved_by_name
      FROM qc_discard_requests dr
      LEFT JOIN qc_sell_recheck_entries sr ON sr.id = dr.sell_recheck_id
      LEFT JOIN qc_lots ql ON ql.id = sr.qc_lot_id
      LEFT JOIN qc_lot_items qli ON qli.id = sr.qc_lot_item_id
      LEFT JOIN shipment s ON s.id = dr.shipment_id
      LEFT JOIN user u1 ON u1.id = dr.applied_by
      LEFT JOIN user u2 ON u2.id = dr.created_by
      LEFT JOIN user u3 ON u3.id = dr.approved_by
      WHERE dr.id = ?
    `, [id]);

    if (!row) {
      return res.status(404).json(errPayload('Discard request not found', 'NOT_FOUND'));
    }

    res.json(row);
  } catch (e) {
    console.error('Error fetching discard request:', e);
    res.status(500).json(errPayload('Failed to fetch discard request', 'DB_ERROR', e.message));
  }
});

// PUT /api/quality-check/discard-requests/:id/approve - Approve or reject discard request
router.put('/discard-requests/:id/approve', requireAuth, requirePerm('QualityCheck', 'approve'), async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();
    const userId = req.session?.user?.id;
    const { id } = req.params;
    const { action, comment } = req.body; // 'approve' or 'reject', and optional comment

    if (!action || !['approve', 'reject'].includes(action)) {
      await conn.rollback();
      return res.status(400).json(errPayload('action must be "approve" or "reject"', 'VALIDATION_ERROR'));
    }

    // Get discard request with related data
    const [[discardRequest]] = await conn.query(`
      SELECT 
        dr.*,
        sr.qc_lot_id,
        sr.qc_lot_item_id,
        sr.qc_inspection_id,
        qli.product_id,
        qli.uom_id
      FROM qc_discard_requests dr
      LEFT JOIN qc_sell_recheck_entries sr ON sr.id = dr.sell_recheck_id
      LEFT JOIN qc_lot_items qli ON qli.id = sr.qc_lot_item_id
      WHERE dr.id = ?
    `, [id]);

    if (!discardRequest) {
      await conn.rollback();
      return res.status(404).json(errPayload('Discard request not found', 'NOT_FOUND'));
    }

    if (discardRequest.is_approved === 1) {
      await conn.rollback();
      return res.status(400).json(errPayload('Discard request is already approved', 'VALIDATION_ERROR'));
    }

    if (action === 'approve') {
      // Check if inventory movement is enabled
      const movementEnabled = await isInventoryMovementEnabled();
      if (!movementEnabled) {
        await conn.rollback();
        return res.status(400).json(errPayload('Inventory movement is disabled. Cannot approve discard request.', 'INVENTORY_DISABLED'));
      }

      const discardQty = parseFloat(discardRequest.discard_quantity) || 0;

      if (discardQty <= 0) {
        await conn.rollback();
        return res.status(400).json(errPayload('Invalid discard quantity', 'VALIDATION_ERROR'));
      }

      if (!discardRequest.product_id) {
        await conn.rollback();
        return res.status(400).json(errPayload('Product ID not found for this discard request', 'VALIDATION_ERROR'));
      }

      // Find regular IN transaction(s) created for SELL_RECHECK for this lot & product
      // First try to find SELL_RECHECK specific transactions by qc_posting_type
      let [inTransactions] = await conn.query(`
        SELECT *
        FROM inventory_transactions
        WHERE qc_lot_id = ?
          AND product_id = ?
          AND movement = 'IN'
          AND movement_type_id = 1
          AND qc_posting_type = 'SELL_RECHECK'
          AND (is_deleted = 0 OR is_deleted IS NULL)
        ORDER BY id ASC
      `, [discardRequest.qc_lot_id, discardRequest.product_id]);

      // If no SELL_RECHECK transactions found, try to find by txn_type
      if (!inTransactions.length) {
        [inTransactions] = await conn.query(`
          SELECT *
          FROM inventory_transactions
          WHERE qc_lot_id = ?
            AND product_id = ?
            AND movement = 'IN'
            AND movement_type_id = 1
            AND txn_type = 'QC_SELL_RECHECK'
            AND (is_deleted = 0 OR is_deleted IS NULL)
          ORDER BY id ASC
        `, [discardRequest.qc_lot_id, discardRequest.product_id]);
      }

      // If still no SELL_RECHECK transactions found, try to find any IN transactions for this lot/product
      if (!inTransactions.length) {
        [inTransactions] = await conn.query(`
          SELECT *
          FROM inventory_transactions
          WHERE qc_lot_id = ?
            AND product_id = ?
            AND movement = 'IN'
            AND movement_type_id = 1
            AND (is_deleted = 0 OR is_deleted IS NULL)
          ORDER BY id ASC
        `, [discardRequest.qc_lot_id, discardRequest.product_id]);
      }

      // If still no transactions, try to find from purchase bill transactions related to this lot
      if (!inTransactions.length && discardRequest.qc_lot_id) {
        // Get lot info to find purchase bill
        const [[lotInfo]] = await conn.query(`
          SELECT shipment_id FROM qc_lots WHERE id = ?
        `, [discardRequest.qc_lot_id]);

        if (lotInfo && lotInfo.shipment_id) {
          // Get purchase bill from shipment
          const [[shipmentInfo]] = await conn.query(`
            SELECT po_id FROM shipment WHERE id = ?
          `, [lotInfo.shipment_id]);

          if (shipmentInfo && shipmentInfo.po_id) {
            // Get purchase bill ID
            const [[poInfo]] = await conn.query(`
              SELECT id FROM ap_bills WHERE po_id = ? LIMIT 1
            `, [shipmentInfo.po_id]);

            if (poInfo && poInfo.id) {
              // Find IN TRANSIT transactions from purchase bill that can be converted
              [inTransactions] = await conn.query(`
                SELECT *
                FROM inventory_transactions
                WHERE source_type = 'AP_BILL'
                  AND source_id = ?
                  AND product_id = ?
                  AND movement_type_id = 3
                  AND (is_deleted = 0 OR is_deleted IS NULL)
                ORDER BY id ASC
              `, [poInfo.id, discardRequest.product_id]);
            }
          }
        }
      }

      // If still no transactions, try to find any IN transactions for this product from stock
      // This handles cases where transactions might not exist but stock does
      if (!inTransactions.length) {
        // Get stock batches for this product to create discard transaction
        const [stockBatches] = await conn.query(`
          SELECT 
            isb.*,
            ib.batch_no
          FROM inventory_stock_batches isb
          JOIN inventory_batches ib ON ib.id = isb.batch_id
          WHERE isb.product_id = ?
            AND isb.qty_on_hand > 0
          ORDER BY ib.exp_date ASC, ib.mfg_date ASC, isb.id ASC
        `, [discardRequest.product_id]);

        if (stockBatches.length > 0) {
          // Create virtual transactions from stock batches
          // Use the first batch as reference
          const refBatch = stockBatches[0];
          inTransactions = [{
            id: null, // Virtual transaction
            txn_date: new Date().toISOString().split('T')[0],
            product_id: discardRequest.product_id,
            warehouse_id: refBatch.warehouse_id,
            batch_id: refBatch.batch_id,
            qty: refBatch.qty_on_hand,
            unit_cost: refBatch.unit_cost || 0,
            currency_id: refBatch.currency_id,
            exchange_rate: 1,
            uom_id: refBatch.uom_id,
            source_type: 'QC_DISCARD_REQUEST',
            source_id: id,
            source_line_id: null
          }];
        }
      }

      if (!inTransactions.length) {
        await conn.rollback();
        return res.status(400).json(
          errPayload(
            `No inventory transactions or stock found for this discard request. Please ensure the sell recheck entry has been posted to inventory first. (qc_lot_id=${discardRequest.qc_lot_id}, product_id=${discardRequest.product_id})`,
            'VALIDATION_ERROR'
          )
        );
      }

      let remainingToDiscard = discardQty;

      for (const txn of inTransactions) {
        if (remainingToDiscard <= 0) break;

        const txnQty = parseFloat(txn.qty) || 0;
        if (txnQty <= 0) continue;

        const qtyFromThisTxn = Math.min(remainingToDiscard, txnQty);
        if (qtyFromThisTxn <= 0) continue;

        const unitCost = parseFloat(txn.unit_cost) || 0;
        const baseAmount = qtyFromThisTxn * unitCost;
        const exchangeRate = parseFloat(txn.exchange_rate) || 1;
        const foreignAmount = baseAmount;
        const totalAmount = exchangeRate > 0 ? baseAmount * exchangeRate : baseAmount;

        // Insert DISCARD transaction for discarded quantity
        await conn.query(`
          INSERT INTO inventory_transactions
            (txn_date, movement, txn_type, source_type, source_id, source_line_id,
             product_id, warehouse_id, batch_id, qty, unit_cost, amount,
             currency_id, exchange_rate, foreign_amount, total_amount, uom_id, movement_type_id,
             qc_lot_id, qc_inspection_id, qc_posting_type, is_posted)
          VALUES
            (?, 'DISCARD', 'QC_DISCARD_REQUEST', 'QC_DISCARD_REQUEST', ?, ?,
             ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, 5,
             ?, ?, 'DISCARD_REQUEST', 1)
        `, [
          txn.txn_date || new Date().toISOString().split('T')[0],
          id, // source_id = discard_request_id
          null, // source_line_id
          txn.product_id,
          txn.warehouse_id,
          txn.batch_id,
          qtyFromThisTxn,
          unitCost,
          baseAmount,
          txn.currency_id,
          exchangeRate,
          foreignAmount,
          totalAmount,
          txn.uom_id || discardRequest.uom_id,
          discardRequest.qc_lot_id,
          discardRequest.qc_inspection_id || null
        ]);

        // Reduce qty and amounts on original IN transaction (only if it's a real transaction, not virtual)
        if (txn.id !== null && txn.id !== undefined) {
          const remainingQty = txnQty - qtyFromThisTxn;
          if (remainingQty > 0) {
            const newAmount = remainingQty * unitCost;
            const newForeignAmount = newAmount;
            const newTotalAmount = exchangeRate > 0 ? newAmount * exchangeRate : newAmount;

            await conn.query(`
              UPDATE inventory_transactions
              SET qty = ?, amount = ?, foreign_amount = ?, total_amount = ?
              WHERE id = ?
            `, [remainingQty, newAmount, newForeignAmount, newTotalAmount, txn.id]);
          } else {
            await conn.query(`
              UPDATE inventory_transactions
              SET qty = 0, amount = 0, foreign_amount = 0, total_amount = 0, is_deleted = 1
              WHERE id = ?
            `, [txn.id]);
          }
        }
        // For virtual transactions (from stock batches), we only update stock, not transactions

        // Update inventory stock: reduce on-hand by discarded quantity
        await inventoryService.updateInventoryStock(
          conn,
          txn.product_id,
          txn.warehouse_id,
          txn.batch_id,
          qtyFromThisTxn,
          unitCost,
          false, // isIn = false (reduces stock)
          txn.currency_id,
          txn.uom_id
        );

        remainingToDiscard -= qtyFromThisTxn;
      }

      if (remainingToDiscard > 0) {
        await conn.rollback();
        return res.status(400).json(
          errPayload(
            `Insufficient stock to discard. Requested: ${discardQty}, Available: ${discardQty - remainingToDiscard}`,
            'VALIDATION_ERROR'
          )
        );
      }

      // Update discard request as approved
      await conn.query(`
        UPDATE qc_discard_requests
        SET is_approved = 1,
            approved_by = ?,
            approved_at = NOW(),
            status_id = 9,
            remark = CONCAT(COALESCE(remark, ''), CASE WHEN remark IS NOT NULL AND remark != '' THEN '\n\n' ELSE '' END, 'Approval Comment: ', ?),
            updated_by = ?,
            updated_at = NOW()
        WHERE id = ?
      `, [userId, comment || 'No comment provided', userId, id]);
    } else {
      // Reject action
      await conn.query(`
        UPDATE qc_discard_requests
        SET is_approved = 0,
            status_id = 10,
            remark = CONCAT(COALESCE(remark, ''), CASE WHEN remark IS NOT NULL AND remark != '' THEN '\n\n' ELSE '' END, 'Rejection Comment: ', ?),
            updated_by = ?,
            updated_at = NOW()
        WHERE id = ?
      `, [comment || 'No comment provided', userId, id]);

      // Also update the related sell recheck entry status back to original (remove status_id = 8)
      if (discardRequest.qc_inspection_id) {
        await conn.query(`
          UPDATE qc_inspections
          SET status_id = NULL, updated_at = NOW()
          WHERE id = ?
        `, [discardRequest.qc_inspection_id]);
      }
    }

    await conn.commit();
    res.json({ id, message: `Discard request ${action === 'approve' ? 'approved' : 'rejected'} successfully` });
  } catch (e) {
    await conn.rollback();
    console.error(`Error ${req.body.action}ing discard request:`, e);
    res.status(500).json(errPayload(`Failed to ${req.body.action} discard request`, 'DB_ERROR', e.message));
  } finally {
    conn.release();
  }
});

export default router;

