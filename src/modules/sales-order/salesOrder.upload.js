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

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Determine subdirectory based on route or scope
        // We'll organize by scope: header, dispatch, completion
        // Default to 'header' if not clear
        let scope = 'header';
        if (req.path.includes('/dispatch')) scope = 'dispatch';
        else if (req.path.includes('/complete')) scope = 'completion';
        else if (req.path.includes('/delivered')) scope = 'delivery';

        const uploadPath = path.join('uploads', 'sales_orders', scope);
        ensureDir(uploadPath);
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const name = crypto.randomBytes(16).toString('hex');
        cb(null, name + ext);
    }
});

// Filters
const fileFilter = (req, file, cb) => {
    // Allow images, pdfs, docs
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    if (allowed.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(null, true); // Allow all for now, or stricter if needed
    }
};

export const headerUpload = multer({ storage, fileFilter });
export const dispatchUpload = multer({ storage, fileFilter });
export const completionUpload = multer({ storage, fileFilter });
export const deliveryUpload = multer({ storage, fileFilter });
