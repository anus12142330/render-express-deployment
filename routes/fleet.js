import express from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import db from '../db.js';
import sharp from 'sharp';

const router = express.Router();

const fleetStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadPath = file.fieldname === 'vehicle_images' ? 'uploads/fleet/images' : 'uploads/fleet/documents';
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const name = crypto.randomBytes(16).toString('hex');
        cb(null, name + ext);
    }
});

const upload = multer({ storage: fleetStorage }).fields([
    { name: 'vehicle_images', maxCount: 10 },
    { name: 'vehicle_documents', maxCount: 10 }
]);

// Create a separate multer middleware for single attachment uploads
const attachmentUpload = multer({ storage: fleetStorage }).single('file');

const q = async (sql, params = []) => (await db.promise().query(sql, params))[0];

// POST a new attachment
router.post('/upload', attachmentUpload, async (req, res) => {
    const { fleet_id, attachment_name, expiry_date } = req.body;
    const file = req.file;

    if (!file || !fleet_id) {
        return res.status(400).json({ error: 'Fleet ID and file are required.' });
    }

    try {
        const normalizedPath = file.path.replace(/\\/g, '/');
        let thumbnailPath = null;

        // Generate thumbnail if it's an image
        if (file.mimetype.startsWith('image/')) {
            const thumbFilename = `thumb-${file.filename}`;
            const thumbFullPath = path.join(file.destination, thumbFilename);
            await sharp(file.path).resize(100, 100).toFile(thumbFullPath);
            thumbnailPath = thumbFullPath.replace(/\\/g, '/');
        }

        const sql = 'INSERT INTO fleet_documents (fleet_id, document_path, thumbnail_path, name, expiry_date, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)';
        
        const [result] = await db.promise().query(sql, [fleet_id, normalizedPath, thumbnailPath, attachment_name || file.originalname, expiry_date || null, file.mimetype, file.size]);

        const historySql = 'INSERT INTO history (module, module_id, user_id, action, details) VALUES (?, ?, ?, ?, ?)';
        const details = JSON.stringify({ file_name: attachment_name || file.originalname, attachment_id: result.insertId });
        await db.promise().query(historySql, ['fleets', fleet_id, req.session?.user?.id || null, 'ATTACHMENT_ADDED', details]);

        res.status(201).json({ success: true, message: 'Attachment uploaded successfully.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save attachment', details: err.message });
    }
});

// POST to update an attachment (using POST because PUT with multipart/form-data can be tricky)
router.post('/attachment/:id', attachmentUpload, async (req, res) => {
    const { id } = req.params;
    const { attachment_name, expiry_date } = req.body;
    const file = req.file;

    // Get old details for history
    const [oldDocRows] = await db.promise().query('SELECT fleet_id, name FROM fleet_documents WHERE id = ?', [id]);
    const oldDoc = oldDocRows[0];

    try {
        let sql = 'UPDATE fleet_documents SET name = ?, expiry_date = ?';
        const params = [attachment_name, expiry_date || null];

        if (file) {
            let thumbnailPath = null;
            const normalizedPath = file.path.replace(/\\/g, '/');

            // Generate thumbnail if it's an image
            if (file.mimetype.startsWith('image/')) {
                const thumbFilename = `thumb-${file.filename}`;
                const thumbFullPath = path.join(file.destination, thumbFilename);
                await sharp(file.path).resize(100, 100).toFile(thumbFullPath);
                thumbnailPath = thumbFullPath.replace(/\\/g, '/');
            }
            sql += ', document_path = ?, thumbnail_path = ?, mime_type = ?, size_bytes = ?';
            params.push(normalizedPath, thumbnailPath, file.mimetype, file.size);
        }

        sql += ' WHERE id = ?';
        params.push(id);

        await q(sql, params);

        const historySql = 'INSERT INTO history (module, module_id, user_id, action, details) VALUES (?, ?, ?, ?, ?)';
        const details = JSON.stringify({ file_name: attachment_name, from_name: oldDoc?.name, attachment_id: id });
        await db.promise().query(historySql, ['fleets', oldDoc?.fleet_id, req.session?.user?.id || null, 'ATTACHMENT_UPDATED', details]);

        res.json({ success: true, message: 'Attachment updated successfully.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update attachment', details: err.message });
    }
});

