/*
 * Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0.
 */

import { cacheTokenCount, calculateCacheHitRate, formatCacheHitRate, summarizeUsage } from './cost-model.js';
import { EXTENSION_DISPLAY_NAME, MAX_USAGE_RECORDS_PER_CHAT } from './constants.js';
import { createLocalizer } from './i18n.js';
import { createPriceSettingsUi } from './price-settings-ui.js';
import { bindExtensionTheme } from './theme.js';
import { createExtensionDialog } from './dialog.js';
import { mountExtensionSettings } from './extension-settings.js';

const POLL_MS = 5_000;

function element(documentRef, tag, className, text) {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
}

function iconButton(documentRef, label, iconClass, className) {
    const button = element(documentRef, 'button', `vertex-paygo-icon-button vertex-paygo-cost-icon-button ${className}`);
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    const icon = element(documentRef, 'i', `fa-solid ${iconClass}`);
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon);
    return button;
}

function money(value) {
    return `$${Number(value).toFixed(6)}`;
}

function cacheRate(value) {
    return formatCacheHitRate(value);
}

function errorText(code, t = createLocalizer()) {
    const normalized = String(code ?? '').toUpperCase();
    if (!normalized) return '';
    if (normalized === '429' || normalized.endsWith('_429') || normalized.includes('RATE') || normalized.includes('QUOTA')) return t("vertex_paygo.costs.rate_limited");
    if (normalized.includes('ABORT') || normalized.includes('CANCEL') || normalized === 'CLIENT_DISCONNECTED') return t("vertex_paygo.costs.disconnected");
    if (normalized.includes('COMPRESS') || normalized.includes('COMPACT')) return t("vertex_paygo.costs.compressed");
    if (normalized.includes('RESTART')) return t("vertex_paygo.costs.restarted");
    if (normalized.includes('TIMEOUT')) return t("vertex_paygo.costs.timeout");
    if (normalized === 'UPSTREAM_RESPONSE_STREAM_FAILED') return t("vertex_paygo.costs.stream_interrupted");
    if (normalized === 'USAGE_METADATA_MISSING') return t("vertex_paygo.costs.usage_omitted");
    if (normalized.includes('LIMIT')) return t("vertex_paygo.costs.capture_limit");
    const http = normalized.match(/HTTP_(\d{3})$/);
    if (http) return `HTTP ${http[1]}`;
    return t("vertex_paygo.costs.request_error");
}

function statusText(record, estimate, t = createLocalizer()) {
    if (record?.status === 'pending') return t("vertex_paygo.costs.pending");
    if (record?.status === 'failed') return t("vertex_paygo.costs.failed", { p0: errorText(record.errorCode, t) ? `（${errorText(record.errorCode, t)}）` : '' });
    if (record?.status === 'incomplete' && record.errorCode) {
        return errorText(record.errorCode, t) + (estimate.amount !== null ? t("vertex_paygo.costs.partial_suffix") : '');
    }
    const reasons = {
        usage_missing: t("vertex_paygo.costs.no_usage"), usage_incomplete: t("vertex_paygo.costs.usage_incomplete"),
        cache_exceeds_prompt: t("vertex_paygo.costs.usage_invalid"), provisioned_throughput: t("vertex_paygo.costs.provisioned"),
        unsupported_modality: t("vertex_paygo.costs.modality"), traffic_tier_mismatch: t("vertex_paygo.costs.tier_mismatch"),
        price_missing: t("vertex_paygo.costs.price_missing"), long_price_missing: t("vertex_paygo.costs.long_price_missing"),
        tool_use: t("vertex_paygo.costs.tool_partial"), request_incomplete: t("vertex_paygo.costs.usage_partial"),
        tauri_normalized: t("vertex_paygo.costs.tauri_partial"),
        cache_count_missing: t("vertex_paygo.costs.cache_unknown"),
        cache_count_mixed: t("vertex_paygo.costs.cache_mixed"),
        cache_count_invalid: t("vertex_paygo.costs.cache_invalid"),
    };
    if (estimate.reason && reasons[estimate.reason]) {
        const suffix = estimate.priceSource === 'current' && estimate.amount !== null ? t("vertex_paygo.costs.current_price_suffix") : '';
        return `${reasons[estimate.reason]}${suffix}`;
    }
    if (record?.status === 'incomplete') return t("vertex_paygo.costs.incomplete");
    if (estimate.status === 'estimated') return estimate.priceSource === 'current' ? t("vertex_paygo.costs.estimated_current") : t("vertex_paygo.costs.estimated");
    if (estimate.status === 'partial') return estimate.priceSource === 'current' ? t("vertex_paygo.costs.partial_current") : t("vertex_paygo.costs.partial");
    if (estimate.status === 'unpriced') return t("vertex_paygo.costs.price_missing");
    return errorText(record?.errorCode, t) || t("vertex_paygo.costs.unavailable");
}

