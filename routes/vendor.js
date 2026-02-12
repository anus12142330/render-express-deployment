// server/routes/vendor.js
import express from 'express';
import db from '../db.js';
import crypto from 'crypto';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';

const router = express.Router();
const errPayload = (message, type = 'APP_ERROR', hint) => ({ error: { message, type, hint } });

// ---------- FS helpers ----------
const ensureDir = (dir) => { try { fs.mkdirSync(dir, { recursive: true }); } catch {} };
ensureDir('uploads/vendor');

// ---------- Multer ----------
const vendorStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, 'uploads/vendor'),
    filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname || '');
        const name = crypto.randomBytes(16).toString('hex');
        cb(null, name + ext);
    }
});
const uploadVendor = multer({ storage: vendorStorage });

// ---------- Constants ----------
/**
 * company_type_id: '1' => vendor
 * (matches your DB which stores company/customer in the same `vendor` table)
 */
const COMPANY_TYPE_VENDOR = '1';

/* ================================
   GET /api/document-types
================================ */
router.get('/document-types', async (req, res) => {
    try {
        const [rows] = await db.promise().query(
            `SELECT id, name, has_expiry FROM kyc_documents ORDER BY name ASC`
        );
        res.json(rows);
    } catch (err) {
        console.error('document-types:', err);
        res.status(500).json(errPayload('Failed to load document types', 'DB_ERROR', err.message));
    }
});


// Utility
const like = (s = '') => `%${s}%`;

/* ================================
   GET /api/vendors/full
   (light list for pickers/autocomplete)
================================ */
router.get('/full', async (req, res) => {
    const { search = '' } = req.query;
    try {
        const [rows] = await db.promise().query(
            `
      SELECT v.id, v.display_name AS name, v.uniqid, vo.tax_treatment_id
      FROM vendor v
      LEFT JOIN vendor_other as vo ON vo.vendor_id=v.id
      WHERE v.company_type_id = ? AND v.is_deleted = 0
        AND (v.display_name LIKE ? OR v.company_name LIKE ?)
      ORDER BY v.display_name ASC
      LIMIT 100
      `,
            [COMPANY_TYPE_VENDOR, like(search), like(search)]
        );
        res.json(rows);
    } catch (err) {
        console.error('vendors/full:', err);
        res.status(500).json(errPayload('Failed to load vendors', 'DB_ERROR', err.message));
    }
});

/* ================================
   GET /api/vendors
   (paged list with search)
================================ */
router.get('/', async (req, res) => {
    const limit = parseInt(req.query.limit || 25, 10);
    const offset = parseInt(req.query.offset || 0, 10);
    const search = String(req.query.search || '');
    const isActive = req.query.is_active;
    const userId = req.query.user_id;

    try {
        const [data] = await db.promise().query(
            `
      SELECT
        v.id,
        v.uniqid,
        v.display_name AS name,
        v.company_name,
        v.email_address AS email,
        v.phone_work,
        vo.currency_id,
        0 AS payables,
        0 AS unused_credits,
        (
          SELECT COUNT(*)
          FROM vendor_attachment va
          WHERE va.vendor_id = v.id AND va.expiry_date < CURDATE()
        ) AS expired_attachments_count,
         currency.name as currency_name
      FROM vendor v
      LEFT JOIN vendor_other as vo ON vo.vendor_id=v.id 
      LEFT JOIN currency ON currency.id=vo.currency_id      
      WHERE v.company_type_id = ?
        AND (
          v.display_name LIKE ? OR
          v.company_name LIKE ? OR
          v.email_address LIKE ? OR
          v.phone_work LIKE ?
        ) AND v.is_deleted = 0 
        ${userId ? 'AND v.user_id = ?' : ''}
        ${isActive ? 'AND v.is_active = 1' : ''}
      ORDER BY v.display_name ASC
      LIMIT ? OFFSET ?
      `,
            [COMPANY_TYPE_VENDOR, like(search), like(search), like(search), like(search)].concat(userId ? [userId] : []).concat([limit, offset])
        );

        const [countRows] = await db.promise().query(
            `
      SELECT COUNT(*) AS total
      FROM vendor v
      WHERE v.company_type_id = ?
        AND (
          v.display_name LIKE ? OR
          v.company_name LIKE ? OR
          v.email_address LIKE ? OR
          v.phone_work LIKE ?
        ) AND v.is_deleted = 0 
        ${userId ? 'AND v.user_id = ?' : ''}
        ${isActive ? 'AND v.is_active = 1' : ''}
      `,
            [COMPANY_TYPE_VENDOR, like(search), like(search), like(search), like(search)].concat(userId ? [userId] : [])
        );

        res.json({ data, total: countRows[0]?.total || 0 });
    } catch (err) {
        console.error('vendors list:', err);
        res.status(500).json(errPayload('Failed to load vendors', 'DB_ERROR', err.message));
    }
});

