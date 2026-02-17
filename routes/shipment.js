import express from "express";
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import mysql from 'mysql2/promise';
import sharp from 'sharp';
import crypto from 'crypto';
import db from "../db.js";
import dayjs from "dayjs";
import axios from 'axios';
import utc from 'dayjs/plugin/utc.js'; // Import UTC plugin
import timezone from 'dayjs/plugin/timezone.js'; // Import timezone plugin
dayjs.extend(utc);
dayjs.extend(timezone);
import { fetchContainerDataFromDubaiTrade, saveOrUpdateContainerData } from '../jobs/container-tracking.js';

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

// Helper function to generate QC lot number
const generateQCLotNumber = async (conn) => {
    const year = new Date().getFullYear().toString().slice(-2);
    const month = String(new Date().getMonth() + 1).padStart(2, '0');
    const prefix = `QC${year}${month}`;

    const [rows] = await conn.query(
        `SELECT lot_number FROM qc_lots WHERE lot_number LIKE ? ORDER BY lot_number DESC LIMIT 1`,
        [`${prefix}%`]
    );

    let seq = 1;
    if (rows.length > 0) {
        const lastNumber = rows[0].lot_number;
        const match = lastNumber.match(new RegExp(`^${prefix}(\\d{3})$`));
        if (match) {
            seq = parseInt(match[1], 10) + 1;
        }
    }

    return `${prefix}${String(seq).padStart(3, '0')}`;
};

// Auto-create QC lot when shipment transitions from Sailed to Cleared
const autoCreateQCLot = async (conn, shipmentId, poId, userId) => {
    try {
        // Check if QC lot already exists for this shipment
        const [existing] = await conn.query(
            'SELECT id FROM qc_lots WHERE shipment_id = ? LIMIT 1',
            [shipmentId]
        );

        if (existing.length > 0) {
            // QC lot already exists, skip creation
            return;
        }

        // Fetch shipment details
        const [shipments] = await conn.query(`
            SELECT 
                s.id, s.ship_uniqid, s.arrival_date, s.arrival_time,
                po.po_number, po.id as po_id,
                v.display_name as vendor_name
            FROM shipment s
            LEFT JOIN purchase_orders po ON po.id = s.po_id
            LEFT JOIN vendor v ON v.id = s.vendor_id
            WHERE s.id = ?
        `, [shipmentId]);

        if (shipments.length === 0) return;
        const shipment = shipments[0];

        // Fetch containers
        const [containers] = await conn.query(`
            SELECT container_no, id
            FROM shipment_container
            WHERE shipment_id = ?
        `, [shipmentId]);

        // Fetch container items grouped by container + product
        // This will create multiple qc_lot_items - one for each container+product combination
        const containerIds = containers.map(c => c.id);
        let containerProductGroups = [];
        if (containerIds.length > 0) {
            // Group by container_id AND product_id to create separate items for each combination
            const [containerItems] = await conn.query(`
                SELECT 
                    sci.container_id,
                    sc.container_no,
                    sci.product_id,
                    sci.product_name,
                    pd.variety,
                    sci.package_type,
                    SUM(sci.package_count) as total_package_count,
                    SUM(sci.net_weight) as total_net_weight,
                    SUM(sci.gross_weight) as total_gross_weight,
                    i.uom_id
                FROM shipment_container_item sci
                LEFT JOIN shipment_container sc ON sc.id = sci.container_id
                LEFT JOIN product_details pd ON pd.product_id = sci.product_id
                LEFT JOIN purchase_order_items i ON i.item_id = sci.product_id AND i.purchase_order_id = ?
                WHERE sci.container_id IN (?)
                GROUP BY sci.container_id, sc.container_no, sci.product_id, sci.product_name, pd.variety, sci.package_type, i.uom_id
                ORDER BY sci.container_id, sci.product_id
            `, [poId, containerIds]);
            containerProductGroups = containerItems;
        }

        // If no container items, try to get from PO items (fallback - create one lot per product)
        if (containerProductGroups.length === 0 && poId) {
            const [poItems] = await conn.query(`
                SELECT 
                    NULL as container_id,
                    NULL as container_no,
                    i.item_id as product_id,
                    i.item_name as product_name,
                    pd.variety,
                    NULL as package_type,
                    i.quantity as total_package_count,
                    NULL as total_net_weight,
                    NULL as total_gross_weight,
                    i.uom_id
                FROM purchase_order_items i
                LEFT JOIN product_details pd ON pd.product_id = i.item_id
                WHERE i.purchase_order_id = ?
            `, [poId]);
            containerProductGroups = poItems;
        }

        const arrivalDateTime = shipment.arrival_date && shipment.arrival_time
            ? `${shipment.arrival_date} ${shipment.arrival_time}`
            : shipment.arrival_date || null;

        // Generate single lot number for this shipment
        const lotNumber = await generateQCLotNumber(conn);

        // Get container numbers (comma-separated for the lot)
        const containerNumber = containers.length > 0
            ? containers.map(c => c.container_no).filter(Boolean).join(', ')
            : null;

        // Insert single QC lot for this shipment
        const [lotResult] = await conn.query(`
            INSERT INTO qc_lots (
                lot_number, shipment_id, container_number,
                po_id, po_number, arrival_date_time,
                status, created_by
            ) VALUES (?, ?, ?, ?, ?, ?, 'AWAITING_QC', ?)
        `, [
            lotNumber,
            shipmentId,
            containerNumber,
            poId || null,
            shipment.po_number || null,
            arrivalDateTime,
            userId
        ]);

        const qcLotId = lotResult.insertId;

        // Insert multiple lot items - one for each container + product combination
        if (containerProductGroups.length > 0) {
            const itemValues = containerProductGroups.map(group => [
                qcLotId,
                group.container_id || null,
                group.container_no || null,
                group.product_id || null,
                group.product_name || 'Unknown Product',
                group.variety || null,
                group.package_type || null,
                group.total_package_count || null,
                group.total_net_weight || null,
                group.uom_id || null
            ]);

            await conn.query(`
                INSERT INTO qc_lot_items (
                    qc_lot_id, container_id, container_no, product_id, product_name, variety, packaging_type,
                    declared_quantity_units, declared_quantity_net_weight, uom_id
                ) VALUES ?
            `, [itemValues]);
        }

        // Log history
        await addHistory(conn, {
            module: 'shipment',
            moduleId: shipmentId,
            userId,
            action: 'QC_LOT_AUTO_CREATED',
            details: { qc_lot_id: qcLotId, lot_number: lotNumber, items_count: containerProductGroups.length }
        });

    } catch (error) {
        // Log error but don't fail the shipment transition
        console.error('Error auto-creating QC lot:', error);
        // Optionally log to a separate error table or history
    }
};

const recordStageHistory = async (connLike, {
    poId = null,
    shipmentId,
    fromStageId = null,
    toStageId,
    payload = null
} = {}) => {
    const normalizedShipmentId = Number(shipmentId);
    const normalizedToStageId = Number(toStageId);
    const normalizedFromStageId = Number(fromStageId);
    if (!Number.isFinite(normalizedShipmentId) || !Number.isFinite(normalizedToStageId)) {
        return;
    }

    const shouldTrackHistory =
        (Number.isFinite(normalizedFromStageId) && normalizedFromStageId >= 2) ||
        normalizedToStageId >= 2;

    if (!shouldTrackHistory) {
        return;
    }

    const runner = connLike?.query ? connLike : db.promise();
    const payloadJson = payload ? JSON.stringify(payload) : null;

    await runner.query(
        `INSERT INTO shipment_stage_history
            (po_id, shipment_id, from_stage_id, to_stage_id, changed_at, payload_json)
         VALUES (?, ?, ?, ?, NOW(), ?)`,
        [
            poId ?? null,
            normalizedShipmentId,
            Number.isFinite(normalizedFromStageId) ? normalizedFromStageId : null,
            normalizedToStageId,
            payloadJson
        ]
    );
};

const ensureAllocationTable = async (conn) => {

    // Ensure legacy tables have new columns / indexes

    await conn.query(`
        UPDATE shipment_po_item_allocation spia
        JOIN shipment s ON spia.shipment_id = s.id
        SET spia.po_id = s.po_id
        WHERE (spia.po_id IS NULL OR spia.po_id = 0) AND s.po_id IS NOT NULL
    `);
};

const toFiniteNumber = (value, fallback = 0) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
};

