export const requireFields = (body, fields = []) => {
    const missing = fields.filter((key) => body?.[key] === undefined || body?.[key] === null || body?.[key] === '');
    return missing;
};

export const validateItems = (items = []) => {
    const errors = [];
    if (!Array.isArray(items) || items.length === 0) {
        errors.push('At least 1 item is required.');
        return errors;
    }

    items.forEach((item, idx) => {
        const qty = Number(item?.quantity ?? item?.qty ?? 0);
        const price = Number(item?.unit_price ?? item?.unitPrice ?? 0);
        if (!Number.isFinite(qty) || qty <= 0) {
            errors.push(`Item ${idx + 1}: quantity must be > 0.`);
        }
        if (!Number.isFinite(price) || price < 0) {
            errors.push(`Item ${idx + 1}: unit_price must be >= 0.`);
        }
    });

    return errors;
};

export const normalizeTaxMode = (mode) => {
    const value = String(mode || '').toUpperCase();
    return value === 'INCLUSIVE' ? 'INCLUSIVE' : 'EXCLUSIVE';
};
