/**
 * POST /api/documents/extract
 * Accepts a PDF or image file (trade license), extracts text, returns company_name and expiry_date.
 * Used by mobile when user attaches Trade License (kyc_document id 1).
 */
import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const uploadDir = path.join(__dirname, '..', 'uploads', 'documents-extract');
try {
  fs.mkdirSync(uploadDir, { recursive: true });
} catch (_) {}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `extract-${Date.now()}-${file.originalname || 'file'}`),
});
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });

const router = Router();

// Normalize date parts to YYYY-MM-DD
function toYYYYMMDD(y, month, day) {
  if (y < 100) y += 2000;
  if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
    return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return null;
}

function findExpiryDate(text) {
  if (!text || typeof text !== 'string') return null;
  const normalized = text.replace(/\s+/g, ' ');
  // 1) Explicit "Expiry Date" label (e.g. "Expiry Date 2021/10/13" or "Expiry Date" next line "2021/10/13")
  const expiryLabelMatch = normalized.match(/\bexpiry\s*date\s*[:\s]*(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/i);
  if (expiryLabelMatch) {
    const out = toYYYYMMDD(parseInt(expiryLabelMatch[1], 10), parseInt(expiryLabelMatch[2], 10), parseInt(expiryLabelMatch[3], 10));
    if (out) return out;
  }
  // 2) "Expiry Date" then later in text YYYY/MM/DD (use text after "expiry date" so we don't grab Issue Date)
  const expiryIdx = normalized.toLowerCase().indexOf('expiry date');
  if (expiryIdx !== -1) {
    const afterExpiry = normalized.slice(expiryIdx + 10);
    const dateAfter = afterExpiry.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/);
    if (dateAfter) {
      const out = toYYYYMMDD(parseInt(dateAfter[1], 10), parseInt(dateAfter[2], 10), parseInt(dateAfter[3], 10));
      if (out) return out;
    }
  }
  // 3) Other expiry keywords + date (DD/MM/YYYY or YYYY/MM/DD)
  const withKeyword = normalized.match(/\b(?:expir(?:y|es|ation)?|valid\s+until)\s*[:\s]*(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/i);
  if (withKeyword) {
    const out = toYYYYMMDD(parseInt(withKeyword[1], 10), parseInt(withKeyword[2], 10), parseInt(withKeyword[3], 10));
    if (out) return out;
  }
  const withKeywordDD = normalized.match(/\b(?:expir(?:y|es|ation)?|valid\s+until)\s*[:\s]*(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/i);
  if (withKeywordDD) {
    const y = parseInt(withKeywordDD[3], 10);
    const out = toYYYYMMDD(y < 100 ? y + 2000 : y, parseInt(withKeywordDD[2], 10), parseInt(withKeywordDD[1], 10));
    if (out) return out;
  }
  return null;
}

function findCompanyName(text) {
  if (!text || typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const keys = [
    'trade name',       // e.g. "Trade Name" -> ASAS GEN TR L.L.C
    'licensee', 'company name', 'establishment name', 'trading name', 'business name',
    'name of establishment', 'name of company', 'customer name', 'entity name'
  ];
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    for (const key of keys) {
      if (lower.includes(key)) {
        const afterColon = lines[i].split(/[:\-]/).slice(1).join(':').trim();
        if (afterColon && afterColon.length > 2 && afterColon.length < 200 && !/^\d[\d\/\-\.\s]*$/.test(afterColon)) {
          return afterColon;
        }
        if (lines[i + 1] && lines[i + 1].length > 2 && lines[i + 1].length < 200 && !/^\d[\d\/\-\.\s]*$/.test(lines[i + 1])) {
          return lines[i + 1].trim();
        }
      }
    }
  }
  for (const line of lines) {
    if (line.length >= 4 && line.length <= 120 && !/^\d+$/.test(line) && !/^\d[\d\s\-\.\/]+$/.test(line)) {
      return line;
    }
  }
  return null;
}

router.post('/extract', upload.single('file'), async (req, res) => {
  let filePath = null;
  try {
    if (!req.file || !req.file.path) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    filePath = req.file.path;
    const ext = (req.file.originalname || '').toLowerCase().split('.').pop() || path.extname(req.file.path).slice(1);

    let text = '';
    if (ext === 'pdf' || req.file.mimetype === 'application/pdf') {
      const pdfParse = require('pdf-parse');
      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse(buffer);
      text = data?.text || '';
    } else {
      // Image: could use tesseract/OCR here; for now return empty and mobile can still use manual entry
      return res.json({
        success: true,
        company_name: null,
        customer_name: null,
        expiry_date: null,
        message: 'Image OCR not configured; please enter details manually.',
      });
    }

    const company_name = findCompanyName(text);
    const expiry_date = findExpiryDate(text);

    res.json({
      success: true,
      company_name: company_name || null,
      customer_name: company_name || null,
      expiry_date: expiry_date || null,
    });
  } catch (err) {
    console.error('documents/extract:', err);
    res.status(500).json({
      success: false,
      message: err?.message || 'Extraction failed',
      company_name: null,
      customer_name: null,
      expiry_date: null,
    });
  } finally {
    if (filePath && fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (_) {}
    }
  }
});

export default router;
