/* SPDX-License-Identifier: MPL-2.0 */
export function billingDate(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const value = key => parts.find(part => part.type === key)?.value;
    return `${value('year')}-${value('month')}-${value('day')}`;
}

export function summarizeBillingRows(rows) {
    const groups = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || typeof row.currency !== 'string' || !/^[A-Z]{3}$/.test(row.currency) || !Number.isFinite(row.netCost)) continue;
        const group = groups.get(row.currency) ?? { currency: row.currency, netCost: 0, count: 0 };
        group.netCost += row.netCost; group.count++; groups.set(row.currency, group);
    }
    return [...groups.values()].filter(group => Number.isFinite(group.netCost));
}

export function billingMoney(value, currency) {
    if (!Number.isFinite(value) || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return '—';
    try { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency, currencyDisplay: 'code', minimumFractionDigits: 5, maximumFractionDigits: 8 }).format(value); }
    catch { return `${currency} ${value.toFixed(8)}`; }
}

/** BigQuery CAST(TIMESTAMP AS STRING) uses a space and short UTC offset. */
export function billingExportDate(value) {
    if (typeof value !== 'string') return null;
    const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(value.trim());
    if (!match) return null;
    let zone = match[4];
    if (/^[+-]\d{2}$/.test(zone)) zone += ':00';
    else if (/^[+-]\d{4}$/.test(zone)) zone = zone.slice(0, 3) + ':' + zone.slice(3);
    const date = new Date(`${match[1]}T${match[2]}${match[3] ? '.' + match[3].slice(0, 3) : ''}${zone}`);
    return Number.isFinite(date.getTime()) ? date : null;
}

export const BILLING_SETTINGS_DEFAULTS = Object.freeze({ version: 1, enabled: false, queryProject: '', datasetProject: '', dataset: '', table: '', projectFilter: '', location: 'US', secretId: '', labelMode: 'off' });

/** Reject an incomplete read instead of turning a damaged response into a blank save. */
export function billingSettings(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean'
        || !['off', 'chat', 'request'].includes(value.labelMode)
        || !['queryProject', 'dataset', 'table'].every(key => typeof value[key] === 'string')) {
        throw new Error('账单设置响应不完整，请重新读取。');
    }
    const projected = { ...BILLING_SETTINGS_DEFAULTS };
    for (const key of Object.keys(projected)) {
        if (key === 'version') continue;
        if (value[key] !== undefined) {
            if (typeof value[key] !== typeof projected[key]) throw new Error('账单设置响应格式无效，请重新读取。');
            projected[key] = value[key];
        }
    }
    return projected;
}

export function sameBillingSettings(left, right) {
    return !!left && !!right && Object.keys(BILLING_SETTINGS_DEFAULTS).every(key => left[key] === right[key]);
}

function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Build exactly the requested scope; a request ID is independent of the open chat. */
export function billingQuery({ startDate, endDate, scope = 'project', chatId, requestId } = {}) {
    if (!validDate(startDate) || !validDate(endDate)) throw new Error('请选择有效的账单开始和结束日期。');
    const span = (Date.parse(endDate) - Date.parse(startDate)) / 86400000;
    if (span < 0 || span > 30) throw new Error('结束日期不能早于开始日期，查询范围最多 31 天。');
    if (!['project', 'chat', 'request'].includes(scope)) throw new Error('请选择有效的账单查询范围。');
    const query = { startDate, endDate };
    const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
    if (scope === 'chat') {
        if (!identifier(chatId)) throw new Error('请先打开已有请求记录的聊天。');
        query.chatId = chatId;
    }
    if (scope === 'request') {
        if (typeof requestId !== 'string' || !/^[a-z0-9_-]{1,63}$/.test(requestId)) throw new Error('请输入有效的请求 ID（小写字母、数字、下划线或连字符，最多 63 字符）。');
        query.requestId = requestId;
    }
    return query;
}

/** Only billing export rows feed the actual-cost UI; estimate records cannot enter it. */
export function billingRows(value) {
    if (value?.ok !== true || value.kind !== 'billing-export' || !Array.isArray(value.rows)) throw new Error('实际账单响应格式无效。');
    return value.rows.slice(0, 1000).filter(row => row && typeof row === 'object' && !Array.isArray(row)).map(row => ({
        day: validDate(row.day) ? row.day : null,
        currency: typeof row.currency === 'string' && /^[A-Z]{3}$/.test(row.currency) ? row.currency : null,
        grossCost: Number.isFinite(row.grossCost) ? row.grossCost : null,
        credits: Number.isFinite(row.credits) ? row.credits : null,
        netCost: Number.isFinite(row.netCost) ? row.netCost : null,
        lastExportTime: typeof row.lastExportTime === 'string' ? row.lastExportTime.slice(0, 128) : null,
        requestLabel: typeof row.requestLabel === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(row.requestLabel) ? row.requestLabel : null,
    }));
}
