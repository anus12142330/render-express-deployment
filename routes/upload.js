// server/routes/upload.js  (ESM)
import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const router = Router();

// Resolve project root (so this works regardless of CWD)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..'); // adjust if your structure differs

const UPLOAD_ROOT = path.join(ROOT, 'uploads'); // /uploads
const SUBDIR = 'document_templates';            // /uploads/document_templates

// ensure dirs exist
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
ensureDir(path.join(UPLOAD_ROOT, SUBDIR));

const allowedExt = ['.pdf', '.doc', '.docx', '.png', '.jpg', '.jpeg', '.svg'];
const allowedMime = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png',
  'image/jpeg',
  'image/svg+xml'
]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(UPLOAD_ROOT, SUBDIR));
  },
  filename: (req, file, cb) => {
    const original = (file.originalname || 'file').toLowerCase();
    const ext = path.extname(original);
    const base = path.basename(original, ext).replace(/[^a-z0-9.\-_]/g, '_');
    const fname = `${base}-${Date.now()}${ext}`;
    cb(null, fname);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!allowedExt.includes(ext) || !allowedMime.has(file.mimetype)) {
      return cb(new Error('Unsupported file type'));
    }
    cb(null, true);
  }
});

router.post('/', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

  // Relative path used by your frontend for "View"
  const relPath = path.join('uploads', SUBDIR, req.file.filename).replace(/\\/g, '/');
  return res.json({
    path: relPath,
    originalName: req.file.originalname,
    mime: req.file.mimetype,
    size: req.file.size
  });
});

export default router;