function choiceLabel(name, value, t = createLocalizer()) {
    if (name === 'source') return ({ vertexai: 'Vertex AI', makersuite: 'Google AI Studio' })[value] ?? value;
    if (name === 'tier') return ({ standard: t("vertex_paygo.costs.standard"), flex: 'Flex', priority: 'Priority' })[value] ?? value;
    return value;
}

export function createCostUi({
    context,
    serverClient,
    getChatId,
    getCurrentPricingKey,
    getPrices = () => ({}),
    getPriceInfo = () => ({ source: 'missing' }),
    setPrice,
    resetPrice,
    refreshCatalog,
    coverageNotice = '',
    documentRef = globalThis.document,
    localize = createLocalizer((fallback, key) => context?.translate?.(fallback, key)),
}) {
    const t = localize;
    if (!documentRef?.createElement) throw new TypeError(t("vertex_paygo.costs.document_unavailable"));
    const menu = documentRef.getElementById('extensionsMenu');
    if (!menu) throw new Error(t("vertex_paygo.costs.menu_unavailable"));

    const menuItem = element(documentRef, 'div', 'list-group-item flex-container flexGap5 vertex-paygo-cost-menu');
    menuItem.setAttribute('role', 'button');
    menuItem.setAttribute('tabindex', '0');
    const icon = element(documentRef, 'div', 'fa-solid fa-coins extensionsMenuExtensionButton');
    icon.setAttribute('aria-hidden', 'true');
    const label = element(documentRef, 'span', '', localize('vertex_paygo.costs.title'));
    label.setAttribute('data-i18n', 'vertex_paygo.costs.title');
    menuItem.append(icon, label);
    menu.append(menuItem);

    let destroyed = false;
    let pollTimer = null;
    let activeChatId = null;
    let popup = null;
    let renderToken = 0;
    let activeView = null;
    const priceSettings = createPriceSettingsUi({ documentRef, getCurrentPricingKey, getPrices, getPriceInfo,
        setPrice, resetPrice, refreshCatalog, localize, onChange: async () => {
            if (!destroyed && activeView) await activeView.load();
        } });
    const unmountSettings = mountExtensionSettings(priceSettings.root, { documentRef, tab: 'pricing',
        label: localize('vertex_paygo.settings.tab.pricing'), onShow: priceSettings.syncCurrentKey });

    const pricingEvents = [...new Set(['SETTINGS_UPDATED', 'SETTINGS_LOADED', 'CHATCOMPLETION_SOURCE_CHANGED']
        .map(name => context.eventTypes?.[name]).filter(Boolean))];
    const onPricingConnectionChanged = () => { if (!destroyed) priceSettings.syncIfConnectionChanged(); };
    for (const event of pricingEvents) context.eventSource?.on?.(event, onPricingConnectionChanged);

    function stopPolling() {
        if (pollTimer !== null) clearTimeout(pollTimer);
        pollTimer = null;
    }

    function buildContent(chatId) {
        const root = element(documentRef, 'section', 'vertex-paygo-cost');
        root.setAttribute('aria-label', localize('vertex_paygo.costs.title'));
        const header = element(documentRef, 'header', 'vertex-paygo-cost-header');
        const heading = element(documentRef, 'h3', '', localize('vertex_paygo.costs.title'));
        const toolbar = element(documentRef, 'div', 'vertex-paygo-cost-toolbar');
        const refresh = iconButton(documentRef, localize('vertex_paygo.costs.refresh'), 'fa-rotate-right', 'vertex-paygo-cost-refresh');
        const close = iconButton(documentRef, localize('vertex_paygo.costs.close'), 'fa-xmark', 'vertex-paygo-cost-close');
        toolbar.append(refresh, close);
        header.append(heading, toolbar);
        const summary = element(documentRef, 'div', 'vertex-paygo-cost-summary', t("vertex_paygo.costs.loading"));
        summary.setAttribute('role', 'status');
        const tableWrap = element(documentRef, 'div', 'vertex-paygo-cost-table-wrap');
        root.append(header, summary, tableWrap);
        if (coverageNotice) root.append(element(documentRef, 'p', 'vertex-paygo-cost-coverage-notice', coverageNotice));

        async function load() {
            const token = ++renderToken;
            stopPolling();
            refresh.disabled = true;
            try {
                if (!chatId) {
                    summary.textContent = t("vertex_paygo.costs.no_records", { p0: EXTENSION_DISPLAY_NAME });
                    tableWrap.replaceChildren();
                    return;
                }
                if (getChatId?.() !== chatId) {
                    summary.textContent = t("vertex_paygo.costs.chat_changed");
                    tableWrap.replaceChildren();
                    return;
                }
                const response = await serverClient.readUsage(chatId);
                if (token !== renderToken || activeChatId !== chatId) return;
                if (getChatId?.() !== chatId) {
                    summary.textContent = t("vertex_paygo.costs.chat_changed");
                    tableWrap.replaceChildren();
                    return;
                }
                if (!response?.ok) throw new Error(response?.error || t("vertex_paygo.costs.load_failed"));
                const records = (Array.isArray(response.records) ? response.records : [])
                    .filter(record => record?.chatId === chatId).slice(-MAX_USAGE_RECORDS_PER_CHAT);
                priceSettings.updateKeyLists(records);
                const result = summarizeUsage(records, getPrices?.() ?? {});
                const latest = result.details.at(-1)?.estimate;
                const subtotal = result.estimatedCount ? money(result.amount) : '—';
                const latestAmount = latest?.amount === null || latest === undefined ? '—' : money(latest.amount);
                summary.textContent = t("vertex_paygo.costs.summary", { p0: subtotal, p1: latestAmount, p2: result.requestCount, p3: result.cachedTokenCount ?? t("vertex_paygo.cache_diagnostics.unknown"), p4: result.unpricedCount, p5: result.incompleteCount });
                if (result.unknownCacheCount) summary.textContent += t("vertex_paygo.costs.unknown_requests", { p0: result.unknownCacheCount });
                summary.textContent += ` · ${localize('vertex_paygo.costs.cache_hit_rate')} ${cacheRate(result.cacheHitRate)}`;
                summary.title = t("vertex_paygo.costs.estimate_note", { p0: localize('vertex_paygo.costs.cache_hit_rate_hint') });
                if (response.truncated) summary.append(element(documentRef, 'strong', 'vertex-paygo-cost-truncated', t("vertex_paygo.costs.truncated")));
                tableWrap.replaceChildren();
                if (records.some(record => record.usageAccuracy === 'tauri-normalized')) {
                    tableWrap.append(element(documentRef, 'p', 'vertex-paygo-cost-tauri-warning',
                        t("vertex_paygo.costs.tauri_note")));
                }
                const table = element(documentRef, 'table', 'vertex-paygo-cost-table');
                const head = element(documentRef, 'thead');
                const headRow = element(documentRef, 'tr');
                for (const title of [t("vertex_paygo.costs.request_time"), t("vertex_paygo.costs.model_tier"), t("vertex_paygo.costs.status"), t("vertex_paygo.costs.input"), t("vertex_paygo.settings.tab.cache"), localize('vertex_paygo.costs.cache_hit_rate'), t("vertex_paygo.costs.output"), t("vertex_paygo.costs.thinking"), t("vertex_paygo.costs.amount")]) headRow.append(element(documentRef, 'th', '', title));
                head.append(headRow);
                const body = element(documentRef, 'tbody');
                tableWrap.append(element(documentRef, 'p', 'vertex-paygo-cost-retention-note',
                    t("vertex_paygo.costs.retention", { p0: MAX_USAGE_RECORDS_PER_CHAT })));
                for (const { record, estimate } of result.details.slice(-MAX_USAGE_RECORDS_PER_CHAT).reverse()) {
                    const row = element(documentRef, 'tr');
                    const count = name => {
                        const value = record.usage?.[name];
                        return Number.isSafeInteger(value) && value >= 0 ? String(value) : '—';
                    };
                    const status = element(documentRef, 'td', '', statusText(record, estimate, t));
                    status.title = [record.errorCode, estimate.reason].filter(Boolean).join(' / ');
                    row.append(
                        element(documentRef, 'td', '', record.createdAt ? new Date(record.createdAt).toLocaleString() : '—'),
                        element(documentRef, 'td', '', `${choiceLabel('source', record.source || '', t)} · ${record.model || t("vertex_paygo.costs.unknown_model")} / ${choiceLabel('tier', record.tier || t("vertex_paygo.costs.unknown_tier"), t)}`),
                        status,
                        element(documentRef, 'td', '', count('promptTokenCount')),
                        element(documentRef, 'td', '', cacheTokenCount(record) ?? '—'),
                        element(documentRef, 'td', '', cacheRate(calculateCacheHitRate([record]))),
                        element(documentRef, 'td', '', count('candidatesTokenCount')),
                        element(documentRef, 'td', '', count('thoughtsTokenCount')),
                        element(documentRef, 'td', '', estimate.amount === null ? '—' : `≈ ${money(estimate.amount)}`),
                    );
                    body.append(row);
                }
                table.append(head, body);
                tableWrap.append(table);
                if (records.some(record => record.status === 'pending')) {
                    pollTimer = setTimeout(() => void load(), POLL_MS);
                }
            } catch (error) {
                if (token === renderToken) summary.textContent = t("vertex_paygo.costs.read_error", { p0: error instanceof Error ? error.message : String(error) });
            } finally {
                if (token === renderToken) refresh.disabled = false;
            }
        }
        refresh.addEventListener('click', () => {
            priceSettings.updateKeyLists();
            priceSettings.renderPriceMeta();
            void load();
        });
        close.addEventListener('click', () => void popup?.complete?.(context.POPUP_RESULT?.CANCELLED ?? 0));
        return { root, header, load };
    }

    async function open() {
        if (destroyed || popup) return;
        stopPolling();
        const chatId = getChatId?.();
        activeChatId = typeof chatId === 'string' && chatId ? chatId : null;
        const view = buildContent(activeChatId);
        activeView = view;
        popup = createExtensionDialog(view.root, {
            okButton: false, wide: true, large: true, leftAlign: true,
            allowHorizontalScrolling: false, allowVerticalScrolling: true,
        });
        popup.dlg.classList.add('vertex-paygo-cost-dialog');
        popup.buttonControls.hidden = true;
        if (typeof popup.body?.insertBefore === 'function' && popup.content?.parentElement === popup.body) {
            view.header.remove();
            popup.body.insertBefore(view.header, popup.content);
        }
        const theme = bindExtensionTheme(popup.dlg ?? view.root, { skipBg: false });
        void view.load();
        try {
            const showing = popup.show();
            theme.sync();
            return await showing;
        } finally { theme.destroy(); stopPolling(); activeChatId = null; popup = null; activeView = null; ++renderToken; }
    }

    function onActivate(event) {
        if (event?.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
        event?.preventDefault?.();
        void open();
    }
    menuItem.addEventListener('click', onActivate);
    menuItem.addEventListener('keydown', onActivate);
    const onChatChanged = () => {
        stopPolling();
        ++renderToken;
        popup?.complete?.(context.POPUP_RESULT?.CANCELLED);
    };
    if (context.eventTypes?.CHAT_CHANGED) context.eventSource?.on(context.eventTypes.CHAT_CHANGED, onChatChanged);

    return {
        open,
        destroy() {
            if (destroyed) return;
            destroyed = true;
            stopPolling();
            ++renderToken;
            menuItem.remove();
            activeView = null;
            for (const event of pricingEvents) context.eventSource?.removeListener?.(event, onPricingConnectionChanged);
            priceSettings.destroy();
            unmountSettings();
            context.eventSource?.removeListener?.(context.eventTypes?.CHAT_CHANGED, onChatChanged);
            popup?.complete?.(context.POPUP_RESULT?.CANCELLED);
        },
    };
}
