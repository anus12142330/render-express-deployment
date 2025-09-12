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
ensureDir('uploads/customer');



// helpers for robust parsing (accept both numeric and legacy strings)
const asIntCustomerType = (v) => (v === 1 || v === '1' || v === 'business') ? 1 : 0; // 1=business, 0=individual

// ---------- Multer ----------
const customerStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, 'uploads/customer'),
    filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname || '');
        const name = crypto.randomBytes(16).toString('hex');
        cb(null, name + ext);
    }
});
const uploadCustomer = multer({ storage: customerStorage });

// ---------- NEW semantics ----------
/**
 * company_type_id: 'customer' | 'vendor'
 * customer_type:   'individual' | 'business'
 *
 * If your DB stores ints instead of strings, change these constants accordingly.
 */
const COMPANY_TYPE_CUSTOMER = '1';

// Utility
const like = (s = '') => `%${s}%`;

/* ================================
   GET /api/customers/full
================================ */
router.get('/full', async (req, res) => {
    const { search = '' } = req.query;
    try {
        const [rows] = await db.promise().query(
            `
      SELECT v.id, v.display_name AS name, v.uniqid
      FROM vendor v
      WHERE v.company_type_id = ?
        AND (v.display_name LIKE ? OR v.company_name LIKE ?)
      ORDER BY v.display_name ASC
      LIMIT 100
      `,
            [COMPANY_TYPE_CUSTOMER, like(search), like(search)]
        );
        res.json(rows);
    } catch (err) {
        console.error('customers/full:', err);
        res.status(500).json(errPayload('Failed to load customers', 'DB_ERROR', err.message));
    }
});

