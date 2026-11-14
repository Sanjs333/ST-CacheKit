/* Local log presentation; SPDX-License-Identifier: MPL-2.0 */
export const MAX_LOG_PREVIEW_RECORDS = 10_000;
export const MAX_LOG_RECORD_CHARS = 16 * 1024;
export const LOG_PREVIEW_PAGE_SIZE = 100;

// Explicit names only: unknown/new events keep their original code, never an inferred diagnosis.
export const LOG_EVENT_LABELS = Object.freeze({
    plugin_initializing: 'starting', host_runtime_loaded: 'host_loaded', plugin_ready: 'ready',
    plugin_initialization_failed: 'start_failed', plugin_initialization_cleanup_failed: 'cleanup_failed',
    plugin_stopping: 'stopping', plugin_stopped: 'stopped', plugin_shutdown_failed: 'stop_failed',
    loopback_starting: 'transport_starting', loopback_started: 'transport_ready',
    loopback_start_failed: 'transport_failed', loopback_stopped: 'transport_stopped',
    log_read_failed: 'log_read_failed',
    prepare_started: 'preparing', prepare_succeeded: 'prepared', prepare_failed: 'prepare_failed',
    prepare_client_disconnected: 'disconnected', usage_ledger_create_failed: 'ledger_create_failed',
    usage_ledger_update_failed: 'ledger_update_failed', request_preview_capture_failed: 'preview_failed',
    proxy_request_received: 'request_received', proxy_forward_started: 'forwarding',
    log_capacity_reached: 'log_full', client_log_capacity_reached: 'client_log_full',
    'extension.init_started': 'client_starting', 'extension.init_ready': 'client_ready',
    'extension.init_failed': 'client_failed', 'policy.refresh_started': 'policy_refresh',
    'policy.refresh_completed': 'policy_refreshed', 'policy.restore_completed': 'policy_restored',
    'server.health_started': 'health_check', 'server.health_ready': 'health_ready',
    'server.health_failed': 'health_failed', 'logs.view_started': 'log_loading',
    'logs.view_ready': 'log_loaded', 'logs.view_failed': 'log_read_failed',
    'logs.save_ready': 'log_downloaded', 'logs.save_failed': 'log_download_failed',
});

export function runtimeLogEventLabel(record, localize) {
    if (record.kind !== 'event') return localize('vertex_paygo.logs.preview.raw_entry');
    const name = Object.hasOwn(LOG_EVENT_LABELS, record.event) ? LOG_EVENT_LABELS[record.event] : null;
    return name ? localize(`vertex_paygo.logs.event.${name}`) : record.event;
}

function parseLine(raw, lineNumber) {
    const fallback = { kind: 'raw', raw, lineNumber, level: 'unknown', source: 'unknown', event: '', timestamp: '' };
    if (raw.length > MAX_LOG_RECORD_CHARS) return { ...fallback, reason: 'oversized' };
    if (!raw.trimStart().startsWith('{')) return { ...fallback, reason: 'unparsed' };
    let value;
    try { value = JSON.parse(raw); } catch { return { ...fallback, reason: 'unparsed' }; }
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || typeof value.event !== 'string' || !value.event || value.event.length > 256
        || typeof value.timestamp !== 'string' || value.timestamp.length > 128
        || !['info', 'warn', 'error'].includes(value.level) || !['client', 'server'].includes(value.source)) {
        return { ...fallback, reason: 'unparsed' };
    }
    const context = value.context && typeof value.context === 'object' && !Array.isArray(value.context) ? value.context : null;
    return { kind: 'event', raw, lineNumber, level: value.level, source: value.source,
        event: value.event, timestamp: value.timestamp, context };
}

export function parseRuntimeLog(value, { maxRecords = MAX_LOG_PREVIEW_RECORDS } = {}) {
    const raw = String(value ?? '');
    const limit = Number.isSafeInteger(maxRecords) && maxRecords > 0
        ? Math.min(maxRecords, MAX_LOG_PREVIEW_RECORDS) : MAX_LOG_PREVIEW_RECORDS;
    // Ring of ranges, not split('\n'): even a file of tiny lines has bounded projection memory.
    const ranges = new Array(limit);
    let offset = 0, lineNumber = 0, count = 0;
    while (offset < raw.length) {
        const newline = raw.indexOf('\n', offset);
        const end = newline === -1 ? raw.length : newline;
        const line = raw.slice(offset, end);
        lineNumber++;
        if (line.trim()) { ranges[count % limit] = { start: offset, end, lineNumber }; count++; }
        offset = end + 1;
    }
    const records = [];
    for (let index = count - 1; index >= Math.max(0, count - limit); index--) {
        const range = ranges[index % limit];
        records.push(parseLine(raw.slice(range.start, range.end), range.lineNumber));
    }
    return { raw, records, total: count, omitted: Math.max(0, count - limit) };
}

export function filterRuntimeLogRecords(records, { level = 'all', query = '' } = {}, localize) {
    const search = String(query).trim().slice(0, 200).toLowerCase();
    return records.filter(record => (level === 'all' || record.level === level)
        && (!search || record.raw.toLowerCase().includes(search)
            || runtimeLogEventLabel(record, localize).toLowerCase().includes(search)));
}

export function runtimeLogTime(timestamp, { locale, getFormatters } = {}) {
    // Do not reinterpret arbitrary text (or browser-dependent date strings) as a timestamp.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(timestamp)) return { short: '—', full: timestamp || '—' };
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return { short: '—', full: timestamp };
    try {
        const formatters = getFormatters?.() ?? {
            short: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
            full: new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
        };
        return { short: formatters.short.format(date), full: formatters.full.format(date) };
    } catch { return { short: date.toLocaleTimeString(), full: date.toLocaleString() }; }
}
