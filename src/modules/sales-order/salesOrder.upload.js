import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';

// Build storage path helper
export const buildStoredPath = (scope, filename) => `uploads/sales_orders/${scope}/${filename}`;

const ensureDir = (dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
};

const UPLOAD_SCOPES = { dispatch: 'dispatch', complete: 'completion', delivery: 'delivery' };

/**
 * Extract base64 image/data from request body and write to disk. Returns array of file-like objects.
 * Use when multer doesn't receive files (e.g. JSON body with attachments as base64).
 */
export async function saveBase64FilesFromBody(req, scope = 'dispatch') {
    const dir = path.join('uploads', 'sales_orders', scope === 'complete' ? 'completion' : scope);
    ensureDir(dir);
    const files = [];
    let payload = req.body;
    if (typeof payload?.payload === 'string') {
        try {
            payload = { ...payload, ...JSON.parse(payload.payload) };
        } catch {
            payload = req.body || {};
        }
    }
    const raw = payload?.attachments || payload?.files || payload?.images || payload?.image || payload?.file || [];
    const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    for (let i = 0; i < list.length; i++) {
        let data = list[i];
        if (typeof data !== 'string') continue;
        const match = data.match(/^data:([^;]+);base64,(.+)$/);
        const base64 = match ? match[2] : data;
        const mime = (match && match[1]) || 'image/jpeg';
        const ext = mime.includes('png') ? '.png' : mime.includes('webp') ? '.webp' : '.jpg';
        const filename = crypto.randomBytes(16).toString('hex') + ext;
        const filePath = path.join(dir, filename);
        try {
            const buf = Buffer.from(base64, 'base64');
            if (buf.length === 0) continue;
            await fs.promises.writeFile(filePath, buf);
            const relPath = `uploads/sales_orders/${scope === 'complete' ? 'completion' : scope}/${filename}`;
            files.push({
                path: filePath,
                file_path: relPath,
                filename,
                originalname: `image_${i}${ext}`,
                mimetype: mime,
                size: buf.length
            });
        } catch (e) {
            console.warn('[upload] base64 save failed', e?.message);
        }
    }
    return files;
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const url = (req.originalUrl || req.url || req.path || '').toLowerCase();
        let scope = 'header';
        if (url.includes('/dispatch')) scope = 'dispatch';
        else if (url.includes('/complete')) scope = 'completion';
        else if (url.includes('/delivered')) scope = 'delivery';

        const uploadPath = path.join('uploads', 'sales_orders', scope);
        ensureDir(uploadPath);
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        const raw = file.originalname || file.originalName || 'file';
        const ext = path.extname(raw) || '.jpg';
        const name = crypto.randomBytes(16).toString('hex');
        cb(null, name + ext);
    }
});

// Accept ALL file types - no filtering (user asked: all formats accept)
const fileFilter = (req, file, cb) => {
    cb(null, true);
};

// Mobile images can be large; avoid 413 / empty files from body size limits (Nginx/Express)
const limits = { fileSize: 20 * 1024 * 1024 }; // 20MB

const multerOpts = { storage, fileFilter, limits };

export const headerUpload = multer(multerOpts);

const multerAny = multer(multerOpts).any();

// Only run multer when request is multipart - otherwise body stays for JSON/base64 fallback
function onlyMultipart(multerMw) {
    return (req, res, next) => {
        const ct = (req.headers['content-type'] || '').toLowerCase();
        if (ct.includes('multipart/form-data')) {
            return multerMw(req, res, next);
        }
        req.files = [];
        next();
    };
}

export const dispatchUpload = onlyMultipart(multerAny);
export const completionUpload = onlyMultipart(multer(multerOpts).any());
export const deliveryUpload = onlyMultipart(multer(multerOpts).any());

// Get files array from req - multer.any() sets req.files as array; support legacy .fields() object shape too
export const getFilesFromRequest = (req) => {
    const f = req.files;
    if (!f) return [];
    if (Array.isArray(f)) return f.slice(0, 50); // cap for safety
    return [].concat(
        f.attachments || [],
        f.files || [],
        f.images || [],
        f.file || [],
        f.photo || [],
        f.photos || [],
        f.documents || []
    ).filter(Boolean).slice(0, 50);
};
