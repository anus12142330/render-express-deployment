import db from '../../../db.js';
import { insertErrorLog, getErrorLogById, listErrorLogs } from './errorLog.repo.js';

async function isSuperAdmin(userId) {
    if (!userId) return false;
    const [adm] = await db
        .promise()
        .query(
            `SELECT 1
               FROM user_role ur
               JOIN role r ON r.id = ur.role_id
              WHERE ur.user_id=? AND r.name='Super Admin'
              LIMIT 1`,
            [userId]
        );
    return Boolean(adm?.[0]);
}

function clampInt(v, { min, max, fallback }) {
    const n = Number.parseInt(String(v ?? ''), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function thirtyDaysAgoIso() {
    const d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 19).replace('T', ' ');
}

export async function createErrorLogHandler(req, res) {
    try {
        const user = req.session?.user || req.user || req.mobileUser || null;
        const body = req.body || {};

        const source = String(body.source || 'WEB').toUpperCase();
        const severity = String(body.severity || 'ERROR').toUpperCase();

        const id = await insertErrorLog({
            source: ['WEB', 'MOBILE', 'SERVER'].includes(source) ? source : 'WEB',
            severity: ['ERROR', 'WARN'].includes(severity) ? severity : 'ERROR',
            message: body.message,
            stack: body.stack,
            context_json: body.context || body.context_json || null,
            device_id: body.device_id,
            device_type: body.device_type,
            app_version: body.app_version,
            user_id: user?.id || null,
            user_email: user?.email || null,
            request_id: body.request_id || req.headers['x-request-id'] || null,
            session_id: body.session_id || null,
            url: body.url || null,
            api_path: body.api_path || null
        });

        return res.status(201).json({ id });
    } catch (e) {
        return res.status(500).json({ error: e?.message || 'Failed to log error' });
    }
}

export async function listErrorLogsHandler(req, res) {
    const userId = req.session?.user?.id || req.user?.id || req.mobileUser?.id;
    if (!(await isSuperAdmin(userId))) return res.status(403).json({ error: 'Forbidden' });

    const page = clampInt(req.query.page, { min: 1, max: 1000000, fallback: 1 });
    const pageSize = clampInt(req.query.pageSize, { min: 1, max: 200, fallback: 25 });

    const sourceRaw = req.query.source ? String(req.query.source).toUpperCase() : '';
    const source = ['WEB', 'MOBILE', 'SERVER'].includes(sourceRaw) ? sourceRaw : null;

    const from = req.query.from ? String(req.query.from) : thirtyDaysAgoIso();
    const to = req.query.to ? String(req.query.to) : null;
    const search = req.query.search ? String(req.query.search) : '';
    const filterUserId = req.query.user_id != null && String(req.query.user_id).trim() !== '' ? Number(req.query.user_id) : null;

    const { rows, total } = await listErrorLogs({
        page,
        pageSize,
        search,
        source,
        userId: filterUserId,
        from,
        to
    });

    return res.json({ rows, total, page, pageSize });
}

export async function getErrorLogByIdHandler(req, res) {
    const userId = req.session?.user?.id || req.user?.id || req.mobileUser?.id;
    if (!(await isSuperAdmin(userId))) return res.status(403).json({ error: 'Forbidden' });

    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });

    const row = await getErrorLogById(id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    return res.json(row);
}