// DELETE an attachment
router.delete('/attachment/:id', async (req, res) => {
    const { id } = req.params;
    // Get details for history before deleting
    const [docRows] = await db.promise().query('SELECT fleet_id, name FROM fleet_documents WHERE id = ?', [id]);
    const doc = docRows[0];

    await q('DELETE FROM fleet_documents WHERE id = ?', [id]);

    if (doc) {
        const historySql = 'INSERT INTO history (module, module_id, user_id, action, details) VALUES (?, ?, ?, ?, ?)';
        const details = JSON.stringify({ file_name: doc.name, attachment_id: id });
        await db.promise().query(historySql, ['fleets', doc.fleet_id, req.session?.user?.id || null, 'ATTACHMENT_DELETED', details]);
    }
    res.json({ success: true, message: 'Attachment deleted.' });
});

// GET all fleets
router.get('/', async (req, res, next) => {

    // Handle request for a simplified list for dropdowns
    if (req.query.select === '1') {
        try {
            const data = await q(`
                SELECT id, vehicle_name as name 
                FROM fleets 
                WHERE  is_active=1 AND is_deleted = 0 
                ORDER BY vehicle_name ASC`
            );
            return res.json(data);
        } catch (error) { return next(error); }
    }
    try {
        const sql = `
            SELECT
                f.id, f.vehicle_name, f.plate_number, f.brand, f.model, f.is_active, f.tc_no, f.ownership_type, f.owner_company_name, f.vehicle_type_id,
                fi.thumbnail_path AS thumbnail
            FROM fleets f
            LEFT JOIN fleet_images fi ON f.id = fi.fleet_id AND fi.is_primary = 1
            WHERE f.is_deleted = 0
        `;
        const fleets = await q(sql);
        res.json(fleets);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch fleets', details: err.message });
    }
});

// GET a single fleet by ID
router.get('/:id', async (req, res) => {
    try {
        const [fleet] = await q('SELECT * FROM fleets WHERE id = ? AND is_deleted = 0', [req.params.id]);
        if (!fleet) {
            return res.status(404).json({ error: 'Fleet not found' });
        }
        
        const history = await q('SELECT h.*, u.name as user_name FROM history h LEFT JOIN user u ON u.id = h.user_id WHERE h.module = "fleets" AND h.module_id = ? ORDER BY h.created_at DESC', [req.params.id]);
        const images = await q('SELECT * FROM fleet_images WHERE fleet_id = ?', [req.params.id]);
        
        // The frontend is expecting the attachments array to be named 'attachments'
        // The table is named 'fleet_documents', so we alias it here.
        const attachments = await q('SELECT id, fleet_id, document_path as file_path, thumbnail_path, name as attachment_name, DATE_FORMAT(expiry_date, "%Y-%m-%d") AS expiry_date, mime_type, size_bytes, category FROM fleet_documents WHERE fleet_id = ?', [req.params.id]);

        // Combine and send
        res.json({ ...fleet, images, attachments, history });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch fleet', details: err.message });
    }
});

