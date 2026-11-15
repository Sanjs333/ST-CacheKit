/*
 * Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0.
 */

import { calculateCacheHitRate, summarizeUsage } from './cost-model.js';
import { EXTENSION_DISPLAY_NAME } from './constants.js';
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
    return value == null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function errorText(code) {
    const normalized = String(code ?? '').toUpperCase();
    if (!normalized) return '';
    if (normalized === '429' || normalized.endsWith('_429') || normalized.includes('RATE') || normalized.includes('QUOTA')) return '限流';
    if (normalized.includes('ABORT') || normalized.includes('CANCEL') || normalized === 'CLIENT_DISCONNECTED') return '连接中断';
    if (normalized.includes('COMPRESS') || normalized.includes('COMPACT')) return '压缩响应无法采集用量';
    if (normalized.includes('RESTART')) return '服务重启，用量不完整';
    if (normalized.includes('TIMEOUT')) return '等待用量超时';
    if (normalized === 'UPSTREAM_RESPONSE_STREAM_FAILED') return '响应流中断';
    if (normalized === 'USAGE_METADATA_MISSING') return '未返回用量';
    if (normalized.includes('LIMIT')) return '用量采集超出限制';
    const http = normalized.match(/HTTP_(\d{3})$/);
    if (http) return `HTTP ${http[1]}`;
    return '请求错误';
}

function statusText(record, estimate) {
    if (record?.status === 'pending') return '待生成';
    if (record?.status === 'failed') return `请求失败${errorText(record.errorCode) ? `（${errorText(record.errorCode)}）` : ''}`;
    if (record?.status === 'incomplete' && record.errorCode) {
        return errorText(record.errorCode) + (estimate.amount !== null ? '，部分估算' : '');
    }
    const reasons = {
        usage_missing: '无用量数据', usage_incomplete: '用量数据不完整',
        cache_exceeds_prompt: '用量数据无效', provisioned_throughput: '预置吞吐量无法估算',
        unsupported_modality: '非文本模态无法估算', traffic_tier_mismatch: '计费层级不匹配',
        price_missing: '价格未配置', long_price_missing: '长上下文价格未配置',
        tool_use: '含工具调用，仅部分估算', request_incomplete: '用量不完整，仅部分估算',
        tauri_normalized: 'TauriTavern 用量信息可能不完整，仅部分估算',
    };
    if (estimate.reason && reasons[estimate.reason]) {
        const suffix = estimate.priceSource === 'current' && estimate.amount !== null ? '（按当前价格）' : '';
        return `${reasons[estimate.reason]}${suffix}`;
    }
    if (record?.status === 'incomplete') return '用量不完整';
    if (estimate.status === 'estimated') return estimate.priceSource === 'current' ? '估算（按当前价格）' : '估算';
    if (estimate.status === 'partial') return estimate.priceSource === 'current' ? '部分估算（按当前价格）' : '部分估算';
    if (estimate.status === 'unpriced') return '价格未配置';
    return errorText(record?.errorCode) || '无法估算';
}

