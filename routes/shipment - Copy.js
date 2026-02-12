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
import { fetchContainerDataFromDubaiTrade, saveOrUpdateContainerData } from './container-tracking.js';

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
            ? `AND s.id IN (SELECT id FROM shipment WHERE shipment_stage_id = 1 ORDER BY id DESC LIMIT ${limit})`
            : '';
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
        COALESCE(s.confirm_airway_bill_no, s.airway_bill_no) as airway_bill_no,
        s.bl_no,
        COALESCE(s.confirm_airline, s.airline) as airline,
        COALESCE(s.confirm_flight_no, s.flight_no) as flight_no,
        s.confirm_airway_bill_no,
        s.confirm_flight_no,
        s.confirm_airline,
        s.is_mofa_required,
        s.shipping_line_name,
        s.original_doc_receipt_mode,
        s.doc_receipt_person_name,
        s.doc_receipt_person_contact,
        s.doc_receipt_courier_no,
        s.doc_receipt_courier_company,
        s.doc_receipt_tracking_link,
        DATE_FORMAT(s.confirm_arrival_date, '%d-%b-%Y') as confirm_arrival_date,
        s.confirm_arrival_time,
        s.total_lots, -- Fetch total_lots directly from the DB
        DATE_FORMAT(s.arrival_date, '%d-%b-%Y') as arrival_date,
        s.arrival_time,
        s.lot_number,
        s.parent_shipment_id,
        po.po_number,
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
      WHERE s.shipment_stage_id > 0 AND s.is_inactive = 0 
      GROUP BY s.id
      ORDER BY s.shipment_stage_id, s.id DESC
      `, [req.session?.user?.id || 0, req.session?.user?.id || 0]
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
           cs.country AS company_country,
           ct.name AS container_type_name, 
           cl.name AS container_load_name
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

    // Fetch PO documents
    const [poDocuments] = await db.promise().query(`
        SELECT spd.id, spd.document_type_id, spd.document_name, dt.name as document_type_name
        FROM shipment_po_document spd
       JOIN document_type dt ON dt.id = spd.document_type_id
        WHERE spd.shipment_id = ?
    `, [row.id]);
    
    // Also fetch PO items
    const [poItems] = await db.promise().query(`
        SELECT i.item_name, i.description, i.quantity, i.hscode,
               (SELECT SUM(sc.net_weight) FROM shipment_container_item sc WHERE sc.product_id = i.item_id AND sc.container_id IN (SELECT id FROM shipment_container WHERE shipment_id = ?)) as net_weight,
               (SELECT SUM(sc.gross_weight) FROM shipment_container_item sc WHERE sc.product_id = i.item_id AND sc.container_id IN (SELECT id FROM shipment_container WHERE shipment_id = ?)) as gross_weight,
               um.name as uom_name,
               (SELECT pi.file_path 
                FROM product_images pi 
                WHERE pi.product_id = i.item_id 
                ORDER BY pi.is_primary DESC, pi.id ASC 
                LIMIT 1) as image_url
        FROM purchase_order_items i
        LEFT JOIN uom_master um ON um.id = i.uom_id
        WHERE i.purchase_order_id = ?
        ORDER BY i.id ASC
    `, [row.id, row.id, row.po_id]);
    
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
    
    res.json({ ...row, po_items: poItems || [], containers: containers || [], commonFiles: allFiles, po_documents: poDocuments || [] });
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
            etd_date, vessel_name, shipping_line_name, shipper, consignee, notify_party
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
            shipping_line_name: 'Shipping Line', shipper: 'Shipper', consignee: 'Consignee', notify_party: 'Notify Party'
        };

        const formatDateForHistory = (dateValue) => {
            if (!dateValue) return 'empty';
            return dayjs(dateValue).format('DD-MMM-YYYY');
        };

        for (const key in fieldsToCompare) {
            const oldValue = oldShipment[key] || '';
            const newValue = req.body[key] || ''; // The date from the form is already YYYY-MM-DD
            if (String(oldValue) !== String(newValue)) {
                changes[fieldsToCompare[key]] = {
                    from: key === 'etd_date' ? formatDateForHistory(oldValue) : (oldValue || 'empty'),
                    to: key === 'etd_date' ? formatDateForHistory(newValue) : (newValue || 'empty')
                };
            }
        }

        await connection.query(
            `UPDATE shipment SET
                bl_description = ?, free_time = ?, discharge_port_local_charges = ?,
                discharge_port_agent = ?, freight_charges = ?, freight_payment_terms = ?, freight_amount_if_payable = ?, freight_amount_currency_id = ?, bl_type = ?,
                etd_date = ?, vessel_name = ?, shipping_line_name = ?, shipper = ?, consignee = ?, notify_party = ?,
                updated_date = NOW()
            WHERE id = ?`,
            [bl_description || null, free_time || null, discharge_port_local_charges || null, discharge_port_agent || null, freight_charges || null, freight_payment_terms || null, freight_amount_if_payable || null, freight_amount_currency_id || null, bl_type || null, etd_date || null, vessel_name || null, shipping_line_name || null, shipper || null, consignee || null, notify_party || null, oldShipment.id]
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
            etd_date, vessel_name, shipping_line_name, shipper, consignee, notify_party
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
                etd_date = ?, vessel_name = ?, shipping_line_name = ?, shipper = ?, consignee = ?, notify_party = ?,
                containers_back_to_back = ?, containers_stock_sales = ?, no_containers = ?
            WHERE id = ?`,
            [
                bl_description || null, free_time || null, discharge_port_local_charges || null,
                discharge_port_agent || null, freight_charges || null, freight_payment_terms || null, freight_amount_if_payable || null, freight_amount_currency_id || null, bl_type || null,
                etd_date || null, vessel_name || null, shipping_line_name || null, shipper || null, consignee || null, notify_party || null,
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
    const { b2b_containers, ss_containers } = req.body;
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
            `UPDATE shipment SET shipper = ?, consignee = ?, notify_party = ?, bl_description = ?, free_time = ?, bl_type = ?, freight_payment_terms = ?, freight_amount_if_payable = ?, freight_amount_currency_id = ?, etd_date = ?, vessel_name = ?, shipping_line_name = ? WHERE id = ?`,
            [originalShipment.shipper, originalShipment.consignee, originalShipment.notify_party, originalShipment.bl_description, originalShipment.free_time, originalShipment.bl_type, originalShipment.freight_payment_terms, originalShipment.freight_amount_if_payable, originalShipment.freight_amount_currency_id, originalShipment.etd_date, originalShipment.vessel_name, originalShipment.shipping_line_name, newShipmentId]
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
    const { airway_bill_no, flight_no, airline, arrival_date, arrival_time, pickup_date, keptCommonImages: keptCommonImagesJson, items: itemsJson } = req.body;
    const isEditing = req.body.is_editing === 'true';
    const items = JSON.parse(itemsJson || '[]');
    const files = req.files || [];
    const userId = req.session?.user?.id;
    const userName = req.session?.user?.name || 'System';

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        const [[shipment]] = await conn.query(`SELECT id, po_id, airway_bill_no, flight_no, airline, arrival_date, arrival_time, shipment_stage_id FROM shipment WHERE ship_uniqid = ?`, [shipUniqid]);
        if (!shipment) throw new Error("Shipment not found.");

        // Update shipment with Airway Bill and Flight No
        await conn.query(
            `UPDATE shipment SET airway_bill_no = ?, flight_no = ?, airline = ?, arrival_date = ?, arrival_time = ? WHERE id = ?`,
            [airway_bill_no, flight_no, airline || null, arrival_date || null, (arrival_time && arrival_time.trim() !== '') ? arrival_time : null, shipment.id] //
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
            if (shipment.airline !== airline) changes.push(`Airline changed from '${shipment.airline || ''}' to '${airline}'`);
            if (dayjs(shipment.arrival_date).format('YYYY-MM-DD') !== arrival_date) changes.push(`Arrival Date changed`);
            if (shipment.arrival_time !== arrival_time) changes.push(`Arrival Time changed`);
            // You could add item change detection here if needed in the future.

            await addHistory(conn, {
                module: 'shipment', moduleId: shipment.id, userId: userId,
                action: 'UNDERLOADING_DETAILS_UPDATED',
                details: { changes: changes.join('; ') || 'Product details updated.' }
            });
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

/* ---------- move to sailed (4) with confirmed details and docs ---------- */
router.post("/:shipUniqid/sail", upload.any(), async (req, res) => {
    const { shipUniqid } = req.params;
    const userId = req.session?.user?.id;
    const userName = req.session?.user?.name || 'System';
    const conn = await db.promise().getConnection();

    try {
        await conn.beginTransaction();        

        const {
            confirm_sailing_date, confirm_vessel_name, confirm_eta_date, bl_no, confirm_shipping_line, confirm_discharge_port_agent,
            confirm_airway_bill_no, confirm_flight_no, confirm_airline, confirm_arrival_date, confirm_arrival_time, 
            is_mofa_required, original_doc_receipt_mode, doc_receipt_person_name, doc_receipt_person_contact,
            doc_receipt_courier_no, doc_receipt_courier_company, doc_receipt_tracking_link,
            documents_meta,
            is_editing // New flag from the frontend
        } = req.body;


        const [[shipment]] = await conn.query(`SELECT id, shipment_stage_id FROM shipment WHERE ship_uniqid = ?`, [shipUniqid]);
        if (!shipment) {
            throw new Error("Shipment not found.");
        }

        const [[po]] = await conn.query(`SELECT mode_shipment_id FROM purchase_orders WHERE id = (SELECT po_id FROM shipment WHERE id = ?)`, [shipment.id]);
        const isAir = String(po.mode_shipment_id) === '2';

        // If we are NOT editing, the shipment must be in stage 3 to proceed.
        if (!is_editing && shipment.shipment_stage_id !== 3) {
            return res.status(400).json(errPayload("Shipment must be in the 'Underloading' stage to confirm sailed details."));
        }

        // --- 1. Validate Input ---
        if (isAir) {
            if (!confirm_sailing_date || !confirm_airway_bill_no || !confirm_flight_no || !confirm_airline || !confirm_arrival_date || !confirm_arrival_time) {
                return res.status(400).json(errPayload("Departure Date, AWB No, Flight No, Airline, Arrival Date, and Arrival Time are required for Air shipments."));
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

        // --- 2. Fetch old values for history comparison ---
        const [[oldShipmentDetails]] = await conn.query(
            `SELECT etd_date, vessel_name, eta_date, bl_no,shipping_line_name, confirm_shipping_line, confirm_discharge_port_agent,
                    airway_bill_no, flight_no, airline, confirm_airway_bill_no, confirm_flight_no, confirm_airline,
                    arrival_date, arrival_time, confirm_arrival_date, confirm_arrival_time,
                    is_mofa_required, original_doc_receipt_mode, doc_receipt_person_name, doc_receipt_person_contact,
                    doc_receipt_courier_no, doc_receipt_courier_company, doc_receipt_tracking_link FROM shipment WHERE id = ?`,
            [shipment.id]
        );

        const changes = {};
        const formatDateForHistory = (dateValue) => dateValue ? dayjs(dateValue).format('DD-MMM-YYYY') : 'empty';

        // Compare Sailing Date (ETD)
        if (isAir) {
            if (formatDateForHistory(oldShipmentDetails.etd_date) !== formatDateForHistory(confirm_sailing_date)) {
                changes['Departure Date'] = { from: formatDateForHistory(oldShipmentDetails.etd_date), to: formatDateForHistory(confirm_sailing_date) };
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
            if (formatDateForHistory(oldShipmentDetails.arrival_date) !== formatDateForHistory(confirm_arrival_date)) {
                changes['Arrival Date'] = { from: formatDateForHistory(oldShipmentDetails.arrival_date), to: formatDateForHistory(confirm_arrival_date) };
            }
            if (oldShipmentDetails.arrival_time !== confirm_arrival_time) {
                changes['Arrival Time'] = { from: oldShipmentDetails.arrival_time || 'empty', to: confirm_arrival_time };
            }
        } else {
            if (formatDateForHistory(oldShipmentDetails.etd_date) !== formatDateForHistory(confirm_sailing_date)) {
                changes['Sailing Date (ETD)'] = { from: formatDateForHistory(oldShipmentDetails.etd_date), to: formatDateForHistory(confirm_sailing_date) };
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
        }

        if (String(oldShipmentDetails.is_mofa_required) !== String(is_mofa_required)) {
            changes['MOFA Required'] = { from: oldShipmentDetails.is_mofa_required ? 'Yes' : 'No', to: is_mofa_required ? 'Yes' : 'No' };
        }

        // --- 2. Update Shipment with Confirmed Details ---
        if (isAir) {
            await conn.query(
                `UPDATE shipment SET 
                    sailing_date = ?,
                    confirm_airway_bill_no = ?, confirm_flight_no = ?, confirm_airline = ?,
                    confirm_arrival_date = ?, confirm_arrival_time = ?, is_mofa_required = ?,
                    original_doc_receipt_mode = ?, doc_receipt_person_name = ?, doc_receipt_person_contact = ?,
                    doc_receipt_courier_no = ?, doc_receipt_courier_company = ?, doc_receipt_tracking_link = ?
                 WHERE id = ?`, 
                [
                    confirm_sailing_date, confirm_airway_bill_no, confirm_flight_no, confirm_airline, 
                    confirm_arrival_date, (confirm_arrival_time && confirm_arrival_time.trim() !== '') ? confirm_arrival_time : null, is_mofa_required,
                    original_doc_receipt_mode || null, doc_receipt_person_name || null, doc_receipt_person_contact || null,
                    doc_receipt_courier_no || null, doc_receipt_courier_company || null, doc_receipt_tracking_link || null,
                    shipment.id
                ]
            );
        } else {
            await conn.query(
                `UPDATE shipment SET 
                    sailing_date = ?,
                    confirm_vessel_name = ?,
                    eta_date = ?, bl_no = ?,
                    confirm_shipping_line = ?, confirm_discharge_port_agent = ?, is_mofa_required = ?,
                    original_doc_receipt_mode = ?, doc_receipt_person_name = ?, doc_receipt_person_contact = ?,
                    doc_receipt_courier_no = ?, doc_receipt_courier_company = ?, doc_receipt_tracking_link = ?
                 WHERE id = ?`, 
                [
                    confirm_sailing_date, confirm_vessel_name, confirm_eta_date,
                    bl_no, confirm_shipping_line, confirm_discharge_port_agent, 
                    is_mofa_required,
                    original_doc_receipt_mode || null, doc_receipt_person_name || null, doc_receipt_person_contact || null,
                    doc_receipt_courier_no || null, doc_receipt_courier_company || null, doc_receipt_tracking_link || null,
                    shipment.id
                ]
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

  if (!containerNo) return res.status(400).json({ ok: false, error: 'Container number is required.' });
  if (!shipmentContainerId) return res.status(400).json({ ok: false, error: 'scId (shipment_container_id) is required.' });

  try {
    // 1) Try cache (within last 3 hours)
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

    // 2) Cache miss -> fetch live
    const live = await fetchContainerDataFromDubaiTrade(containerNo);
    if (!live || !live.containerNumber) {
      return res.status(502).json({ ok: false, error: 'Failed to fetch from Dubai Trade.' });
    }

    // 3) Upsert
    // Use the centralized save function to ensure consistency with the cron job
    await saveOrUpdateContainerData(pool, containerNo, live, shipmentId, shipmentContainerId);

    return res.json({
      ok: true,
      source: 'live',
      lastFetchedAt: new Date().toISOString(),
      data: live,
    });
  } catch (err) {
    console.error('DubaiTrade status error:', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

export default router;