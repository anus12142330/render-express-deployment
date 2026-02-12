import express from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import fs from 'fs/promises';
import db from '../db.js';
import dayjs from 'dayjs';

const router = express.Router();

const driverStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadPath = file.fieldname === 'photo' ? 'uploads/drivers/photos' : 'uploads/drivers/documents';
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const name = crypto.randomBytes(16).toString('hex');
        cb(null, name + ext);
    }
});

const upload = multer({ storage: driverStorage }).fields([
    { name: 'photo', maxCount: 1 },
    { name: 'documents', maxCount: 10 }
]);

// Create a separate multer middleware for single attachment uploads
const attachmentUpload = multer({ storage: driverStorage }).single('file');


const q = async (sql, params = []) => (await db.promise().query(sql, params))[0];

const asArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
// Normalize to DATE-only string (avoid timezone shifts)
const normDate = (s) => {
  if (!s) return null;
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};

// Make paths URL-safe (Windows -> web)
const safePath = (p) => (p ? String(p).replace(/\\/g, '/') : null);


// GET all drivers/helpers
router.get('/', async (req, res, next) => {
    // Handle request for a simplified list for dropdowns
    if (req.query.select === '1') {
        try {
            const { type } = req.query; // 'driver' or 'helper'
            const whereClauses = ["is_deleted = 0"];
            const params = [];

            if (type) {
                whereClauses.push("type = ?");
                params.push(type);
            }

            const data = await q(`SELECT id, name FROM drivers WHERE ${whereClauses.join(' AND ')} ORDER BY name ASC`, params);
            return res.json(data);
        } catch (error) { return next(error); }
    }
    try {
        const drivers = await q('SELECT * FROM drivers WHERE is_deleted = 0');
        res.json(drivers);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch drivers', details: err.message });
    }
});