/* ================================
   POST /api/vendors
   (create vendor)
================================ */
router.post('/', uploadVendor.array('attachments'), async (req, res) => {
    const {
        company_name, display_name, email_address, phone_work, phone_mobile, remarks, website,
        tags, tax_treatment_id, tax_registration_number, source_supply_id,
        currency_id, payment_terms_id,
        bill_attention, bill_country_id, bill_address_1, bill_address_2,
        bill_city, bill_state_id, bill_zip_code, bill_phone, bill_fax, customer_of,
        ship_attention, ship_country_id, ship_address_1, ship_address_2,
        ship_city, ship_state_id, ship_zip_code, ship_phone, ship_fax
    } = req.body;

    const uniqid = `vnd_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const userId = req.session?.user?.id || null;
    const files = req.files || [];
    const tagsRaw = req.body.tags;

    let contactPersons = [];
    try {
        contactPersons = JSON.parse(req.body.contactPersons || '[]');
    } catch {
        return res.status(400).json(errPayload('Invalid contactPersons JSON'));
    }

    const conn = await db.promise().getConnection();
    try {
        let safeCustomerOf = (Array.isArray(customer_of) ? customer_of.join(',') : String(customer_of || ''))
            .split(',').map(s => s.trim()).filter(Boolean).join(',');

        // If customer_of is not provided, check if there's only one company
        if (!safeCustomerOf) {
            const [companies] = await conn.query('SELECT id FROM company_settings');
            if (companies.length === 1) {
                safeCustomerOf = String(companies[0].id);
            }
        }
        const safeTags = typeof tagsRaw === 'string' ? tagsRaw : JSON.stringify(tagsRaw || []);

        await conn.beginTransaction();

        // Insert core (shared table)
        const [ins] = await conn.query(
            `
      INSERT INTO vendor
        (company_name, display_name, email_address, phone_work, phone_mobile, tags, remarks, website,
         uniqid, user_id, updated_user, company_type_id, customer_of)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
            [
                company_name, display_name, email_address, phone_work, phone_mobile, safeTags, remarks, website,
                uniqid, userId, userId, COMPANY_TYPE_VENDOR, safeCustomerOf
            ]
        );
        const vendorId = ins.insertId;

        await conn.query(
            `INSERT INTO vendor_other
         (vendor_id, tax_treatment_id, tax_registration_number, source_supply_id, currency_id, payment_terms_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
            [vendorId, tax_treatment_id, tax_registration_number, source_supply_id, currency_id, payment_terms_id]
        );

        // Insert billing address into vendor_address
        await conn.query(
            `INSERT INTO vendor_address (vendor_id, bill_attention, bill_country_id, bill_address_1, bill_address_2, bill_city, bill_state_id, bill_zip_code, bill_phone, bill_fax) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [vendorId, bill_attention, bill_country_id, bill_address_1, bill_address_2, bill_city, bill_state_id, bill_zip_code, bill_phone, bill_fax]
        );

        // Insert shipping address into vendor_shipping_addresses
        await conn.query(
            `INSERT INTO vendor_shipping_addresses (vendor_id, ship_attention, ship_country_id, ship_address_1, ship_address_2, ship_city, ship_state_id, ship_zip_code, ship_phone, ship_fax, is_primary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            [vendorId, ship_attention, ship_country_id, ship_address_1, ship_address_2, ship_city, ship_state_id, ship_zip_code, ship_phone, ship_fax]
        );

        const fullAddress = [bill_address_1, bill_address_2, bill_city, bill_zip_code].filter(Boolean).join(', ');

        for (const p of contactPersons) {
            await conn.query(
                `INSERT INTO contact
           (vendor_id, is_primary, salutation_id, first_name, last_name, email, phone, mobile, skype_name_number, designation, department, customer_name, address, company_type_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    vendorId,
                    p.is_primary ? 1 : 0,
                    p.salutation_id, p.first_name, p.last_name,
                    p.email, p.phone, p.mobile,
                    p.skype_name_number, p.designation, p.department,
                    display_name, // customer_name
                    fullAddress,  // address
                    COMPANY_TYPE_VENDOR // company_type_id
                ]
            );
        }

        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const expiry = req.body[`attachment_expiry_${i}`] || null; // "YYYY-MM-DD" from UI
            const docTypeId = req.body[`attachment_doctype_${i}`] || null;
            let thumbnailPath = null;

            // Generate thumbnail if it's an image
            if (f.mimetype.startsWith('image/')) {
                const thumbFilename = `thumb-${f.filename}`;
                const thumbFullPath = path.join(f.destination, thumbFilename);
                await sharp(f.path).resize(100, 100).toFile(thumbFullPath);
                thumbnailPath = thumbFullPath.replace(/\\/g, '/');
            }

            await conn.query(
                `INSERT INTO vendor_attachment (vendor_id, attachment_path, attachment_name, expiry_date, document_type_id, thumbnail_path, mime_type, size_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [vendorId, (f.path || '').replace(/\\/g, '/'), f.originalname, expiry, docTypeId, thumbnailPath, f.mimetype, f.size]
            );
        }

        await conn.query(
            `INSERT INTO vendor_history (vendor_id, user_id, action) VALUES (?, ?, ?)`,
            [vendorId, userId, 'CREATED']
        );

        await conn.commit();
        res.json({ success: true, message: 'Vendor created successfully', vendorId, uniqid });
    } catch (err) {
        await conn.rollback();
        console.error('Create vendor failed:', err);
        res.status(500).json(errPayload('Vendor create failed', 'DB_ERROR', err.message));
    } finally {
        conn.release();
    }
});

/* ================================
   GET /api/vendors/:uniqid/full
================================ */
router.get('/:uniqid/full', async (req, res) => {
    const uniqid = req.params.uniqid;

    try {
        const [rows] = await db.promise().query(
            `
      SELECT 
        v.*,
        currency.name AS currency_name,
        tax_treatment.name AS tax_name,
        CONCAT_WS(', ', va.bill_address_1, va.bill_address_2, va.bill_city, va.bill_zip_code) AS billing_address,        
        b_state.name AS bill_state_name,
        bill_country.name AS bill_country_name,
        -- Shipping address fields will be fetched in a separate query
        vo.tax_treatment_id,
        vo.tax_registration_number,
        vo.source_supply_id,
        vo.currency_id,
        vo.payment_terms_id,
        va.bill_attention,
        va.bill_country_id,
        va.bill_address_1,
        va.bill_address_2,
        va.bill_city,
        va.bill_state_id,
        va.bill_zip_code,
        va.bill_phone,
        va.bill_fax,
        (
          SELECT COUNT(*)
          FROM vendor_attachment
          WHERE vendor_id = v.id AND expiry_date < CURDATE()
        ) AS expired_attachments_count
      FROM vendor v
      LEFT JOIN vendor_other vo ON v.id = vo.vendor_id
      LEFT JOIN vendor_address va ON v.id = va.vendor_id
      LEFT JOIN currency ON currency.id = vo.currency_id
      LEFT JOIN tax_treatment ON tax_treatment.id = vo.tax_treatment_id
      LEFT JOIN state AS b_state ON b_state.id = va.bill_state_id
      LEFT JOIN country AS bill_country ON bill_country.id = va.bill_country_id
      WHERE v.uniqid = ? AND v.company_type_id = ? AND v.is_deleted = 0
      `,
            [uniqid, COMPANY_TYPE_VENDOR]
        );

        if (!rows.length) return res.status(404).json(errPayload('Vendor not found', 'NOT_FOUND'));

        let vendorData = rows[0];
        const vendorId = vendorData.id;

        // Fetch shipping addresses from the new table
        const [shipping_addresses] = await db.promise().query(
            `SELECT 
                vsa.*,
                s.name as ship_state_name,
                c.name as ship_country_name
             FROM vendor_shipping_addresses vsa
             LEFT JOIN state s ON s.id = vsa.ship_state_id 
             LEFT JOIN country c ON c.id = vsa.ship_country_id 
             WHERE vsa.vendor_id = ? 
             ORDER BY vsa.is_primary DESC, vsa.id ASC`,
            [vendorId]
        );

        // Convert the comma-separated string from DB back to an array for the frontend
        const vendor = {
            ...vendorData,
            shipping_addresses: shipping_addresses || [],
            customer_of: (vendorData.customer_of || '').split(',').map(s => s.trim()).filter(Boolean),
            tags: (() => { try { return JSON.parse(vendorData.tags); } catch { return []; } })()
        };

        // Check if the vendor is in use in purchase orders or bills
        const [usageResult] = await db.promise().query(
            `SELECT (
                (SELECT 1 FROM purchase_orders WHERE vendor_id = ? LIMIT 1) IS NOT NULL OR
                (SELECT 1 FROM ap_bills WHERE supplier_id = ? LIMIT 1) IS NOT NULL
            ) AS in_use`,
            [vendor.id, vendor.id]
        );
        const in_use = !!usageResult[0]?.in_use;
        vendor.in_use = in_use;


        const id = vendorId;

        const [contacts] = await db.promise().query(
            `
            SELECT 
                c.*,
                s.name as salutation_name
            FROM contact c
            LEFT JOIN salutation s ON c.salutation_id = s.id
            WHERE c.vendor_id = ?`,
            [id] 
        );
        const [attachments] = await db.promise().query(
            `SELECT * FROM vendor_attachment WHERE vendor_id = ?`,
            [id]
        );
        const [transactions] = await db.promise().query(
            `SELECT * FROM vendor_transactions WHERE vendor_id = ?`,
            [id]
        );

        const [history] = await db.promise().query(
            `
            SELECT
                vh.id,
                vh.action,
                vh.details,
                vh.created_at,
                u.name AS user_name
            FROM vendor_history vh
            LEFT JOIN user u ON u.id = vh.user_id
            WHERE vh.vendor_id = ? ORDER BY vh.created_at DESC`,
            [id]
        );

        res.json({ vendor, contacts, attachments, transactions: transactions || [], history: history || [] });
    } catch (err) {
        console.error('vendors/:uniqid/full:', err);
        res.status(500).json(errPayload('Failed to load vendor', 'DB_ERROR', err.message));
    }
});

/* ================================
   POST /api/vendors/upload
================================ */
router.post('/upload', uploadVendor.single('file'), async (req, res) => {
    const { vendor_id, expiry_date, document_type_id } = req.body;
    const file = req.file;
    if (!file || !vendor_id) return res.status(400).json(errPayload('Missing file or vendor_id'));

    try {
        await db.promise().query(
            `INSERT INTO vendor_attachment (vendor_id, attachment_path, attachment_name, expiry_date, document_type_id)
       VALUES (?, ?, ?, ?, ?)`,
            [vendor_id, file.path, file.originalname, expiry_date || null, document_type_id || null]
        );
        res.json({ success: true, message: 'File uploaded successfully' });
    } catch (err) {
        console.error('vendors/upload:', err);
        res.status(500).json(errPayload('Upload failed', 'DB_ERROR', err.message));
    }
});

/* ================================
   GET /api/vendors/:id/companies
   (get companies a vendor is associated with)
================================ */
router.get('/:id/companies', async (req, res) => {
    const vendorId = req.params.id;
    if (!vendorId) {
        return res.status(400).json(errPayload('Vendor ID is required', 'BAD_REQUEST'));
    }

    try {
        // 1. Get the customer_of JSON array from the vendor table
        const [[vendorData]] = await db.promise().query(
            `SELECT customer_of FROM vendor WHERE id = ? LIMIT 1`,
            [vendorId]
        );

        if (!vendorData || !vendorData.customer_of) {
            return res.json([]); // No associated companies
        }

        // Now parsing a comma-separated string instead of JSON
        const companyIds = String(vendorData.customer_of).split(',').map(s => s.trim()).filter(Boolean);
        if (companyIds.length === 0) {
            return res.json([]); // No associated companies
        }

        if (!Array.isArray(companyIds) || companyIds.length === 0) {
            return res.json([]);
        }

        // 2. Fetch details for those company IDs from company_settings
        const [companies] = await db.promise().query(
            `SELECT id, name FROM company_settings WHERE id IN (?) ORDER BY name ASC`,
            [companyIds]
        );
        res.json(companies);
    } catch (err) {
        console.error(`Failed to get companies for vendor ${vendorId}:`, err);
        res.status(500).json(errPayload('Failed to load associated companies', 'DB_ERROR', err.message));
    }
});

/* ================================
   PUT /api/vendors/:id
================================ */
router.put('/:id', uploadVendor.array('attachments'), async (req, res) => {
    const vendorId = req.params.id;
    const userId = req.session?.user?.id || null;

    let deletedAttachmentIds = [];
    let contactPersons = [];
    try {
        deletedAttachmentIds = JSON.parse(req.body.deletedAttachmentIds || '[]');
        contactPersons = JSON.parse(req.body.contactPersons || '[]');
    } catch {
        return res.status(400).json(errPayload('Invalid JSON in request body', 'BAD_REQUEST'));
    }

    const {
        company_name, display_name, email_address, phone_work, phone_mobile, remarks, website,
        tags, tax_treatment_id, tax_registration_number, source_supply_id,
        currency_id, payment_terms_id,
        bill_attention, bill_country_id, bill_address_1, bill_address_2,
        bill_city, bill_state_id, bill_zip_code, bill_phone, bill_fax, customer_of,
        ship_attention, ship_country_id, ship_address_1, ship_address_2,
        ship_city, ship_state_id, ship_zip_code, ship_phone, ship_fax
    } = req.body;

    const files = req.files || [];
    const conn = await db.promise().getConnection();

    try {
        await conn.beginTransaction();

        let safeCustomerOf = (Array.isArray(customer_of) ? customer_of.join(',') : String(customer_of || ''))
            .split(',').map(s => s.trim()).filter(Boolean).join(',');

        // If customer_of is not provided, check if there's only one company
        if (!safeCustomerOf) {
            const [companies] = await conn.query('SELECT id FROM company_settings');
            if (companies.length === 1) {
                safeCustomerOf = String(companies[0].id);
            }
        }

        const tagsRaw = req.body.tags;
        const safeTags = typeof tagsRaw === 'string' ? tagsRaw : JSON.stringify(tagsRaw || []);


        
        // --- History Logging: Fetch old state before update ---
        const [oldVendorRows] = await conn.query(`
            SELECT 
                v.*, vo.*,
                tt.name as tax_treatment_name,
                ss.source as source_supply_name,
                c.name as currency_name,
                pt.terms as payment_terms_name
            FROM vendor v 
            LEFT JOIN vendor_other vo ON v.id = vo.vendor_id
            LEFT JOIN tax_treatment tt ON tt.id = vo.tax_treatment_id
            LEFT JOIN source_supply ss ON ss.id = vo.source_supply_id
            LEFT JOIN currency c ON c.id = vo.currency_id
            LEFT JOIN payment_terms pt ON pt.id = vo.payment_terms_id
            WHERE v.id = ?`, [vendorId]);
        const oldVendor = oldVendorRows[0] || {};

        const generateDiff = async (oldObj, newObj, fieldsToCompare) => {
            const diff = [];
            for (const key of fieldsToCompare) {
                const oldValueId = oldObj[key] ?? '';
                const newValueId = newObj[key] ?? '';

                if (String(oldValueId) !== String(newValueId)) {
                    let from = oldValueId;
                    let to = newValueId;

                    // For select fields, get the text representation
                    if (key.endsWith('_id')) {
                        const nameKey = key.replace(/_id$/, '_name');
                        from = oldObj[nameKey] || oldValueId;
                        // For the 'to' value, we need to fetch it based on the new ID
                        const lookupTable = { tax_treatment_id: 'tax_treatment', source_supply_id: 'source_supply', currency_id: 'currency', payment_terms_id: 'payment_terms' }[key];
                        const lookupField = { tax_treatment_id: 'name', source_supply_id: 'source', currency_id: 'name', payment_terms_id: 'terms' }[key];
                        if (lookupTable && newValueId) {
                            const [toRows] = await conn.query(`SELECT ${lookupField} as name FROM ${lookupTable} WHERE id = ?`, [newValueId]);
                            to = toRows[0]?.name || newValueId;
                        }
                    }

                    diff.push({
                        field: key,
                        from: from,
                        to: to
                    });
                }
            }
            return diff;
        };

        const fieldsToTrack = [
            'company_name', 'display_name', 'email_address', 'phone_work', 'phone_mobile', 'website', 'remarks',
            'tax_treatment_id', 'tax_registration_number', 'source_supply_id', 'currency_id', 'payment_terms_id'
        ];

        const changes = await generateDiff(oldVendor, req.body, fieldsToTrack);

        // We will log changes for contacts and addresses later if needed.
        // For now, we log if any of the main fields changed.
        if (changes.length > 0) {
            await conn.query(
                `INSERT INTO vendor_history (vendor_id, user_id, action, details) VALUES (?, ?, ?, ?)`,
                [vendorId, userId, 'UPDATED', JSON.stringify(changes)]
            );
        }
        // --- End History Logging ---

        await conn.query(
            `UPDATE vendor
       SET company_name = ?, display_name = ?, email_address = ?, phone_work = ?, phone_mobile = ?, tags = ?, remarks = ?, website = ?, updated_user = ?, customer_of = ?
       WHERE id = ? AND company_type_id = ?`,
            [company_name, display_name, email_address, phone_work, phone_mobile, safeTags, remarks, website, userId, safeCustomerOf, vendorId, COMPANY_TYPE_VENDOR]
        );

        await conn.query(`DELETE FROM vendor_other WHERE vendor_id = ?`, [vendorId]);
        await conn.query(
            `INSERT INTO vendor_other
         (vendor_id, tax_treatment_id, tax_registration_number, source_supply_id, currency_id, payment_terms_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
            [vendorId, tax_treatment_id, tax_registration_number, source_supply_id, currency_id, payment_terms_id]
        );

        // Explicitly check for and update/insert the billing address
        const [[existingBillAddr]] = await conn.query(
            `SELECT id FROM vendor_address WHERE vendor_id = ? LIMIT 1`,
            [vendorId]
        );

        const billAddrPayload = [
            bill_attention, bill_country_id, bill_address_1, bill_address_2,
            bill_city, bill_state_id, bill_zip_code, bill_phone, bill_fax,
            vendorId
        ];

        if (existingBillAddr) {
            // UPDATE the existing billing address
            await conn.query(
                `UPDATE vendor_address SET bill_attention=?, bill_country_id=?, bill_address_1=?, bill_address_2=?, bill_city=?, bill_state_id=?, bill_zip_code=?, bill_phone=?, bill_fax=? WHERE vendor_id=?`,
                billAddrPayload
            );
        } else {
            // INSERT a new billing address
            await conn.query(
                `INSERT INTO vendor_address (bill_attention, bill_country_id, bill_address_1, bill_address_2, bill_city, bill_state_id, bill_zip_code, bill_phone, bill_fax, vendor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                billAddrPayload
            );
        }

        // Explicitly check for and update/insert the primary shipping address
        const [[existingShipAddr]] = await conn.query(
            `SELECT id FROM vendor_shipping_addresses WHERE vendor_id = ? AND is_primary = 1 LIMIT 1`,
            [vendorId]
        );

        const shipAddrPayload = [
            ship_attention, ship_country_id, ship_address_1, ship_address_2,
            ship_city, ship_state_id, ship_zip_code, ship_phone, ship_fax,
            vendorId
        ];

        if (existingShipAddr) {
            // UPDATE the existing primary shipping address
            await conn.query(
                `UPDATE vendor_shipping_addresses SET ship_attention=?, ship_country_id=?, ship_address_1=?, ship_address_2=?, ship_city=?, ship_state_id=?, ship_zip_code=?, ship_phone=?, ship_fax=? WHERE vendor_id=? AND is_primary = 1`,
                shipAddrPayload
            );
        } else {
            // INSERT a new primary shipping address
            await conn.query(
                `INSERT INTO vendor_shipping_addresses (ship_attention, ship_country_id, ship_address_1, ship_address_2, ship_city, ship_state_id, ship_zip_code, ship_phone, ship_fax, vendor_id, is_primary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
                shipAddrPayload
            );
        }

        const fullAddress = [bill_address_1, bill_address_2, bill_city, bill_zip_code].filter(Boolean).join(', ');

        await conn.query(`DELETE FROM contact WHERE vendor_id = ?`, [vendorId]);
        for (const p of contactPersons) {
            await conn.query(
                `INSERT INTO contact
           (vendor_id, is_primary, salutation_id, first_name, last_name, email, phone, mobile, skype_name_number, designation, department, customer_name, address, company_type_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    vendorId,
                    p.is_primary ? 1 : 0,
                    p.salutation_id, p.first_name, p.last_name,
                    p.email, p.phone, p.mobile,
                    p.skype_name_number, p.designation, p.department,
                    display_name, // customer_name
                    fullAddress,  // address
                    COMPANY_TYPE_VENDOR // company_type_id
                ]
            );
        }

        for (const id of deletedAttachmentIds) {
            await conn.query(`DELETE FROM vendor_attachment WHERE id = ?`, [id]);
        }

        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const expiry = req.body[`attachment_expiry_${i}`] || null;
            const docTypeId = req.body[`attachment_doctype_${i}`] || null;
            let thumbnailPath = null;

            // Generate thumbnail if it's an image
            if (f.mimetype.startsWith('image/')) {
                const thumbFilename = `thumb-${f.filename}`;
                const thumbFullPath = path.join(f.destination, thumbFilename);
                await sharp(f.path).resize(100, 100).toFile(thumbFullPath);
                thumbnailPath = thumbFullPath.replace(/\\/g, '/');
            }

            await conn.query(
                `INSERT INTO vendor_attachment (vendor_id, attachment_path, attachment_name, expiry_date, document_type_id, thumbnail_path, mime_type, size_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [vendorId, f.path, f.originalname, expiry, docTypeId, thumbnailPath, f.mimetype, f.size]
            );
        }

        // update expiry for existing attachments (same pattern as customer.js)
        for (let i = 0; ; i++) {
            const attId = req.body[`existing_attachment_id_${i}`];
            if (!attId) break;
            const expiry = req.body[`attachment_expiry_existing_${i}`] || null;
            const docTypeId = req.body[`attachment_doctype_existing_${i}`] || null;
            await conn.query(
                `UPDATE vendor_attachment SET expiry_date = ?, document_type_id = ? WHERE id = ?`,
                [expiry, docTypeId, attId]);
        }

        await conn.commit();
        res.json({ success: true, message: 'Vendor updated successfully' });
    } catch (err) {
        await conn.rollback();
        console.error('Update vendor failed:', err);
        res.status(500).json(errPayload('Update failed', 'DB_ERROR', err.message));
    } finally {
        conn.release();
    }
});

