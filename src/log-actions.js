/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createLocalizer } from './i18n.js';
import { filterRuntimeLogRecords, LOG_PREVIEW_PAGE_SIZE, parseRuntimeLog, runtimeLogEventLabel, runtimeLogTime } from './log-preview.js';
import { bindExtensionTheme } from './theme.js';
import { createExtensionDialog } from './dialog.js';

const viewers = new WeakMap();

const popupChrome = new WeakMap();
const CONTEXT_FIELDS = new Set(['errorCode', 'statusCode', 'durationMs', 'model', 'provider', 'tier', 'region',
    'phase', 'requestId', 'clientSessionId', 'clientVersion', 'protocolVersion', 'stream', 'paygoOnly', 'serverStatus']);

function requireDocument(documentRef) {
    if (!documentRef || typeof documentRef.createElement !== 'function') throw new TypeError('A document implementation is required.');
    return documentRef;
}

export function buildLogFilename() { return 'st-vertex-paygo.log'; }

export function disposeLogViewerContent(container) {
    viewers.get(container)?.();
    viewers.delete(container);
    popupChrome.get(container)?.status.remove?.();
    popupChrome.get(container)?.header.remove?.();
    popupChrome.delete(container);
}

export function createLogViewerContent(text, {
    documentRef = globalThis.document, localize = createLocalizer(),
    title, description = '', emptyText, locale = documentRef?.documentElement?.lang || globalThis.navigator?.language,
    clipboard = globalThis.navigator?.clipboard,
    download = raw => downloadLogText(raw, { documentRef }),
    closeText = localize('vertex_paygo.logs.close'), onClose = () => {},
} = {}) {
    const doc = requireDocument(documentRef);
    const model = parseRuntimeLog(text);
    let timeFormatters;
    const getTimeFormatters = () => timeFormatters ??= {
        short: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
        full: new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
    };
    const key = (name, values) => localize(`vertex_paygo.logs.${name}`, values);
    const make = (tag, className = '', value, attributes = {}) => {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (value !== undefined) node.textContent = String(value);
        for (const [name, val] of Object.entries(attributes)) node.setAttribute(name, val);
        return node;
    };
    let disposed = false, page = 0, mode = 'preview', filter = 'all', query = '', timer;
    let rowDisposers = [];
    const disposers = [];
    const listen = (node, event, fn, rows = false) => {
        node.addEventListener(event, fn);
        (rows ? rowDisposers : disposers).push(() => node.removeEventListener(event, fn));
    };
    const resetRows = () => { for (const dispose of rowDisposers) dispose(); rowDisposers = []; };
    const container = make('div', 'vertex-paygo-log-viewer');
    const header = make('header', 'vertex-paygo-log-header');
    const headingRow = make('div', 'vertex-paygo-log-heading-row');
    const closeButton = make('button', 'vertex-paygo-icon-button vertex-paygo-log-tool vertex-paygo-log-close', undefined,
        { type: 'button', title: closeText, 'aria-label': closeText, 'data-log-close': '' });
    closeButton.append(make('i', 'fa-solid fa-xmark', undefined, { 'aria-hidden': 'true' }));
    headingRow.append(make('h3', '', title ?? key('title')), closeButton);
    header.append(headingRow);
    listen(closeButton, 'click', onClose);
    const status = make('span', 'vertex-paygo-log-result-status', '', { 'aria-live': 'polite', 'data-log-status': '' });
    if (description) header.append(make('p', 'vertex-paygo-log-description', description));
    const toolbar = make('div', 'vertex-paygo-log-toolbar');
    const switcher = make('div', 'vertex-paygo-log-mode', undefined, { role: 'group', 'aria-label': key('preview.view_mode') });
    const previewButton = make('button', 'menu_button', key('preview.preview'), { type: 'button', 'data-log-mode': 'preview' });
    const rawButton = make('button', 'menu_button', key('preview.original'), { type: 'button', 'data-log-mode': 'raw' });
    switcher.append(previewButton, rawButton);
    const iconButton = (name, icon, extra = {}) => {
        const classes = extra['data-log-action'] ? 'vertex-paygo-icon-button vertex-paygo-log-tool' : 'menu_button vertex-paygo-icon-button';
        const button = make('button', classes, undefined, {
            type: 'button', title: key(name), 'aria-label': key(name), ...extra,
        });
        button.append(make('i', `fa-solid ${icon}`, undefined, { 'aria-hidden': 'true' }));
        return button;
    };
    const tools = make('div', 'vertex-paygo-log-tools');
    const copyButton = iconButton('preview.copy_raw', 'fa-copy', { 'data-log-action': 'copy' });
    const downloadButton = iconButton('preview.download_raw', 'fa-download', { 'data-log-action': 'download' });
    tools.append(copyButton, downloadButton);
    toolbar.append(switcher, tools);
    const filters = make('div', 'vertex-paygo-log-filters');
    const search = make('input', 'text_pole', undefined, { type: 'search', maxlength: '200',
        placeholder: key('preview.search'), 'aria-label': key('preview.search'), 'data-log-filter': 'search' });
    const level = make('select', 'text_pole', undefined, { 'aria-label': key('preview.level'), 'data-log-filter': 'level' });
    for (const value of ['all', 'error', 'warn', 'info', 'unknown']) {
        level.append(make('option', '', key(`preview.level_${value}`), { value }));
    }
    level.value = 'all';
    filters.append(search, level);
    const notice = make('p', 'vertex-paygo-log-preview-notice', '', { 'data-log-limit': '' });
    notice.hidden = !model.omitted;
    if (model.omitted) notice.textContent = key('preview.limit', { count: model.records.length, total: model.total });
    const feedback = make('small', 'vertex-paygo-log-feedback', '', { 'aria-live': 'polite' });
    feedback.hidden = true;
    header.append(toolbar, filters, notice, feedback);
    const list = make('div', 'vertex-paygo-log-list', undefined, { 'data-log-list': '' });
    const original = make('pre', 'vertex-paygo-log-output', undefined, { tabindex: '0', 'aria-label': key('preview.original') });
    original.hidden = true;
    const navigation = make('nav', 'vertex-paygo-log-navigation', undefined, { 'aria-label': key('preview.pages') });
    const previous = iconButton('preview.previous', 'fa-chevron-left', { 'data-log-page': 'previous' });
    const next = iconButton('preview.next', 'fa-chevron-right', { 'data-log-page': 'next' });
    const pageLabel = make('span', '', '', { 'aria-live': 'polite' });
    navigation.append(previous, pageLabel, next);
    const counterFallback = make('footer', 'vertex-paygo-log-count-fallback');
    counterFallback.append(status);
    container.append(header, list, original, navigation, counterFallback);
    popupChrome.set(container, { header, status, fallback: counterFallback });
    const resetScroll = () => {
        const scroller = container.closest?.('.popup-content, .vertex-paygo-dialog-content');
        if (scroller) scroller.scrollTop = 0;
    };
    const showFeedback = (value, error = false) => {
        if (disposed) return;
        feedback.hidden = false; feedback.textContent = value;
        feedback.classList.toggle('vertex-paygo-status--error', error);
    };

    function buildEntry(record) {
        const row = make('details', 'vertex-paygo-log-entry', undefined, { 'data-level': record.level, 'data-log-line': String(record.lineNumber) });
        const summary = make('summary', 'vertex-paygo-log-entry-summary');
        summary.append(make('i', 'fa-solid fa-angle-right vertex-paygo-log-disclosure', undefined, { 'aria-hidden': 'true' }));
        const time = runtimeLogTime(record.timestamp, { locale, getFormatters: getTimeFormatters });
        summary.append(make('span', 'vertex-paygo-log-time', time.short, { title: time.full }),
            make('span', 'vertex-paygo-log-level', key(`preview.level_${record.level}`)));
        const sourceLabel = record.kind === 'event' ? key(`preview.source_${record.source}`) : '—';
        summary.append(make('span', 'vertex-paygo-log-source', sourceLabel));
        const caption = make('span', 'vertex-paygo-log-caption');
        const eventLabel = runtimeLogEventLabel(record, localize);
        caption.append(make('span', 'vertex-paygo-log-event', eventLabel, { title: eventLabel }));
        const errorCode = record.context?.errorCode;
        if (typeof errorCode === 'string' || typeof errorCode === 'number') {
            caption.append(make('code', 'vertex-paygo-log-code', String(errorCode).slice(0, 256)));
        } else if (record.kind === 'raw') {
            caption.append(make('span', 'vertex-paygo-log-excerpt', record.raw.slice(0, 160).replace(/\s+/gu, ' ') + (record.raw.length > 160 ? '…' : '')));
        }
        summary.append(caption);
        const body = make('div', 'vertex-paygo-log-entry-body');
        row.append(summary, body);
        let loaded = false;
        listen(row, 'toggle', () => {
            if (!row.open || loaded || disposed) return;
            loaded = true;
            if (record.kind === 'event') {
                body.append(make('p', 'vertex-paygo-log-entry-name', eventLabel));
                const details = make('dl', 'vertex-paygo-log-fields');
                const pair = (label, value) => details.append(make('dt', '', label), make('dd', '', value));
                pair(key('preview.timestamp'), `${time.full} · ${record.timestamp}`);
                pair(key('preview.event_code'), record.event);
                if (record.context) {
                    const entries = Object.entries(record.context);
                    for (const [name, value] of entries.slice(0, 32)) {
                        let display;
                        if (typeof value === 'object' && value !== null) {
                            display = JSON.stringify(value);
                        } else display = String(value);
                        if (display.length > 2048) display = display.slice(0, 2048) + '…';
                        pair(CONTEXT_FIELDS.has(name) ? key(`field.${name}`) : name, display);
                    }
                    if (entries.length > 32) body.append(make('p', 'vertex-paygo-log-description', key('preview.more_fields')));
                }
                body.append(details);
                const rawDetails = make('details', 'vertex-paygo-log-json');
                const rawSummary = make('summary', 'vertex-paygo-log-json-summary');
                rawSummary.append(make('i', 'fa-solid fa-angle-right vertex-paygo-log-disclosure', undefined, { 'aria-hidden': 'true' }),
                    make('span', '', key('preview.raw_record')));
                rawDetails.append(rawSummary);
                let rawLoaded = false;
                listen(rawDetails, 'toggle', () => {
                    if (!rawDetails.open || rawLoaded || disposed) return;
                    rawLoaded = true;
                    rawDetails.append(make('pre', 'vertex-paygo-log-record-raw', record.raw));
                }, true);
                body.append(rawDetails);
            } else {
                body.append(make('p', 'vertex-paygo-log-description', key(`preview.${record.reason}`)),
                    make('pre', 'vertex-paygo-log-record-raw', record.raw));
            }
        }, true);
        return row;
    }

    function render() {
        if (disposed) return;
        resetRows(); list.replaceChildren();
        const isRaw = mode === 'raw';
        previewButton.setAttribute('aria-pressed', String(!isRaw)); rawButton.setAttribute('aria-pressed', String(isRaw));
        filters.hidden = isRaw;
        notice.hidden = isRaw || !model.omitted;
        list.hidden = isRaw; original.hidden = !isRaw; navigation.hidden = isRaw;
        if (isRaw) {
            // Original mode ignores preview filters and always shows the complete, unchanged file.
            original.textContent = model.raw || emptyText || key('empty');
            status.textContent = String(model.total);
            status.setAttribute('title', key('preview.raw_hint'));
            status.setAttribute('aria-label', `${model.total} · ${key('preview.raw_hint')}`);
            return;
        }
        original.textContent = '';
        const filtered = filterRuntimeLogRecords(model.records, { level: filter, query }, localize);
        const pages = Math.max(1, Math.ceil(filtered.length / LOG_PREVIEW_PAGE_SIZE));
        page = Math.min(page, pages - 1);
        const visible = filtered.slice(page * LOG_PREVIEW_PAGE_SIZE, (page + 1) * LOG_PREVIEW_PAGE_SIZE);
        for (const record of visible) list.append(buildEntry(record));
        if (!visible.length) list.append(make('p', 'vertex-paygo-log-empty', model.total ? key('preview.no_matches') : emptyText || key('empty')));
        status.textContent = `${filtered.length}/${model.total}`;
        const countDescription = key('preview.count', { shown: visible.length, matched: filtered.length, total: model.total });
        status.setAttribute('title', countDescription);
        status.setAttribute('aria-label', countDescription);
        navigation.hidden = pages < 2;
        previous.disabled = page === 0; next.disabled = page >= pages - 1;
        pageLabel.textContent = key('preview.page', { page: page + 1, pages });
    }
    listen(previewButton, 'click', () => { mode = 'preview'; render(); resetScroll(); });
    listen(rawButton, 'click', () => { clearTimeout(timer); query = search.value; page = 0; mode = 'raw'; render(); resetScroll(); });
    listen(level, 'change', () => { filter = level.value; page = 0; render(); resetScroll(); });
    listen(search, 'input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => { query = search.value; page = 0; render(); resetScroll(); }, 120);
    });
    listen(previous, 'click', () => { if (!previous.disabled) { page--; render(); resetScroll(); } });
    listen(next, 'click', () => { if (!next.disabled) { page++; render(); resetScroll(); } });
    listen(copyButton, 'click', async () => {
        copyButton.disabled = true;
        try {
            if (typeof clipboard?.writeText !== 'function') throw new Error('Clipboard unavailable');
            await clipboard.writeText(model.raw); showFeedback(key('preview.copied'));
        } catch { showFeedback(key('preview.copy_failed'), true); }
        finally { if (!disposed) copyButton.disabled = false; }
    });
    listen(downloadButton, 'click', () => {
        try { download(model.raw); showFeedback(key('preview.downloaded')); }
        catch { showFeedback(key('preview.download_failed'), true); }
    });
    viewers.set(container, () => {
        if (disposed) return;
        disposed = true; clearTimeout(timer); resetRows();
        for (const dispose of disposers) dispose();
    });
    render();
    return container;
}