// GET a single driver by ID
router.get('/:id', async (req, res) => {
  try {
    const [driver] = await q('SELECT * FROM drivers WHERE id = ? AND is_deleted = 0', [req.params.id]);
    if (!driver) return res.status(404).json({ error: 'Driver not found' }); 

    const [documents, emergency_contacts] = await Promise.all([
      q(
      // Use the same alias as Fleet for consistency
      'SELECT id, driver_id, document_path as file_path, document_type as attachment_name, DATE_FORMAT(expiry_date, "%Y-%m-%d") AS expiry_date, mime_type, size_bytes FROM driver_documents WHERE driver_id = ?',
      [req.params.id]
      ),
      q(
        'SELECT * FROM driver_emergency_contacts WHERE driver_id = ?',
        [req.params.id]
      )
    ]);

    // The frontend expects the attachments array to be named 'attachments'
    const attachments = documents;
    res.json({ ...driver, attachments, emergency_contacts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch driver', details: err.message });
  }
});

// GET a single driver by UNIQID
// --- keep this near the top, BEFORE '/:id'
router.get('/by-uniqid/:uniqid', async (req, res) => {
  try {
    const { uniqid } = req.params;
    const { with_history } = req.query;

    const [driver] = await q(
      'SELECT * FROM drivers WHERE uniqid = ? AND is_deleted = 0',
      [uniqid]
    );
    if (!driver) return res.status(404).json({ error: 'Driver not found' });

    const [documents, emergency_contacts] = await Promise.all([
      q(
        'SELECT id, driver_id, document_path as file_path, document_type as attachment_name, DATE_FORMAT(expiry_date, "%Y-%m-%d") AS expiry_date, mime_type, size_bytes FROM driver_documents WHERE driver_id = ?',
        [driver.id]
      ),
      q(
        'SELECT * FROM driver_emergency_contacts WHERE driver_id = ?',
        [driver.id]
      )
    ]);

    // Try driver_history first; fall back to empty if table/column not present
    let history = [];
    if (with_history) {
      try {
        // Adjust the table/column below to your actual schema if needed.
        history = await q(
          "SELECT h.*, u.name as user_name FROM history h LEFT JOIN user u ON u.id = h.user_id WHERE h.module = 'drivers' AND h.module_id = ? ORDER BY h.created_at DESC",
          [driver.id]
        );
      } catch (e) {
        // If driver_history doesn't exist or column missing, ignore gracefully
        history = [];
      }
    }

    const attachments = documents;
    res.json({ ...driver, attachments, history, emergency_contacts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch driver by uniqid', details: err.message });
  }
});

// POST a new driver
router.post('/', upload, async (req, res) => {
    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();
        const uniqid = crypto.randomUUID();
        const { 
            name, employee_id, type, contact_number, email, address, 
            nationality, blood_group, tag_id, date_of_birth, 
            license_number, license_issue_date, license_expiry_date,
            emergency_contacts: emergencyContactsJson
        } = req.body;
        
        let photoPath = null;
        let thumbnailPath = null;
        if (req.files?.photo?.[0]) {
            const originalPath = req.files.photo[0].path;
            photoPath = originalPath; // Keep the original path reference
            const thumbnailDir = path.join('uploads', 'drivers', 'photos', 'thumbnails');
            await fs.mkdir(thumbnailDir, { recursive: true });
            thumbnailPath = path.join(thumbnailDir, req.files.photo[0].filename);

            // Process image in buffer to avoid file lock issues
            const processedImageBuffer = await sharp(originalPath)
                .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 85 })
                .toBuffer();
            await fs.writeFile(originalPath, processedImageBuffer); // Overwrite original with processed

            // Create thumbnail from the processed buffer
            await sharp(processedImageBuffer)
                .resize(150, 150)
                .toFile(thumbnailPath);
        }

        const sql = `
            INSERT INTO drivers (
                uniqid, name, employee_id, type, contact_number, email, address, 
                nationality, blood_group, tag_id, date_of_birth, 
                license_number, license_issue_date, license_expiry_date, 
                photo_path, photo_thumbnail_path
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        const [result] = await conn.query(sql, [
            uniqid, name, employee_id, type, contact_number, email || null, address, 
            nationality || null, blood_group || null, tag_id || null, date_of_birth || null,
            license_number || null, license_issue_date || null, license_expiry_date || null,
            photoPath, thumbnailPath
        ]);
        const driverId = result.insertId;

        // Handle emergency contacts
        if (emergencyContactsJson) {
            const emergencyContacts = JSON.parse(emergencyContactsJson);
            if (Array.isArray(emergencyContacts) && emergencyContacts.length > 0) {
                const contactValues = emergencyContacts.map(c => [driverId, c.name, c.contact_number]);
                await conn.query(
                    'INSERT INTO driver_emergency_contacts (driver_id, name, contact_number) VALUES ?',
                    [contactValues]
                );
            }
        }

        if (req.files?.documents && req.files.documents.length) {
        // Preferred: arrays from FE
        let docTypes = asArray(req.body['document_type[]']);
        let docExpiries = asArray(req.body['expiry_date[]']);

        // Fallback: old style doc_type_0 / doc_expiry_0
        if (docTypes.length === 0 && docExpiries.length === 0) {
            const tmpT = [], tmpE = [];
            for (let i = 0; i < req.files.documents.length; i++) {
            tmpT.push(req.body[`doc_type_${i}`] ?? null);
            tmpE.push(req.body[`doc_expiry_${i}`] ?? null);
            }
            docTypes = tmpT;
            docExpiries = tmpE;
        }

        const insertDocSql = `
            INSERT INTO driver_documents (driver_id, document_path, document_type, expiry_date)
            VALUES (?, ?, ?, ?)
        `;

        for (let i = 0; i < req.files.documents.length; i++) {
            const f = req.files.documents[i];
            const t = docTypes[i] ?? null;
            const d = normDate(docExpiries[i]);         // <- DATE only
            await conn.query(insertDocSql, [driverId, safePath(f.path), t, d]);
        }
        }

        // Log creation in history
        const historySql = 'INSERT INTO history (module, module_id, user_id, action, details) VALUES (?, ?, ?, ?, ?)';
        const createDetails = JSON.stringify({ name });
        await conn.query(historySql, ['drivers', driverId, req.session?.user?.id || null, 'CREATED', createDetails]);

        await conn.commit();
        res.status(201).json({ success: true, id: driverId, uniqid, message: 'Driver/Helper created successfully' });
    } catch (err) {
        await conn.rollback();
        res.status(500).json({ error: 'Failed to create driver', details: err.message });
    } finally {
        conn.release();
    }
});

// PUT to update a driver


router.put('/:id', upload, async (req, res) => {
    const { id } = req.params;
    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        // Fetch old driver data for comparison
        const [oldDriverRows] = await conn.query('SELECT * FROM drivers WHERE id = ?', [id]);
        if (!oldDriverRows.length) {
            return res.status(404).json({ error: 'Driver not found' });
        }
        const oldDriver = oldDriverRows[0];
        const { 
            name, employee_id, type, contact_number, email, address, 
            nationality, blood_group, tag_id, date_of_birth, 
            license_number, license_issue_date, license_expiry_date,
            emergency_contacts: emergencyContactsJson, // This is a JSON string
            updated_documents: updatedDocumentsJson, // This is a JSON string
            deleted_documents,
            new_documents_meta: newDocumentsMetaJson // New field for new docs
        } = req.body;

        let photoPath = req.body.existing_photo_path || null; // Keep existing photo by default
        let thumbnailPath = req.body.existing_photo_thumbnail_path || null;

        if (req.files?.photo?.[0]) {
            const uploadedFile = req.files.photo[0];
            photoPath = uploadedFile.path; // Keep the original path reference
            const thumbnailDir = path.join('uploads', 'drivers', 'photos', 'thumbnails');
            await fs.mkdir(thumbnailDir, { recursive: true });
            thumbnailPath = path.join(thumbnailDir, uploadedFile.filename);

            // --- FIX: Read file into buffer ONCE to avoid file lock issues on Windows ---
            const inputFileBuffer = await fs.readFile(uploadedFile.path);

            // Process the main image from the buffer
            const processedImageBuffer = await sharp(inputFileBuffer)
                .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 85 })
                .toBuffer();
            await fs.writeFile(uploadedFile.path, processedImageBuffer); // Overwrite original with processed version

            // Create the thumbnail from the same initial buffer
            await sharp(inputFileBuffer).resize(150, 150).toFile(thumbnailPath);
        }

        // Compare fields and build changes array for history
        const changes = [];
        const fieldsToCompare = {
            name, employee_id, type, contact_number, email, address,
            nationality, blood_group, tag_id, date_of_birth,
            license_number, license_issue_date, license_expiry_date
        };

        for (const key in fieldsToCompare) {
            const oldValue = oldDriver[key];
            const newValue = fieldsToCompare[key];
            const dateFields = ['date_of_birth', 'license_issue_date', 'license_expiry_date'];

            let fromValue = dateFields.includes(key) && oldValue ? dayjs(oldValue).format('YYYY-MM-DD') : oldValue;
            let toValue = newValue;

            if (String(fromValue || '') !== String(toValue || '')) {
                changes.push({ field: key.replace(/_/g, ' '), from: fromValue, to: toValue });
            }
        }


        const sql = `
            UPDATE drivers SET 
                name = ?, employee_id = ?, type = ?, contact_number = ?, email = ?, address = ?, 
                nationality = ?, blood_group = ?, tag_id = ?, date_of_birth = ?, 
                license_number = ?, license_issue_date = ?, license_expiry_date = ?, 
                photo_path = ?, photo_thumbnail_path = ?
            WHERE id = ?
        `;
        await conn.query(sql, [
            name, employee_id, type, contact_number, email || null, address, 
            nationality || null, blood_group || null, tag_id || null, date_of_birth || null,
            license_number || null, license_issue_date || null, license_expiry_date || null,
            photoPath, thumbnailPath, 
            id
        ]);

        // Easiest way to handle contact updates: delete all and re-insert
        await conn.query('DELETE FROM driver_emergency_contacts WHERE driver_id = ?', [id]);
        if (emergencyContactsJson) {
            const emergencyContacts = JSON.parse(emergencyContactsJson);
            if (Array.isArray(emergencyContacts) && emergencyContacts.length > 0) {
                const contactValues = emergencyContacts.map(c => [id, c.name, c.contact_number]);
                await conn.query(
                    'INSERT INTO driver_emergency_contacts (driver_id, name, contact_number) VALUES ?',
                    [contactValues]
                );
            }
        }

        // Handle updates to existing documents
        if (updatedDocumentsJson) {
            const updatedDocuments = JSON.parse(updatedDocumentsJson);
            if (Array.isArray(updatedDocuments) && updatedDocuments.length > 0) {
                const updatePromises = updatedDocuments.map(doc => {
                    return conn.query(
                        'UPDATE driver_documents SET document_type = ?, expiry_date = ? WHERE id = ?',
                       [doc.document_type, normDate(doc.expiry_date) || null, doc.id]
                    );
                });
                await Promise.all(updatePromises);
            }
        }

        // Handle NEW documents added during an update
        if (req.files?.documents && req.files.documents.length) {
            const newDocsMeta = JSON.parse(newDocumentsMetaJson || '[]');
            const insertDocSql = `
                INSERT INTO driver_documents (driver_id, document_path, document_type, expiry_date)
                VALUES (?, ?, ?, ?)
            `;

            for (let i = 0; i < req.files.documents.length; i++) {
                const file = req.files.documents[i];
                const meta = newDocsMeta[i] || {};
                const docName = meta.name || file.originalname;
                await conn.query(insertDocSql, [id, safePath(file.path), docName, normDate(meta.expiry_date)]);
            }
        }


        // Handle deleted documents
        if (deleted_documents) {
            const docIds = JSON.parse(deleted_documents);
            if (docIds.length > 0) {
                await conn.query('DELETE FROM driver_documents WHERE id IN (?)', [docIds]);
            }
        }

        // Log the changes if any
        if (changes.length > 0) {
            const historySql = 'INSERT INTO history (module, module_id, user_id, action, details) VALUES (?, ?, ?, ?, ?)';
            await conn.query(historySql, ['drivers', id, req.session?.user?.id || null, 'UPDATED', JSON.stringify({ changes })]);
        }

        await conn.commit();
        res.json({ success: true, message: 'Driver/Helper updated successfully' });
    } catch (err) {
        await conn.rollback();
        res.status(500).json({ error: 'Failed to update driver', details: err.message });
    } finally {
        conn.release();
    }
});

// DELETE a driver (soft delete)
router.delete('/:id', async (req, res) => {
    try {
        const [driver] = await q('SELECT name FROM drivers WHERE id = ?', [req.params.id]);
        await q('UPDATE drivers SET is_deleted = 1 WHERE id = ?', [req.params.id]);

        // Log deletion in history
        const historySql = 'INSERT INTO history (module, module_id, user_id, action, details) VALUES (?, ?, ?, ?, ?)';
        const details = JSON.stringify({ name: driver?.name || `ID ${req.params.id}` });
        await db.promise().query(historySql, ['drivers', req.params.id, req.session?.user?.id || null, 'DELETED', details]);
        res.json({ success: true, message: 'Driver/Helper deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete driver', details: err.message });
    }
});

export default router;

// --- ATTACHMENT ROUTES ---

// POST a new attachment
router.post('/upload', attachmentUpload, async (req, res) => {
    const { driver_id, attachment_name, expiry_date } = req.body;
    const file = req.file;

    if (!file || !driver_id) {
        return res.status(400).json({ error: 'Driver ID and file are required.' });
    }

    try {
        const sql = 'INSERT INTO driver_documents (driver_id, document_path, document_type, expiry_date, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?, ?)';
        const normalizedPath = file.path.replace(/\\/g, '/');
        const [result] = await db.promise().query(sql, [driver_id, normalizedPath, attachment_name || file.originalname, expiry_date || null, file.mimetype, file.size]);

        const historySql = 'INSERT INTO history (module, module_id, user_id, action, details) VALUES (?, ?, ?, ?, ?)';
        const details = JSON.stringify({ file_name: attachment_name || file.originalname, attachment_id: result.insertId });
        await db.promise().query(historySql, ['drivers', driver_id, req.session?.user?.id || null, 'ATTACHMENT_ADDED', details]);

        res.status(201).json({ success: true, message: 'Attachment uploaded successfully.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save attachment', details: err.message });
    }
});

// POST to update an attachment
router.post('/attachment/:id', attachmentUpload, async (req, res) => {
    const { id } = req.params;
    const { attachment_name, expiry_date } = req.body;
    const file = req.file;

    const [oldDoc] = await q('SELECT driver_id, document_type FROM driver_documents WHERE id = ?', [id]);

    try {
        let sql = 'UPDATE driver_documents SET document_type = ?, expiry_date = ?';
        const params = [attachment_name, expiry_date || null];

        if (file) {
            sql += ', document_path = ?, mime_type = ?, size_bytes = ?';
            params.push(safePath(file.path), file.mimetype, file.size);
        }
        sql += ' WHERE id = ?';
        params.push(id);
        await q(sql, params);
        
        const historySql = 'INSERT INTO history (module, module_id, user_id, action, details) VALUES (?, ?, ?, ?, ?)';
        const details = JSON.stringify({ file_name: attachment_name, from_name: oldDoc?.document_type, attachment_id: id });
        await db.promise().query(historySql, ['drivers', oldDoc?.driver_id, req.session?.user?.id || null, 'ATTACHMENT_UPDATED', details]);

        res.json({ success: true, message: 'Attachment updated successfully.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update attachment', details: err.message });
    }
});

// DELETE an attachment
router.delete('/attachment/:id', async (req, res) => {
    const { id } = req.params;
    const [doc] = await q('SELECT driver_id, document_type FROM driver_documents WHERE id = ?', [id]);
    if (!doc) return res.status(404).json({ error: 'Attachment not found' });

    await q('DELETE FROM driver_documents WHERE id = ?', [id]);

    const historySql = 'INSERT INTO history (module, module_id, user_id, action, details) VALUES (?, ?, ?, ?, ?)';
    const details = JSON.stringify({ file_name: doc.document_type, attachment_id: id });
    await db.promise().query(historySql, ['drivers', doc.driver_id, req.session?.user?.id || null, 'ATTACHMENT_DELETED', details]);

    res.json({ success: true, message: 'Attachment deleted.' });
});

/*
-- Database Schema for Drivers/Helpers

CREATE TABLE `drivers` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `uniqid` varchar(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `employee_id` varchar(50) DEFAULT NULL,
  `type` enum('driver','helper') NOT NULL DEFAULT 'driver',
  `license_number` varchar(100) DEFAULT NULL,
  `license_expiry` date DEFAULT NULL,
  `contact_number` varchar(50) DEFAULT NULL,
  `address` text DEFAULT NULL,
  `photo_path` varchar(255) DEFAULT NULL,
  `photo_thumbnail_path` varchar(255) DEFAULT NULL,
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniqid` (`uniqid`)
) ENGINE=InnoDB;

CREATE TABLE `driver_documents` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `driver_id` int(11) NOT NULL,
  `document_path` varchar(255) NOT NULL,
  `document_type` varchar(100) DEFAULT NULL,
  `expiry_date` date DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `driver_id` (`driver_id`),
  CONSTRAINT `driver_documents_ibfk_1` FOREIGN KEY (`driver_id`) REFERENCES `drivers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

*/