/* ================================
   DELETE /api/vendors/attachments/:id
================================ */
router.delete('/attachments/:id', async (req, res) => {
    const attachmentId = Number(req.params.id);
    const userId = req.session?.user?.id;
    const userName = req.session?.user?.name || 'System';
    if (!attachmentId) return res.status(400).json(errPayload("Invalid attachment ID."));

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        // Get file details before deleting
        const [[attachment]] = await conn.query(`SELECT id, vendor_id, attachment_name FROM vendor_attachment WHERE id = ?`, [attachmentId]);
        if (!attachment) return res.status(404).json(errPayload("Attachment not found."));

        // Delete the attachment record
        await conn.query(`DELETE FROM vendor_attachment WHERE id = ?`, [attachmentId]);

        // Add history for the deletion
        await conn.query(
            `INSERT INTO vendor_history (vendor_id, user_id, action, details) VALUES (?, ?, ?, ?)`,
            [attachment.vendor_id, userId, 'FILE_DELETED', JSON.stringify({ user: userName, file_name: attachment.attachment_name })]
        );

        await conn.commit();
        res.json({ success: true, message: 'Attachment deleted' });
    } catch (err) {
        await conn.rollback();
        console.error('delete attachment:', err);
        res.status(500).json(errPayload('Failed to delete attachment', 'DB_ERROR', err.message));
    } finally {
        conn.release();
    }
});

