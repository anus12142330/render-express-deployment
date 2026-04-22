import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_ROOT = path.resolve(__dirname, '../../../uploads/cargo_returns');

const ensureDir = (dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
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

/** Multipart upload for cargo return attachments (field name: `attachments`). */
export const cargoReturnUpload = multer({
    storage,
    limits: { fileSize: 25 * 1024 * 1024, files: 20 }
});

/** Relative path stored in DB (served under app.use('/uploads', ...)). */
export function buildCargoReturnStoredPath(filename) {
    return `uploads/cargo_returns/files/${filename}`;
}
