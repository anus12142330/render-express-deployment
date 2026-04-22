import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_ROOT = path.resolve(__dirname, '../uploads/inventory_adjustments');

const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(UPLOAD_ROOT, 'files');
    ensureDir(uploadPath);
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '') || '.bin';
    cb(null, crypto.randomBytes(16).toString('hex') + ext);
  }
});

/** Multipart upload (field name: `attachments`). */
export const inventoryAdjustmentUpload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 20 }
});

export function buildIaStoredPath(filename) {
  return `uploads/inventory_adjustments/files/${filename}`;
}