/* ================================
   POST /api/vendors/attachment/:id/update
================================ */
router.post('/attachment/:id/update', uploadVendor.single('file'), async (req, res) => {
    const { id } = req.params;
    const { expiry_date, document_type_id } = req.body;
    const file = req.file;

    const updates = [];
    const values = [];

    if (file) {
        updates.push('attachment_name = ?', 'attachment_path = ?', 'mime_type = ?', 'size_bytes = ?');
        values.push(file.originalname, `uploads/vendor/${file.filename}`, file.mimetype, file.size);
        // Note: This specific route does not generate a thumbnail.
        // The main create/update routes do. If thumbnail is needed here,
        // sharp.js logic would be added.
    }
    
    // Only push expiry_date if it's actually provided in the body (even if empty string, allow null)
    if (expiry_date !== undefined) {
        updates.push('expiry_date = ?');
        values.push(expiry_date || null);
    }
    
    // Only push document_type_id if it's provided
    if (document_type_id !== undefined) {
        updates.push('document_type_id = ?');
        values.push(document_type_id || null);
    }
    
    // If no updates, return error
    if (updates.length === 0) {
        return res.status(400).json(errPayload('No fields to update', 'VALIDATION_ERROR'));
    }
    
    values.push(id);

    try {
        await db.promise().query(`UPDATE vendor_attachment SET ${updates.join(', ')} WHERE id = ?`, values);
        res.json({ success: true, message: 'Attachment updated successfully' });
    } catch (err) {
        console.error('update attachment:', err);
        res.status(500).json(errPayload('Failed to update attachment', 'DB_ERROR', err.message));
    }
});