function choiceLabel(name, value) {
    if (name === 'source') return ({ vertexai: 'Vertex AI', makersuite: 'Google AI Studio' })[value] ?? value;
    if (name === 'tier') return ({ standard: '标准', flex: 'Flex', priority: 'Priority' })[value] ?? value;
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
    if (!documentRef?.createElement) throw new TypeError('当前环境缺少页面文档接口。');
    const menu = documentRef.getElementById('extensionsMenu');
    if (!menu) throw new Error('酒馆扩展菜单不可用。');

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
        setPrice, resetPrice, refreshCatalog, onChange: async () => {
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
        const summary = element(documentRef, 'div', 'vertex-paygo-cost-summary', '正在读取用量…');
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
                    summary.textContent = `暂无用量记录。单价可在扩展设置「${EXTENSION_DISPLAY_NAME}」→「价格」中设置。`;
                    tableWrap.replaceChildren();
                    return;
                }
                if (getChatId?.() !== chatId) {
                    summary.textContent = '对话已切换，请重新打开费用窗口。';
                    tableWrap.replaceChildren();
                    return;
                }
                const response = await serverClient.readUsage(chatId);
                if (token !== renderToken || activeChatId !== chatId) return;
                if (getChatId?.() !== chatId) {
                    summary.textContent = '对话已切换，请重新打开费用窗口。';
                    tableWrap.replaceChildren();
                    return;
                }
                if (!response?.ok) throw new Error(response?.error || '读取用量失败');
                const records = (Array.isArray(response.records) ? response.records : [])
                    .filter(record => record?.chatId === chatId);
                priceSettings.updateKeyLists(records);
                const result = summarizeUsage(records, getPrices?.() ?? {});
                const latest = result.details.at(-1)?.estimate;
                const subtotal = result.estimatedCount ? money(result.amount) : '—';
                const latestAmount = latest?.amount === null || latest === undefined ? '—' : money(latest.amount);
                summary.textContent = `已估算小计 ${subtotal} · 最近一次 ${latestAmount} · ${result.requestCount} 次请求 · 缓存命中 ${result.cachedTokenCount} token · 待计价 ${result.unpricedCount} · 不完整 ${result.incompleteCount}`;
                summary.textContent += ` · ${localize('vertex_paygo.costs.cache_hit_rate')} ${cacheRate(result.cacheHitRate)}`;
                summary.title = localize('vertex_paygo.costs.cache_hit_rate_hint');
                if (response.truncated) summary.append(element(documentRef, 'strong', 'vertex-paygo-cost-truncated', ' · 记录已截断，仅统计返回的部分账本'));
                tableWrap.replaceChildren();
                if (records.some(record => record.usageAccuracy === 'tauri-normalized')) {
                    tableWrap.append(element(documentRef, 'p', 'vertex-paygo-cost-tauri-warning',
                        'TauriTavern 的非流式用量可能缺少思考 Token 等信息，费用估算可能不完整或偏低。'));
                }
                const table = element(documentRef, 'table', 'vertex-paygo-cost-table');
                const head = element(documentRef, 'thead');
                const headRow = element(documentRef, 'tr');
                for (const title of ['时间', '模型 / 层级', '状态', '输入', '缓存', localize('vertex_paygo.costs.cache_hit_rate'), '输出', '思考', '费用']) headRow.append(element(documentRef, 'th', '', title));
                head.append(headRow);
                const body = element(documentRef, 'tbody');
                // Sum the entire ledger, but bound the number of live DOM rows.
                if (result.details.length > 200) tableWrap.append(element(documentRef, 'p', '', '合计包含全部已读取请求，下表显示最近 200 条。'));
                for (const { record, estimate } of result.details.slice(-200).reverse()) {
                    const row = element(documentRef, 'tr');
                    const count = name => {
                        const value = record.usage?.[name];
                        return Number.isSafeInteger(value) && value >= 0 ? String(value) : '—';
                    };
                    const status = element(documentRef, 'td', '', statusText(record, estimate));
                    status.title = [record.errorCode, estimate.reason].filter(Boolean).join(' / ');
                    row.append(
                        element(documentRef, 'td', '', record.createdAt ? new Date(record.createdAt).toLocaleString() : '—'),
                        element(documentRef, 'td', '', `${choiceLabel('source', record.source || '')} · ${record.model || '未知模型'} / ${record.tier || '未知层级'}`),
                        status,
                        element(documentRef, 'td', '', count('promptTokenCount')),
                        element(documentRef, 'td', '', count('cachedContentTokenCount')),
                        element(documentRef, 'td', '', cacheRate(calculateCacheHitRate([record]))),
                        element(documentRef, 'td', '', count('candidatesTokenCount')),
                        element(documentRef, 'td', '', count('thoughtsTokenCount')),
                        element(documentRef, 'td', '', estimate.amount === null ? '—' : money(estimate.amount)),
                    );
                    body.append(row);
                }
                table.append(head, body);
                tableWrap.append(table);
                if (records.some(record => record.status === 'pending')) {
                    pollTimer = setTimeout(() => void load(), POLL_MS);
                }
            } catch (error) {
                if (token === renderToken) summary.textContent = `无法读取用量：${error instanceof Error ? error.message : String(error)}`;
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
