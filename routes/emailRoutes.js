import express from 'express';
import nodemailer from 'nodemailer';
import db from '../db.js';
import sendEmail from '../../src/utils/sendEmailHelper.mjs'; // ✅ adjust path as needed


const router = express.Router();

router.post('/test-email', async (req, res) => {
  try {
    const to = req.session?.user?.email || process.env.EMAIL_FROM;
    const from = process.env.EMAIL_FROM;
    const subject = 'Test Email from System';
    const content = '<p>This is a <strong>test email</strong> from the settings panel.</p>';

    const result = await sendEmail({ to, from, subject, content });

    res.json(result);
  } catch (err) {
    console.error('❌ Email send failed:', err.message);
    res.status(500).json({
      error: 'Failed to send email',
      details: err.message
    });
  }
});

export default router;
