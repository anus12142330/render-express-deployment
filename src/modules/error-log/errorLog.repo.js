import db from '../../../db.js';

export async function insertErrorLog(row) {
    const {
        source,
        severity,
        message,
        stack,
        context_json,
        device_id,
        device_type,
        app_version,
        user_id,
        user_email,
        request_id,
        session_id,
        url,
        api_path
    } = row || {};

    const ctx =
        context_json == null
            ? null
            : typeof context_json === 'string'
              ? context_json
              : JSON.stringify(context_json);

    const [res] = await db.promise().query(
        `INSERT INTO app_error_logs
         (source, severity, message, stack, context_json, device_id, device_type, app_version, user_id, user_email, request_id, session_id, url, api_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            source,
            severity || 'ERROR',
            String(message || 'Unknown error'),
            stack != null ? String(stack) : null,
            ctx,
            device_id != null ? String(device_id) : null,
            device_type || 'UNKNOWN',
            app_version != null ? String(app_version) : null,
            user_id != null ? Number(user_id) : null,
            user_email != null ? String(user_email) : null,
            request_id != null ? String(request_id) : null,
            session_id != null ? String(session_id) : null,
            url != null ? String(url) : null,
            api_path != null ? String(api_path) : null
        ]
    );
    return res?.insertId || null;
}

export async function getErrorLogById(id) {
    const [rows] = await db.promise().query(`SELECT * FROM app_error_logs WHERE id = ?`, [id]);
    return rows?.[0] || null;
}

export async function listErrorLogs({ page, pageSize, search, source, userId, from, to }) {
    const terms = [];
    const args = [];

    if (from) {
        terms.push('created_at >= ?');
        args.push(from);
    }
    if (to) {
        terms.push('created_at <= ?');
        args.push(to);
    }
    if (source) {
        terms.push('source = ?');
        args.push(source);
    }
    if (userId != null) {
        terms.push('user_id = ?');
        args.push(userId);
    }
    if (search && String(search).trim()) {
        const q = `%${String(search).trim()}%`;
        terms.push('(message LIKE ? OR api_path LIKE ? OR url LIKE ? OR user_email LIKE ?)');
        args.push(q, q, q, q);
    }

    const where = terms.length ? `WHERE ${terms.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;

    const [countRows] = await db.promise().query(`SELECT COUNT(*) AS cnt FROM app_error_logs ${where}`, args);
    const total = Number(countRows?.[0]?.cnt ?? 0);

    const [rows] = await db.promise().query(
        `SELECT id, created_at, source, severity, message, device_type, device_id, app_version, user_id, user_email, api_path, url
         FROM app_error_logs
         ${where}
         ORDER BY id DESC
         LIMIT ? OFFSET ?`,
        [...args, pageSize, offset]
    );
    return { rows: rows || [], total };
}