/* ================================
   GET /api/customers
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
        v.customer_type,      -- 'individual' | 'business'
        0 AS payables,
        0 AS unused_credits,
        (
          SELECT COUNT(*) FROM vendor_attachment va
          WHERE va.vendor_id = v.id AND va.expiry_date < CURDATE()
        ) AS expired_attachments_count
      FROM vendor v
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
                COMPANY_TYPE_CUSTOMER,
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
            [COMPANY_TYPE_CUSTOMER, like(search), like(search), like(search), like(search)]
        );

        res.json({ data, total: countRows[0]?.total || 0 });
    } catch (err) {
        console.error('customers list:', err);
        res.status(500).json(errPayload('Failed to load customers', 'DB_ERROR', err.message));
    }
});

/* ================================
   POST /api/customers
================================ */
router.post('/', uploadCustomer.array('attachments'), async (req, res) => {
    const {
        company_name, display_name, email_address, phone_work, phone_mobile, remarks,
        tax_treatment_id, tax_registration_number, source_supply_id,
        currency_id, payment_terms_id,
        bill_attention, bill_country_id, bill_address_1, bill_address_2,
        bill_city, bill_state_id, bill_zip_code, bill_phone, bill_fax,
        ship_attention, ship_country_id, ship_address_1, ship_address_2,
        ship_city, ship_state_id, ship_zip_code, ship_phone, ship_fax,
        customer_type // <-- 'individual' | 'business' from the form
    } = req.body;

    const uniqid = `cus_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const userId = req.session?.user?.id || null;
    const files = req.files || [];

    let contactPersons = [];
    try {
        contactPersons = JSON.parse(req.body.contactPersons || '[]');
    } catch (e) {
        return res.status(400).json(errPayload('Invalid contactPersons JSON'));
    }

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        // Insert core record (shared "vendor" table)
        const [ins] = await conn.query(
            `
      INSERT INTO vendor
        (company_name, display_name, email_address, phone_work, phone_mobile, remarks,
         uniqid, user_id, updated_user, company_type_id, customer_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
            [
                company_name, display_name, email_address, phone_work, phone_mobile, remarks,
                uniqid, userId, userId, COMPANY_TYPE_CUSTOMER, customer_type || 'individual'
            ]
        );
        const customerId = ins.insertId;

        await conn.query(
            `INSERT INTO vendor_other
         (vendor_id, tax_treatment_id, tax_registration_number, source_supply_id, currency_id, payment_terms_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
            [customerId, tax_treatment_id, tax_registration_number, source_supply_id, currency_id, payment_terms_id]
        );

        await conn.query(
            `INSERT INTO vendor_address (
         vendor_id, bill_attention, bill_country_id, bill_address_1, bill_address_2,
         bill_city, bill_state_id, bill_zip_code, bill_phone, bill_fax,
         ship_attention, ship_country_id, ship_address_1, ship_address_2,
         ship_city, ship_state_id, ship_zip_code, ship_phone, ship_fax
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                customerId,
                bill_attention, bill_country_id, bill_address_1, bill_address_2,
                bill_city, bill_state_id, bill_zip_code, bill_phone, bill_fax,
                ship_attention, ship_country_id, ship_address_1, ship_address_2,
                ship_city, ship_state_id, ship_zip_code, ship_phone, ship_fax
            ]
        );

        for (const p of contactPersons) {
            await conn.query(
                `INSERT INTO vendor_contact
           (vendor_id, salutation_id, first_name, last_name, email, phone, mobile, skype_name_number, designation, department)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    customerId,
                    p.salutation_id, p.first_name, p.last_name,
                    p.email, p.phone, p.mobile,
                    p.skype_name_number, p.designation, p.department
                ]
            );
        }

        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const expiry = req.body[`attachment_expiry_${i}`] || null; // "YYYY-MM-DD" from UI

            await conn.query(
                `INSERT INTO vendor_attachment (vendor_id, attachment_path, attachment_name, expiry_date)
                 VALUES (?, ?, ?, ?)`,
                [customerId, (f.path || '').replace(/\\/g, '/'), f.originalname, expiry]
            );
        }

        await conn.commit();
        res.json({ success: true, message: 'Customer created successfully', customerId, uniqid });
    } catch (err) {
        await conn.rollback();
        console.error('Create customer failed:', err);
        res.status(500).json(errPayload('Customer create failed', 'DB_ERROR', err.message));
    } finally {
        conn.release();
    }
});

/* ================================
   GET /api/customers/:uniqid/full
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
            [uniqid, COMPANY_TYPE_CUSTOMER]
        );

        if (!rows.length) return res.status(404).json(errPayload('Customer not found', 'NOT_FOUND'));

        const customer = rows[0];
        const id = customer.id;

        const [contacts] = await db.promise().query(
            `SELECT * FROM vendor_contact WHERE vendor_id = ?`,
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

        res.json({ customer, contacts, attachments, transactions: transactions || [] });
    } catch (err) {
        console.error('customers/:uniqid/full:', err);
        res.status(500).json(errPayload('Failed to load customer', 'DB_ERROR', err.message));
    }
});

/* ================================
   POST /api/customers/upload
================================ */
router.post('/upload', uploadCustomer.single('file'), async (req, res) => {
    const { customer_id, expiry_date } = req.body;
    const file = req.file;
    if (!file || !customer_id) return res.status(400).json(errPayload('Missing file or customer_id'));

    try {
        await db.promise().query(
            `INSERT INTO vendor_attachment (vendor_id, attachment_path, attachment_name, expiry_date)
       VALUES (?, ?, ?, ?)`,
            [customer_id, file.path, file.originalname, expiry_date || null]
        );
        res.json({ success: true, message: 'File uploaded successfully' });
    } catch (err) {
        console.error('customers/upload:', err);
        res.status(500).json(errPayload('Upload failed', 'DB_ERROR', err.message));
    }
});

/* ================================
   PUT /api/customers/:id
================================ */
router.put('/:id', uploadCustomer.array('attachments'), async (req, res) => {
    const customerId = req.params.id;
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
        company_name, display_name, email_address, phone_work, phone_mobile, remarks,
        tax_treatment_id, tax_registration_number, source_supply_id,
        currency_id, payment_terms_id,
        bill_attention, bill_country_id, bill_address_1, bill_address_2,
        bill_city, bill_state_id, bill_zip_code, bill_phone, bill_fax,
        ship_attention, ship_country_id, ship_address_1, ship_address_2,
        ship_city, ship_state_id, ship_zip_code, ship_phone, ship_fax,
        customer_type // may be updated
    } = req.body;

    const files = req.files || [];
    const conn = await db.promise().getConnection();

    try {
        await conn.beginTransaction();

        await conn.query(
            `UPDATE vendor
       SET company_name = ?, display_name = ?, email_address = ?, phone_work = ?, phone_mobile = ?, remarks = ?, updated_user = ?, customer_type = ?
       WHERE id = ? AND company_type_id = ?`,
            [company_name, display_name, email_address, phone_work, phone_mobile, remarks, userId, customer_type || 'individual', customerId, COMPANY_TYPE_CUSTOMER]
        );

        await conn.query(`DELETE FROM vendor_other WHERE vendor_id = ?`, [customerId]);
        await conn.query(
            `INSERT INTO vendor_other
         (vendor_id, tax_treatment_id, tax_registration_number, source_supply_id, currency_id, payment_terms_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
            [customerId, tax_treatment_id, tax_registration_number, source_supply_id, currency_id, payment_terms_id]
        );

        await conn.query(`DELETE FROM vendor_address WHERE vendor_id = ?`, [customerId]);
        await conn.query(
            `INSERT INTO vendor_address (
        vendor_id, bill_attention, bill_country_id, bill_address_1, bill_address_2,
        bill_city, bill_state_id, bill_zip_code, bill_phone, bill_fax,
        ship_attention, ship_country_id, ship_address_1, ship_address_2,
        ship_city, ship_state_id, ship_zip_code, ship_phone, ship_fax
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                customerId,
                bill_attention, bill_country_id, bill_address_1, bill_address_2,
                bill_city, bill_state_id, bill_zip_code, bill_phone, bill_fax,
                ship_attention, ship_country_id, ship_address_1, ship_address_2,
                ship_city, ship_state_id, ship_zip_code, ship_phone, ship_fax
            ]
        );

        await conn.query(`DELETE FROM vendor_contact WHERE vendor_id = ?`, [customerId]);
        for (const p of contactPersons) {
            await conn.query(
                `INSERT INTO vendor_contact
           (vendor_id, salutation_id, first_name, last_name, email, phone, mobile, skype_name_number, designation, department)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    customerId,
                    p.salutation_id, p.first_name, p.last_name,
                    p.email, p.phone, p.mobile,
                    p.skype_name_number, p.designation, p.department
                ]
            );
        }

        for (const id of deletedAttachmentIds) {
            await conn.query(`DELETE FROM vendor_attachment WHERE id = ?`, [id]);
        }

        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const expiry = req.body[`attachment_expiry_${i}`] || null;
            await conn.query(
                `INSERT INTO vendor_attachment (vendor_id, attachment_path, attachment_name, expiry_date)
         VALUES (?, ?, ?, ?)`,
                [customerId, f.path, f.originalname, expiry]
            );
        }

        for (let i = 0; ; i++) {
            const attId = req.body[`existing_attachment_id_${i}`];
            if (!attId) break;
            const expiry = req.body[`attachment_expiry_existing_${i}`] || null;
            await conn.query(`UPDATE vendor_attachment SET expiry_date = ? WHERE id = ?`, [expiry, attId]);
        }

        await conn.commit();
        res.json({ success: true, message: 'Customer updated successfully' });
    } catch (err) {
        await conn.rollback();
        console.error('Update customer failed:', err);
        res.status(500).json(errPayload('Update failed', 'DB_ERROR', err.message));
    } finally {
        conn.release();
    }
});

