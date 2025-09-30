// server/routes/vendor.js
import express from 'express';
import db from '../db.js';
import crypto from 'crypto';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

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
 * company_type_id: '0' => vendor
 * (matches your DB which stores company/customer in the same `vendor` table)
 */
const COMPANY_TYPE_VENDOR = '0';

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
      WHERE v.company_type_id = ?
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
        )
      ORDER BY v.display_name ASC
      LIMIT ? OFFSET ?
      `,
            [
                COMPANY_TYPE_VENDOR,
                like(search), like(search), like(search), like(search),
                limit, offset
            ]
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
        )
      `,
            [COMPANY_TYPE_VENDOR, like(search), like(search), like(search), like(search)]
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
        bill_city, bill_state_id, bill_zip_code, bill_phone, bill_fax,
        ship_attention, ship_country_id, ship_address_1, ship_address_2,
        ship_city, ship_state_id, ship_zip_code, ship_phone, ship_fax
    } = req.body;

    const uniqid = `vnd_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const userId = req.session?.user?.id || null;
    const files = req.files || [];
    const tagsRaw = req.body.tags;
    const safeTags = typeof tagsRaw === 'string' ? tagsRaw : JSON.stringify(tagsRaw || []);

    let contactPersons = [];
    try {
        contactPersons = JSON.parse(req.body.contactPersons || '[]');
    } catch {
        return res.status(400).json(errPayload('Invalid contactPersons JSON'));
    }

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        // Insert core (shared table)
        const [ins] = await conn.query(
            `
      INSERT INTO vendor
        (company_name, display_name, email_address, phone_work, phone_mobile,tags , remarks, website,
         uniqid, user_id, updated_user, company_type_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
            [
                company_name, display_name, email_address, phone_work, phone_mobile, safeTags, remarks, website,
                uniqid, userId, userId, COMPANY_TYPE_VENDOR
            ]
        );
        const vendorId = ins.insertId;

        await conn.query(
            `INSERT INTO vendor_other
         (vendor_id, tax_treatment_id, tax_registration_number, source_supply_id, currency_id, payment_terms_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
            [vendorId, tax_treatment_id, tax_registration_number, source_supply_id, currency_id, payment_terms_id]
        );

        await conn.query(
            `INSERT INTO vendor_address (
         vendor_id, bill_attention, bill_country_id, bill_address_1, bill_address_2,
         bill_city, bill_state_id, bill_zip_code, bill_phone, bill_fax,
         ship_attention, ship_country_id, ship_address_1, ship_address_2,
         ship_city, ship_state_id, ship_zip_code, ship_phone, ship_fax
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                vendorId,
                bill_attention, bill_country_id, bill_address_1, bill_address_2,
                bill_city, bill_state_id, bill_zip_code, bill_phone, bill_fax,
                ship_attention, ship_country_id, ship_address_1, ship_address_2,
                ship_city, ship_state_id, ship_zip_code, ship_phone, ship_fax
            ]
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

            await conn.query(
                `INSERT INTO vendor_attachment (vendor_id, attachment_path, attachment_name, expiry_date, document_type_id)
         VALUES (?, ?, ?, ?, ?)`,
                [vendorId, (f.path || '').replace(/\\/g, '/'), f.originalname, expiry, docTypeId]
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
        CONCAT_WS(', ', va.ship_address_1, va.ship_address_2, va.ship_city, va.ship_zip_code) AS shipping_address,
        bill_state.name AS bill_state_name,
        bill_country.name AS bill_country_name,
        ship_state.name AS ship_state_name,
        ship_country.name AS ship_country_name,
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
        va.ship_attention,
        va.ship_country_id,
        va.ship_address_1,
        va.ship_address_2,
        va.ship_city,
        va.ship_state_id,
        va.ship_zip_code,
        va.ship_phone,
        va.ship_fax,
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
      LEFT JOIN state AS bill_state ON bill_state.id = va.bill_state_id
      LEFT JOIN country AS bill_country ON bill_country.id = va.bill_country_id
      LEFT JOIN state AS ship_state ON ship_state.id = va.ship_state_id
      LEFT JOIN country AS ship_country ON ship_country.id = va.ship_country_id
      WHERE v.uniqid = ? AND v.company_type_id = ?
      `,
            [uniqid, COMPANY_TYPE_VENDOR]
        );

        if (!rows.length) return res.status(404).json(errPayload('Vendor not found', 'NOT_FOUND'));

        const vendor = rows[0];
        const id = vendor.id;

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
        bill_city, bill_state_id, bill_zip_code, bill_phone, bill_fax,
        ship_attention, ship_country_id, ship_address_1, ship_address_2,
        ship_city, ship_state_id, ship_zip_code, ship_phone, ship_fax
    } = req.body;

    const files = req.files || [];
    const conn = await db.promise().getConnection();
    const tagsRaw = req.body.tags;
    const safeTags = typeof tagsRaw === 'string' ? tagsRaw : JSON.stringify(tagsRaw || []);

    try {
        await conn.beginTransaction();
        
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
       SET company_name = ?, display_name = ?, email_address = ?, phone_work = ?, phone_mobile = ?, tags = ?, remarks = ?, website = ?, updated_user = ?
       WHERE id = ? AND company_type_id = ?`,
            [company_name, display_name, email_address, phone_work, phone_mobile, safeTags,   remarks, website, userId, vendorId, COMPANY_TYPE_VENDOR]
        );

        await conn.query(`DELETE FROM vendor_other WHERE vendor_id = ?`, [vendorId]);
        await conn.query(
            `INSERT INTO vendor_other
         (vendor_id, tax_treatment_id, tax_registration_number, source_supply_id, currency_id, payment_terms_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
            [vendorId, tax_treatment_id, tax_registration_number, source_supply_id, currency_id, payment_terms_id]
        );

        await conn.query(`DELETE FROM vendor_address WHERE vendor_id = ?`, [vendorId]);
        await conn.query(
            `INSERT INTO vendor_address (
        vendor_id, bill_attention, bill_country_id, bill_address_1, bill_address_2,
        bill_city, bill_state_id, bill_zip_code, bill_phone, bill_fax,
        ship_attention, ship_country_id, ship_address_1, ship_address_2,
        ship_city, ship_state_id, ship_zip_code, ship_phone, ship_fax
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                vendorId,
                bill_attention, bill_country_id, bill_address_1, bill_address_2,
                bill_city, bill_state_id, bill_zip_code, bill_phone, bill_fax,
                ship_attention, ship_country_id, ship_address_1, ship_address_2,
                ship_city, ship_state_id, ship_zip_code, ship_phone, ship_fax
            ]
        );

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
            await conn.query(
                `INSERT INTO vendor_attachment (vendor_id, attachment_path, attachment_name, expiry_date, document_type_id)
         VALUES (?, ?, ?, ?, ?)`,
                [vendorId, f.path, f.originalname, expiry, docTypeId]
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
    const { id } = req.params;
    try {
        await db.promise().query(`DELETE FROM vendor_attachment WHERE id = ?`, [id]);
        res.json({ success: true, message: 'Attachment deleted' });
    } catch (err) {
        console.error('delete attachment:', err);
        res.status(500).json(errPayload('Failed to delete attachment', 'DB_ERROR', err.message));
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
        updates.push('attachment_name = ?', 'attachment_path = ?');
        values.push(file.originalname, `uploads/vendor/${file.filename}`);
    }
    updates.push('expiry_date = ?');
    updates.push('document_type_id = ?');
    values.push(expiry_date || null);
    values.push(document_type_id || null);
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
    const { id: vendorId } = req.params;
    const { billing, shipping } = req.body;

    try {
        const [rows] = await db.promise().query(`SELECT id FROM vendor_address WHERE vendor_id = ?`, [vendorId]);
        if (rows.length === 0) return res.status(404).json(errPayload('Address not found for vendor', 'NOT_FOUND'));

        const addressId = rows[0].id;

        if (billing) {
            await db.promise().query(
                `UPDATE vendor_address SET
           bill_attention = ?, bill_country_id = ?, bill_address_1 = ?, bill_address_2 = ?, bill_city = ?, bill_state_id = ?, bill_zip_code = ?, bill_phone = ?, bill_fax = ?
         WHERE id = ?`,
                [
                    billing.attention, billing.country, billing.address, billing.street2,
                    billing.city, billing.state, billing.zip, billing.phone, billing.fax,
                    addressId
                ]
            );
        }

        if (shipping) {
            await db.promise().query(
                `UPDATE vendor_address SET
           ship_attention = ?, ship_country_id = ?, ship_address_1 = ?, ship_address_2 = ?, ship_city = ?, ship_state_id = ?, ship_zip_code = ?, ship_phone = ?, ship_fax = ?
         WHERE id = ?`,
                [
                    shipping.attention, shipping.country, shipping.address, shipping.street2,
                    shipping.city, shipping.state, shipping.zip, shipping.phone, shipping.fax,
                    addressId
                ]
            );
        }

        res.json({ success: true });
    } catch (err) {
        console.error('update-address:', err);
        res.status(500).json(errPayload('Failed to update address', 'DB_ERROR', err.message));
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

export default router;