const upsertShipmentPoAllocations = async (conn, {
    shipmentId,
    poId,
    allocations,
    allocationMode = 'partial',
    userId,
    skipAvailabilityCheck = false,
    updatePlannedQuantity = false,
    updateAllocatedQuantity = true,
    updateLoadedQuantity = false
}) => {
    if (!allocations || allocations.length === 0) return;

    await ensureAllocationTable(conn);

    const poItemIds = [...new Set(allocations.map(a => Number(a.po_item_id)).filter(Boolean))];
    if (poItemIds.length === 0) return;

    const [poItems] = await conn.query(
        `SELECT id, item_id AS product_id, quantity FROM purchase_order_items WHERE purchase_order_id = ? AND id IN (?)`,
        [poId, poItemIds]
    );
    const itemMap = new Map(poItems.map(item => [Number(item.id), item]));

    const missing = poItemIds.filter(id => !itemMap.has(id));
    if (missing.length > 0) {
        throw new Error(`PO item(s) not found: ${missing.join(', ')}`);
    }

    const [existingRows] = await conn.query(
        `SELECT po_item_id, planned_quantity, allocated_quantity, loaded_quantity, remaining_quantity FROM shipment_po_item_allocation WHERE shipment_id = ? AND po_item_id IN (?)`,
        [shipmentId, poItemIds]
    );
    const existingAllocatedMap = new Map(existingRows.map(row => [Number(row.po_item_id), toFiniteNumber(row.allocated_quantity)]));
    const existingPlannedMap = new Map(existingRows.map(row => [Number(row.po_item_id), toFiniteNumber(row.planned_quantity)]));
    const existingLoadedMap = new Map(existingRows.map(row => [Number(row.po_item_id), toFiniteNumber(row.loaded_quantity)]));
    const existingRemainingMap = new Map(existingRows.map(row => [Number(row.po_item_id), toFiniteNumber(row.remaining_quantity)]));

    const [totalRows] = await conn.query(
        `SELECT po_item_id,
                SUM(allocated_quantity) AS allocated,
                SUM(loaded_quantity) AS loaded
         FROM shipment_po_item_allocation
         WHERE po_item_id IN (?)
         GROUP BY po_item_id`,
        [poItemIds]
    );
    const totalsAllocatedMap = new Map(totalRows.map(row => [Number(row.po_item_id), toFiniteNumber(row.allocated)]));
    const totalsLoadedMap = new Map(totalRows.map(row => [Number(row.po_item_id), toFiniteNumber(row.loaded)]));

    for (const allocation of allocations) {
        const poItemId = Number(allocation.po_item_id);
        if (!poItemId) continue;
        const poItem = itemMap.get(poItemId);
        if (!poItem) {
            throw new Error(`PO item ${poItemId} not found.`);
        }

        const requestedQtyRaw = toFiniteNumber(allocation.quantity);
        const requestedQty = Math.max(requestedQtyRaw, 0);

        const totalAllocated = totalsAllocatedMap.get(poItemId) || 0;
        const totalLoaded = totalsLoadedMap.get(poItemId) || 0;
        const existingAllocated = existingAllocatedMap.get(poItemId) || 0;
        const existingPlanned = existingPlannedMap.get(poItemId) || 0;
        const existingLoaded = existingLoadedMap.get(poItemId) || 0;
        const allocatedByOthers = totalAllocated - existingAllocated;
        const orderedQty = toFiniteNumber(poItem.quantity);
        const availableQty = Math.max(orderedQty - allocatedByOthers, 0);

        const nextPlanned = updatePlannedQuantity ? requestedQty : existingPlanned;
        const nextAllocated = updateAllocatedQuantity ? requestedQty : existingAllocated;
        const nextLoaded = updateLoadedQuantity ? requestedQty : existingLoaded;

        if (!skipAvailabilityCheck && nextAllocated > availableQty + 1e-6) {
            throw new Error(`Allocation for PO item ${poItemId} exceeds the available quantity.`);
        }

        const remainingCalcBase = orderedQty - (allocatedByOthers + nextAllocated);
        const remainingGlobal = updateAllocatedQuantity
            ? Math.max(Number(remainingCalcBase.toFixed(4)), 0)
            : (existingRemainingMap.get(poItemId) ?? Math.max(Number(remainingCalcBase.toFixed(4)), 0));
        const productId = allocation.product_id ? Number(allocation.product_id) : (poItem.product_id ? Number(poItem.product_id) : null);

        const insertValues = [
            shipmentId,
            poId,
            poItemId,
            productId,
            nextPlanned,
            nextAllocated,
            nextLoaded,
            remainingGlobal,
            allocationMode === 'full' ? 'full' : 'partial',
            userId || null,
            userId || null
        ];

        const updateClauses = [];
        if (updatePlannedQuantity) {
            updateClauses.push('planned_quantity = VALUES(planned_quantity)');
        }
        updateClauses.push('po_id = VALUES(po_id)');
        if (updateAllocatedQuantity) {
            updateClauses.push('allocated_quantity = VALUES(allocated_quantity)');
            updateClauses.push('remaining_quantity = GREATEST(VALUES(remaining_quantity), 0)');
        }
        if (updateLoadedQuantity) {
            updateClauses.push('loaded_quantity = VALUES(loaded_quantity)');
        }
        updateClauses.push('allocation_mode = VALUES(allocation_mode)');
        updateClauses.push('updated_by = VALUES(updated_by)');
        updateClauses.push('updated_at = NOW()');

        await conn.query(
            `INSERT INTO shipment_po_item_allocation
                (shipment_id, po_id, po_item_id, product_id, planned_quantity, allocated_quantity, loaded_quantity, remaining_quantity, allocation_mode, created_by, updated_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
             ON DUPLICATE KEY UPDATE ${updateClauses.join(', ')}`,
            insertValues
        );

        if (updateAllocatedQuantity) {
            totalsAllocatedMap.set(poItemId, allocatedByOthers + nextAllocated);
            existingAllocatedMap.set(poItemId, nextAllocated);
            existingRemainingMap.set(poItemId, remainingGlobal);
        }
        if (updatePlannedQuantity) {
            existingPlannedMap.set(poItemId, nextPlanned);
        }
        if (updateLoadedQuantity) {
            totalsLoadedMap.set(poItemId, (totalLoaded - existingLoaded) + nextLoaded);
            existingLoadedMap.set(poItemId, nextLoaded);
        }
    }
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

router.get("/:shipUniqid/stage-history", async (req, res) => {
    try {
        const shipUniqid = req.params.shipUniqid;
        const [[shipment]] = await db.promise().query(
            `SELECT id, po_id FROM shipment WHERE ship_uniqid = ? LIMIT 1`,
            [shipUniqid]
        );
        if (!shipment) {
            return res.status(404).json(errPayload("Shipment not found"));
        }

        const [rows] = await db.promise().query(
            `
            SELECT ssh.id,
                   ssh.po_id,
                   ssh.shipment_id,
                   ssh.from_stage_id,
                   ssh.to_stage_id,
                   ssh.changed_at,
                   fs.name AS from_stage_name,
                   ts.name AS to_stage_name
            FROM shipment_stage_history ssh
            LEFT JOIN shipment_stage fs ON fs.id = ssh.from_stage_id
            LEFT JOIN shipment_stage ts ON ts.id = ssh.to_stage_id
            WHERE ssh.po_id = ?
            ORDER BY ssh.changed_at ASC
            `,
            [shipment.po_id]
        );

        res.json({ ok: true, stageHistory: rows });
    } catch (e) {
        res.status(500).json(errPayload("Failed to fetch stage history", "DB_ERROR", e.message));
    }
});

// --- list stages (from your shipment_stage table)
router.get("/stages", async (req, res) => {
    try {
        const { is_import } = req.query;
        const params = [];
        let where = 'WHERE is_inactive = 0';
        if (is_import === '0' || is_import === '1') {
            where += ' AND (is_import = ? OR id = 1)';
            params.push(parseInt(is_import, 10));
        }

        const [rows] = await db.promise().query(
            `SELECT id, name, sort_order, is_import, chip_bg_color, chip_text_color FROM shipment_stage ${where} ORDER BY sort_order, id`,
            params
        );
        res.json(rows || []);
    } catch (e) {
        res.status(500).json({ error: { message: "Failed to load stages", type: "DB_ERROR", hint: e.message } });
    }
});

// --- lot options for bills (exclude archive stage)
router.get("/lot-options", async (req, res) => {
    try {
        const poId = req.query.po_id ? Number(req.query.po_id) : null;
        const vendorId = req.query.vendor_id ? Number(req.query.vendor_id) : null;

        if (!poId && !vendorId) {
            return res.json([]);
        }

        const where = ['s.is_inactive = 0', 's.shipment_stage_id <> 7', 's.lot_number IS NOT NULL'];
        const params = [];

        if (poId) {
            where.push('s.po_id = ?');
            params.push(poId);
        } else if (vendorId) {
            where.push('s.vendor_id = ?');
            params.push(vendorId);
        }

        const [rows] = await db.promise().query(
            `
            SELECT
                s.id AS shipment_id,
                s.ship_uniqid,
                s.po_id,
                s.vendor_id,
                s.lot_number,
                s.total_lots,
                s.shipment_stage_id,
                po.po_number,
                v.display_name as vendor_name
            FROM shipment s
            LEFT JOIN purchase_orders po ON po.id = s.po_id
            LEFT JOIN vendor v ON v.id = s.vendor_id
            WHERE ${where.join(' AND ')}
            ORDER BY s.lot_number DESC, s.id DESC
            `,
            params
        );

        const data = (rows || []).map((row) => {
            const lotLabel = row.total_lots > 1
                ? `Lot ${row.lot_number}/${row.total_lots}`
                : `Lot ${row.lot_number}`;
            const poPart = row.po_number ? `${row.po_number} — ` : '';
            return {
                shipment_id: row.shipment_id,
                shipment_uniqid: row.ship_uniqid,
                po_id: row.po_id,
                vendor_id: row.vendor_id,
                lot_number: row.lot_number,
                total_lots: row.total_lots,
                stage_id: row.shipment_stage_id,
                po_number: row.po_number || null,
                vendor_name: row.vendor_name || null,
                lot_label: `${poPart}${lotLabel}`
            };
        });

        res.json(data);
    } catch (e) {
        res.status(500).json(errPayload("Failed to load shipment lots.", "DB_ERROR", e.message));
    }
});

// --- board: all shipments with their current stage (from purchase_orders.shipment_stage_id)
router.get("/board", async (req, res) => {
    try {
        const {
            po_number,
            vendor_id,
            product_id,
            trade_type_id
        } = req.query;

        let whereClauses = ['s.shipment_stage_id > 0', 's.is_inactive = 0'];
        const params = [req.session?.user?.id || 0, req.session?.user?.id || 0];

        const tradeTypeFilter = trade_type_id ? parseInt(trade_type_id, 10) : null;

        if (po_number) {
            whereClauses.push('po.po_number LIKE ?');
            params.push(`%${po_number}%`);
        }
        if (vendor_id) {
            whereClauses.push('s.vendor_id = ?');
            params.push(vendor_id);
        }
        if (product_id) {
            whereClauses.push('EXISTS (SELECT 1 FROM purchase_order_items poi_filter WHERE poi_filter.purchase_order_id = po.id AND poi_filter.item_id = ?)');
            params.push(product_id);
        }
        if (Number.isInteger(tradeTypeFilter)) {
            whereClauses.push('po.trade_type_id = ?');
            params.push(tradeTypeFilter);
        }

        const [rows] = await db.promise().query(
            `
      SELECT
        s.ship_uniqid,
        s.id AS shipment_id,
        s.po_id,
        s.vendor_id,
        s.shipment_stage_id AS stage_id,        
        po.confirmation_type,
        CASE
            WHEN s.shipment_stage_id >= 2 THEN s.no_containers
            ELSE po.no_containers
        END AS no_containers,
        CASE
            WHEN s.shipment_stage_id >= 2 THEN s.containers_stock_sales
            ELSE po.containers_stock_sales
        END AS containers_stock_sales,
        CASE
            WHEN s.shipment_stage_id >= 2 THEN s.containers_back_to_back
            ELSE po.containers_back_to_back
        END AS containers_back_to_back,
        COALESCE(s.confirm_vessel_name, s.vessel_name) as vessel_name,
        -- For Underloading (3) and before, show ETD. For Sailed (4) and after, show the confirmed sailing date.
        CASE 
            WHEN s.shipment_stage_id >= 4 THEN DATE_FORMAT(s.sailing_date, '%d-%b-%Y')
            ELSE DATE_FORMAT(s.etd_date, '%d-%b-%Y') 
        END AS etd_date,
        -- For Underloading (3) and before, show ETA. For Sailed (4) and after, show the confirmed arrival/ETA date.
        CASE
            WHEN s.shipment_stage_id >= 4 AND po.mode_shipment_id = 2 THEN DATE_FORMAT(s.confirm_arrival_date, '%d-%b-%Y') -- Air has confirm_arrival_date
            WHEN s.shipment_stage_id >= 4 AND po.mode_shipment_id = 1 THEN DATE_FORMAT(s.eta_date, '%d-%b-%Y') -- Sea uses eta_date
            ELSE DATE_FORMAT(s.eta_date, '%d-%b-%Y')
        END as eta_date,
        -- Add scraped discharge date for comparison on the board, aliased correctly
        (
            SELECT MIN(dtcs.discharge_date) 
            FROM dubai_trade_container_status dtcs 
            WHERE dtcs.shipment_id = s.id
        ) as scraped_discharge_date,
        -- Get discharge date as YYYY-MM-DD for calendar, fallback to shipment table eta_date
        COALESCE(
            (
                SELECT DATE_FORMAT(MIN(dtcs.discharge_date), '%Y-%m-%d')
                FROM dubai_trade_container_status dtcs 
                WHERE dtcs.shipment_id = s.id
            ),
            DATE_FORMAT(s.eta_date, '%Y-%m-%d')
        ) as discharge_date_raw,
        -- Get to_town_date from Dubai Trade moves, fallback to container return's to_town_date
        COALESCE(
            (
                SELECT DATE_FORMAT(
                    MAX(COALESCE(
                        STR_TO_DATE(m.date, '%Y-%m-%d %H:%i:%s'),
                        STR_TO_DATE(m.date, '%Y-%m-%d'),
                        STR_TO_DATE(m.date, '%d-%b-%Y %H:%i'),
                        STR_TO_DATE(m.date, '%d-%b-%Y')
                    )),
                    '%Y-%m-%d'
                )
                FROM dubai_trade_container_status dtcs
                INNER JOIN dubai_trade_container_moves m ON m.dubai_trade_status_id = dtcs.id
                WHERE dtcs.shipment_id = s.id
                  AND UPPER(m.move) LIKE '%TO TOWN%'
            ),
            (
                SELECT DATE_FORMAT(MAX(scr.to_town_date), '%Y-%m-%d')
                FROM shipment_container sc
                LEFT JOIN shipment_container_return scr ON scr.container_id = sc.id
                WHERE sc.shipment_id = s.id
                  AND scr.to_town_date IS NOT NULL
            ),
            DATE_FORMAT(s.cleared_date, '%Y-%m-%d')
        ) as to_town_date_raw,
        -- Get from_town_date from Dubai Trade moves
        (
            SELECT DATE_FORMAT(
                MAX(COALESCE(
                    STR_TO_DATE(m.date, '%Y-%m-%d %H:%i:%s'),
                    STR_TO_DATE(m.date, '%Y-%m-%d'),
                    STR_TO_DATE(m.date, '%d-%b-%Y %H:%i'),
                    STR_TO_DATE(m.date, '%d-%b-%Y')
                )),
                '%Y-%m-%d'
            )
            FROM dubai_trade_container_status dtcs
            INNER JOIN dubai_trade_container_moves m ON m.dubai_trade_status_id = dtcs.id
            WHERE dtcs.shipment_id = s.id
              AND (UPPER(m.move) LIKE '%FROM_TOWN%' OR UPPER(m.move) LIKE '%FROM TOWN%')
        ) as from_town_date_raw,
        DATE_FORMAT(s.sailing_date, '%Y-%m-%d') as sailing_date_raw,
        DATE_FORMAT(s.cleared_date, '%Y-%m-%d') as cleared_date_raw,
        DATE_FORMAT(s.discharge_date, '%Y-%m-%d') as discharge_date,
        COALESCE(s.confirm_airway_bill_no, s.airway_bill_no) as airway_bill_no,
        s.departure_time,
        s.bl_no,
        COALESCE(s.confirm_airline, s.airline) as airline,
        COALESCE(s.confirm_flight_no, s.flight_no) as flight_no,
        s.confirm_airway_bill_no,
        s.confirm_flight_no,
        s.confirm_airline,
        s.free_time,
        s.confirm_free_time,
        s.is_mofa_required,
        DATE_FORMAT(s.firs_due_date, '%d-%b-%Y') as firs_due_date,
        DATE_FORMAT(s.mofa_due_date, '%d-%b-%Y') as mofa_due_date,
        DATE_FORMAT(s.custom_submission_due_date, '%d-%b-%Y') as custom_submission_due_date,
        -- Check if documents are attached (match ShipmentDetailsModal behavior - no is_draft filter)
        (SELECT COUNT(*) > 0 FROM shipment_file sf 
         INNER JOIN document_type dt ON dt.id = sf.document_type_id 
         WHERE sf.shipment_id = s.id AND dt.code = 'firs_attachment') as has_firs_attachment,
        (SELECT COUNT(*) > 0 FROM shipment_file sf 
         INNER JOIN document_type dt ON dt.id = sf.document_type_id 
         WHERE sf.shipment_id = s.id AND dt.code = 'mofa_attachment') as has_mofa_attachment,
        (SELECT COUNT(*) > 0 FROM shipment_file sf 
         INNER JOIN document_type dt ON dt.id = sf.document_type_id 
         WHERE sf.shipment_id = s.id AND dt.code = 'original_document_cleared') as has_custom_attachment,
        s.shipping_line_name,
        s.original_doc_receipt_mode,
        s.doc_receipt_person_name,
        s.doc_receipt_person_contact,
        s.doc_receipt_courier_no,
        s.doc_receipt_courier_company,
        s.doc_receipt_tracking_link,
        s.closed_comment,
        DATE_FORMAT(s.closed_date, '%Y-%m-%d') as closed_date,
        s.archive_comment,
        DATE_FORMAT(s.archive_date, '%Y-%m-%d') as archive_date,
        DATE_FORMAT(s.do_validity_date, '%d-%b-%Y') as do_validity_date,
        DATE_FORMAT(s.do_validity_date, '%Y-%m-%d') as do_validity_date_raw,
        (
            SELECT GROUP_CONCAT(sc.container_no ORDER BY sc.id SEPARATOR '||')
            FROM shipment_container sc
            WHERE sc.shipment_id = s.id
        ) AS container_numbers,
        (
            SELECT COUNT(*) 
            FROM shipment_po_document spd
            WHERE spd.shipment_id = s.id
        ) AS required_document_count,
        (
            SELECT COUNT(*)
            FROM shipment_po_document spd
            WHERE spd.shipment_id = s.id
              AND NOT EXISTS (
                    SELECT 1
                    FROM shipment_file sf
                    WHERE sf.shipment_id = s.id
                      AND sf.document_type_id = spd.document_type_id
                      AND (sf.is_draft IS NULL OR sf.is_draft = 0)
                )
        ) AS missing_original_document_count,
        (
            SELECT GROUP_CONCAT(DISTINCT dt.name SEPARATOR '||')
            FROM shipment_po_document spd
            JOIN document_type dt ON dt.id = spd.document_type_id
            WHERE spd.shipment_id = s.id
              AND NOT EXISTS (
                    SELECT 1
                    FROM shipment_file sf
                    WHERE sf.shipment_id = s.id
                      AND sf.document_type_id = spd.document_type_id
                      AND (sf.is_draft IS NULL OR sf.is_draft = 0)
                )
        ) AS missing_original_document_names,
        DATE_FORMAT(s.confirm_arrival_date, '%d-%b-%Y') as confirm_arrival_date,
        s.confirm_arrival_time,
        s.total_lots, -- Fetch total_lots directly from the DB
        DATE_FORMAT(s.arrival_date, '%d-%b-%Y') as arrival_date,
        s.arrival_time,
        s.lot_number,
        s.parent_shipment_id,
        s.purchase_bill_id,
        po.po_number,
        po.trade_type_id,
        po.mode_shipment_id,
        po.pdf_path,
        v.display_name as vendor_name,
        c.display_name as customer_name,
        po.po_uniqid AS po_uniqid,
        dpl.name as loading_name,
        dpd.name as discharge_name,
        -- For Underloading (3) and before, show Port of Loading. For Sailed (4) and after, show Port of Discharge.
        CASE
            WHEN s.shipment_stage_id >= 4 THEN dpd.name
            ELSE dpl.name
        END as relevant_port_name,
        GROUP_CONCAT(DISTINCT poi.item_name SEPARATOR ' • ') as products,
        (
            SELECT COUNT(*) 
            FROM shipment_log sl 
            WHERE sl.shipment_id = s.id
              AND sl.user_id != ? 
              AND sl.id > COALESCE((SELECT last_read_log_id FROM shipment_log_read_status WHERE shipment_id = s.id AND user_id = ?), 0)
        ) as unread_log_count
      FROM shipment s 
      LEFT JOIN purchase_orders po ON po.id = s.po_id
      LEFT JOIN vendor v ON v.id = s.vendor_id -- Vendor from shipment table
      LEFT JOIN vendor c ON c.id = po.confirmation_customer_id
      LEFT JOIN delivery_place dpl ON dpl.id=po.port_loading
      LEFT JOIN delivery_place dpd ON dpd.id=po.port_discharge
      LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
      WHERE ${whereClauses.join(' AND ')}
      GROUP BY s.id
      ORDER BY s.shipment_stage_id, s.id DESC
      `, params
        );

        rows.forEach(r => {
            if (r.container_numbers) {
                const list = r.container_numbers.split('||').filter(Boolean);
                r.containers = list.map((containerNo, index) => ({
                    id: `${r.shipment_id}_${index}`,
                    container_no: containerNo
                }));
            } else {
                r.containers = [];
            }
            delete r.container_numbers;

            if (typeof r.missing_original_document_names === 'string' && r.missing_original_document_names.length > 0) {
                r.missing_original_document_names = r.missing_original_document_names.split('||').filter(Boolean);
            } else {
                r.missing_original_document_names = [];
            }
            if (typeof r.container_return_pending_names === 'string' && r.container_return_pending_names.length > 0) {
                r.container_return_pending_names = r.container_return_pending_names.split('||').filter(Boolean);
            }
            r.closed_comment = r.closed_comment || null;
            r.closed_date = r.closed_date || null;
            r.archive_comment = r.archive_comment || null;
            r.archive_date = r.archive_date || null;
        });

        const shipmentsNeedingReturns = rows.filter(r => Number(r.stage_id) >= 5 && String(r.mode_shipment_id) === '1');

        if (shipmentsNeedingReturns.length > 0) {
            const shipmentIds = shipmentsNeedingReturns.map(r => r.shipment_id);
            const [returnRows] = await db.promise().query(
                `
                SELECT 
                    sc.shipment_id,
                    sc.id AS container_id,
                    sc.container_no,
                     DATE_FORMAT(scr.to_town_date, '%Y-%m-%d') AS to_town_date_raw,
                    DATE_FORMAT(scr.to_town_date, '%d-%b-%Y') AS to_town_date_formatted,
                    DATE_FORMAT(scr.return_date, '%Y-%m-%d') AS return_date_raw,
                    DATE_FORMAT(scr.return_date, '%d-%b-%Y') AS return_date_formatted,
                        (
                            SELECT DATE_FORMAT(
                                       MAX(COALESCE(
                                           STR_TO_DATE(m.date, '%Y-%m-%d %H:%i:%s'),
                                           STR_TO_DATE(m.date, '%Y-%m-%d'),
                                           STR_TO_DATE(m.date, '%d-%b-%Y %H:%i'),
                                           STR_TO_DATE(m.date, '%d-%b-%Y')
                                       )),
                                       '%Y-%m-%d'
                                   )
                            FROM dubai_trade_container_moves m
                            WHERE m.dubai_trade_status_id = dtcs.id
                              AND UPPER(m.move) LIKE '%TO TOWN%'
                        ) AS dt_to_town_date_raw,
                        (
                            SELECT DATE_FORMAT(
                                       MAX(COALESCE(
                                           STR_TO_DATE(m.date, '%Y-%m-%d %H:%i:%s'),
                                           STR_TO_DATE(m.date, '%Y-%m-%d'),
                                           STR_TO_DATE(m.date, '%d-%b-%Y %H:%i'),
                                           STR_TO_DATE(m.date, '%d-%b-%Y')
                                       )),
                                       '%d-%b-%Y'
                                   )
                            FROM dubai_trade_container_moves m
                            WHERE m.dubai_trade_status_id = dtcs.id
                              AND UPPER(m.move) LIKE '%TO TOWN%'
                        ) AS dt_to_town_date_formatted,
                        DATE_FORMAT(
                            COALESCE(
                                (
                                    SELECT MAX(COALESCE(
                                               STR_TO_DATE(m.date, '%Y-%m-%d %H:%i:%s'),
                                               STR_TO_DATE(m.date, '%Y-%m-%d'),
                                               STR_TO_DATE(m.date, '%d-%b-%Y %H:%i'),
                                               STR_TO_DATE(m.date, '%d-%b-%Y')
                                           ))
                                    FROM dubai_trade_container_moves m
                                    WHERE m.dubai_trade_status_id = dtcs.id
                                      AND UPPER(m.move) LIKE '%TO TOWN%'
                                ),
                                dtcm.to_town_date,
                                scr.to_town_date
                            ),
                            '%Y-%m-%d'
                        ) AS to_town_date_raw,
                        DATE_FORMAT(
                            COALESCE(
                                (
                                    SELECT MAX(COALESCE(
                                               STR_TO_DATE(m.date, '%Y-%m-%d %H:%i:%s'),
                                               STR_TO_DATE(m.date, '%Y-%m-%d'),
                                               STR_TO_DATE(m.date, '%d-%b-%Y %H:%i'),
                                               STR_TO_DATE(m.date, '%d-%b-%Y')
                                           ))
                                    FROM dubai_trade_container_moves m
                                    WHERE m.dubai_trade_status_id = dtcs.id
                                      AND UPPER(m.move) LIKE '%TO TOWN%'
                                ),
                                dtcm.to_town_date,
                                scr.to_town_date
                            ),
                            '%d-%b-%Y'
                        ) AS to_town_date_formatted,
                    COUNT(DISTINCT scrf.id) AS attachment_count
                FROM shipment_container sc
                LEFT JOIN dubai_trade_container_status dtcs ON dtcs.shipment_container_id = sc.id
                LEFT JOIN (
                    SELECT 
                        dubai_trade_status_id, 
                        MAX(date) AS to_town_date
                    FROM dubai_trade_container_moves
                    WHERE UPPER(move) LIKE '%TO TOWN%'
                    GROUP BY dubai_trade_status_id
                ) AS dtcm ON dtcm.dubai_trade_status_id = dtcs.id
                LEFT JOIN shipment_container_return scr ON scr.container_id = sc.id
                LEFT JOIN shipment_container_return_file scrf ON scrf.return_id = scr.id
                WHERE sc.shipment_id IN (?)
                GROUP BY sc.id, sc.shipment_id, sc.container_no, scr.return_date, scr.to_town_date, dtcm.to_town_date
                `,
                [shipmentIds]
            );

            const returnsByShipment = {};
            for (const row of returnRows) {
                const key = row.shipment_id;
                if (!returnsByShipment[key]) returnsByShipment[key] = [];
                returnsByShipment[key].push({
                    container_id: row.container_id,
                    container_no: row.container_no,
                    return_date_raw: row.return_date_raw,
                    return_date_formatted: row.return_date_formatted,
                    dt_to_town_date_raw: row.dt_to_town_date_raw,
                    dt_to_town_date_formatted: row.dt_to_town_date_formatted,
                    to_town_date_raw: row.to_town_date_raw,
                    to_town_date_formatted: row.to_town_date_formatted,
                    attachment_count: Number(row.attachment_count || 0)
                });
            }

            rows.forEach(r => {
                if (Number(r.stage_id) >= 5) {
                    const list = returnsByShipment[r.shipment_id] || [];
                    list.sort((a, b) => {
                        if (a.container_no && b.container_no) {
                            return String(a.container_no).localeCompare(String(b.container_no));
                        }
                        return Number(a.container_id) - Number(b.container_id);
                    });
                    r.container_returns = list;
                    r.container_return_pending_names = list
                        .filter(item => Number(item.attachment_count || 0) === 0)
                        .map(item => item.container_no || `Container ${item.container_id}`);
                } else {
                    r.container_returns = [];
                    r.container_return_pending_names = [];
                }
            });
        }
        rows.forEach(r => {
            r.required_document_count = Number(r.required_document_count || 0);
            r.missing_original_document_count = Number(r.missing_original_document_count || 0);
            if (!Array.isArray(r.container_return_pending_names)) r.container_return_pending_names = [];
        });

        res.json(rows || []);
    } catch (e) {
        res.status(500).json({
            error: { message: "Failed to load board", type: "DB_ERROR", hint: e.message }
        });
    }
});

// Helper function to safely parse and format date
const safeDateParse = (dateStr) => {
    if (!dateStr) return null;
    try {
        const parsed = dayjs(dateStr, ['YYYY-MM-DD', 'DD-MMM-YYYY', 'YYYY-MM-DD HH:mm:ss'], true);
        return parsed.isValid() ? parsed.format('YYYY-MM-DD') : null;
    } catch {
        return null;
    }
};

// Helper function to ensure start <= end
const validateDateRange = (start, end) => {
    if (!start || !end) return null;
    const startDate = dayjs(start);
    const endDate = dayjs(end);
    if (!startDate.isValid() || !endDate.isValid()) return null;
    if (endDate.isBefore(startDate, 'day')) return null;
    return { start: startDate.format('YYYY-MM-DD'), end: endDate.format('YYYY-MM-DD') };
};

// Received Calendar endpoint - returns date ranges for in-hand containers
router.get("/received-calendar", async (req, res) => {
    try {
        // Fetch shipments that are relevant for received / in-hand status
        // Stages: Discharge (4), Cleared (5), Closed (6) - containers have landed at POD
        const [rows] = await db.promise().query(`
            SELECT 
                s.id as shipment_id,
                s.ship_uniqid,
                s.po_id,
                po.po_number,
                v.display_name as vendor_name,
                dpd.name as discharge_port,
                s.shipment_stage_id as stage_id,
                po.mode_shipment_id,
                -- Get discharge date from Dubai Trade
                (
                    SELECT DATE_FORMAT(MIN(dtcs.discharge_date), '%Y-%m-%d')
                    FROM dubai_trade_container_status dtcs 
                    WHERE dtcs.shipment_id = s.id
                ) as discharge_date_raw,
                -- Get to_town_date from Dubai Trade moves
                (
                    SELECT DATE_FORMAT(
                        MAX(COALESCE(
                            STR_TO_DATE(m.date, '%Y-%m-%d %H:%i:%s'),
                            STR_TO_DATE(m.date, '%Y-%m-%d'),
                            STR_TO_DATE(m.date, '%d-%b-%Y %H:%i'),
                            STR_TO_DATE(m.date, '%d-%b-%Y')
                        )),
                        '%Y-%m-%d'
                    )
                    FROM dubai_trade_container_status dtcs
                    INNER JOIN dubai_trade_container_moves m ON m.dubai_trade_status_id = dtcs.id
                    WHERE dtcs.shipment_id = s.id
                      AND UPPER(m.move) LIKE '%TO TOWN%'
                ) as to_town_date_raw,
                -- Get from_town_date from Dubai Trade moves
                (
                    SELECT DATE_FORMAT(
                        MAX(COALESCE(
                            STR_TO_DATE(m.date, '%Y-%m-%d %H:%i:%s'),
                            STR_TO_DATE(m.date, '%Y-%m-%d'),
                            STR_TO_DATE(m.date, '%d-%b-%Y %H:%i'),
                            STR_TO_DATE(m.date, '%d-%b-%Y')
                        )),
                        '%Y-%m-%d'
                    )
                    FROM dubai_trade_container_status dtcs
                    INNER JOIN dubai_trade_container_moves m ON m.dubai_trade_status_id = dtcs.id
                    WHERE dtcs.shipment_id = s.id
                      AND (UPPER(m.move) LIKE '%FROM_TOWN%' OR UPPER(m.move) LIKE '%FROM TOWN%')
                ) as from_town_date_raw,
                -- Fallback dates from shipment stages
                DATE_FORMAT(s.sailing_date, '%Y-%m-%d') as sailing_date_raw,
                DATE_FORMAT(s.cleared_date, '%Y-%m-%d') as cleared_date_raw,
                DATE_FORMAT(s.eta_date, '%Y-%m-%d') as eta_date_raw,
                DATE_FORMAT(s.confirm_arrival_date, '%Y-%m-%d') as confirm_arrival_date_raw,
                -- Container numbers
                (
                    SELECT GROUP_CONCAT(sc.container_no ORDER BY sc.id SEPARATOR ', ')
                    FROM shipment_container sc
                    WHERE sc.shipment_id = s.id
                ) as container_numbers
            FROM shipment s
            LEFT JOIN purchase_orders po ON po.id = s.po_id
            LEFT JOIN vendor v ON v.id = s.vendor_id
            LEFT JOIN delivery_place dpd ON dpd.id = po.port_discharge
            WHERE s.shipment_stage_id >= 4  -- Sailed and after (containers have landed)
              AND s.shipment_stage_id <= 6  -- Up to Closed
            ORDER BY s.shipment_stage_id, s.id DESC
        `);

        // Fetch container return dates for fallback
        const shipmentIds = rows.map(r => r.shipment_id);
        let returnDatesByShipment = {};
        if (shipmentIds.length > 0) {
            const [returnRows] = await db.promise().query(`
                SELECT 
                    sc.shipment_id,
                    DATE_FORMAT(scr.return_date, '%Y-%m-%d') AS return_date_raw,
                    DATE_FORMAT(scr.to_town_date, '%Y-%m-%d') AS return_to_town_date_raw
                FROM shipment_container sc
                LEFT JOIN shipment_container_return scr ON scr.container_id = sc.id
                WHERE sc.shipment_id IN (?)
                GROUP BY sc.shipment_id, scr.return_date, scr.to_town_date
            `, [shipmentIds]);

            returnRows.forEach(row => {
                if (!returnDatesByShipment[row.shipment_id]) {
                    returnDatesByShipment[row.shipment_id] = [];
                }
                returnDatesByShipment[row.shipment_id].push({
                    return_date_raw: row.return_date_raw,
                    return_to_town_date_raw: row.return_to_town_date_raw
                });
            });
        }

        // Process each shipment and compute date ranges
        // Each PO/shipment should show two ranges:
        // Range 1: Discharge Date → To Town Date
        // Range 2: To Town Date → From Town Date
        // Priority: Dubai Trade moves first, then fallback to stage dates
        const result = [];
        for (const row of rows) {
            // Priority 1: Try Dubai Trade dates first
            let dischargeDate = safeDateParse(row.discharge_date_raw);
            let toTownDate = safeDateParse(row.to_town_date_raw);
            let fromTownDate = safeDateParse(row.from_town_date_raw);

            // Fallback for Range 1: Discharge Date
            // If Dubai Trade doesn't have discharge_date, use ETA/Sailing date from Sailed stage (stage 4)
            if (!dischargeDate && Number(row.stage_id) >= 4) {
                dischargeDate = safeDateParse(row.sailing_date_raw) ||
                    safeDateParse(row.eta_date_raw) ||
                    safeDateParse(row.confirm_arrival_date_raw);
            }

            // Fallback for Range 1 & 2: To Town Date
            // If Dubai Trade doesn't have to_town_date, use cleared_date from Cleared stage (stage 5)
            // Then check container return table for return_to_town_date_raw
            if (!toTownDate && Number(row.stage_id) >= 5) {
                toTownDate = safeDateParse(row.cleared_date_raw);

                if (!toTownDate && returnDatesByShipment[row.shipment_id]) {
                    const returnData = returnDatesByShipment[row.shipment_id][0];
                    toTownDate = safeDateParse(returnData?.return_to_town_date_raw);
                }
            }

            // Fallback for Range 2: From Town Date
            // If Dubai Trade doesn't have from_town_date, use return_date from container return table
            if (!fromTownDate) {
                if (returnDatesByShipment[row.shipment_id]) {
                    const returnData = returnDatesByShipment[row.shipment_id][0];
                    fromTownDate = safeDateParse(returnData?.return_date_raw);
                }
            }

            // Compute Range 1: Discharge Date → To Town Date
            // Shows period from discharge/ETA to to_town/cleared
            // Compute independently - use best available dates for this range
            const range1Discharge = dischargeDate; // Already has fallback applied
            const range1ToTown = toTownDate; // Already has fallback applied
            const range1 = validateDateRange(range1Discharge, range1ToTown);

            // Compute Range 2: To Town Date → From Town Date
            // Shows period from to_town/cleared to from_town/return
            // Compute independently - use best available dates for this range
            const range2ToTown = toTownDate; // Already has fallback applied
            const range2FromTown = fromTownDate; // Already has fallback applied
            const range2 = validateDateRange(range2ToTown, range2FromTown);

            // Always include the shipment if at least one range is valid
            // Both range1 and range2 are computed independently and included (even if null)
            // This ensures the frontend can display both ranges when available
            if (range1 || range2) {
                result.push({
                    id: row.shipment_id,
                    po_id: row.po_id,
                    po_number: row.po_number || row.ship_uniqid,
                    ship_uniqid: row.ship_uniqid,
                    vendor_name: row.vendor_name || null,
                    discharge_port: row.discharge_port || null,
                    container_no: row.container_numbers || null,
                    range1: range1,  // Discharge → To Town (can be null if dates unavailable)
                    range2: range2,  // To Town → From Town (can be null if dates unavailable)
                    stage_id: Number(row.stage_id),
                    mode_shipment_id: Number(row.mode_shipment_id)
                });
            }
        }

        res.json(result);
    } catch (e) {
        res.status(500).json({
            error: { message: "Failed to load received calendar", type: "DB_ERROR", hint: e.message }
        });
    }
});

// In Hand Calendar endpoint - alias for received-calendar with same logic
router.get("/inhand-calendar", async (req, res) => {
    try {
        // Fetch shipments that are relevant for in-hand status
        // Stages: Sailed (4), Cleared (5), Closed (6) - containers have landed at POD
        const [rows] = await db.promise().query(`
            SELECT 
                s.id as shipment_id,
                s.ship_uniqid,
                s.po_id,
                po.po_number,
                v.display_name as vendor_name,
                dpd.name as discharge_port,
                s.shipment_stage_id as stage_id,
                po.mode_shipment_id,
                -- Get discharge date from Dubai Trade
                (
                    SELECT DATE_FORMAT(MIN(dtcs.discharge_date), '%Y-%m-%d')
                    FROM dubai_trade_container_status dtcs 
                    WHERE dtcs.shipment_id = s.id
                ) as discharge_date_raw,
                -- Get to_town_date from Dubai Trade moves
                (
                    SELECT DATE_FORMAT(
                        MAX(COALESCE(
                            STR_TO_DATE(m.date, '%Y-%m-%d %H:%i:%s'),
                            STR_TO_DATE(m.date, '%Y-%m-%d'),
                            STR_TO_DATE(m.date, '%d-%b-%Y %H:%i'),
                            STR_TO_DATE(m.date, '%d-%b-%Y')
                        )),
                        '%Y-%m-%d'
                    )
                    FROM dubai_trade_container_status dtcs
                    INNER JOIN dubai_trade_container_moves m ON m.dubai_trade_status_id = dtcs.id
                    WHERE dtcs.shipment_id = s.id
                      AND UPPER(m.move) LIKE '%TO TOWN%'
                ) as to_town_date_raw,
                -- Get from_town_date from Dubai Trade moves
                (
                    SELECT DATE_FORMAT(
                        MAX(COALESCE(
                            STR_TO_DATE(m.date, '%Y-%m-%d %H:%i:%s'),
                            STR_TO_DATE(m.date, '%Y-%m-%d'),
                            STR_TO_DATE(m.date, '%d-%b-%Y %H:%i'),
                            STR_TO_DATE(m.date, '%d-%b-%Y')
                        )),
                        '%Y-%m-%d'
                    )
                    FROM dubai_trade_container_status dtcs
                    INNER JOIN dubai_trade_container_moves m ON m.dubai_trade_status_id = dtcs.id
                    WHERE dtcs.shipment_id = s.id
                      AND (UPPER(m.move) LIKE '%FROM_TOWN%' OR UPPER(m.move) LIKE '%FROM TOWN%')
                ) as from_town_date_raw,
                -- Fallback dates from shipment stages
                DATE_FORMAT(s.sailing_date, '%Y-%m-%d') as sailing_date_raw,
                DATE_FORMAT(s.cleared_date, '%Y-%m-%d') as cleared_date_raw,
                DATE_FORMAT(s.eta_date, '%Y-%m-%d') as eta_date_raw,
                DATE_FORMAT(s.confirm_arrival_date, '%Y-%m-%d') as confirm_arrival_date_raw,
                -- Container numbers
                (
                    SELECT GROUP_CONCAT(sc.container_no ORDER BY sc.id SEPARATOR ', ')
                    FROM shipment_container sc
                    WHERE sc.shipment_id = s.id
                ) as container_numbers
            FROM shipment s
            LEFT JOIN purchase_orders po ON po.id = s.po_id
            LEFT JOIN vendor v ON v.id = s.vendor_id
            LEFT JOIN delivery_place dpd ON dpd.id = po.port_discharge
            WHERE s.shipment_stage_id >= 4  -- Sailed and after (containers have landed)
              AND s.shipment_stage_id <= 6  -- Up to Closed
            ORDER BY s.shipment_stage_id, s.id DESC
        `);

        // Fetch container return dates for fallback
        const shipmentIds = rows.map(r => r.shipment_id);
        let returnDatesByShipment = {};
        if (shipmentIds.length > 0) {
            const [returnRows] = await db.promise().query(`
                SELECT 
                    sc.shipment_id,
                    DATE_FORMAT(scr.return_date, '%Y-%m-%d') AS return_date_raw,
                    DATE_FORMAT(scr.to_town_date, '%Y-%m-%d') AS return_to_town_date_raw
                FROM shipment_container sc
                LEFT JOIN shipment_container_return scr ON scr.container_id = sc.id
                WHERE sc.shipment_id IN (?)
                GROUP BY sc.shipment_id, scr.return_date, scr.to_town_date
            `, [shipmentIds]);

            returnRows.forEach(row => {
                if (!returnDatesByShipment[row.shipment_id]) {
                    returnDatesByShipment[row.shipment_id] = [];
                }
                returnDatesByShipment[row.shipment_id].push({
                    return_date_raw: row.return_date_raw,
                    return_to_town_date_raw: row.return_to_town_date_raw
                });
            });
        }

        // Process each shipment and compute date ranges
        // Each PO/shipment should show two ranges:
        // Range 1: Discharge Date → To Town Date
        // Range 2: To Town Date → From Town Date
        // Priority: Dubai Trade moves first, then fallback to stage dates
        const result = [];
        for (const row of rows) {
            // Priority 1: Try Dubai Trade dates first
            let dischargeDate = safeDateParse(row.discharge_date_raw);
            let toTownDate = safeDateParse(row.to_town_date_raw);
            let fromTownDate = safeDateParse(row.from_town_date_raw);

            // Fallback for Range 1: Discharge Date
            // If Dubai Trade doesn't have discharge_date, use ETA/Sailing date from Sailed stage (stage 4)
            if (!dischargeDate && Number(row.stage_id) >= 4) {
                dischargeDate = safeDateParse(row.sailing_date_raw) ||
                    safeDateParse(row.eta_date_raw) ||
                    safeDateParse(row.confirm_arrival_date_raw);
            }

            // Fallback for Range 1 & 2: To Town Date
            // If Dubai Trade doesn't have to_town_date, use cleared_date from Cleared stage (stage 5)
            // Then check container return table for return_to_town_date_raw
            if (!toTownDate && Number(row.stage_id) >= 5) {
                toTownDate = safeDateParse(row.cleared_date_raw);

                if (!toTownDate && returnDatesByShipment[row.shipment_id]) {
                    const returnData = returnDatesByShipment[row.shipment_id][0];
                    toTownDate = safeDateParse(returnData?.return_to_town_date_raw);
                }
            }

            // Fallback for Range 2: From Town Date
            // If Dubai Trade doesn't have from_town_date, use return_date from container return table
            if (!fromTownDate) {
                if (returnDatesByShipment[row.shipment_id]) {
                    const returnData = returnDatesByShipment[row.shipment_id][0];
                    fromTownDate = safeDateParse(returnData?.return_date_raw);
                }
            }

            // Compute Range 1: Discharge Date → To Town Date
            const range1 = validateDateRange(dischargeDate, toTownDate);

            // Compute Range 2: To Town Date → From Town Date
            // Range 2 should start from the day AFTER toTownDate (not including toTownDate itself)
            // because toTownDate is the end of Range 1
            let range2Start = null;
            if (toTownDate) {
                const toTownDay = dayjs(toTownDate);
                if (toTownDay.isValid()) {
                    range2Start = toTownDay.add(1, 'day').format('YYYY-MM-DD');
                }
            }
            const range2 = validateDateRange(range2Start, fromTownDate);

            // Debug logging for first few shipments
            if (result.length < 3) {
                console.log(`[inhand-calendar] PO ${row.po_number || row.ship_uniqid}:`, {
                    dischargeDate,
                    toTownDate,
                    fromTownDate,
                    range2Start,
                    range1: range1 ? `${range1.start} to ${range1.end}` : 'null',
                    range2: range2 ? `${range2.start} to ${range2.end}` : 'null'
                });
            }

            // Always include the shipment if at least one range is valid
            // Both range1 and range2 are included (even if null) so frontend can display both when available
            if (range1 || range2) {
                result.push({
                    id: row.shipment_id,
                    po_id: row.po_id,
                    po_number: row.po_number || row.ship_uniqid,
                    ship_uniqid: row.ship_uniqid,
                    vendor_name: row.vendor_name || null,
                    discharge_port: row.discharge_port || null,
                    container_no: row.container_numbers || null,
                    range1: range1,  // Discharge → To Town (can be null if dates unavailable)
                    range2: range2,  // To Town → From Town (can be null if dates unavailable)
                    stage_id: Number(row.stage_id),
                    mode_shipment_id: Number(row.mode_shipment_id)
                });
            }
        }

        res.json(result);
    } catch (e) {
        res.status(500).json({
            error: { message: "Failed to load in-hand calendar", type: "DB_ERROR", hint: e.message }
        });
    }
});

router.get("/archive", async (req, res) => {
    try {
        const [rows] = await db.promise().query(
            `
            SELECT
                s.id,
                s.ship_uniqid,
                s.po_id,
                po.po_number,
                v.display_name AS vendor_name,
                s.lot_number,
                s.total_lots,
                DATE_FORMAT(s.closed_date, '%d-%b-%Y') AS closed_date,
                DATE_FORMAT(s.archive_date, '%d-%b-%Y') AS archive_date,
                s.archive_comment,
                (
                    SELECT GROUP_CONCAT(sc.container_no ORDER BY sc.id SEPARATOR ', ')
                    FROM shipment_container sc
                    WHERE sc.shipment_id = s.id
                ) AS container_numbers
            FROM shipment s
            LEFT JOIN purchase_orders po ON po.id = s.po_id
            LEFT JOIN vendor v ON v.id = s.vendor_id
            WHERE s.shipment_stage_id = 7
            ORDER BY s.archive_date DESC, s.id DESC
            `
        );

        const formatted = rows.map((row) => ({
            ...row,
            lot_label:
                Number(row.total_lots) > 1
                    ? `Lot ${row.lot_number}/${row.total_lots}`
                    : (row.lot_number ? `Lot ${row.lot_number}` : "-"),
            container_numbers: row.container_numbers || "-",
            closed_date: row.closed_date || "-",
            archive_date: row.archive_date || "-",
        }));

        res.json(formatted);
    } catch (e) {
        res.status(500).json(errPayload("Failed to load archive shipments.", "DB_ERROR", e.message));
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
           s.shipment_stage_id AS stage_id,
           po.mode_shipment_id, po.no_containers,
           po.pdf_path, po.documents_payment_ids, po.documents_payment_labels,
           s.bl_type, s.freight_amount_currency_id,
           st.name AS stage_name,
           curr.name AS freight_currency_name,
           v.display_name AS vendor_name,           
           va.bill_address_1, va.bill_address_2, va.bill_city, va.bill_zip_code,
           v_state.name AS vendor_state_name,
           v_country.name AS vendor_country_name,
           vc.first_name as vendor_contact_first_name,
           vc.last_name as vendor_contact_last_name,
           vc.email as vendor_contact_email,
           vc.phone as vendor_contact_phone,
           vc.mobile as vendor_contact_mobile,
           dpl.name AS loading_name, 
           dpd.name AS discharge_name,
           inco.name AS inco_name,
           ms.name AS mode_shipment_name,
           -- Company details for consignee
           cs.name AS company_name,
           cs.full_address AS company_address,
           s.confirm_airway_bill_no,
           s.confirm_arrival_date,
           s.confirm_arrival_time,
           s.is_mofa_required,
           s.original_doc_receipt_mode,
           s.doc_receipt_person_name,
           s.doc_receipt_person_contact,
           s.doc_receipt_courier_no,
           s.doc_receipt_courier_company,
           s.doc_receipt_tracking_link,
          s.confirm_flight_no,
         s.confirm_airline,
         s.confirm_shipping_line,
         s.confirm_discharge_port_agent,
         DATE_FORMAT(s.closed_date, '%Y-%m-%d') as closed_date,
         s.closed_comment,
         DATE_FORMAT(s.archive_date, '%Y-%m-%d') as archive_date,
         s.archive_comment,
           cs.country AS company_country,
           ct.name AS container_type_name, 
           cl.name AS container_load_name,
           -- Linked AP Purchase Bill (comma-separated IDs)
           s.purchase_bill_id
      FROM shipment s
      JOIN purchase_orders po ON po.id = s.po_id      
      LEFT JOIN mode_of_shipment ms ON ms.id = po.mode_shipment_id
      LEFT JOIN inco_terms inco ON inco.id = po.inco_terms_id      
      LEFT JOIN shipment_stage st ON st.id = s.shipment_stage_id
      LEFT JOIN vendor v ON v.id = s.vendor_id      
      LEFT JOIN vendor_address va ON va.vendor_id = v.id
      LEFT JOIN state v_state ON v_state.id = va.bill_state_id
      LEFT JOIN country v_country ON v_country.id = va.bill_country_id
      LEFT JOIN contact vc ON vc.vendor_id = v.id AND vc.is_primary = 1
      LEFT JOIN delivery_place dpl ON dpl.id = po.port_loading
      LEFT JOIN delivery_place dpd ON dpd.id = po.port_discharge
      LEFT JOIN container_type ct ON ct.id = po.container_type_id
      LEFT JOIN company_settings cs ON cs.id = po.company_id
      LEFT JOIN currency curr ON curr.id = s.freight_amount_currency_id
      LEFT JOIN container_load cl ON cl.id = po.container_load_id
     WHERE s.ship_uniqid = ? LIMIT 1`, [id]);
    if (!row) return res.status(404).json({ error: { message: "Not found" } });

    // Fetch purchase bill numbers for comma-separated IDs
    let purchase_bill_number = null;
    if (row.purchase_bill_id && row.purchase_bill_id.trim() !== '') {
        const billIds = row.purchase_bill_id.split(',').map(id => id.trim()).filter(id => id && /^\d+$/.test(id));
        if (billIds.length > 0) {
            const placeholders = billIds.map(() => '?').join(',');
            const [bills] = await db.promise().query(
                `SELECT bill_number FROM ap_bills WHERE id IN (${placeholders}) ORDER BY id`,
                billIds
            );
            if (bills && bills.length > 0) {
                purchase_bill_number = bills.map(b => b.bill_number).join(', ');
            }
        }
    }
    row.purchase_bill_number = purchase_bill_number;

    // Fetch PO documents
    const [poDocuments] = await db.promise().query(`
        SELECT spd.id, spd.document_type_id, spd.document_name, dt.name as document_type_name
        FROM shipment_po_document spd
       JOIN document_type dt ON dt.id = spd.document_type_id
        WHERE spd.shipment_id = ?
    `, [row.id]);

    // Also fetch PO items
    const [poItems] = await db.promise().query(`
        SELECT 
            i.id AS po_item_id,
            i.item_id AS product_id,
            i.item_name,
            i.description,
            i.quantity,
            i.hscode,
            COALESCE(spia.total_allocated_quantity, 0) AS total_allocated_quantity,
            GREATEST(i.quantity - COALESCE(spia.total_allocated_quantity, 0), 0) AS open_quantity,
            (SELECT SUM(sc.net_weight)
             FROM shipment_container_item sc
             WHERE sc.product_id = i.item_id
               AND sc.container_id IN (SELECT id FROM shipment_container WHERE shipment_id = ?)) AS net_weight,
            (SELECT SUM(sc.gross_weight)
             FROM shipment_container_item sc
             WHERE sc.product_id = i.item_id
               AND sc.container_id IN (SELECT id FROM shipment_container WHERE shipment_id = ?)) AS gross_weight,
            um.name AS uom_name,
            (SELECT pi.file_path 
             FROM product_images pi 
             WHERE pi.product_id = i.item_id 
             ORDER BY pi.is_primary DESC, pi.id ASC 
             LIMIT 1) AS image_url
        FROM purchase_order_items i
        LEFT JOIN uom_master um ON um.id = i.uom_id
        LEFT JOIN (
            SELECT po_item_id, SUM(allocated_quantity) AS total_allocated_quantity
            FROM shipment_po_item_allocation
            WHERE po_id = ?
            GROUP BY po_item_id
        ) spia ON spia.po_item_id = i.id
        WHERE i.purchase_order_id = ?
        ORDER BY i.id ASC
    `, [row.id, row.id, row.po_id, row.po_id]);

    // Also fetch container details if they exist
    const [containers] = await db.promise().query(`
        SELECT sc.*, dtcs.last_fetched_at, dtcs.discharge_date AS scraped_discharge_date, dtcs.location AS scraped_discharge_port
        FROM shipment_container sc
        LEFT JOIN dubai_trade_container_status dtcs ON sc.container_no = dtcs.container_no AND sc.shipment_id = dtcs.shipment_id
        WHERE sc.shipment_id = ?
    `, [row.id]);

    if (containers.length > 0) {
        const containerIds = containers.map(c => c.id);
        const [images] = await db.promise().query(`SELECT * FROM shipment_container_file WHERE container_id IN (?)`, [containerIds]);
        const [items] = await db.promise().query(`
            SELECT sci.*, 
                   (SELECT pi.file_path 
                    FROM product_images pi 
                    WHERE pi.product_id = sci.product_id 
                    ORDER BY pi.is_primary DESC, pi.id ASC LIMIT 1) as image_url,
                   (SELECT pd.variety
                    FROM product_details pd
                    WHERE pd.product_id = sci.product_id
                    ORDER BY pd.id ASC LIMIT 1) as variety,
                   (SELECT pd.grade_and_size_code
                    FROM product_details pd
                    WHERE pd.product_id = sci.product_id
                    ORDER BY pd.id ASC LIMIT 1) as grade_and_size_code
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

        const [moveRows] = await db.promise().query(`
            SELECT 
                sc.id AS container_id,
                dtcm.move,
                dtcm.category,
                dtcm.status,
                dtcm.date,
                dtcm.vehicle,
                dtcm.eir_no,
                dtcm.haulier,
                dtcm.terminal
            FROM dubai_trade_container_status dtcs
            INNER JOIN dubai_trade_container_moves dtcm ON dtcm.dubai_trade_status_id = dtcs.id
            INNER JOIN shipment_container sc ON sc.container_no = dtcs.container_no AND sc.shipment_id = dtcs.shipment_id
            WHERE sc.shipment_id = ?
            ORDER BY dtcm.date ASC
        `, [row.id]);

        const movesByContainer = moveRows.reduce((acc, move) => {
            const cid = Number(move.container_id);
            if (!acc[cid]) acc[cid] = [];
            acc[cid].push({
                move: move.move || null,
                category: move.category || null,
                status: move.status || null,
                date: move.date ? dayjs(move.date).toISOString() : null,
                vehicle: move.vehicle || null,
                eir_no: move.eir_no || null,
                haulier: move.haulier || null,
                terminal: move.terminal || null
            });
            return acc;
        }, {});

        const [containerReturns] = await db.promise().query(`
            SELECT scr.id, scr.container_id, scr.return_date, scr.to_town_date
            FROM shipment_container_return scr
            WHERE scr.container_id IN (?)
        `, [containerIds]);

        let returnFilesRows = [];
        if (containerReturns.length > 0) {
            const returnIds = containerReturns.map((row) => row.id);
            const [files] = await db.promise().query(`
                SELECT scrf.*
                FROM shipment_container_return_file scrf
                WHERE scrf.return_id IN (?)
            `, [returnIds]);
            returnFilesRows = files || [];
        }

        const returnByContainerId = containerReturns.reduce((acc, row) => {
            acc[row.container_id] = row;
            return acc;
        }, {});

        const returnFilesByReturnId = returnFilesRows.reduce((acc, file) => {
            if (!acc[file.return_id]) acc[file.return_id] = [];
            acc[file.return_id].push(file);
            return acc;
        }, {});

        containers.forEach(c => {
            c.items = itemsByContainer[c.id] || [];
            c.images = imagesByContainer[c.id] || [];
            const returnInfo = returnByContainerId[c.id];
            if (returnInfo) {
                c.return_details = {
                    id: returnInfo.id,
                    return_date: returnInfo.return_date,
                    to_town_date: returnInfo.to_town_date,
                    files: returnFilesByReturnId[returnInfo.id] || []
                };
            } else {
                c.return_details = null;
            }
            c.dubai_trade_moves = movesByContainer[c.id] || [];
        });
    }

    // Fetch common files for the shipment (from shipment_file table)
    const [shipmentFiles] = await db.promise().query(`
        SELECT sf.*, dt.name as document_type_name, dt.code as document_type_code, sf.is_draft
        FROM shipment_file sf
        JOIN document_type dt ON dt.id = sf.document_type_id
        WHERE sf.shipment_id = ?`, [row.id]);

    // Fetch files attached to the original Purchase Order (from purchase_order_attachments table)
    const [poAttachments] = await db.promise().query(`
        SELECT id, file_name, file_path, mime_type, size_bytes, created_at
        FROM purchase_order_attachments
        WHERE purchase_order_id = ?`, [row.po_id]);

    // Combine both sets of files into one `commonFiles` array for the frontend
    const allFiles = [...(shipmentFiles || []), ...(poAttachments || []).map(f => ({ ...f, document_type_code: 'po_document' }))];

    // Fetch additional products
    const [additionalProducts] = await db.promise().query(`
        SELECT sap.id, sap.product_id, p.product_name, p.hscode,
               (SELECT pi.file_path 
                FROM product_images pi 
                WHERE pi.product_id = sap.product_id 
                ORDER BY pi.is_primary DESC, pi.id ASC LIMIT 1) as image_url,
               (SELECT pd.variety
                FROM product_details pd
                WHERE pd.product_id = sap.product_id
                ORDER BY pd.id ASC LIMIT 1) as variety,
               (SELECT pd.grade_and_size_code
                FROM product_details pd
                WHERE pd.product_id = sap.product_id
                ORDER BY pd.id ASC LIMIT 1) as grade_and_size_code,
               (SELECT pd.packing_alias
                FROM product_details pd
                WHERE pd.product_id = sap.product_id
                ORDER BY pd.id ASC LIMIT 1) as packing_alias,
               (SELECT pd.packing_text
                FROM product_details pd
                WHERE pd.product_id = sap.product_id
                ORDER BY pd.id ASC LIMIT 1) as packing_text,
               (SELECT um.name
                FROM product_details pd
                LEFT JOIN uom_master um ON um.id = pd.uom_id
                WHERE pd.product_id = sap.product_id
                ORDER BY pd.id ASC LIMIT 1) as uom_name,
               (SELECT pd.uom_id
                FROM product_details pd
                WHERE pd.product_id = sap.product_id
                ORDER BY pd.id ASC LIMIT 1) as uom_id
        FROM shipment_additional_product sap
        LEFT JOIN products p ON p.id = sap.product_id
        WHERE sap.shipment_id = ?
        ORDER BY sap.id ASC
    `, [row.id]);

    res.json({ ...row, po_items: poItems || [], containers: containers || [], commonFiles: allFiles, po_documents: poDocuments || [], additional_products: additionalProducts || [] });
});

/* ---------- update planned details (from wizard edit) ---------- */
router.put("/:shipUniqid/planned-details", upload.none(), async (req, res) => {
    const { shipUniqid } = req.params;
    const userId = req.session?.user?.id;
    const userName = req.session?.user?.name || 'System';
    const connection = await db.promise().getConnection();

    try {
        await connection.beginTransaction();

        const {
            bl_description, free_time,
            discharge_port_local_charges, discharge_port_agent, freight_charges, freight_payment_terms, freight_amount_if_payable, freight_amount_currency_id, bl_type, po_documents,
            etd_date, vessel_name, shipping_line_name, departure_time, airline, flight_no, arrival_date, arrival_time, airway_bill_no, shipper, consignee, notify_party,
            has_additional_products, additional_products
        } = req.body;

        // Find the shipment
        const [[oldShipment]] = await connection.query(`SELECT * FROM shipment WHERE ship_uniqid = ? LIMIT 1`, [shipUniqid]);
        if (!oldShipment) return res.status(404).json(errPayload("Shipment not found."));

        // --- Compare old and new values to find changes ---
        const changes = {};
        const fieldsToCompare = {
            bl_description: 'BL Description', free_time: 'Free Time',
            discharge_port_local_charges: 'POD Local Charges', discharge_port_agent: 'POD Agent', freight_charges: 'Freight Charges',
            freight_payment_terms: 'Freight Terms', bl_type: 'BL Type', freight_amount_currency_id: 'Freight Currency',
            freight_amount_if_payable: 'Freight Amount', etd_date: 'ETD', vessel_name: 'Vessel Name',
            shipping_line_name: 'Shipping Line', departure_time: 'Departure Time', airline: 'Airline', flight_no: 'Flight No.',
            arrival_date: 'Arrival Date', arrival_time: 'Arrival Time', airway_bill_no: 'Airway Bill No.',
            shipper: 'Shipper', consignee: 'Consignee', notify_party: 'Notify Party'
        };

        const formatDateForHistory = (dateValue) => {
            if (!dateValue) return 'empty';
            return dayjs(dateValue).format('DD-MMM-YYYY');
        };

        const dateFields = new Set(['etd_date', 'arrival_date']);

        for (const key in fieldsToCompare) {
            const oldValue = oldShipment[key] || '';
            const newValue = req.body[key] || ''; // The date from the form is already YYYY-MM-DD
            if (String(oldValue) !== String(newValue)) {
                changes[fieldsToCompare[key]] = {
                    from: dateFields.has(key) ? formatDateForHistory(oldValue) : (oldValue || 'empty'),
                    to: dateFields.has(key) ? formatDateForHistory(newValue) : (newValue || 'empty')
                };
            }
        }

        await connection.query(
            `UPDATE shipment SET
                bl_description = ?, free_time = ?, discharge_port_local_charges = ?,
                discharge_port_agent = ?, freight_charges = ?, freight_payment_terms = ?, freight_amount_if_payable = ?, freight_amount_currency_id = ?, bl_type = ?,
                etd_date = ?, vessel_name = ?, shipping_line_name = ?, departure_time = ?, airline = ?, flight_no = ?, arrival_date = ?, arrival_time = ?, airway_bill_no = ?, shipper = ?, consignee = ?, notify_party = ?,
                updated_date = NOW()
            WHERE id = ?`,
            [
                bl_description || null,
                free_time || null,
                discharge_port_local_charges || null,
                discharge_port_agent || null,
                freight_charges || null,
                freight_payment_terms || null,
                freight_amount_if_payable || null,
                freight_amount_currency_id || null,
                bl_type || null,
                etd_date || null,
                vessel_name || null,
                shipping_line_name || null,
                (departure_time && departure_time.trim() !== '') ? departure_time : null,
                airline || null,
                flight_no || null,
                arrival_date || null,
                (arrival_time && arrival_time.trim() !== '') ? arrival_time : null,
                airway_bill_no || null,
                shipper || null,
                consignee || null,
                notify_party || null,
                oldShipment.id
            ]
        );

        // Handle PO Documents
        await connection.query('DELETE FROM shipment_po_document WHERE shipment_id = ?', [oldShipment.id]);
        const poDocumentsParsed = typeof po_documents === 'string' ? JSON.parse(po_documents) : po_documents;
        if (poDocumentsParsed && Array.isArray(poDocumentsParsed) && poDocumentsParsed.length > 0) {
            const poDocValues = poDocumentsParsed
                .filter(doc => doc.document_type_id && !isNaN(Number(doc.document_type_id)) && Number(doc.document_type_id) > 0)
                .map(doc => [oldShipment.id, doc.document_type_id, null]);

            if (poDocValues.length > 0) {
                await connection.query(
                    'INSERT INTO shipment_po_document (shipment_id, document_type_id, document_name) VALUES ?',
                    [poDocValues]
                );
            }
        }

        // Handle Additional Products
        await connection.query('DELETE FROM shipment_additional_product WHERE shipment_id = ?', [oldShipment.id]);
        if (has_additional_products === '1' || has_additional_products === 1) {
            const additionalProductsParsed = typeof additional_products === 'string' ? JSON.parse(additional_products) : additional_products;
            if (additionalProductsParsed && Array.isArray(additionalProductsParsed) && additionalProductsParsed.length > 0) {
                const productValues = additionalProductsParsed
                    .filter(prod => prod.product_id && !isNaN(Number(prod.product_id)) && Number(prod.product_id) > 0)
                    .map(prod => [oldShipment.id, Number(prod.product_id)]);

                if (productValues.length > 0) {
                    await connection.query(
                        'INSERT INTO shipment_additional_product (shipment_id, product_id) VALUES ?',
                        [productValues]
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
            details: { changes: changes, user: userName }
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

/* ---------- fetch purchase order allocations for a shipment ---------- */
router.get("/:shipUniqid/po-allocations", async (req, res) => {
    const { shipUniqid } = req.params;
    try {
        const [[shipment]] = await db.promise().query(
            `SELECT id, po_id FROM shipment WHERE ship_uniqid = ? LIMIT 1`,
            [shipUniqid]
        );
        if (!shipment) return res.status(404).json(errPayload("Shipment not found."));

        const [rows] = await db.promise().query(
            `SELECT
                a.id,
                a.po_item_id,
                a.product_id,
                a.po_id,
                a.planned_quantity,
                a.allocated_quantity,
                a.loaded_quantity,
                a.remaining_quantity,
                a.allocation_mode,
                i.item_name,
                i.quantity AS po_quantity
             FROM shipment_po_item_allocation a
             LEFT JOIN purchase_order_items i ON i.id = a.po_item_id
             WHERE a.shipment_id = ?`,
            [shipment.id]
        );

        res.json(rows || []);
    } catch (error) {
        res.status(500).json(errPayload("Failed to fetch product allocations.", "DB_ERROR", error.message));
    }
});

/* ---------- save purchase order allocations for an existing shipment ---------- */
router.post("/:shipUniqid/po-allocations", async (req, res) => {
    const { shipUniqid } = req.params;
    const { allocations: rawAllocations, allocation_mode, update_planned, update_allocated } = req.body || {};
    const userId = req.session?.user?.id || null;

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        const [[shipment]] = await conn.query(
            `SELECT id, po_id FROM shipment WHERE ship_uniqid = ? LIMIT 1`,
            [shipUniqid]
        );

        if (!shipment) {
            await conn.rollback();
            return res.status(404).json(errPayload("Shipment not found."));
        }

        let allocations = [];
        if (Array.isArray(rawAllocations)) {
            allocations = rawAllocations;
        } else if (typeof rawAllocations === 'string') {
            try {
                const parsed = JSON.parse(rawAllocations);
                if (Array.isArray(parsed)) allocations = parsed;
            } catch {
                allocations = [];
            }
        }

        const mode = allocation_mode === 'full' ? 'full' : 'partial';

        let shouldUpdatePlanned = Boolean(update_planned);
        let shouldUpdateAllocated = update_allocated === false || update_allocated === 'false' ? false : true;

        if (mode === 'full') {
            shouldUpdatePlanned = true;
            shouldUpdateAllocated = true;
        }

        if (mode === 'full' && allocations.length === 0) {
            const [poItems] = await conn.query(
                `SELECT id, item_id AS product_id, quantity
                 FROM purchase_order_items
                 WHERE purchase_order_id = ?`,
                [shipment.po_id]
            );
            if (poItems.length) {
                const ids = poItems.map(item => item.id);
                await ensureAllocationTable(conn);
                const [totals] = await conn.query(
                    `SELECT po_item_id, SUM(allocated_quantity) AS allocated
                     FROM shipment_po_item_allocation
                     WHERE po_item_id IN (?)
                     GROUP BY po_item_id`,
                    [ids]
                );
                const totalsMap = new Map(totals.map(row => [Number(row.po_item_id), toFiniteNumber(row.allocated)]));
                allocations = poItems
                    .map(item => {
                        const already = totalsMap.get(Number(item.id)) || 0;
                        const remaining = Math.max(toFiniteNumber(item.quantity) - already, 0);
                        if (remaining <= 0) return null;
                        return {
                            po_item_id: item.id,
                            product_id: item.product_id,
                            quantity: remaining
                        };
                    })
                    .filter(Boolean);
            }
        }

        await upsertShipmentPoAllocations(conn, {
            shipmentId: shipment.id,
            poId: shipment.po_id,
            allocations,
            allocationMode: mode,
            userId,
            updatePlannedQuantity: shouldUpdatePlanned,
            updateAllocatedQuantity: shouldUpdateAllocated
        });

        await conn.commit();
        res.json({ ok: true, allocation_count: allocations.length });
    } catch (error) {
        await conn.rollback();
        res.status(500).json(errPayload("Failed to save product allocations.", "DB_ERROR", error.message));
    } finally {
        conn.release();
    }
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
            [vessel_name, etd_date, eta_date, sailed_date, Number(is_transhipment) ? 1 : 0, sh.shipment_id]
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
        const isDryRun = req.body?.dry_run === true; // Check for dry run flag
        const userId = req.session?.user?.id ?? null;
        const userName = req.session?.user?.name ?? 'System';

        const [[row]] = await db.promise().query(
            `SELECT s.id AS shipment_id, s.po_id, s.shipment_stage_id,
             dpl.name as loading_name,dpd.name as discharge_name
         FROM shipment s JOIN purchase_orders po ON po.id = s.po_id -- Keep join for port names
         LEFT JOIN vendor v ON v.id=s.vendor_id
         LEFT JOIN delivery_place dpl ON dpl.id=po.port_loading
         LEFT JOIn delivery_place dpd ON dpd.id=po.port_discharge
        WHERE s.ship_uniqid = ? LIMIT 1`,
            [shipUniqid]
        );
        if (!row) return res.status(404).json({ error: { message: "Shipment not found" } });

        const fromStageId = Number(row.shipment_stage_id || 0);
        if (toStageId === fromStageId) {
            // If the user is trying to "move" to the same stage, it's an edit.
            // We just process field updates without changing the stage or logging a stage change.
            // The frontend will close the modal, so we just return success.
            return res.json({ ok: true, updated: { from_stage_id: fromStageId, message: "Details updated for the current stage." } });
        }
        // Disallow backwards
        if (toStageId < fromStageId) { return res.status(400).json({ error: { message: "Cannot move backwards" } }); }
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

        } else if (toStageId === 3) { // Sailed
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
            if (!isDryRun && !cleared_date) {
                return res.status(400).json(errPayload("Cleared Date is required"));
            }

            // Optional: ensure discharge was already set
            const [[prev]] = await db.promise().query(
                `SELECT discharge_date FROM shipment WHERE id=? LIMIT 1`,
                [row.shipment_id]
            );
            // Only check for discharge date if it's not a dry run.
            if (!isDryRun) {
                if (!prev?.discharge_date) {
                    return res.status(400).json(errPayload("Set Discharge Date (Stage 4) before Clearance"));
                }
            }

            // --- New Validation for Sailed Documents ---
            // Get all required document types from the PO and any added in the "Planned" stage.
            const [[po]] = await db.promise().query(
                `SELECT documents_payment_ids FROM purchase_orders WHERE id = ?`,
                [row.po_id]
            );
            const requiredDocIds = new Set(JSON.parse(po.documents_payment_ids || '[]').map(String));

            const [plannedDocs] = await db.promise().query(
                `SELECT document_type_id FROM shipment_po_document WHERE shipment_id = ?`,
                [row.shipment_id]
            );
            plannedDocs.forEach(doc => requiredDocIds.add(String(doc.document_type_id)));

            const [requiredDocTypes] = await db.promise().query(
                `SELECT id, name FROM document_type WHERE id IN (?)`,
                [[...requiredDocIds]]
            );

            // For each required document, check if at least one non-draft (original) version exists.
            const missingOriginals = [];
            for (const doc of requiredDocTypes) {
                const [[{ count }]] = await db.promise().query(
                    `SELECT COUNT(*) as count FROM shipment_file WHERE shipment_id = ? AND document_type_id = ? AND is_draft = 0`,
                    [row.shipment_id, doc.id]
                );
                if (count === 0) {
                    missingOriginals.push(doc.name);
                }
            }
            if (missingOriginals.length > 0) return res.status(400).json(errPayload(`Cannot clear shipment. Please upload the 'Original' version for the following documents: ${missingOriginals.join(', ')}`));

            // If this is a dry run, we've passed validation, so we can return success.
            if (isDryRun) {
                return res.json({ ok: true, message: "Dry run validation successful." });
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
        } else if (toStageId === 6) { // Returned
            const { eir_no, token_no, transportation_charges, returned_date } = fields;

            if (!eir_no) return res.status(400).json(errPayload("EIR No is required"));
            if (!token_no) return res.status(400).json(errPayload("Token No is required"));

            const charges = transportation_charges === 0 ? 0 : parseFloat(transportation_charges);
            if (Number.isNaN(charges) || charges < 0) {
                return res.status(400).json(errPayload("Transportation Charges must be a non-negative number"));
            }

            // Require all Stage-6 required docs (with ref_no & ref_date)
            const missing = await getMissingRequiredDocs(row.shipment_id, 6, { requireMeta: true });
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

        // update SHIPMENT stage
        await db.promise().query(`UPDATE shipment SET shipment_stage_id = ? WHERE id = ?`, [toStageId, row.shipment_id]);

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

        await recordStageHistory(db.promise(), {
            poId: row.po_id,
            shipmentId: row.shipment_id,
            fromStageId,
            toStageId,
            payload: fields
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
        const refNo = req.body.ref_no || null;
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
router.post("/create-from-po", upload.none(), async (req, res) => {
    const connection = await db.promise().getConnection();
    try {
        const userId = req.session?.user?.id;
        const userName = req.session?.user?.name || 'System';
        await connection.beginTransaction();

        const {
            po_id, // This is the purchase_order.id
            bl_description, free_time, discharge_port_local_charges, discharge_port_agent, freight_charges,
            freight_payment_terms, freight_amount_if_payable, freight_amount_currency_id, bl_type, po_documents,
            etd_date, vessel_name, shipping_line_name, departure_time, airline, flight_no, arrival_date, arrival_time, airway_bill_no,
            shipper, consignee, notify_party, has_additional_products, additional_products
        } = req.body;

        // Find the existing shipment record linked to the Purchase Order
        // The frontend sends shipment.id as po_id, so we find by shipment.id
        const [[shipment]] = await connection.query(
            `SELECT s.id, s.ship_uniqid, s.po_id FROM shipment s WHERE s.po_id = ? AND s.shipment_stage_id = 1`,
            [po_id]
        );

        if (!shipment) {
            return res.status(404).json(errPayload("Shipment not found or it is not in the 'To Do List' stage."));
        }

        // Fetch the original container counts from the PO
        const [[poDetails]] = await connection.query(
            `SELECT containers_back_to_back, containers_stock_sales, no_containers FROM purchase_orders WHERE id = ?`,
            [shipment.po_id]
        );

        if (!poDetails) {
            return res.status(404).json(errPayload("Associated Purchase Order not found."));
        }

        // Use the counts from the PO, not the request body
        const b2bCount = Number(poDetails.containers_back_to_back) || 0;
        const ssCount = Number(poDetails.containers_stock_sales) || 0;
        const totalContainers = Number(poDetails.no_containers) || 0;

        // UPDATE the existing shipment record with the details from the wizard
        await connection.query(
            `UPDATE shipment SET
                bl_description = ?, free_time = ?, discharge_port_local_charges = ?, discharge_port_agent = ?,
                freight_charges = ?, freight_payment_terms = ?, freight_amount_if_payable = ?, freight_amount_currency_id = ?, bl_type = ?,
                etd_date = ?, vessel_name = ?, shipping_line_name = ?, departure_time = ?, airline = ?, flight_no = ?, arrival_date = ?, arrival_time = ?, airway_bill_no = ?, shipper = ?, consignee = ?, notify_party = ?,
                containers_back_to_back = ?, containers_stock_sales = ?, no_containers = ?
            WHERE id = ?`,
            [
                bl_description || null, free_time || null, discharge_port_local_charges || null,
                discharge_port_agent || null, freight_charges || null, freight_payment_terms || null, freight_amount_if_payable || null, freight_amount_currency_id || null, bl_type || null,
                etd_date || null, vessel_name || null, shipping_line_name || null,
                (departure_time && departure_time.trim() !== '') ? departure_time : null,
                airline || null,
                flight_no || null,
                arrival_date || null,
                (arrival_time && arrival_time.trim() !== '') ? arrival_time : null,
                airway_bill_no || null,
                shipper || null, consignee || null, notify_party || null,
                b2bCount, ssCount, totalContainers, shipment.id
            ]
        );
        const shipmentId = shipment.id;

        // Handle PO Documents
        await connection.query('DELETE FROM shipment_po_document WHERE shipment_id = ?', [shipmentId]);
        const poDocumentsParsed = typeof po_documents === 'string' ? JSON.parse(po_documents) : po_documents;
        if (poDocumentsParsed && Array.isArray(poDocumentsParsed) && poDocumentsParsed.length > 0) {
            const poDocValues = poDocumentsParsed
                .filter(doc => doc.document_type_id && !isNaN(Number(doc.document_type_id)) && Number(doc.document_type_id) > 0)
                .map(doc => [shipmentId, doc.document_type_id, null]);

            if (poDocValues.length > 0) {
                await connection.query(
                    'INSERT INTO shipment_po_document (shipment_id, document_type_id, document_name) VALUES ?',
                    [poDocValues]
                );
            }
        }

        // Handle Additional Products
        await connection.query('DELETE FROM shipment_additional_product WHERE shipment_id = ?', [shipmentId]);
        if (has_additional_products === '1' || has_additional_products === 1) {
            const additionalProductsParsed = typeof additional_products === 'string' ? JSON.parse(additional_products) : additional_products;
            if (additionalProductsParsed && Array.isArray(additionalProductsParsed) && additionalProductsParsed.length > 0) {
                const productValues = additionalProductsParsed
                    .filter(prod => prod.product_id && !isNaN(Number(prod.product_id)) && Number(prod.product_id) > 0)
                    .map(prod => [shipmentId, Number(prod.product_id)]);

                if (productValues.length > 0) {
                    await connection.query(
                        'INSERT INTO shipment_additional_product (shipment_id, product_id) VALUES ?',
                        [productValues]
                    );
                }
            }
        }

        // Move SHIPMENT to Stage 2 (Planned)
        await connection.query(`UPDATE shipment SET shipment_stage_id = 2 WHERE id = ?`, [shipment.id]);

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

/* ---------- split a shipment (for partial shipment) and move to underloading ---------- */
router.post("/:shipUniqid/split-shipment", async (req, res) => {
    const { shipUniqid } = req.params;
    const { b2b_containers, ss_containers, product_allocations } = req.body;
    const userId = req.session?.user?.id;
    const userName = req.session?.user?.name || 'System';

    const b2bCount = Number(b2b_containers) || 0;
    const ssCount = Number(ss_containers) || 0;
    const totalMoving = b2bCount + ssCount;

    if (totalMoving <= 0) {
        return res.status(400).json(errPayload("At least one container must be moved."));
    }

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        // 1. Get original shipment and PO details
        const [[originalShipment]] = await conn.query(
            `SELECT s.*, po.po_number, s.shipment_stage_id
             FROM shipment s 
             JOIN purchase_orders po ON s.po_id = po.id 
             WHERE s.ship_uniqid = ?`,
            [shipUniqid]
        );

        if (!originalShipment) return res.status(404).json(errPayload("Original shipment not found."));

        if (b2bCount > originalShipment.containers_back_to_back || ssCount > originalShipment.containers_stock_sales) {
            return res.status(400).json(errPayload("Cannot move more containers than are available."));
        }

        // --- Lot Number Logic ---
        // 1. Find the root shipment (the ultimate ancestor)
        let rootShipmentId = originalShipment.id;
        let current = originalShipment;
        while (current.parent_shipment_id) {
            const [[parent]] = await conn.query(`SELECT id, parent_shipment_id FROM shipment WHERE id = ?`, [current.parent_shipment_id]);
            if (!parent) break;
            rootShipmentId = parent.id;
            current = parent;
        }

        // 2. Count lots already moved to Underloading or beyond to determine the next lot number in the queue.
        const [[{ count }]] = await conn.query(
            `SELECT COUNT(*) as count FROM shipment WHERE (id = ? OR parent_shipment_id = ?) AND shipment_stage_id >= 3`,
            [rootShipmentId, rootShipmentId]
        );
        const newLotNumber = count + 1;

        // 2. Create the new shipment record for the partial shipment
        const newShipUniqid = crypto.randomBytes(8).toString('hex');
        const [shipResult] = await conn.query(
            `INSERT INTO shipment (
                po_id, ship_uniqid, vendor_id, shipment_stage_id,
                containers_back_to_back, containers_stock_sales, no_containers, lot_number, total_lots,
                created_by, parent_shipment_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                originalShipment.po_id, newShipUniqid, originalShipment.vendor_id, 3, // New shipment starts at Stage 3 (Underloading)
                b2bCount, ssCount, totalMoving, newLotNumber, 1, // Default total_lots to 1, will be updated by recalculate
                userId, originalShipment.id
            ]
        );

        const newShipmentId = shipResult.insertId;

        // 3. Copy planned details from the original shipment
        await conn.query(
            `UPDATE shipment SET shipper = ?, consignee = ?, notify_party = ?, bl_description = ?, free_time = ?, bl_type = ?, freight_payment_terms = ?, freight_amount_if_payable = ?, freight_amount_currency_id = ?, etd_date = ?, vessel_name = ?, shipping_line_name = ?, departure_time = ?, airline = ?, flight_no = ?, arrival_date = ?, arrival_time = ? WHERE id = ?`,
            [
                originalShipment.shipper,
                originalShipment.consignee,
                originalShipment.notify_party,
                originalShipment.bl_description,
                originalShipment.free_time,
                originalShipment.bl_type,
                originalShipment.freight_payment_terms,
                originalShipment.freight_amount_if_payable,
                originalShipment.freight_amount_currency_id,
                originalShipment.etd_date,
                originalShipment.vessel_name,
                originalShipment.shipping_line_name,
                originalShipment.departure_time,
                originalShipment.airline,
                originalShipment.flight_no,
                originalShipment.arrival_date,
                originalShipment.arrival_time,
                newShipmentId
            ]
        );

        // 4. Copy existing shipment_po_document entries to the new shipment
        const [existingPoDocuments] = await conn.query(
            `SELECT document_type_id FROM shipment_po_document WHERE shipment_id = ?`,
            [originalShipment.id]
        );

        for (const doc of existingPoDocuments) {
            await conn.query(
                `INSERT INTO shipment_po_document (shipment_id, document_type_id) VALUES (?, ?)`,
                [newShipmentId, doc.document_type_id]
            );
        }

        // --- Trigger recalculation of lot numbers and total_lots for the entire family ---
        // This ensures total_lots is accurate for all family members after a split.
        await recalculateLotNumbersInternal(conn, originalShipment.id, userId, userName);

        // 3. Update the original SHIPMENT with remaining container counts
        await conn.query(
            `UPDATE shipment SET containers_back_to_back = containers_back_to_back - ?, containers_stock_sales = containers_stock_sales - ?, no_containers = no_containers - ? WHERE id = ?`,
            [b2bCount, ssCount, totalMoving, originalShipment.id]
        );

        const normalizedAllocations = Array.isArray(product_allocations)
            ? product_allocations
            : (typeof product_allocations === 'string'
                ? (() => { try { const parsed = JSON.parse(product_allocations); return Array.isArray(parsed) ? parsed : []; } catch { return []; } })()
                : []);

        if (normalizedAllocations.length > 0) {
            await upsertShipmentPoAllocations(conn, {
                shipmentId: newShipmentId,
                poId: originalShipment.po_id,
                allocations: normalizedAllocations,
                allocationMode: 'partial',
                userId,
                updatePlannedQuantity: true,
                updateAllocatedQuantity: true
            });
        }

        // 5. Add history log for the split action
        await addHistory(conn, {
            module: 'shipment',
            moduleId: originalShipment.id,
            userId: userId,
            action: 'SHIPMENT_SPLIT',
            details: {
                user: userName,
                original_po: originalShipment.po_number,
                new_shipment_id: newShipmentId,
                moved_b2b: b2bCount,
                moved_ss: ssCount
            }
        });

        // Also add a creation log for the new shipment
        await addHistory(conn, {
            module: 'shipment',
            moduleId: newShipmentId,
            userId: userId,
            action: 'SHIPMENT_CREATED_FROM_SPLIT',
            details: { user: userName, source_po: originalShipment.po_number }
        });

        await conn.commit();
        res.json({ ok: true, newShipUniqid: newShipUniqid, newShipmentId: newShipmentId });
    } catch (e) {
        await conn.rollback();

        res.status(500).json(errPayload("Failed to split shipment.", "DB_ERROR", e.message));
    } finally {
        conn.release();
    }
});

/* ---------- save underloading details (SEA) and move to stage 3 ---------- */
router.post("/:shipUniqid/underloading-sea", upload.any(), async (req, res) => {
    const { shipUniqid } = req.params;
    const { etd_date, vessel_name, eta_date } = req.body;
    const keptCommonImagesJson = req.body.keptCommonImages || '[]'; // Safely get kept images
    const containers = JSON.parse(req.body.containers || '[]');
    const rawAllocations = req.body.po_allocations;
    let incomingAllocations = [];
    if (rawAllocations) {
        try {
            incomingAllocations = Array.isArray(rawAllocations) ? rawAllocations : JSON.parse(rawAllocations);
        } catch {
            incomingAllocations = [];
        }
    }
    const isEditing = req.body.is_editing === 'true';
    const files = req.files || [];
    const userId = req.session?.user?.id;
    const userName = req.session?.user?.name || 'System';

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        const [[shipment]] = await conn.query(`SELECT id, po_id, shipment_stage_id FROM shipment WHERE ship_uniqid = ?`, [shipUniqid]);
        if (!shipment) throw new Error("Shipment not found.");

        // Update common shipment details
        await conn.query(
            `UPDATE shipment SET etd_date = ?, vessel_name = ?, eta_date = ? WHERE id = ?`,
            [etd_date || null, vessel_name || null, eta_date || null, shipment.id]
        );

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
                const isImage = file.mimetype && file.mimetype.startsWith('image/');
                const isVideo = file.mimetype && file.mimetype.startsWith('video/');
                let thumbPath = null;

                if (isImage) {
                    // Generate thumbnail for images only
                    const thumbName = `thumb_${path.basename(file.path)}`;
                    const thumbDiskPath = path.join(THUMB_DIR, thumbName);
                    await sharp(file.path).resize(200, 200, { fit: 'inside', withoutEnlargement: true }).toFile(thumbDiskPath);
                    thumbPath = path.posix.join("uploads", "shipment", "thumbnail", thumbName);
                } else if (isVideo) {
                    // For videos, use the video file itself as thumbnail (or null)
                    thumbPath = null;
                }

                const originalPath = path.posix.join("uploads", "shipment", path.basename(file.path));
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
                    `UPDATE shipment_container SET container_no = ?, seal_no = ?, pickup_date = ? WHERE id = ?`, //
                    [container.container_no, container.seal_no || null, (container.pickup_date && container.pickup_date.trim() !== '') ? container.pickup_date : null, containerId] //
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
                    `INSERT INTO shipment_container (shipment_id, container_no, seal_no, pickup_date) VALUES (?, ?, ?, ?)`, //
                    [shipment.id, container.container_no, container.seal_no || null, (container.pickup_date && container.pickup_date.trim() !== '') ? container.pickup_date : null] //
                );
                containerId = containerResult.insertId;
            }

            // Save container-specific images
            const containerImages = files.filter(f => f.fieldname === `container_images_${container.id}`);
            for (const file of containerImages) {
                const isImage = file.mimetype && file.mimetype.startsWith('image/');
                const isVideo = file.mimetype && file.mimetype.startsWith('video/');
                let thumbPath = null;

                if (isImage) {
                    // Generate thumbnail for images only
                    const thumbName = `thumb_${path.basename(file.path)}`;
                    const thumbDiskPath = path.join(THUMB_DIR, thumbName);
                    await sharp(file.path)
                        .resize(200, 200, { fit: 'inside', withoutEnlargement: true })
                        .toFile(thumbDiskPath);
                    thumbPath = path.posix.join("uploads", "shipment", "thumbnail", thumbName);
                } else if (isVideo) {
                    // For videos, use null for thumbnail (or could use video file itself)
                    thumbPath = null;
                }

                const originalPath = path.posix.join("uploads", "shipment", path.basename(file.path));
                await conn.query(
                    `INSERT INTO shipment_container_file (container_id, file_name, file_path, thumbnail_path, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?, ?)`,
                    [containerId, file.originalname, originalPath, thumbPath, file.mimetype, file.size]
                );
            }


            const itemValues = (container.items || []).map(it => {
                // Destructure to include product_id and exclude product_option
                const { product_id, product_name, package_type, package_count, net_weight, gross_weight, hscode } = it;
                const normalizedProductId = (product_id === undefined || product_id === null || product_id === '') ? null : Number(product_id);
                return [containerId, normalizedProductId, product_name, package_type, package_count, net_weight, gross_weight, hscode];
            });

            if (itemValues.length > 0) {
                await conn.query(
                    `INSERT INTO shipment_container_item (container_id, product_id, product_name, package_type, package_count, net_weight, gross_weight, hscode) VALUES ?`,
                    [itemValues]
                );
            }
        }

        if (incomingAllocations.length > 0 && shipment.po_id) {
            const sanitizedAllocations = incomingAllocations
                .map(a => ({
                    po_item_id: Number(a.po_item_id) || 0,
                    product_id: (a.product_id === undefined || a.product_id === null || a.product_id === '') ? null : Number(a.product_id),
                    quantity: toFiniteNumber(a.quantity)
                }))
                .filter(a => a.po_item_id);
            if (sanitizedAllocations.length > 0) {
                await upsertShipmentPoAllocations(conn, {
                    shipmentId: shipment.id,
                    poId: shipment.po_id,
                    allocations: sanitizedAllocations,
                    allocationMode: 'partial',
                    userId,
                    skipAvailabilityCheck: true,
                    updatePlannedQuantity: false,
                    updateAllocatedQuantity: false,
                    updateLoadedQuantity: true
                });
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

            // --- Lot Number Logic for Last Lot ---
            // If this is the last part of a split being moved, it needs its lot number assigned.
            if (shipment.parent_shipment_id || shipment.lot_number > 1) {
                let rootShipmentId = shipment.parent_shipment_id || shipment.id;
                let current = shipment;
                // Find the ultimate ancestor
                while (current.parent_shipment_id) {
                    const [[parent]] = await conn.query(`SELECT id, parent_shipment_id FROM shipment WHERE id = ?`, [current.parent_shipment_id]);
                    if (!parent) break;
                    rootShipmentId = parent.id;
                    current = parent;
                }
                // Count lots already in Underloading or beyond to determine this lot's number
                const [[{ count }]] = await conn.query(
                    `SELECT COUNT(*) as count FROM shipment WHERE (id = ? OR parent_shipment_id = ?) AND shipment_stage_id >= 3`,
                    [rootShipmentId, rootShipmentId]
                );
                const thisLotNumber = count + 1;
                await conn.query(`UPDATE shipment SET lot_number = ? WHERE id = ?`, [thisLotNumber, shipment.id]);
            }

            await conn.query(`UPDATE shipment SET shipment_stage_id = 3 WHERE id = ?`, [shipment.id]);
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

            await recordStageHistory(conn, {
                poId: shipment.po_id,
                shipmentId: shipment.id,
                fromStageId: shipment.shipment_stage_id,
                toStageId: 3,
                payload: {
                    source: 'underloading-sea',
                    etd_date: etd_date || null,
                    eta_date: eta_date || null,
                    vessel_name: vessel_name || null,
                    container_count: containers.length
                }
            });
        }

        await conn.commit();

        const movedFromStageId = Number(shipment.shipment_stage_id);
        const toStageId = movedFromStageId === 2 ? 3 : movedFromStageId;

        res.json({
            ok: true,
            shipUniqid,
            toStageId,
            transitioned: movedFromStageId === 2,
            updated: {
                from_stage_id: movedFromStageId,
                etd_date: (etd_date && etd_date.trim() !== '') ? etd_date : null,
                vessel_name: vessel_name || null,
                eta_date: (eta_date && eta_date.trim() !== '') ? eta_date : null,
                mode_shipment_id: 1
            }
        });
    } catch (e) {
        await conn.rollback();
        res.status(500).json(errPayload("Failed to save sea underloading details", "DB_ERROR", e.message));
    } finally {
        conn.release();
    }
});

/* ---------- save underloading details (AIR) and move to stage 3 ---------- */
router.post("/:shipUniqid/underloading-air", upload.any(), async (req, res) => {
    const { shipUniqid } = req.params;
    const airway_bill_no = req.body.airway_bill_no ?? req.body.airwayBillNo ?? req.body.airwayBill_no ?? null;
    const flight_no = req.body.flight_no ?? req.body.flightNo ?? null;
    const airline = req.body.airline ?? req.body.confirm_airline ?? req.body.confirmAirline ?? null;
    const arrival_date = req.body.arrival_date ?? req.body.arrivalDate ?? null;
    const arrival_time = req.body.arrival_time ?? req.body.arrivalTime ?? null;
    const departure_date = req.body.departure_date ?? req.body.departureDate ?? req.body.etd_date ?? null;
    const departure_time = req.body.departure_time ?? req.body.departureTime ?? req.body.confirm_departure_time ?? null;
    const pickup_date = req.body.pickup_date ?? req.body.pickupDate ?? null;
    const keptCommonImagesJson = req.body.keptCommonImages;
    const itemsJson = req.body.items;
    const isEditing = req.body.is_editing === 'true';
    const items = JSON.parse(itemsJson || '[]');
    const rawAllocations = req.body.po_allocations;
    let incomingAllocations = [];
    if (rawAllocations) {
        try {
            incomingAllocations = Array.isArray(rawAllocations) ? rawAllocations : JSON.parse(rawAllocations);
        } catch {
            incomingAllocations = [];
        }
    }
    const files = req.files || [];
    const userId = req.session?.user?.id;
    const userName = req.session?.user?.name || 'System';

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        const [[shipment]] = await conn.query(`SELECT id, po_id, airway_bill_no, flight_no, airline, arrival_date, arrival_time, shipment_stage_id FROM shipment WHERE ship_uniqid = ?`, [shipUniqid]);
        if (!shipment) throw new Error("Shipment not found.");

        // Update shipment with Airway Bill and Flight No
        const normalizedDepartureDate = departure_date || req.body.etd_date || null;
        const normalizedDepartureTime = (departure_time && departure_time.trim() !== '') ? departure_time : null;

        await conn.query(
            `UPDATE shipment SET airway_bill_no = ?, flight_no = ?, airline = ?, arrival_date = ?, arrival_time = ?, etd_date = ?, departure_time = ? WHERE id = ?`,
            [
                airway_bill_no,
                flight_no,
                airline || null,
                arrival_date || null,
                (arrival_time && arrival_time.trim() !== '') ? arrival_time : null,
                normalizedDepartureDate || null,
                normalizedDepartureTime,
                shipment.id
            ]
        ); //

        // For Air, we create/update a single "dummy" container to hold the items, reusing the sea-freight tables.
        const [[existingContainer]] = await conn.query(`SELECT id FROM shipment_container WHERE shipment_id = ? LIMIT 1`, [shipment.id]);
        let containerId;
        if (existingContainer) {
            containerId = existingContainer.id;
            await conn.query(`UPDATE shipment_container SET container_no = ?, seal_no = ?, pickup_date = ? WHERE id = ?`, [airway_bill_no, flight_no, (pickup_date && pickup_date.trim() !== '') ? pickup_date : null, containerId]);
            await conn.query(`DELETE FROM shipment_container_item WHERE container_id = ?`, [containerId]); // Clear old items
        } else {
            const [cResult] = await conn.query(`INSERT INTO shipment_container (shipment_id, container_no, seal_no) VALUES (?, ?, ?)`, [shipment.id, airway_bill_no, flight_no]);
            containerId = cResult.insertId;
        }

        // Insert items for the air shipment's container
        if (items.length > 0) {
            const itemValues = items.map(it => {
                const normalizedProductId = (it.product_id === undefined || it.product_id === null || it.product_id === '') ? null : Number(it.product_id);
                return [containerId, normalizedProductId, it.product_name, it.package_type, it.package_count, it.net_weight, it.gross_weight, it.hscode];
            });
            await conn.query(`INSERT INTO shipment_container_item (container_id, product_id, product_name, package_type, package_count, net_weight, gross_weight, hscode) VALUES ?`, [itemValues]);
        }

        if (incomingAllocations.length > 0 && shipment.po_id) {
            const sanitizedAllocations = incomingAllocations
                .map(a => ({
                    po_item_id: Number(a.po_item_id) || 0,
                    product_id: (a.product_id === undefined || a.product_id === null || a.product_id === '') ? null : Number(a.product_id),
                    quantity: toFiniteNumber(a.quantity)
                }))
                .filter(a => a.po_item_id);
            if (sanitizedAllocations.length > 0) {
                await upsertShipmentPoAllocations(conn, {
                    shipmentId: shipment.id,
                    poId: shipment.po_id,
                    allocations: sanitizedAllocations,
                    allocationMode: 'partial',
                    userId,
                    skipAvailabilityCheck: true,
                    updatePlannedQuantity: false,
                    updateAllocatedQuantity: false,
                    updateLoadedQuantity: true
                });
            }
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
                const isImage = file.mimetype && file.mimetype.startsWith('image/');
                const isVideo = file.mimetype && file.mimetype.startsWith('video/');
                let thumbPath = null;

                if (isImage) {
                    // Generate thumbnail for images only
                    const thumbName = `thumb_${path.basename(file.path)}`;
                    const thumbDiskPath = path.join(THUMB_DIR, thumbName);
                    await sharp(file.path).resize(200, 200, { fit: 'inside', withoutEnlargement: true }).toFile(thumbDiskPath);
                    thumbPath = path.posix.join("uploads", "shipment", "thumbnail", thumbName);
                } else if (isVideo) {
                    // For videos, use null for thumbnail
                    thumbPath = null;
                }

                const originalPath = path.posix.join("uploads", "shipment", path.basename(file.path));
                await conn.query(
                    `INSERT INTO shipment_file (shipment_id, document_type_id, file_name, file_path, thumbnail_path, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [shipment.id, commonDocType.id, file.originalname, originalPath, thumbPath, file.mimetype, file.size]
                );
            }
        }

        const normalizeDate = (value) => {
            if (!value) return '';
            const parsed = dayjs(value);
            if (!parsed.isValid()) return String(value);
            return parsed.format('YYYY-MM-DD');
        };

        const normalizeTime = (value) => {
            if (!value) return '';
            const raw = String(value).trim();
            if (!raw) return '';
            const formats = ['HH:mm:ss.SSSSSS', 'HH:mm:ss', 'HH:mm'];
            for (const fmt of formats) {
                const parsed = dayjs(raw, fmt, true);
                if (parsed.isValid()) return parsed.format('HH:mm');
            }
            const fallback = dayjs(raw);
            return fallback.isValid() ? fallback.format('HH:mm') : raw;
        };

        if (isEditing) {
            // We are editing, so just log the specific changes.
            const changes = [];
            if (shipment.airway_bill_no !== airway_bill_no) changes.push(`Airway Bill changed from '${shipment.airway_bill_no || ''}' to '${airway_bill_no}'`);
            if (shipment.flight_no !== flight_no) changes.push(`Flight No changed from '${shipment.flight_no || ''}' to '${flight_no}'`);
            if (shipment.airline !== airline) changes.push(`Airline changed from '${shipment.airline || ''}' to '${airline}'`);

            const existingArrivalDate = normalizeDate(shipment.arrival_date);
            const incomingArrivalDate = normalizeDate(arrival_date);
            if (existingArrivalDate !== incomingArrivalDate) changes.push(`Arrival Date changed`);

            const existingArrivalTime = normalizeTime(shipment.arrival_time);
            const incomingArrivalTime = normalizeTime(arrival_time);
            if (existingArrivalTime !== incomingArrivalTime) changes.push(`Arrival Time changed`);

            const existingDepartureDate = normalizeDate(shipment.etd_date);
            const incomingDepartureDate = normalizeDate(normalizedDepartureDate);
            //if (existingDepartureDate !== incomingDepartureDate) changes.push(`Departure Date changed`);

            const existingDepartureTime = normalizeTime(shipment.departure_time);
            const incomingDepartureTime = normalizeTime(normalizedDepartureTime);
            //if (existingDepartureTime !== incomingDepartureTime) changes.push(`Departure Time changed`);
            // You could add item change detection here if needed in the future.

            if (changes.length > 0) {
                await addHistory(conn, {
                    module: 'shipment', moduleId: shipment.id, userId: userId,
                    action: 'UNDERLOADING_DETAILS_UPDATED',
                    details: { changes: changes.join('; ') }
                });
            }
        } else {
            // This is a new entry, so move the stage and log the stage change.

            // --- Lot Number Logic for Last Lot (Air) ---
            if (shipment.parent_shipment_id || shipment.lot_number > 1) {
                let rootShipmentId = shipment.parent_shipment_id || shipment.id;
                let current = shipment;
                while (current.parent_shipment_id) {
                    const [[parent]] = await conn.query(`SELECT id, parent_shipment_id FROM shipment WHERE id = ?`, [current.parent_shipment_id]);
                    if (!parent) break;
                    rootShipmentId = parent.id;
                    current = parent;
                }
                const [[{ count }]] = await conn.query(
                    `SELECT COUNT(*) as count FROM shipment WHERE (id = ? OR parent_shipment_id = ?) AND shipment_stage_id >= 3`,
                    [rootShipmentId, rootShipmentId]
                );
                const thisLotNumber = count + 1;
                await conn.query(`UPDATE shipment SET lot_number = ? WHERE id = ?`, [thisLotNumber, shipment.id]);
            }

            await conn.query(`UPDATE shipment SET shipment_stage_id = 3 WHERE id = ?`, [shipment.id]);
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

            await recordStageHistory(conn, {
                poId: shipment.po_id,
                shipmentId: shipment.id,
                fromStageId: shipment.shipment_stage_id,
                toStageId: 3,
                payload: {
                    source: 'underloading-air',
                    airway_bill_no,
                    flight_no,
                    airline,
                    arrival_date,
                    arrival_time
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

router.get("/:shipUniqid/logger-details", async (req, res) => {
    const { shipUniqid } = req.params;
    try {
        const [[shipment]] = await db.promise().query(
            'SELECT id, supplier_logger_installed, logger_count FROM shipment WHERE ship_uniqid = ?',
            [shipUniqid]
        );
        if (!shipment) {
            return res.status(404).json(errPayload("Shipment not found."));
        }
        const [rows] = await db.promise().query(
            'SELECT serial_no, installation_place FROM shipment_temperature_loggers WHERE shipment_id = ? ORDER BY id ASC',
            [shipment.id]
        );
        res.json({
            success: true,
            supplier_logger_installed: shipment.supplier_logger_installed,
            logger_count: shipment.logger_count,
            loggers: rows || []
        });
    } catch (e) {
        res.status(500).json(errPayload("Failed to load logger details", "DB_ERROR", e.message));
    }
});

/* ---------- move to sailed (4) with confirmed details and docs ---------- */
router.post("/:shipUniqid/sail", upload.any(), async (req, res) => {
    const { shipUniqid } = req.params;
    const userId = req.session?.user?.id;
    const userName = req.session?.user?.name || 'System';
    const conn = await db.promise().getConnection();

    try {
        await conn.beginTransaction();

        const {
            confirm_sailing_date, confirm_departure_time, confirm_vessel_name, confirm_eta_date, bl_no, confirm_shipping_line, confirm_discharge_port_agent,
            confirm_airway_bill_no, confirm_flight_no, confirm_airline, confirm_arrival_date, confirm_arrival_time,
            confirm_free_time,
            // New: linked AP purchase bill (ap_bills.id)
            purchase_bill_id,
            supplier_logger_installed,
            logger_count,
            loggers,
            is_mofa_required, original_doc_receipt_mode, doc_receipt_person_name, doc_receipt_person_contact,
            doc_receipt_courier_no, doc_receipt_courier_company, doc_receipt_tracking_link,
            documents_meta,
            is_editing // New flag from the frontend
        } = req.body;


        const [[shipment]] = await conn.query(`SELECT id, po_id, shipment_stage_id FROM shipment WHERE ship_uniqid = ?`, [shipUniqid]);
        if (!shipment) {
            throw new Error("Shipment not found.");
        }

        const [[po]] = await conn.query(`SELECT mode_shipment_id FROM purchase_orders WHERE id = ?`, [shipment.po_id]);
        const isAir = String(po.mode_shipment_id) === '2';

        // If we are NOT editing, the shipment must be in stage 3 (Underloading) to proceed.
        if (!is_editing && shipment.shipment_stage_id !== 3) {
            return res.status(400).json(errPayload("Shipment must be in the 'Underloading' stage to confirm sailed details."));
        }

        // --- 1. Validate Input ---
        if (isAir) {
            if (!confirm_sailing_date || !confirm_departure_time || !confirm_airway_bill_no || !confirm_flight_no || !confirm_airline || !confirm_arrival_date || !confirm_arrival_time) {
                return res.status(400).json(errPayload("Departure Date, Departure Time, AWB No, Flight No, Airline, Arrival Date, and Arrival Time are required for Air shipments."));
            }
        } else {
            if (!confirm_sailing_date || !confirm_vessel_name || !confirm_eta_date || !bl_no || !confirm_shipping_line || !confirm_discharge_port_agent) {
                return res.status(400).json(errPayload("Sailing Date, Vessel Name, ETA, BL No, Shipping Line, and POD Agent are required for Sea shipments."));
            }
        }

        // Validate courier details if mode is 'courier'
        if (original_doc_receipt_mode === 'courier' && (!doc_receipt_courier_no || !doc_receipt_courier_company)) {
            return res.status(400).json(errPayload("Courier No. and Courier Company are required when receipt mode is 'Courier'."));
        }

        const loggerInstalled = String(supplier_logger_installed || '').trim().toUpperCase();
        let loggerCountNum = Number(logger_count || 0);
        let loggerRows = [];
        if (loggers) {
            try {
                loggerRows = typeof loggers === 'string' ? JSON.parse(loggers) : loggers;
            } catch {
                return res.status(400).json(errPayload("Invalid logger rows payload."));
            }
        }
        if (loggerInstalled && loggerInstalled !== 'YES' && loggerInstalled !== 'NO') {
            return res.status(400).json(errPayload("Supplier logger installed must be YES or NO."));
        }
        if (!loggerInstalled) {
            return res.status(400).json(errPayload("Supplier logger installed is required."));
        }
        if (loggerInstalled === 'YES') {
            if (!Number.isFinite(loggerCountNum) || loggerCountNum < 1) {
                return res.status(400).json(errPayload("Logger count must be greater than 0."));
            }
            if (loggerCountNum > 20) {
                return res.status(400).json(errPayload("Logger count cannot exceed 20."));
            }
            if (!Array.isArray(loggerRows) || loggerRows.length !== loggerCountNum) {
                return res.status(400).json(errPayload("Logger rows must match logger count."));
            }
            for (let i = 0; i < loggerRows.length; i += 1) {
                const row = loggerRows[i] || {};
                if (!String(row.serial_no || '').trim()) {
                    return res.status(400).json(errPayload(`Serial No. is required at row ${i + 1}.`));
                }
                if (!String(row.installation_place || '').trim()) {
                    return res.status(400).json(errPayload(`Installation Place is required at row ${i + 1}.`));
                }
            }
        } else if (loggerInstalled === 'NO') {
            loggerCountNum = 0;
            loggerRows = [];
        }

        // --- 2. Fetch old values for history comparison ---
        const [[oldShipmentDetails]] = await conn.query(
            `SELECT sailing_date, etd_date, vessel_name, confirm_vessel_name, eta_date, bl_no,shipping_line_name, confirm_shipping_line, confirm_discharge_port_agent,
                    airway_bill_no, flight_no, airline, confirm_airway_bill_no, confirm_flight_no, confirm_airline,
                    arrival_date, arrival_time, confirm_arrival_date, confirm_arrival_time,
                    departure_time, confirm_departure_time,
                    free_time, confirm_free_time,
                    is_mofa_required, original_doc_receipt_mode, doc_receipt_person_name, doc_receipt_person_contact,
                    doc_receipt_courier_no, doc_receipt_courier_company, doc_receipt_tracking_link FROM shipment WHERE id = ?`,
            [shipment.id]
        );

        const changes = {};
        const formatDateForHistory = (dateValue) => dateValue ? dayjs(dateValue).format('DD-MMM-YYYY') : 'empty';

        // Compare Sailing Date (ETD)
        if (isAir) {
            if (formatDateForHistory(oldShipmentDetails.sailing_date) !== formatDateForHistory(confirm_sailing_date)) {
                changes['Departure Date'] = { from: formatDateForHistory(oldShipmentDetails.sailing_date), to: formatDateForHistory(confirm_sailing_date) };
            }
            if ((oldShipmentDetails.confirm_departure_time || '').trim() !== (confirm_departure_time || '').trim()) {
                changes['Departure Time'] = { from: oldShipmentDetails.confirm_departure_time || 'empty', to: confirm_departure_time || 'empty' };
            }
            if (oldShipmentDetails.confirm_airway_bill_no !== confirm_airway_bill_no) {
                changes['AWB No.'] = { from: oldShipmentDetails.confirm_airway_bill_no || 'empty', to: confirm_airway_bill_no };
            }
            if (oldShipmentDetails.confirm_flight_no !== confirm_flight_no) {
                changes['Flight No.'] = { from: oldShipmentDetails.confirm_flight_no || 'empty', to: confirm_flight_no };
            }
            if (oldShipmentDetails.confirm_airline !== confirm_airline) {
                changes['Airline'] = { from: oldShipmentDetails.confirm_airline || 'empty', to: confirm_airline };
            }
            if (formatDateForHistory(oldShipmentDetails.confirm_arrival_date) !== formatDateForHistory(confirm_arrival_date)) {
                changes['Arrival Date'] = { from: formatDateForHistory(oldShipmentDetails.confirm_arrival_date), to: formatDateForHistory(confirm_arrival_date) };
            }
            if (oldShipmentDetails.confirm_arrival_time !== confirm_arrival_time) {
                changes['Arrival Time'] = { from: oldShipmentDetails.confirm_arrival_time || 'empty', to: confirm_arrival_time };
            }
        } else {
            if (formatDateForHistory(oldShipmentDetails.sailing_date) !== formatDateForHistory(confirm_sailing_date)) {
                changes['Sailing Date'] = { from: formatDateForHistory(oldShipmentDetails.sailing_date), to: formatDateForHistory(confirm_sailing_date) };
            }
            if (oldShipmentDetails.vessel_name !== confirm_vessel_name) {
                changes['Confirmed Vessel Name'] = { from: oldShipmentDetails.vessel_name || 'empty', to: confirm_vessel_name || 'empty' };
            }
            if (formatDateForHistory(oldShipmentDetails.eta_date) !== formatDateForHistory(confirm_eta_date)) {
                changes['Discharge Port ETA'] = { from: formatDateForHistory(oldShipmentDetails.eta_date), to: formatDateForHistory(confirm_eta_date) };
            }
            if (oldShipmentDetails.bl_no !== bl_no) {
                changes['BL No.'] = { from: oldShipmentDetails.bl_no || 'empty', to: bl_no };
            }
            if (oldShipmentDetails.confirm_shipping_line !== confirm_shipping_line) {
                changes['Confirm Shipping Line'] = { from: oldShipmentDetails.confirm_shipping_line || 'empty', to: confirm_shipping_line };
            }
            if (oldShipmentDetails.confirm_discharge_port_agent !== confirm_discharge_port_agent) {
                changes['Confirm POD Agent'] = { from: oldShipmentDetails.confirm_discharge_port_agent || 'empty', to: confirm_discharge_port_agent };
            }
            // if (oldShipmentDetails.confirm_free_time !== confirm_free_time) {
            //     changes['Confirm Free Time'] = { from: oldShipmentDetails.confirm_free_time  || 'empty', to: confirm_free_time || 'empty' };
            // }
        }

        if (String(oldShipmentDetails.is_mofa_required || '0') !== String(is_mofa_required || '0')) {
            changes['MOFA Required'] = { from: oldShipmentDetails.is_mofa_required ? 'Yes' : 'No', to: is_mofa_required ? 'Yes' : 'No' };
        }

        // --- 2. Update Shipment with Confirmed Details ---
        // Handle purchase_bill_id as comma-separated string (e.g., "1,2,3")
        // Validate that all IDs are valid integers if provided
        let parsedPurchaseBillId = null;
        if (purchase_bill_id && purchase_bill_id.trim() !== '') {
            const ids = purchase_bill_id.split(',').map(id => id.trim()).filter(id => id);
            // Validate all IDs are numeric
            const validIds = ids.filter(id => /^\d+$/.test(id));
            if (validIds.length !== ids.length) {
                return res.status(400).json(errPayload("Invalid purchase bill IDs. All IDs must be numeric."));
            }
            parsedPurchaseBillId = validIds.join(',');
        }

        if (isAir) {
            await conn.query(
                `UPDATE shipment SET 
                    sailing_date = ?,
                    confirm_departure_time = ?,
                    confirm_airway_bill_no = ?, confirm_flight_no = ?, confirm_airline = ?,
                    confirm_arrival_date = ?, confirm_arrival_time = ?, 
                    is_mofa_required = ?,
                    original_doc_receipt_mode = ?, doc_receipt_person_name = ?, doc_receipt_person_contact = ?,
                    doc_receipt_courier_no = ?, doc_receipt_courier_company = ?, doc_receipt_tracking_link = ?,
                    purchase_bill_id = ?,
                    supplier_logger_installed = ?,
                    logger_count = ?
                 WHERE id = ?`,
                [
                    confirm_sailing_date,
                    (confirm_departure_time && confirm_departure_time.trim() !== '') ? confirm_departure_time : null,
                    confirm_airway_bill_no, confirm_flight_no, confirm_airline,
                    confirm_arrival_date, (confirm_arrival_time && confirm_arrival_time.trim() !== '') ? confirm_arrival_time : null,
                    is_mofa_required === '1' ? 1 : 0,
                    original_doc_receipt_mode || null, doc_receipt_person_name || null, doc_receipt_person_contact || null,
                    doc_receipt_courier_no || null, doc_receipt_courier_company || null, doc_receipt_tracking_link || null,
                    parsedPurchaseBillId,
                    loggerInstalled || null,
                    loggerCountNum,
                    shipment.id
                ]
            );
        } else {
            await conn.query(
                `UPDATE shipment SET 
                    sailing_date = ?,
                    confirm_vessel_name = ?,
                    eta_date = ?, bl_no = ?,
                    confirm_shipping_line = ?, confirm_discharge_port_agent = ?, confirm_free_time = ?,
                    is_mofa_required = ?,
                    original_doc_receipt_mode = ?, doc_receipt_person_name = ?, doc_receipt_person_contact = ?,
                    doc_receipt_courier_no = ?, doc_receipt_courier_company = ?, doc_receipt_tracking_link = ?,
                    purchase_bill_id = ?,
                    supplier_logger_installed = ?,
                    logger_count = ?
                 WHERE id = ?`,
                [
                    confirm_sailing_date,
                    confirm_vessel_name, confirm_eta_date,
                    bl_no, confirm_shipping_line, confirm_discharge_port_agent,
                    confirm_free_time ? parseInt(confirm_free_time, 10) : null,
                    is_mofa_required === '1' ? 1 : 0,
                    original_doc_receipt_mode || null, doc_receipt_person_name || null, doc_receipt_person_contact || null,
                    doc_receipt_courier_no || null, doc_receipt_courier_company || null, doc_receipt_tracking_link || null,
                    parsedPurchaseBillId,
                    loggerInstalled || null,
                    loggerCountNum,
                    shipment.id
                ]
            );
        }

        await conn.query('DELETE FROM shipment_temperature_loggers WHERE shipment_id = ?', [shipment.id]);
        if (loggerInstalled === 'YES' && Array.isArray(loggerRows) && loggerRows.length > 0) {
            const values = loggerRows.map(row => ([
                shipment.id,
                String(row.serial_no || '').trim(),
                String(row.installation_place || '').trim()
            ]));
            await conn.query(
                'INSERT INTO shipment_temperature_loggers (shipment_id, serial_no, installation_place) VALUES ?',
                [values]
            );
        }

        // --- 3. Process File Uploads (existing logic) ---
        const files = req.files || [];
        const docMeta = JSON.parse(documents_meta || '{}');

        for (const file of files) {
            // fieldname will be like 'draft_123' or 'original_123'
            const [uploadType, docTypeId] = file.fieldname.split('_');
            if (!['draft', 'original'].includes(uploadType) || !docTypeId) continue;

            const isDraft = uploadType === 'draft' ? 1 : 0;
            const meta = docMeta[docTypeId] || {}; // Metadata is not used here but kept for future use

            const relPath = path.posix.join("uploads", "shipment", path.basename(file.path));
            await conn.query(
                `INSERT INTO shipment_file (shipment_id, document_type_id, is_draft, file_name, file_path, mime_type, size_bytes, ref_no, ref_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [shipment.id, docTypeId, isDraft, file.originalname, relPath, file.mimetype, file.size, meta.ref_no || null, meta.ref_date || null]
            );
        }

        // --- 4. Move Stage and Log History ---
        if (!is_editing && shipment.shipment_stage_id === 3) { // Only change stage if NOT editing
            await conn.query(`UPDATE shipment SET shipment_stage_id = 4 WHERE id = ?`, [shipment.id]);
            await addHistory(conn, { module: 'shipment', moduleId: shipment.id, userId, action: 'STAGE_CHANGED', details: { from: 'Underloading', to: 'Sailed', user: userName } });
            await recordStageHistory(conn, {
                poId: shipment.po_id,
                shipmentId: shipment.id,
                fromStageId: shipment.shipment_stage_id,
                toStageId: 4,
                payload: {
                    source: 'sail',
                    confirm_sailing_date,
                    confirm_departure_time,
                    confirm_vessel_name,
                    confirm_eta_date,
                    bl_no,
                    confirm_shipping_line,
                    confirm_discharge_port_agent,
                    confirm_airway_bill_no,
                    confirm_flight_no,
                    confirm_airline,
                    confirm_arrival_date,
                    confirm_arrival_time
                }
            });
        }

        // Add history for confirmed details changes if any
        if (Object.keys(changes).length > 0) {
            await addHistory(conn, { module: 'shipment', moduleId: shipment.id, userId, action: 'SAILED_DETAILS_CONFIRMED', details: { changes, user: userName } });
        }

        await conn.commit();
        res.json({ ok: true, shipUniqid, toStageId: 4, updated: { from_stage_id: 3 } });

    } catch (e) {
        await conn.rollback();
        res.status(500).json(errPayload("Failed to move shipment to Sailed", "DB_ERROR", e.message));
    } finally {
        conn.release();
    }
});

/* ---------- move to cleared (5) with all details and docs ---------- */
const clearedUploads = upload.any();
router.post("/:shipUniqid/transition/cleared", clearedUploads, async (req, res) => {
    const { shipUniqid } = req.params;
    const userId = req.session?.user?.id;
    const userName = req.session?.user?.name || 'System';
    const conn = await db.promise().getConnection();

    try {
        await conn.beginTransaction();

        const uploadedFilesArray = Array.isArray(req.files) ? req.files : [];
        const filesByField = Array.isArray(req.files)
            ? uploadedFilesArray.reduce((acc, file) => {
                if (!acc[file.fieldname]) acc[file.fieldname] = [];
                acc[file.fieldname].push(file);
                return acc;
            }, {})
            : (req.files || {});

        const [[shipment]] = await conn.query(`SELECT id, po_id, shipment_stage_id, is_mofa_required FROM shipment WHERE ship_uniqid = ?`, [shipUniqid]);
        if (!shipment) {
            throw new Error("Shipment not found.");
        }

        const [shipmentContainers] = await conn.query(`SELECT id FROM shipment_container WHERE shipment_id = ?`, [shipment.id]);
        const validContainerIdList = shipmentContainers.map((row) => row.id);
        const validContainerIds = new Set(validContainerIdList);
        let existingContainerReturns = [];
        if (validContainerIdList.length > 0) {
            const [rows] = await conn.query(
                `SELECT id, container_id, return_date, to_town_date FROM shipment_container_return WHERE container_id IN (?)`,
                [validContainerIdList]
            );
            existingContainerReturns = rows;
        }
        const returnByContainerId = existingContainerReturns.reduce((acc, row) => {
            acc[row.container_id] = row;
            return acc;
        }, {});

        // --- 1. Update text fields in the shipment table ---
        const {
            do_no, do_validity_date, boe_no, boe_date,
            firs_no, firs_date, firs_due_date, mofa_due_date,
            custom_submission_due_date,
            is_mofa_required,
            is_transport_required,
            transporter_name,
            hauler_code,
            transport_from_place,
            transport_to_place,
            kept_main_file_ids: keptMainFileIdsRaw
        } = req.body;

        let keptMainFileIds = [];
        try {
            keptMainFileIds = JSON.parse(keptMainFileIdsRaw || '[]');
        } catch {
            keptMainFileIds = [];
        }

        let containerReturnsPayload = [];
        try {
            containerReturnsPayload = JSON.parse(req.body.container_returns || '[]');
        } catch {
            containerReturnsPayload = [];
        }
        if (!Array.isArray(containerReturnsPayload)) {
            containerReturnsPayload = [];
        }

        // Check if MOFA is required
        const mofaRequired = String(is_mofa_required || shipment.is_mofa_required || '0') === '1';

        await conn.query(
            `UPDATE shipment SET
                do_no = ?, do_validity_date = ?, boe_no = ?, boe_date = ?,
                firs_no = ?, firs_date = ?, firs_due_date = ?, mofa_due_date = ?,
                custom_submission_due_date = ?,
                is_transport_required = ?, transporter_name = ?, hauler_code = ?,
                transport_from_place = ?, transport_to_place = ?
             WHERE id = ?`,
            [
                do_no || null, do_validity_date || null, boe_no || null, boe_date || null,
                firs_no || null, firs_date || null, firs_due_date || null, mofa_due_date || null,
                custom_submission_due_date || null,
                is_transport_required === '1' ? 1 : 0,
                transporter_name || null,
                hauler_code || null,
                transport_from_place || null,
                transport_to_place || null,
                shipment.id
            ]
        );

        // --- 2. Process and save file uploads ---
        const docTypeMap = {
            'do_copy': 'do_copy',
            'boe_copy': 'boe_copy',
            'firs_attachment': 'firs_attachment',
            'mofa_attachment': 'mofa_attachment',
            'original_document': 'original_document_cleared' // Use a specific code
        };

        const [docTypes] = await conn.query(
            `SELECT id, code FROM document_type WHERE code IN (?)`,
            [Object.values(docTypeMap)]
        );
        const docTypeIdLookup = docTypes.reduce((acc, dt) => {
            acc[dt.code] = dt.id;
            return acc;
        }, {});

        // --- 2a. Remove deleted files (that were not kept) ---
        const managedDocTypeIds = Object.values(docTypeIdLookup).filter(Boolean);
        if (managedDocTypeIds.length > 0) {
            if (keptMainFileIds.length > 0) {
                await conn.query(
                    `DELETE FROM shipment_file WHERE shipment_id = ? AND document_type_id IN (?) AND id NOT IN (?)`,
                    [shipment.id, managedDocTypeIds, keptMainFileIds]
                );
            } else {
                await conn.query(
                    `DELETE FROM shipment_file WHERE shipment_id = ? AND document_type_id IN (?)`,
                    [shipment.id, managedDocTypeIds]
                );
            }
        }

        for (const [fieldName, files] of Object.entries(filesByField)) {
            const docTypeCode = docTypeMap[fieldName];
            if (!docTypeCode || !files) continue;
            const docTypeId = docTypeIdLookup[docTypeCode];

            if (docTypeId) {
                for (const file of files) {
                    const relPath = path.posix.join("uploads", "shipment", path.basename(file.path));
                    await conn.query(
                        `INSERT INTO shipment_file (shipment_id, document_type_id, file_name, file_path, mime_type, size_bytes, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, NOW())`,
                        [shipment.id, docTypeId, file.originalname, relPath, file.mimetype, file.size]
                    );
                }
            }
        }

        // --- 3. Handle container return information (dates + documents) ---
        // Required DB tables (define separately):
        //   shipment_container_return (id, shipment_id, container_id, return_date, created_at, updated_at)
        //   shipment_container_return_file (id, return_id, file_name, file_path, mime_type, size_bytes, uploaded_at)
        const containerEntryById = new Map();
        for (const entry of containerReturnsPayload) {
            const entryContainerId = Number(entry?.container_id);
            if (entryContainerId) {
                containerEntryById.set(entryContainerId, entry);
            }
        }
        const fileContainerIds = Object.keys(filesByField)
            .filter((name) => name.startsWith('container_return_files_'))
            .map((name) => Number(name.replace('container_return_files_', '')))
            .filter(Boolean);
        const containerIdsToProcess = new Set([...containerEntryById.keys(), ...fileContainerIds]);

        if (containerIdsToProcess.size > 0) {
            for (const containerId of containerIdsToProcess) {
                if (!containerId || !validContainerIds.has(containerId)) continue;

                const entry = containerEntryById.get(containerId) || {};
                const returnDateNormalized = entry?.return_date ? entry.return_date : null;
                const toTownDateNormalized = entry?.to_town_date ? entry.to_town_date : null;
                const keptFileIds = Array.isArray(entry?.kept_file_ids)
                    ? entry.kept_file_ids.map((id) => Number(id)).filter(Boolean)
                    : [];

                const existingReturn = returnByContainerId[containerId];
                let returnRecordId;

                if (existingReturn) {
                    await conn.query(
                        `UPDATE shipment_container_return SET return_date = ?, to_town_date = ?, updated_at = NOW() WHERE id = ?`,
                        [returnDateNormalized || null, toTownDateNormalized || null, existingReturn.id]
                    );
                    returnRecordId = existingReturn.id;
                    existingReturn.to_town_date = toTownDateNormalized || null;
                } else {
                    const [result] = await conn.query(
                        `INSERT INTO shipment_container_return (shipment_id, container_id, return_date, to_town_date, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())`,
                        [shipment.id, containerId, returnDateNormalized || null, toTownDateNormalized || null]
                    );
                    returnRecordId = result.insertId;
                    returnByContainerId[containerId] = { id: returnRecordId, container_id: containerId, return_date: returnDateNormalized, to_town_date: toTownDateNormalized };
                }

                if (returnRecordId) {
                    if (keptFileIds.length > 0) {
                        await conn.query(
                            `DELETE FROM shipment_container_return_file WHERE return_id = ? AND id NOT IN (?)`,
                            [returnRecordId, keptFileIds]
                        );
                    } else {
                        await conn.query(
                            `DELETE FROM shipment_container_return_file WHERE return_id = ?`,
                            [returnRecordId]
                        );
                    }

                    const uploadFieldKey = `container_return_files_${containerId}`;
                    const newFiles = filesByField[uploadFieldKey] || [];
                    for (const file of newFiles) {
                        const relPath = path.posix.join("uploads", "shipment", path.basename(file.path));
                        await conn.query(
                            `INSERT INTO shipment_container_return_file (return_id, file_name, file_path, mime_type, size_bytes, uploaded_at) VALUES (?, ?, ?, ?, ?, NOW())`,
                            [returnRecordId, file.originalname, relPath, file.mimetype, file.size]
                        );
                    }
                }
            }
        }

        // --- 4. Check if required files are present for transition ---
        // Required files: FIRS, MOFA (if required), Original Document
        const hasFirsNew = (filesByField['firs_attachment'] || []).length > 0;
        const hasMofaNew = !mofaRequired || (filesByField['mofa_attachment'] || []).length > 0;
        const hasOriginalDocNew = (filesByField['original_document'] || []).length > 0;

        // Also check existing files in database
        let hasFirsTotal = hasFirsNew;
        let hasMofaTotal = hasMofaNew;
        let hasOriginalDocTotal = hasOriginalDocNew;

        if (docTypeIdLookup['firs_attachment']) {
            const [existingFirs] = await conn.query(
                `SELECT COUNT(*) as count FROM shipment_file WHERE shipment_id = ? AND document_type_id = ?`,
                [shipment.id, docTypeIdLookup['firs_attachment']]
            );
            hasFirsTotal = hasFirsNew || (existingFirs[0]?.count || 0) > 0;
        }

        if (mofaRequired && docTypeIdLookup['mofa_attachment']) {
            const [existingMofa] = await conn.query(
                `SELECT COUNT(*) as count FROM shipment_file WHERE shipment_id = ? AND document_type_id = ?`,
                [shipment.id, docTypeIdLookup['mofa_attachment']]
            );
            hasMofaTotal = hasMofaNew || (existingMofa[0]?.count || 0) > 0;
        }

        if (docTypeIdLookup['original_document_cleared']) {
            const [existingOriginal] = await conn.query(
                `SELECT COUNT(*) as count FROM shipment_file WHERE shipment_id = ? AND document_type_id = ?`,
                [shipment.id, docTypeIdLookup['original_document_cleared']]
            );
            hasOriginalDocTotal = hasOriginalDocNew || (existingOriginal[0]?.count || 0) > 0;
        }

        // Check if required dates are present for transition
        const hasFirsDate = !!firs_date;
        const hasFirsDueDate = !!firs_due_date;
        const hasMofaDueDate = !mofaRequired || !!mofa_due_date;
        const hasCustomSubmissionDueDate = !!custom_submission_due_date;

        const missingRequirements = [];
        if (!hasFirsTotal) missingRequirements.push("FIRS attachment");
        if (!hasFirsDate) missingRequirements.push("FIRS date");
        if (!hasFirsDueDate) missingRequirements.push("FIRS due date");
        if (!hasMofaTotal) missingRequirements.push("MOFA attachment");
        if (!hasMofaDueDate) missingRequirements.push("MOFA due date");
        if (!hasOriginalDocTotal) missingRequirements.push("Original document");
        if (!hasCustomSubmissionDueDate) missingRequirements.push("Customs submission due date");

        const canTransition = missingRequirements.length === 0;

        // --- 4. Update stage and log history only if all required files and dates are present ---
        const fromStageId = shipment.shipment_stage_id;
        let toStageId = fromStageId; // Default: stay in current stage

        if (canTransition && fromStageId === 4) {
            // Only transition if currently in Sailed stage (4) and all files are present
            await conn.query(`UPDATE shipment SET shipment_stage_id = 5, cleared_date = NOW() WHERE id = ?`, [shipment.id]);
            await addHistory(conn, {
                module: 'shipment',
                moduleId: shipment.id,
                userId,
                action: 'STAGE_CHANGED',
                details: { from: 'Sailed', to: 'Cleared', user: userName }
            });
            await recordStageHistory(conn, {
                poId: shipment.po_id,
                shipmentId: shipment.id,
                fromStageId,
                toStageId: 5,
                payload: {
                    source: 'cleared',
                    do_no,
                    do_validity_date,
                    boe_no,
                    boe_date,
                    firs_no,
                    firs_date,
                    firs_due_date,
                    mofa_due_date,
                    custom_submission_due_date,
                    is_transport_required,
                    transporter_name,
                    hauler_code,
                    transport_from_place,
                    transport_to_place,
                    container_returns: containerReturnsPayload
                }
            });
            toStageId = 5;

            // Auto-create QC lot when transitioning from Sailed (4) to Cleared (5)
            await autoCreateQCLot(conn, shipment.id, shipment.po_id, userId);
        } else if (fromStageId === 4) {
            // Save without transitioning - add history log for data update
            await addHistory(conn, {
                module: 'shipment',
                moduleId: shipment.id,
                userId,
                action: 'UPDATED',
                details: { section: 'Cleared Details', user: userName, note: 'Saved cleared details. Waiting for required documents to transition.' }
            });
        }

        const message = canTransition && fromStageId === 4
            ? "Shipment moved to Cleared successfully."
            : "Cleared details saved. Upload pending items before moving to Cleared.";

        await conn.commit();
        res.json({
            ok: true,
            shipUniqid,
            toStageId: toStageId,
            transitioned: canTransition && fromStageId === 4,
            updated: { from_stage_id: fromStageId },
            missingRequirements,
            message,
            warning: !canTransition
        });
    } catch (e) {
        await conn.rollback();
        res.status(500).json(errPayload("Failed to move shipment to Cleared", "DB_ERROR", e.message));
    } finally {
        conn.release();
    }
});

const closedUploads = upload.any();
router.post("/:shipUniqid/transition/closed", closedUploads, async (req, res) => {
    const { shipUniqid } = req.params;
    const userId = req.session?.user?.id;
    const userName = req.session?.user?.name || 'System';
    const conn = await db.promise().getConnection();

    try {
        await conn.beginTransaction();

        const [[shipment]] = await conn.query(
            `SELECT s.id, s.po_id, s.shipment_stage_id, po.mode_shipment_id, s.is_mofa_required
             FROM shipment s
             LEFT JOIN purchase_orders po ON po.id = s.po_id
             WHERE s.ship_uniqid = ?`,
            [shipUniqid]
        );
        if (!shipment) {
            await conn.rollback();
            return res.status(404).json(errPayload("Shipment not found."));
        }
        if (Number(shipment.shipment_stage_id) !== 5) {
            await conn.rollback();
            return res.status(400).json(errPayload("Shipment must be in Cleared stage before closing."));
        }

        const comment = (req.body?.comment || "").trim();
        if (!comment) {
            await conn.rollback();
            return res.status(400).json(errPayload("Closing comments are required."));
        }

        const [requiredDocs] = await conn.query(
            `SELECT spd.document_type_id, dt.name
             FROM shipment_po_document spd
             JOIN document_type dt ON dt.id = spd.document_type_id
             WHERE spd.shipment_id = ?`,
            [shipment.id]
        );
        if (!requiredDocs.length) {
            await conn.rollback();
            return res.status(400).json(errPayload("Configure required documents in Planned stage before closing."));
        }

        const missingOriginals = [];
        for (const doc of requiredDocs) {
            const [rows] = await conn.query(
                `SELECT COUNT(*) AS cnt
                 FROM shipment_file sf
                 WHERE sf.shipment_id = ?
                   AND sf.document_type_id = ?
                   AND (sf.is_draft IS NULL OR sf.is_draft = 0)`,
                [shipment.id, doc.document_type_id]
            );
            if (!rows[0].cnt) {
                missingOriginals.push(doc.name || `Document ID ${doc.document_type_id}`);
            }
        }

        const hasDocByCode = async (code) => {
            const [rows] = await conn.query(
                `SELECT COUNT(*) AS cnt
                 FROM shipment_file sf
                 INNER JOIN document_type dt ON dt.id = sf.document_type_id
                 WHERE sf.shipment_id = ?
                   AND dt.code = ?`,
                [shipment.id, code]
            );
            return rows[0].cnt > 0;
        };

        const issues = [];
        const hasFirs = await hasDocByCode('firs_attachment');
        if (!hasFirs) issues.push("FIRS");
        if (Number(shipment.is_mofa_required) === 1) {
            const hasMofa = await hasDocByCode('mofa_attachment');
            if (!hasMofa) issues.push("MOFA");
        }
        const hasCustom = await hasDocByCode('original_document_cleared');
        if (!hasCustom) issues.push("Custom documents");

        const containerIssues = [];
        if (Number(shipment.mode_shipment_id) === 1) {
            const [containerRows] = await conn.query(
                `SELECT sc.container_no,
                        (SELECT COUNT(*) FROM shipment_container_return scr WHERE scr.container_id = sc.id) AS has_return,
                        (SELECT COUNT(*) FROM shipment_container_return_file scrf
                          JOIN shipment_container_return scr ON scr.id = scrf.return_id
                         WHERE scr.container_id = sc.id) AS attachment_count
                 FROM shipment_container sc
                 WHERE sc.shipment_id = ?`,
                [shipment.id]
            );
            for (const row of containerRows) {
                if (!row.has_return || !row.attachment_count) {
                    containerIssues.push(row.container_no || 'Container');
                }
            }
        }

        if (missingOriginals.length) {
            issues.push(`Originals: ${missingOriginals.join(', ')}`);
        }
        if (containerIssues.length) {
            issues.push(`Container returns: ${containerIssues.join(', ')}`);
        }

        if (issues.length) {
            await conn.rollback();
            return res.json({
                ok: true,
                shipUniqid,
                toStageId: Number(shipment.shipment_stage_id) || 5,
                transitioned: false,
                updated: { from_stage_id: Number(shipment.shipment_stage_id) || 5 },
                missingRequirements: issues,
                warning: true,
                message: `Cannot close shipment. Pending: ${issues.join('; ')}`
            });
        }

        if (req.files && req.files.length > 0) {
            const [docTypeRows] = await conn.query(
                `SELECT id FROM document_type WHERE code = 'closed_stage_attachment' LIMIT 1`
            );
            let docTypeId;
            if (docTypeRows.length) {
                docTypeId = docTypeRows[0].id;
            } else {
                const [insertDocType] = await conn.query(
                    `INSERT INTO document_type (code, name, is_active) VALUES ('closed_stage_attachment', 'Closed Stage Attachment', 1)`
                );
                docTypeId = insertDocType.insertId;
            }

            for (const file of req.files) {
                const relPath = path.posix.join("uploads", "shipment", path.basename(file.path));
                await conn.query(
                    `INSERT INTO shipment_file
                        (shipment_id, document_type_id, file_name, file_path, mime_type, size_bytes, uploaded_at)
                     VALUES (?, ?, ?, ?, ?, ?, NOW())`,
                    [shipment.id, docTypeId, file.originalname, relPath, file.mimetype, file.size]
                );
            }
        }

        await conn.query(
            `UPDATE shipment 
             SET shipment_stage_id = 6,
                 closed_comment = ?,
                 closed_date = CURDATE()
             WHERE id = ?`,
            [comment, shipment.id]
        );

        const [[closedInfo]] = await conn.query(
            `SELECT DATE_FORMAT(closed_date, '%Y-%m-%d') AS closed_date
             FROM shipment
             WHERE id = ?`,
            [shipment.id]
        );
        const closedDate = closedInfo?.closed_date || null;

        await addHistory(conn, {
            module: 'shipment',
            moduleId: shipment.id,
            userId,
            action: 'STAGE_CHANGED',
            details: { from: 'Cleared', to: 'Closed', user: userName, comment }
        });
        await recordStageHistory(conn, {
            poId: shipment.po_id,
            shipmentId: shipment.id,
            fromStageId: 5,
            toStageId: 6,
            payload: { source: 'closed', comment }
        });

        await conn.commit();
        res.json({
            ok: true,
            transitioned: true,
            shipUniqid,
            toStageId: 6,
            updated: { from_stage_id: 5, closed_comment: comment, closed_date: closedDate },
            message: "Shipment closed successfully."
        });
    } catch (e) {
        await conn.rollback();
        res.status(500).json(errPayload("Failed to close shipment.", "DB_ERROR", e.message));
    } finally {
        conn.release();
    }
});

const archiveUploads = upload.any();
router.post("/:shipUniqid/transition/archive", archiveUploads, async (req, res) => {
    const { shipUniqid } = req.params;
    const userId = req.session?.user?.id;
    const userName = req.session?.user?.name || 'System';
    const conn = await db.promise().getConnection();

    try {
        await conn.beginTransaction();

        const [[shipment]] = await conn.query(
            `SELECT id, po_id, shipment_stage_id
             FROM shipment
             WHERE ship_uniqid = ?`,
            [shipUniqid]
        );

        if (!shipment) {
            await conn.rollback();
            return res.status(404).json(errPayload("Shipment not found."));
        }

        if (Number(shipment.shipment_stage_id) !== 6) {
            await conn.rollback();
            return res.status(400).json(errPayload("Shipment must be in Closed stage before archiving."));
        }

        const comment = (req.body?.comment || "").trim();
        if (!comment) {
            await conn.rollback();
            return res.status(400).json(errPayload("Manager review comment is required."));
        }

        if (req.files && req.files.length > 0) {
            const [docTypeRows] = await conn.query(
                `SELECT id FROM document_type WHERE code = 'archive_stage_attachment' LIMIT 1`
            );
            let docTypeId;
            if (docTypeRows.length) {
                docTypeId = docTypeRows[0].id;
            } else {
                const [insertDocType] = await conn.query(
                    `INSERT INTO document_type (code, name, is_active) VALUES ('archive_stage_attachment', 'Archive Stage Attachment', 1)`
                );
                docTypeId = insertDocType.insertId;
            }

            for (const file of req.files) {
                const relPath = path.posix.join("uploads", "shipment", path.basename(file.path));
                await conn.query(
                    `INSERT INTO shipment_file
                        (shipment_id, document_type_id, file_name, file_path, mime_type, size_bytes, uploaded_at)
                     VALUES (?, ?, ?, ?, ?, ?, NOW())`,
                    [shipment.id, docTypeId, file.originalname, relPath, file.mimetype, file.size]
                );
            }
        }

        await conn.query(
            `UPDATE shipment
             SET shipment_stage_id = 7,
                 archive_comment = ?,
                 archive_date = CURDATE()
             WHERE id = ?`,
            [comment, shipment.id]
        );

        const [[archiveInfo]] = await conn.query(
            `SELECT DATE_FORMAT(archive_date, '%Y-%m-%d') AS archive_date
             FROM shipment
             WHERE id = ?`,
            [shipment.id]
        );
        const archiveDate = archiveInfo?.archive_date || null;

        await addHistory(conn, {
            module: 'shipment',
            moduleId: shipment.id,
            userId,
            action: 'STAGE_CHANGED',
            details: { from: 'Closed', to: 'Archive', user: userName, comment }
        });
        await recordStageHistory(conn, {
            poId: shipment.po_id,
            shipmentId: shipment.id,
            fromStageId: 6,
            toStageId: 7,
            payload: { source: 'archive', comment }
        });

        await conn.commit();
        res.json({
            ok: true,
            transitioned: true,
            shipUniqid,
            toStageId: 7,
            updated: { from_stage_id: 6, archive_comment: comment, archive_date: archiveDate },
            message: "Shipment archived successfully."
        });
    } catch (e) {
        await conn.rollback();
        res.status(500).json(errPayload("Failed to archive shipment.", "DB_ERROR", e.message));
    } finally {
        conn.release();
    }
});

/* ---------- Internal function to recalculate lot numbers for a shipment family ---------- */
async function recalculateLotNumbersInternal(conn, shipmentId, userId, userName) {
    // 1. Find the ultimate root of the family
    let rootShipmentId = shipmentId;
    let current = { id: shipmentId, parent_shipment_id: null }; // Start with the provided shipment
    // If the provided shipment has a parent, traverse up to find the ultimate root
    const [[initialShipment]] = await conn.query(`SELECT id, parent_shipment_id FROM shipment WHERE id = ?`, [shipmentId]);
    if (initialShipment) {
        current = initialShipment;
        while (current.parent_shipment_id) {
            const [[parent]] = await conn.query(`SELECT id, parent_shipment_id FROM shipment WHERE id = ?`, [current.parent_shipment_id]);
            if (!parent) break;
            rootShipmentId = parent.id;
            current = parent;
        }
    }

    // 2. Get all shipments in the family (all descendants of the ultimate root)
    // For MySQL < 8.0 (no recursive CTEs), we fetch all shipments and build the family tree in JS.
    const [allShipmentsRaw] = await conn.query(`SELECT id, parent_shipment_id, shipment_stage_id, created_date FROM shipment`);
    const childrenMap = new Map(); // parentId -> [childId, ...]
    allShipmentsRaw.forEach(s => {
        if (s.parent_shipment_id) {
            if (!childrenMap.has(s.parent_shipment_id)) childrenMap.set(s.parent_shipment_id, []);
            childrenMap.get(s.parent_shipment_id).push(s.id);
        }
    });

    const familyMemberIds = new Set();
    const findDescendants = (currentId) => {
        familyMemberIds.add(currentId);
        if (childrenMap.has(currentId)) {
            for (const childId of childrenMap.get(currentId)) {
                findDescendants(childId);
            }
        }
    };
    findDescendants(rootShipmentId);

    // Filter `allShipmentsRaw` to get only members of this family and sort them
    const family = allShipmentsRaw
        .filter(s => familyMemberIds.has(s.id))
        .sort((a, b) => {
            // Sort by stage (>=3 first), then by creation date
            const stageOrderA = a.shipment_stage_id >= 3 ? 0 : 1;
            const stageOrderB = b.shipment_stage_id >= 3 ? 0 : 1;
            if (stageOrderA !== stageOrderB) return stageOrderA - stageOrderB;
            return new Date(a.created_date).getTime() - new Date(b.created_date).getTime();
        });

    // 3. Re-assign lot numbers and total_lots sequentially
    const totalLotsInFamily = family.length;
    let lotCounter = 1;
    for (const member of family) {
        await conn.query(`UPDATE shipment SET lot_number = ?, total_lots = ? WHERE id = ?`, [lotCounter, totalLotsInFamily, member.id]);
        lotCounter++;
    }

    await addHistory(conn, { module: 'shipment', moduleId: shipmentId, userId, action: 'LOT_NUMBERS_RECALCULATED', details: { user: userName } });
}

/* ---------- fix/recalculate lot numbers for a shipment family ---------- */
router.post("/:shipUniqid/recalculate-lots", async (req, res) => {
    const { shipUniqid } = req.params;
    const userId = req.session?.user?.id;
    const conn = await db.promise().getConnection();

    try {
        await conn.beginTransaction();

        // 1. Find the shipment and its root
        const [[shipment]] = await conn.query(`SELECT id, parent_shipment_id FROM shipment WHERE ship_uniqid = ?`, [shipUniqid]);
        if (!shipment) throw new Error("Shipment not found.");

        await recalculateLotNumbersInternal(conn, shipment.id, userId, req.session?.user?.name || 'System');

        await conn.commit();
        res.json({ ok: true, message: `Lot numbers for this shipment family have been recalculated successfully.` });

    } catch (e) {
        await conn.rollback();
        res.status(500).json(errPayload("Failed to recalculate lot numbers.", "DB_ERROR", e.message));
    } finally {
        conn.release();
    }
});

/* ---------- Get Dubai Trade Container Status (Scraping) ---------- */
router.get("/dubai-trade-status/:containerNo", async (req, res) => {
    const pool = db.promise();
    const containerNo = (req.params.containerNo || '').trim().toUpperCase();
    const shipmentContainerId = Number(req.query.scId || 0) || null;     // REQUIRED for cache key
    const shipmentId = Number(req.query.shipmentId || 0) || null;        // for bookkeeping
    const forceLive = req.query.forceLive === 'true';                    // Force live fetch, skip cache

    if (!containerNo) return res.status(400).json({ ok: false, error: 'Container number is required.' });
    if (!shipmentContainerId) return res.status(400).json({ ok: false, error: 'scId (shipment_container_id) is required.' });

    try {
        // 1) Try cache (within last 3 hours) - skip if forceLive is true
        if (!forceLive) {
            const [[cached]] = await pool.query(
                `SELECT raw_data, last_fetched_at
           FROM dubai_trade_container_status
          WHERE container_no = ? AND shipment_container_id = ?
          ORDER BY last_fetched_at DESC
          LIMIT 1`,
                [containerNo, shipmentContainerId]
            );

            // Use minutes for a more precise time comparison to avoid timezone-related issues.
            const minutesSinceLastFetch = cached ? dayjs().diff(dayjs(cached.last_fetched_at), 'minute') : Infinity;

            if (cached && minutesSinceLastFetch < 180) { // 180 minutes = 3 hours
                console.log(`[API] Serving cached Dubai Trade data for container: ${containerNo}`);
                const payload = JSON.parse(cached.raw_data || '{}');
                return res.json({
                    ok: true,
                    source: 'cache',
                    lastFetchedAt: cached.last_fetched_at,
                    data: payload,
                });
            }
        }

        // 2) Cache miss or forceLive -> fetch live
        if (forceLive) {
            console.log(`[API] Force live fetch requested for container: ${containerNo}`);
        } else {
            console.log(`[API] Cache miss, fetching live data for container: ${containerNo}`);
        }
        const live = await fetchContainerDataFromDubaiTrade(containerNo);
        if (!live || !live.containerNumber) {
            return res.status(502).json({ ok: false, error: 'Failed to fetch from Dubai Trade.' });
        }

        // 3) Upsert
        // Use the centralized save function to ensure consistency with the cron job
        await saveOrUpdateContainerData(pool, containerNo, live, shipmentId, shipmentContainerId);

        console.log(`[API] Successfully fetched live data for container: ${containerNo}`);
        return res.json({
            ok: true,
            source: 'live',
            lastFetchedAt: dayjs().tz(process.env.TZ || 'Asia/Dubai').format('YYYY-MM-DD HH:mm:ss'),
            data: live,
        });
    } catch (err) {
        console.error('DubaiTrade status error:', err);
        return res.status(500).json({ ok: false, error: 'Internal error' });
    }
});

export default router;