/* ================================
   DELETE /api/customers/attachments/:id
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
   POST /api/customers/attachment/:id/update
================================ */
router.post('/attachment/:id/update', uploadCustomer.single('file'), async (req, res) => {
    const { id } = req.params;
    const { expiry_date } = req.body;
    const file = req.file;

    const updates = [];
    const values = [];

    if (file) {
        updates.push('attachment_name = ?', 'attachment_path = ?');
        values.push(file.originalname, `uploads/customer/${file.filename}`);
    }
    updates.push('expiry_date = ?');
    values.push(expiry_date || null);
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
   POST /api/customers/:id/update-address
================================ */
router.post('/:id/update-address', async (req, res) => {
    const { id: customerId } = req.params;
    const { billing, shipping } = req.body;

    try {
        const [rows] = await db.promise().query(`SELECT id FROM vendor_address WHERE vendor_id = ?`, [customerId]);
        if (rows.length === 0) return res.status(404).json(errPayload('Address not found for customer', 'NOT_FOUND'));

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
   Contacts add/update (unchanged)
================================ */
router.post('/contacts', async (req, res) => {
    const {
        customer_id, salutation, first_name, last_name,
        email, phone, mobile, skype_name_number,
        designation, department
    } = req.body;

    try {
        await db.promise().query(
            `INSERT INTO vendor_contact
         (vendor_id, salutation_id, first_name, last_name, email, phone, mobile, skype_name_number, designation, department)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [customer_id, salutation, first_name, last_name, email, phone, mobile, skype_name_number, designation, department]
        );
        res.status(200).json({ message: 'Contact added' });
    } catch (err) {
        console.error('add customer contact:', err);
        res.status(500).json(errPayload('Failed to add contact', 'DB_ERROR', err.message));
    }
});

router.put('/contacts/:id', async (req, res) => {
    const {
        salutation, first_name, last_name, email,
        phone, mobile, skype_name_number, designation, department
    } = req.body;
    const id = req.params.id;

    try {
        await db.promise().query(
            `UPDATE vendor_contact SET
         salutation_id = ?, first_name = ?, last_name = ?, email = ?,
         phone = ?, mobile = ?, skype_name_number = ?, designation = ?, department = ?
       WHERE id = ?`,
            [salutation, first_name, last_name, email, phone, mobile, skype_name_number, designation, department, id]
        );
        res.json({ message: 'Contact updated' });
    } catch (err) {
        console.error('update customer contact:', err);
        res.status(500).json(errPayload('Failed to update contact', 'DB_ERROR', err.message));
    }
});




export default router;