export async function showLogViewer(text, { context, documentRef = globalThis.document,
    localize = createLocalizer(), title, description, emptyText, closeText = 'Close', ...options } = {}) {
    let popup, theme;
    const dismiss = () => {
        if (typeof popup?.complete === 'function') void popup.complete(context?.POPUP_RESULT?.NEGATIVE ?? 0);
        else if (typeof popup?.closeButton?.click === 'function') popup.closeButton.click();
        else popup?.okButton?.click?.();
    };
    const content = createLogViewerContent(text, { documentRef, localize, title, description, emptyText, ...options, closeText, onClose: dismiss });
    try {
        popup = createExtensionDialog(content, { okButton: false,
            wide: true, large: true, leftAlign: true, allowHorizontalScrolling: false, allowVerticalScrolling: true });
        popup.dlg?.classList?.add('vertex-paygo-log-dialog');
        if (popup.closeButton?.style) popup.closeButton.style.display = 'none';
        // A transparent header must not overlay scrolled text. Keep it as a
        // non-scrolling sibling of native popup-content, rather than a tinted sticky card.
        const chrome = popupChrome.get(content);
        if (typeof popup.body?.insertBefore === 'function' && popup.content?.parentElement === popup.body) {
            chrome.header.remove();
            popup.body.insertBefore(chrome.header, popup.content);
        }
        // Use the host footer, outside its scrolling content. Older popup adapters
        // without buttonControls retain the standalone content-footer fallback.
        if (typeof popup.buttonControls?.append === 'function') {
            const counter = popupChrome.get(content);
            counter.status.remove();
            popup.buttonControls.append(counter.status);
            counter.fallback.hidden = true;
        }
        theme = bindExtensionTheme(popup.dlg ?? content, { skipBg: false });
        const showing = popup.show();
        theme.sync();
        return await showing;
    } finally { theme?.destroy(); disposeLogViewerContent(content); }
}

export function downloadLogText(text, {
    documentRef = globalThis.document,
    BlobImpl = globalThis.Blob,
    urlApi = globalThis.URL,
    filename = buildLogFilename(),
} = {}) {
    const resolvedDocument = requireDocument(documentRef);
    if (typeof BlobImpl !== 'function' || typeof urlApi?.createObjectURL !== 'function' || typeof urlApi?.revokeObjectURL !== 'function') {
        throw new TypeError('Browser download APIs are unavailable.');
    }

    const blob = new BlobImpl([String(text)], { type: 'text/plain;charset=utf-8' });
    let objectUrl;
    let link;
    try {
        objectUrl = urlApi.createObjectURL(blob);
        link = resolvedDocument.createElement('a');
        link.href = objectUrl;
        link.download = String(filename);
        link.hidden = true;
        resolvedDocument.body?.append(link);
        link.click();
    } finally {
        link?.remove?.();
        if (objectUrl !== undefined) urlApi.revokeObjectURL(objectUrl);
    }
    return filename;
}