/* ================================
   POST /api/vendors/:id/update-address
================================ */
router.post('/:id/update-address', async (req, res) => {
    const { id: uniqid } = req.params; // Changed to use uniqid for consistency
    const { billing, shipping } = req.body;
    const conn = await db.promise().getConnection();

    try {
        await conn.beginTransaction();

        const [[vendor]] = await conn.query(`SELECT id FROM vendor WHERE uniqid = ?`, [uniqid]);
        if (!vendor) {
            await conn.rollback();
            return res.status(404).json(errPayload('Vendor not found', 'NOT_FOUND'));
        }
        const vendorId = vendor.id;

        if (billing) {
            const [[addr]] = await conn.query(`SELECT id FROM vendor_address WHERE vendor_id = ?`, [vendorId]);
            const payload = [
                billing.attention, billing.country, billing.address, billing.street2,
                billing.city, billing.state, billing.zip, billing.phone, billing.fax,
                vendorId
            ];
            if (addr) {
                await conn.query(
                    `UPDATE vendor_address SET bill_attention=?, bill_country_id=?, bill_address_1=?, bill_address_2=?, bill_city=?, bill_state_id=?, bill_zip_code=?, bill_phone=?, bill_fax=? WHERE vendor_id=?`,
                    payload
                );
            } else {
                await conn.query(
                    `INSERT INTO vendor_address (bill_attention, bill_country_id, bill_address_1, bill_address_2, bill_city, bill_state_id, bill_zip_code, bill_phone, bill_fax, vendor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    payload
                );
            }
        }

        if (shipping) {
            const payload = [
                shipping.attention, shipping.country, shipping.address, shipping.street2,
                shipping.city, shipping.state, shipping.zip, shipping.phone, shipping.fax,
            ];

            if (shipping.id) { // Existing shipping address
                await conn.query(
                    `UPDATE vendor_shipping_addresses SET ship_attention=?, ship_country_id=?, ship_address_1=?, ship_address_2=?, ship_city=?, ship_state_id=?, ship_zip_code=?, ship_phone=?, ship_fax=? WHERE id=? AND vendor_id=?`,
                    [...payload, shipping.id, vendorId]
                );
            } else { // New shipping address
                await conn.query(
                    `INSERT INTO vendor_shipping_addresses (ship_attention, ship_country_id, ship_address_1, ship_address_2, ship_city, ship_state_id, ship_zip_code, ship_phone, ship_fax, vendor_id, is_primary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
                    [...payload, vendorId]
                );
            }
        }

        await conn.commit();
        res.json({ success: true, message: 'Address updated successfully' });
    } catch (err) {
        await conn.rollback();
        console.error('update-address:', err);
        res.status(500).json(errPayload('Failed to update address', 'DB_ERROR', err.message));
    } finally {
        conn.release();
    }
});

/* ================================
   Contacts add/update
================================ */
router.post('/contacts', async (req, res) => {
    const {
        vendor_id, salutation_id, first_name, last_name,
        email, phone, mobile, skype_name_number,
        designation, department
    } = req.body;

    try {
        await db.promise().query(
            `INSERT INTO contact
         (vendor_id, salutation_id, first_name, last_name, email, phone, mobile, skype_name_number, designation, department)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [vendor_id, salutation_id, first_name, last_name, email, phone, mobile, skype_name_number, designation, department]
        );
        res.status(200).json({ message: 'Contact added' });
    } catch (err) {
        console.error('add vendor contact:', err);
        res.status(500).json(errPayload('Failed to add contact', 'DB_ERROR', err.message));
    }
});

router.put('/contacts/:id', async (req, res) => {
    const {
        salutation_id, first_name, last_name, email,
        phone, mobile, skype_name_number, designation, department
    } = req.body;
    const id = req.params.id;

    try {
        await db.promise().query(
            `UPDATE contact SET
         salutation_id = ?, first_name = ?, last_name = ?, email = ?,
         phone = ?, mobile = ?, skype_name_number = ?, designation = ?, department = ?
       WHERE id = ?`,
            [salutation_id, first_name, last_name, email, phone, mobile, skype_name_number, designation, department, id]
        );
        res.json({ message: 'Contact updated' });
    } catch (err) {
        console.error('update vendor contact:', err);
        res.status(500).json(errPayload('Failed to update contact', 'DB_ERROR', err.message));
    }
});

/* ================================
   PUT /api/vendors/:id/soft-delete
   (soft delete)
================================ */
router.put('/:id/soft-delete', async (req, res) => {
    const { id } = req.params;
    const userId = req.session?.user?.id || null;
    const conn = await db.promise().getConnection();

    try {
        await conn.beginTransaction();

        // 1. Check if vendor exists
        const [[vendor]] = await conn.query('SELECT display_name FROM vendor WHERE id = ? AND is_deleted = 0', [id]);
        if (!vendor) {
            await conn.rollback();
            return res.status(404).json(errPayload('Vendor not found or already deleted.', 'NOT_FOUND'));
        }

        // 2. Check if the vendor is in use
        const [usageResult] = await conn.query(
            `SELECT (
                (SELECT 1 FROM purchase_orders WHERE vendor_id = ? LIMIT 1) IS NOT NULL OR
                (SELECT 1 FROM ap_bills WHERE supplier_id = ? LIMIT 1) IS NOT NULL
            ) AS in_use`,
            [id, id]
        );

        if (usageResult[0]?.in_use) {
            await conn.rollback();
            return res.status(400).json(errPayload('This vendor cannot be deleted because they are part of one or more transactions.', 'IN_USE'));
        }

        // 3. Perform soft delete
        await conn.query('UPDATE vendor SET is_deleted = 1, updated_user = ? WHERE id = ?', [userId, id]);

        // 4. Log history
        await conn.query(
            `INSERT INTO vendor_history (vendor_id, user_id, action, details) VALUES (?, ?, ?, ?)`,
            [id, userId, 'DELETED', JSON.stringify({ vendor_name: vendor.display_name })]
        );

        await conn.commit();
        res.json({ success: true, message: 'Vendor deleted successfully.' });
    } catch (err) {
        await conn.rollback();
        console.error('Soft delete vendor failed:', err);
        res.status(500).json(errPayload('Soft delete failed', 'DB_ERROR', err.message));
    } finally {
        conn.release();
    }
});

// DELETE a vendor (soft delete)
router.delete('/:id', async (req, res, next) => {
    const { id } = req.params;
    const userId = req.session?.user?.id || null;

    try {
        const [[vendor]] = await db.promise().query('SELECT display_name FROM vendor WHERE id = ?', [id]);
        if (!vendor) {
            return res.status(404).json({ error: 'Vendor not found' });
        }

        await db.promise().query('UPDATE vendor SET is_deleted = 1 WHERE id = ?', [id]);

        const historySql = 'INSERT INTO vendor_history (vendor_id, user_id, action, details) VALUES (?, ?, ?, ?, ?)';
        const details = JSON.stringify({ vendor_name: vendor.display_name });
        await db.promise().query(historySql, [id, userId, 'DELETED', details]);

        res.json({ success: true, message: 'Vendor deleted successfully.' });
    } catch (err) {
        next(err);
    }
});

// PATCH to update a vendor's active status
router.patch('/:id/status', async (req, res, next) => {
    const { id } = req.params;
    const { is_active } = req.body;

    if (is_active === undefined) {
        const err = new Error('is_active field is required.');
        err.status = 400;
        return next(err);
    }

    try {
        await db.promise().query('UPDATE vendor SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, id]);
        res.json({ success: true, message: 'Vendor status updated successfully.' });
    } catch (err) {
        next(err);
    }
});

/* ================================
   GET /api/vendors/:id/statement
   Get vendor transaction statement from GL journals (all transaction history)
================================ */
router.get('/:id/statement', async (req, res, next) => {
    try {
        const vendorId = parseInt(req.params.id, 10);
        if (!vendorId || !Number.isFinite(vendorId)) {
            return res.status(400).json(errPayload('Invalid vendor ID'));
        }

        // Get all GL journal lines for this vendor (buyer_id)
        // This includes all transactions: bills, payments, and any other GL entries
        const [journalLines] = await db.promise().query(`
            SELECT 
                gjl.id,
                gjl.journal_id,
                gjl.line_no,
                gjl.account_id,
                gjl.debit,
                gjl.credit,
                gjl.description,
                gjl.entity_type,
                gjl.entity_id,
                gjl.product_id,
                gjl.buyer_id,
                gjl.currency_id,
                gjl.foreign_amount,
                gjl.total_amount,
                gj.id as journal_id_full,
                gj.journal_number,
                gj.journal_date,
                gj.source_type,
                gj.source_id,
                gj.source_name,
                gj.source_date,
                gj.memo,
                gj.currency_id as journal_currency_id,
                gj.exchange_rate,
                gj.foreign_amount as journal_foreign_amount,
                gj.total_amount as journal_total_amount,
                acc.name as account_name,
                acc.account_code,
                c.name as currency_code,
                p.product_name
            FROM gl_journal_lines gjl
            INNER JOIN gl_journals gj ON gj.id = gjl.journal_id
            LEFT JOIN acc_chart_accounts acc ON acc.id = gjl.account_id
            LEFT JOIN currency c ON c.id = gjl.currency_id
            LEFT JOIN products p ON p.id = gjl.product_id
            WHERE gjl.buyer_id = ?
            AND (gj.is_deleted = 0 OR gj.is_deleted IS NULL)
            ORDER BY gj.journal_date DESC, gj.id DESC, gjl.line_no ASC
        `, [vendorId]);

        // Transform journal lines into statement entries
        // Use total_amount if available (for multi-currency), otherwise use debit/credit
        const allTransactions = journalLines.map(line => {
            // Determine transaction type from source_type
            let transactionType = 'GL_ENTRY';
            if (line.source_type === 'AP_BILL') {
                transactionType = 'BILL';
            } else if (line.source_type === 'AP_PAYMENT') {
                transactionType = 'PAYMENT';
            } else if (line.source_type === 'AR_INVOICE') {
                transactionType = 'INVOICE';
            } else if (line.source_type === 'AR_RECEIPT') {
                transactionType = 'RECEIPT';
            }

            // Use total_amount if available (for multi-currency), otherwise use debit/credit
            // total_amount represents the converted amount in default currency
            const debitAmount = line.total_amount !== null && line.total_amount !== undefined && parseFloat(line.debit || 0) > 0
                ? parseFloat(line.total_amount)
                : parseFloat(line.debit || 0);
            const creditAmount = line.total_amount !== null && line.total_amount !== undefined && parseFloat(line.credit || 0) > 0
                ? parseFloat(line.total_amount)
                : parseFloat(line.credit || 0);
            
            const amount = debitAmount > 0 ? debitAmount : creditAmount;

            return {
                id: line.id,
                journal_id: line.journal_id,
                line_no: line.line_no,
                date: line.journal_date || line.source_date,
                document_number: line.source_name || line.journal_number,
                document_uniqid: line.source_id,
                source_type: line.source_type,
                source_id: line.source_id,
                type: transactionType,
                account_name: line.account_name,
                account_code: line.account_code,
                description: line.description || line.memo,
                product_name: line.product_name,
                debit: debitAmount,
                credit: creditAmount,
                amount: amount,
                currency_code: line.currency_code,
                status_name: 'Posted', // GL journals are always posted
                memo: line.memo,
                journal_number: line.journal_number
            };
        });

        // Sort by date (most recent first), then by journal_id, then by line_no
        allTransactions.sort((a, b) => {
            const dateA = new Date(a.date);
            const dateB = new Date(b.date);
            if (dateA.getTime() !== dateB.getTime()) {
                return dateB - dateA; // Most recent first
            }
            if (a.journal_id !== b.journal_id) {
                return b.journal_id - a.journal_id; // Higher journal ID first
            }
            return a.line_no - b.line_no; // Lower line_no first
        });

        // Calculate running balance
        // Running balance = sum of debits - sum of credits
        // Debit and credit amounts are already using total_amount if available (from transformation above)
        let runningBalance = 0;
        const statement = allTransactions.map(txn => {
            runningBalance = runningBalance + parseFloat(txn.debit || 0) - parseFloat(txn.credit || 0);
            return {
                ...txn,
                running_balance: runningBalance
            };
        });

        res.json({ 
            statement,
            opening_balance: 0, // Can be calculated from previous period if needed
            closing_balance: runningBalance
        });
    } catch (err) {
        console.error('vendors/:id/statement:', err);
        next(err);
    }
});

/* ================================
   GET /api/vendors/:id/bill-payments
   Get bills that have payments allocated to them (from supplier payments)
================================ */
router.get('/:id/bill-payments', async (req, res, next) => {
    try {
        const vendorId = parseInt(req.params.id, 10);
        if (!vendorId || !Number.isFinite(vendorId)) {
            return res.status(400).json(errPayload('Invalid vendor ID'));
        }

        // Get bills that have payment allocations
        const [billPayments] = await db.promise().query(`
            SELECT DISTINCT
                ab.id,
                ab.bill_uniqid,
                ab.bill_number,
                ab.bill_date,
                ab.total,
                ab.currency_id,
                c.name as currency_code,
                s.name as status_name,
                SUM(CASE 
                    WHEN p.currency_id = ab.currency_id THEN pa.amount_bank
                    ELSE pa.amount_base
                END) as total_paid,
                COUNT(DISTINCT p.id) as payment_count
            FROM ap_bills ab
            INNER JOIN tbl_payment_allocation pa ON pa.bill_id = ab.id AND pa.alloc_type = 'bill'
            INNER JOIN tbl_payment p ON p.id = pa.payment_id
            LEFT JOIN currency c ON c.id = ab.currency_id
            LEFT JOIN status s ON s.id = ab.status_id
            WHERE ab.supplier_id = ?
              AND (p.is_deleted = 0 OR p.is_deleted IS NULL)
            GROUP BY ab.id, ab.bill_uniqid, ab.bill_number, ab.bill_date, ab.total, ab.currency_id, c.name, s.name
            ORDER BY ab.bill_date DESC, ab.id DESC
        `, [vendorId]);

        res.json({ data: billPayments || [] });
    } catch (e) {
        console.error('Error fetching bill payments:', e);
        next(e);
    }
});

/* ================================
   GET /api/vendors/:id/purchase-receives
   Get supplier payments that have purchase orders allocated to them
================================ */
router.get('/:id/purchase-receives', async (req, res, next) => {
    try {
        const vendorId = parseInt(req.params.id, 10);
        if (!vendorId || !Number.isFinite(vendorId)) {
            return res.status(400).json(errPayload('Invalid vendor ID'));
        }

        // Get supplier payments that have PO allocations (advance payments)
        const [purchaseReceives] = await db.promise().query(`
            SELECT DISTINCT
                p.id,
                p.payment_uniqid,
                p.payment_number,
                p.transaction_date,
                p.currency_id,
                c.name as currency_code,
                s.name as status_name,
                pt.name as payment_type_name,
                SUM(CASE 
                    WHEN p.currency_id = po.currency_id THEN pa.amount_bank
                    ELSE pa.amount_base
                END) as total_allocated,
                COUNT(DISTINCT po.id) as po_count,
                GROUP_CONCAT(DISTINCT po.po_number ORDER BY po.po_number SEPARATOR ', ') as po_numbers
            FROM tbl_payment p
            INNER JOIN tbl_payment_allocation pa ON pa.payment_id = p.id AND pa.alloc_type = 'advance'
            INNER JOIN purchase_orders po ON po.id = pa.po_id
            LEFT JOIN currency c ON c.id = p.currency_id
            LEFT JOIN status s ON s.id = p.status_id
            LEFT JOIN payment_type pt ON pt.id = p.payment_type_id
            WHERE p.party_id = ?
              AND p.is_customer_payment = 0
              AND (p.is_deleted = 0 OR p.is_deleted IS NULL)
            GROUP BY p.id, p.payment_uniqid, p.payment_number, p.transaction_date, p.currency_id, c.name, s.name, pt.name
            ORDER BY p.transaction_date DESC, p.id DESC
        `, [vendorId]);

        res.json({ data: purchaseReceives || [] });
    } catch (e) {
        console.error('Error fetching purchase receives:', e);
        next(e);
    }
});

export default router;