import cron from 'node-cron';
import dotenv from 'dotenv';
import db from '../db.js';
import sendEmail from '../../src/utils/sendEmailHelper.mjs';
import path from 'path';
import fs from 'fs';

dotenv.config();

// ✅ Exportable function
export const runExpiryCheck = async () => {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`📅 Running expiry check for ${today}`);

  try {
    const [results] = await db.promise().query(`
      SELECT 
        v.company_name,
        va.attachment_path,
        va.attachment_name,
        va.expiry_date,
        v.email_address AS vendor_email,
        u.email AS user_email
      FROM vendor_attachment va
      JOIN vendor v ON va.vendor_id = v.id
      JOIN user u ON v.user_id = u.id
      WHERE va.expiry_date = ?
    `, [today]);

    if (results.length === 0) {
      console.log('✅ No expiring documents today.');
      return;
    }

    // Group by vendor+user email
    const grouped = {};
    for (const row of results) {
      const key = `${row.vendor_email},${row.user_email}`;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(row);
    }

    const BASE_URL = process.env.VITE_APP_BASE_NAME || 'http://localhost:5021';
    const ATTACHMENT_DIR = path.resolve();

    for (const key in grouped) {
      const [vendorEmail, userEmail] = key.split(',');
      const firstRow = grouped[key][0]; // just to get vendor name once
      const vendorName = firstRow.company_name;

      const attachmentsList = grouped[key]
          .map(item => `• ${item.attachment_name} (Expiry: ${item.expiry_date})`)
          .join('<br>');

      const content = `
    <p>Dear ${vendorName},</p>
    <p>The following documents are expiring <strong>today</strong>:</p>
    <p>${attachmentsList}</p>
    <p>The files are also attached for your reference.</p>
    <p>Please take necessary action.</p>
  `;

      // Attach files
      const attachmentsToSend = grouped[key]
          .filter(item => item.attachment_path)
          .map(item => {
            const fullPath = path.join(ATTACHMENT_DIR, item.attachment_path);
            return {
              filename: item.attachment_name,
              path: fullPath
            };
          });

      await sendEmail({
        to: [vendorEmail, userEmail],
        subject: `Document Expiry Notification - ${vendorName}`,
        content,
        attachments: attachmentsToSend
      });

      console.log(`📨 Email sent to: ${vendorEmail}, ${userEmail}`);
    }
  } catch (err) {
    console.error('❌ Cron job failed:', err.message);
  }
};

// ✅ Schedule the cron job (8:00 AM daily)
cron.schedule('0 8 * * *', runExpiryCheck);