// POST a new fleet
router.post('/', upload, async (req, res) => {
    const conn = await db.promise().getConnection();
    try {
        const {
            vehicle_name, vehicle_type_id, brand, model, chassis_number,
            plate_number, registration_date, registration_expiry_date, tc_no,
            insurance_company, insurance_name, insurance_expiry_date, insurance_issue_date,
            ownership_type, owner_company_id, owner_company_name, starting_km, vehicle_service_km
        } = req.body;
        let { primary_image } = req.body;

        // If no primary image is selected by the user, and there are images,
        // make the first one primary by default.
        const images = req.files.vehicle_images;
        if (!primary_image && images && images.length > 0) {
            primary_image = images[0].originalname;
        }

        await conn.beginTransaction();

        const fleetSql = `
            INSERT INTO fleets (
                vehicle_name, vehicle_type_id, brand, model, chassis_number,
                plate_number, registration_date, registration_expiry_date, tc_no,
                insurance_company, insurance_name, insurance_expiry_date, insurance_issue_date,
                ownership_type, owner_company_id, owner_company_name, starting_km, vehicle_service_km
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        const [result] = await conn.query(fleetSql, [
            vehicle_name, vehicle_type_id, brand, model, chassis_number,
            plate_number, registration_date || null, registration_expiry_date || null, tc_no,
            insurance_company, insurance_name, insurance_expiry_date || null, insurance_issue_date || null,
            ownership_type,
            ownership_type === 'owned' ? (owner_company_id || null) : null,
            ownership_type === 'rented' ? (owner_company_name || null) : null,
            starting_km, vehicle_service_km || null
        ]);

        const fleetId = result.insertId;

        // Log creation in history
        const historySql = 'INSERT INTO history (module, module_id, user_id, action, details) VALUES (?, ?, ?, ?, ?)';
        const details = JSON.stringify({ vehicle_name });
        await conn.query(historySql, ['fleets', fleetId, req.session?.user?.id || null, 'CREATED', details]);

        // Handle vehicle images
        if (images && images.length > 0) {
            const imagePromises = images.map(async (file) => {
                const thumbnailFilename = `thumb-${file.filename}`;
                const thumbnailPath = path.join(file.destination, thumbnailFilename);

                await sharp(file.path)
                    .resize(200, 200) // Resize to 200x200 pixels
                    .toFile(thumbnailPath);

                const normalizedPath = file.path.replace(/\\/g, '/');
                const normalizedThumbPath = thumbnailPath.replace(/\\/g, '/');

                const isPrimary = file.originalname === primary_image;

                const imageSql = 'INSERT INTO fleet_images (fleet_id, image_path, thumbnail_path, is_primary) VALUES (?, ?, ?, ?)';
                return conn.query(imageSql, [fleetId, normalizedPath, normalizedThumbPath, isPrimary]);
            });
            await Promise.all(imagePromises);

            // After inserting images, find the path of the primary one and update the fleets table
            const primaryImageRecord = await conn.query('SELECT image_path FROM fleet_images WHERE fleet_id = ? AND is_primary = 1', [fleetId]);
            if (primaryImageRecord[0].length > 0) {
                await conn.query('UPDATE fleets SET primary_image = ? WHERE id = ?', [primaryImageRecord[0][0].image_path, fleetId]);
            }
        }

        // Handle vehicle documents
        if (req.files.vehicle_documents) {
            const newDocsMeta = JSON.parse(req.body.new_documents_meta || '[]');
            if (req.files.vehicle_documents.length === newDocsMeta.length) {
                const docPromises = req.files.vehicle_documents.map((file, index) => {
                    let thumbnailPath = null;
                    if (file.mimetype.startsWith('image/')) {
                        const thumbFilename = `thumb-${file.filename}`;
                        const thumbFullPath = path.join(file.destination, thumbFilename);
                        sharp(file.path).resize(100, 100).toFile(thumbFullPath); // Fire and forget for performance
                        thumbnailPath = thumbFullPath.replace(/\\/g, '/');
                    }

                    const meta = newDocsMeta[index]; // meta.name is the doc.type from frontend (e.g., "Registration Document")
                    const docSql = 'INSERT INTO fleet_documents (fleet_id, document_path, thumbnail_path, name, expiry_date, category, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
                    const normalizedPath = file.path.replace(/\\/g, '/');
                    return conn.query(docSql, [fleetId, normalizedPath, thumbnailPath, meta.name, meta.expiry_date || null, meta.category, file.mimetype, file.size]);
                });
                await Promise.all(docPromises);
            }
        }

        await conn.commit();
        res.status(201).json({ success: true, id: fleetId, message: 'Fleet created successfully' });

    } catch (err) {
        await conn.rollback();
        res.status(500).json({ error: 'Failed to create fleet', details: err.message });
    } finally {
        conn.release();
    }
});

// PUT to update a fleet
router.put('/:id', upload, async (req, res) => {
    const { id } = req.params;
    const conn = await db.promise().getConnection();
    try {
        // 1. Fetch old fleet data for comparison
        const [oldFleetRows] = await conn.query('SELECT f.*, vt.name as vehicle_type_name FROM fleets f LEFT JOIN master_vehicle_type vt ON f.vehicle_type_id = vt.id WHERE f.id = ?', [id]);
        if (!oldFleetRows.length) {
            return res.status(404).json({ error: 'Fleet not found' });
        }
        const oldFleet = oldFleetRows[0];

        const {
            vehicle_name, vehicle_type_id, brand, model, chassis_number,
            plate_number, registration_date, registration_expiry_date, tc_no, primary_image,
            insurance_company, insurance_name, insurance_expiry_date, insurance_issue_date, new_documents_meta, updated_documents_meta,
            ownership_type, owner_company_id, owner_company_name, starting_km, vehicle_service_km, deleted_images, deleted_documents
            } = req.body;

        // If new images are being added and there's no primary image selected (neither old nor new),
        // make the first new image the primary one.
        const newImages = req.files.vehicle_images;
        if (!primary_image && newImages && newImages.length > 0) {
            const [existingImages] = await conn.query('SELECT id FROM fleet_images WHERE fleet_id = ?', [id]);
            if (existingImages.length === 0) { // Only auto-set if no images existed before
                req.body.primary_image = newImages[0].originalname;
            }
        }
        const effectivePrimary = req.body.primary_image || primary_image || null;
        await conn.beginTransaction();

        // 2. Prepare for history logging
        const changes = [];
        const fieldsToCompare = {
            vehicle_name, vehicle_type_id, brand, model, chassis_number,
            plate_number, registration_date, registration_expiry_date, tc_no,
            insurance_company, insurance_name, insurance_expiry_date, insurance_issue_date,
            ownership_type, owner_company_id, owner_company_name, starting_km, vehicle_service_km
        };

        // Fetch new vehicle type name if ID changed
        let newVehicleTypeName = oldFleet.vehicle_type_name;
        if (String(oldFleet.vehicle_type_id) !== String(vehicle_type_id)) {
            const [newTypeRows] = await conn.query('SELECT name FROM master_vehicle_type WHERE id = ?', [vehicle_type_id]);
            newVehicleTypeName = newTypeRows[0]?.name || `ID ${vehicle_type_id}`;
        }

        // 3. Compare fields and build changes array
        for (const key in fieldsToCompare) {
            const oldValue = oldFleet[key];
            const newValue = fieldsToCompare[key];
            const dateFields = ['registration_date', 'registration_expiry_date', 'insurance_expiry_date', 'insurance_issue_date'];

            let fromValue = oldValue;
            let toValue = newValue;

            if (dateFields.includes(key)) {
                // Format both old and new values to YYYY-MM-DD for comparison and logging.
                // The issue is that new Date(oldValue) can be affected by the server's timezone.
                // To get the correct YYYY-MM-DD, we create a date, get the timezone offset, and adjust.
                if (oldValue) {
                    const d = new Date(oldValue);
                    fromValue = new Date(d.getTime() - (d.getTimezoneOffset() * 60000)).toISOString().split('T')[0];
                } else {
                    fromValue = null;
                }
                toValue = newValue || null;
            } else if (key === 'vehicle_type_id') {
                fromValue = oldFleet.vehicle_type_name || 'N/A';
                toValue = newVehicleTypeName;
            }
            if (String(fromValue || '') !== String(toValue || '')) {
                changes.push({ field: key.replace(/_/g, ' '), from: fromValue, to: toValue });
            }
        }

        const fleetSql = `
            UPDATE fleets SET
                vehicle_name = ?, vehicle_type_id = ?, brand = ?, model = ?, chassis_number = ?,
                plate_number = ?, registration_date = ?, registration_expiry_date = ?, tc_no = ?,
                insurance_company = ?, insurance_name = ?, insurance_expiry_date = ?, insurance_issue_date = ?,
                ownership_type = ?, owner_company_id = ?, owner_company_name = ?, starting_km = ?, vehicle_service_km = ?
            WHERE id = ?
        `;
        await conn.query(fleetSql, [
            vehicle_name, vehicle_type_id, brand, model, chassis_number,
            plate_number, registration_date || null, registration_expiry_date || null, tc_no,
            insurance_company, insurance_name, insurance_expiry_date || null, insurance_issue_date || null,
            ownership_type,
            ownership_type === 'owned' ? (owner_company_id || null) : null,
            ownership_type === 'rented' ? (owner_company_name || null) : null,
            starting_km, vehicle_service_km || null, id
        ]);

        // 4. Log the changes if any
        if (changes.length > 0) {
            const historySql = 'INSERT INTO history (module, module_id, user_id, action, details) VALUES (?, ?, ?, ?, ?)';
            await conn.query(historySql, ['fleets', id, req.session?.user?.id || null, 'UPDATED', JSON.stringify({ changes })]);
        }

        // Handle new images
        if (req.files.vehicle_images) {
            const imagePromises = req.files.vehicle_images.map(async (file) => {
                const thumbnailFilename = `thumb-${file.filename}`;
                const thumbnailPath = path.join(file.destination, thumbnailFilename);

                await sharp(file.path)
                    .resize(200, 200)
                    .toFile(thumbnailPath);

                const normalizedPath = file.path.replace(/\\/g, '/');
                const normalizedThumbPath = thumbnailPath.replace(/\\/g, '/');
                const isPrimary = file.originalname === primary_image;

                const imageSql = 'INSERT INTO fleet_images (fleet_id, image_path, thumbnail_path, is_primary) VALUES (?, ?, ?, ?)';
                return conn.query(imageSql, [id, normalizedPath, normalizedThumbPath, isPrimary]);
            });
            await Promise.all(imagePromises);
        }

        // Update primary status for existing images
       if (effectivePrimary) {
   await conn.query('UPDATE fleet_images SET is_primary = 0 WHERE fleet_id = ?', [id]);

   // Case A: existing image -> we receive full stored path (starts with "uploads/")
   if (String(effectivePrimary).startsWith('uploads/')) {
     await conn.query(
       'UPDATE fleet_images SET is_primary = 1 WHERE fleet_id = ? AND image_path = ?',
       [id, effectivePrimary]
     );
     await conn.query('UPDATE fleets SET primary_image = ? WHERE id = ?', [effectivePrimary, id]);
   } else {
     // Case B: newly uploaded image -> we received the ORIGINAL filename
     const match = (req.files.vehicle_images || []).find(f => f.originalname === effectivePrimary);
     if (match) {
       const normalizedPath = match.path.replace(/\\/g, '/');
       await conn.query(
         'UPDATE fleet_images SET is_primary = 1 WHERE fleet_id = ? AND image_path = ?',
         [id, normalizedPath]
       );
       await conn.query('UPDATE fleets SET primary_image = ? WHERE id = ?', [normalizedPath, id]);
    }
   }
 }

        // Handle new documents
        if (req.files.vehicle_documents) {
            const newDocsMeta = JSON.parse(req.body.new_documents_meta || '[]');
            if (req.files.vehicle_documents.length === newDocsMeta.length) {
                const docPromises = req.files.vehicle_documents.map((file, index) => {
                    let thumbnailPath = null;
                    if (file.mimetype.startsWith('image/')) {
                        const thumbFilename = `thumb-${file.filename}`;
                        const thumbFullPath = path.join(file.destination, thumbFilename);
                        sharp(file.path).resize(100, 100).toFile(thumbFullPath); // Fire and forget
                        thumbnailPath = thumbFullPath.replace(/\\/g, '/');
                    }

                    const meta = newDocsMeta[index]; // meta.name is the doc.type from frontend (e.g., "Registration Document")
                    const docSql = 'INSERT INTO fleet_documents (fleet_id, document_path, thumbnail_path, name, expiry_date, category, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
                    const normalizedPath = file.path.replace(/\\/g, '/');
                    return conn.query(docSql, [id, normalizedPath, thumbnailPath, meta.name, meta.expiry_date || null, meta.category, file.mimetype, file.size]);
                });
                await Promise.all(docPromises);
            }
        }

        // Handle updated documents metadata
        if (updated_documents_meta) {
            const updatedDocs = JSON.parse(updated_documents_meta);
            if (updatedDocs.length > 0) {
                const updateDocPromises = updatedDocs.map(doc => {
                    const updateSql = 'UPDATE fleet_documents SET name = ?, expiry_date = ?, category = ? WHERE id = ?';
                    return conn.query(updateSql, [doc.name, doc.expiry_date || null, doc.category, doc.id]);
                });
                await Promise.all(updateDocPromises);
            }
        }

        // Handle deleted images
        if (deleted_images) {
            const imageIds = JSON.parse(deleted_images);
            if (imageIds.length > 0) {
                await conn.query('DELETE FROM fleet_images WHERE id IN (?)', [imageIds]);
            }
        }

        // Handle deleted documents
        if (deleted_documents) {
            const docIds = JSON.parse(deleted_documents);
            if (docIds.length > 0) {
               await conn.query('DELETE FROM fleet_documents WHERE id IN (?)', [docIds]);
            }
        }

        await conn.commit();
        res.json({ success: true, message: 'Fleet updated successfully' });

    } catch (err) {
        await conn.rollback();
        res.status(500).json({ error: 'Failed to update fleet', details: err.message });
    } finally {
        conn.release();
    }
});

// DELETE a fleet (soft delete)
router.delete('/:id', async (req, res) => {
    try {
        const [fleet] = await q('SELECT vehicle_name FROM fleets WHERE id = ?', [req.params.id]);
        await q('UPDATE fleets SET is_deleted = 1 WHERE id = ?', [req.params.id]);

        const historySql = 'INSERT INTO history (module, module_id, user_id, action, details) VALUES (?, ?, ?, ?, ?)';
        const details = JSON.stringify({ vehicle_name: fleet?.vehicle_name || `ID ${req.params.id}` });
        await db.promise().query(historySql, ['fleets', req.params.id, req.session?.user?.id || null, 'DELETED', details]);
        res.json({ success: true, message: 'Fleet deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete fleet', details: err.message });
    }
});

// PATCH to update a fleet's active status
router.patch('/:id/status', async (req, res) => {
    const { id } = req.params;
    const { is_active } = req.body;

    if (is_active === undefined) {
        return res.status(400).json({ error: 'is_active field is required.' });
    }

    try {
        await q('UPDATE fleets SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, id]);
        res.json({ success: true, message: 'Fleet status updated successfully.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update fleet status', details: err.message });
    }
});

export default router;


/*
-- Database Schema for Fleets

CREATE TABLE `fleets` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `imei` varchar(50) DEFAULT NULL,
  `vehicle_number` varchar(50) NOT NULL,
  `vehicle_type_id` int(11) DEFAULT NULL,
  `brand_id` int(11) DEFAULT NULL,
  `model` varchar(100) DEFAULT NULL,
  `chassis_number` varchar(100) DEFAULT NULL,
  `plate_number` varchar(50) DEFAULT NULL,
  `registration_date` date DEFAULT NULL,
  `registration_expiry_date` date DEFAULT NULL,
  `insurance_company` varchar(255) DEFAULT NULL,
  `insurance_name` varchar(255) DEFAULT NULL,
  `insurance_expiry_date` date DEFAULT NULL,
  `insurance_issue_date` date DEFAULT NULL,
  `ownership_type` enum('owned','rented') DEFAULT 'owned',
  `starting_km` decimal(10,2) DEFAULT NULL,
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB;

CREATE TABLE `fleet_images` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `fleet_id` int(11) NOT NULL,
  `image_path` varchar(255) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `fleet_id` (`fleet_id`),
  CONSTRAINT `fleet_images_ibfk_1` FOREIGN KEY (`fleet_id`) REFERENCES `fleets` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE `fleet_documents` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `fleet_id` int(11) NOT NULL,
  `document_path` varchar(255) NOT NULL,
  `document_type` varchar(100) DEFAULT NULL,
  `expiry_date` date DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `fleet_id` (`fleet_id`),
  CONSTRAINT `fleet_documents_ibfk_1` FOREIGN KEY (`fleet_id`) REFERENCES `fleets` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE `master_vehicle_type` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB;

*/
