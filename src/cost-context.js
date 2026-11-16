/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/ */

import { normalizePrice, priceKey, pricingRegion } from './cost-model.js';
import { regionalCatalogPrice, regionalPriceMultiplier } from './regional-pricing.js';
import { getActivePricing } from './model-policy.js';
import { normalizeMessageCostPlacement, normalizeMessageCostRecentCount } from './message-cost-settings.js';

const SETTINGS_KEY = 'vertex-paygo-costs';

export function createConversationId(cryptoImpl = globalThis.crypto) {
    if (typeof cryptoImpl?.randomUUID === 'function') return cryptoImpl.randomUUID();
    // LAN HTTP pages do not expose randomUUID, while getRandomValues remains
    // available. This ID is a correlation key, never an authorization token.
    if (typeof cryptoImpl?.getRandomValues === 'function') {
        const bytes = cryptoImpl.getRandomValues(new Uint8Array(16));
        return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    }
    return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function identity(context) {
    const chat = context.getCurrentChatId?.() ?? context.chatId;
    if (typeof chat !== 'string' || !chat) return null;
    const owner = context.groupId != null && context.groupId !== ''
        ? ['group', String(context.groupId)]
        : ['character', context.characters?.[context.characterId]?.avatar];
    if (!owner[1]) return null;
    return JSON.stringify([...owner, chat.replace(/\.jsonl$/i, '')]);
}

// Account settings survive browser reloads and server restarts. Chat names stay
// in local ST settings; only random conversation IDs are sent to the usage API.
export function createCostContext({ getContext, idFactory = createConversationId, getPricing = getActivePricing, now = Date.now }) {
    function settings(context = getContext()) {
        const root = context.extensionSettings;
        if (!root) throw new Error('SillyTavern 扩展设置不可用。');
        const value = root[SETTINGS_KEY] ??= { conversations: {}, prices: {} };
        value.conversations ??= {};
        value.prices ??= {};
        return value;
    }

    function getChatId() {
        const context = getContext();
        const key = identity(context);
        return key ? settings(context).conversations[key] ?? null : null;
    }

    function getMessageCostPlacement() {
        return normalizeMessageCostPlacement(settings().messageCostPlacement);
    }

    function setMessageCostPlacement(value) {
        const context = getContext();
        settings(context).messageCostPlacement = normalizeMessageCostPlacement(value);
        context.saveSettingsDebounced();
    }

    function getMessageCostRecentCount() {
        return normalizeMessageCostRecentCount(settings().messageCostRecentCount);
    }

    function setMessageCostRecentCount(value) {
        const context = getContext();
        settings(context).messageCostRecentCount = normalizeMessageCostRecentCount(value);
        context.saveSettingsDebounced();
    }

    function captureUsageContext() {
        const context = getContext();
        const key = identity(context);
        if (!key) return null;
        const config = settings(context);
        if (!config.conversations[key]) {
            config.conversations[key] = idFactory();
            context.saveSettingsDebounced();
        }
        return config.conversations[key];
    }

    function catalogPrices() {
        const catalog = getPricing();
        const today = new Date(now()).toISOString().slice(0, 10);
        const entries = catalog.entries.flatMap(entry => {
            if (!entry.validUntil || today <= entry.validUntil) return [entry];
            const rate = normalizePrice(entry.afterExpiry);
            // Scheduled catalog rates affect new requests; saved request prices
            // and manual overrides retain their own values.
            return rate ? [{ source: entry.source, model: entry.model, tier: entry.tier,
                sourceUrl: entry.sourceUrl, ...rate }] : [];
        });
        return { catalog, entries };
    }

    function getPrices() {
        const prices = {};
        for (const entry of catalogPrices().entries) {
            const base = normalizePrice(entry);
            prices[priceKey(entry)] = base;
            if (entry.source === 'vertexai') {
                prices[priceKey({ ...entry, region: 'global' })] = base;
                prices[priceKey({ ...entry, region: 'non-global' })] = regionalCatalogPrice(entry, { ...entry, region: 'non-global' });
            }
        }
        for (const [key, value] of Object.entries(settings().prices)) {
            const rate = normalizePrice(value);
            if (!rate) continue;
            prices[key] = rate;
            // Existing manual rates have no region and may already include a
            // surcharge. Keep them as final prices instead of multiplying again.
            let parts;
            try { parts = JSON.parse(key); } catch { continue; }
            if (Array.isArray(parts) && parts.length === 3 && parts[0] === 'vertexai') {
                for (const region of ['global', 'non-global']) {
                    prices[priceKey({ source: parts[0], model: parts[1], tier: parts[2], region })] = rate;
                }
            }
        }
        // Explicit region prices win regardless of insertion order relative to
        // legacy model-wide manual settings.
        for (const [key, value] of Object.entries(settings().prices)) {
            let parts;
            try { parts = JSON.parse(key); } catch { continue; }
            const rate = normalizePrice(value);
            if (rate && Array.isArray(parts) && parts.length === 4) prices[key] = rate;
        }
        return prices;
    }

    function getPriceInfo(key) {
        const region = pricingRegion(key);
        const manual = normalizePrice(settings().prices[priceKey(key)])
            ?? normalizePrice(settings().prices[priceKey({ ...key, region: '' })]);
        if (manual) return { source: 'manual', price: manual, region, regionMultiplier: 1 };
        const { catalog, entries } = catalogPrices();
        const entry = entries.find(entry => priceKey(entry) === priceKey({ ...key, region: '' }));
        return entry ? { source: 'catalog', price: regionalCatalogPrice(entry, key), region,
            regionMultiplier: regionalPriceMultiplier(key), updatedAt: catalog.updatedAt,
            validUntil: entry.validUntil, sourceUrl: entry.sourceUrl }
            : { source: 'missing', price: null, region, regionMultiplier: 1, updatedAt: catalog.updatedAt };
    }
    function setPrices(prices) {
        const validated = {};
        for (const [key, value] of Object.entries(prices)) {
            const rate = normalizePrice(value);
            if (!rate) throw new TypeError('token 单价无效。');
            validated[key] = rate;
        }
        const context = getContext();
        settings(context).prices = validated;
        context.saveSettingsDebounced();
    }

    function setPrice(key, price) {
        setPrices({ ...settings().prices, [priceKey(key)]: price });
    }

    function resetPrice(key) {
        const prices = { ...settings().prices };
        delete prices[priceKey(key)];
        delete prices[priceKey({ ...key, region: '' })];
        setPrices(prices);
    }

    function getUsagePrice(data, state) {
        return getPriceInfo({ source: data.chat_completion_source, model: data.model, tier: state.tier,
            region: data.chat_completion_source === 'vertexai' ? (data.vertexai_region || 'us-central1') : '' }).price;
    }

    function renamed({ avatarId, groupId, oldFileName, newFileName } = {}) {
        if (!oldFileName || !newFileName) return;
        const owner = groupId != null && groupId !== '' ? ['group', String(groupId)] : ['character', avatarId];
        if (!owner[1]) return;
        const context = getContext();
        const map = settings(context).conversations;
        const oldKey = JSON.stringify([...owner, oldFileName.replace(/\.jsonl$/i, '')]);
        const newKey = JSON.stringify([...owner, newFileName.replace(/\.jsonl$/i, '')]);
        if (map[oldKey]) {
            map[newKey] = map[oldKey];
            delete map[oldKey];
            context.saveSettingsDebounced();
        }
    }
    const context = getContext();
    if (context.eventTypes?.CHAT_RENAMED) context.eventSource?.on(context.eventTypes.CHAT_RENAMED, renamed);

    return { getChatId, captureUsageContext, getPrices, setPrices, setPrice, resetPrice, getPriceInfo, getUsagePrice,
        getMessageCostPlacement, setMessageCostPlacement, getMessageCostRecentCount, setMessageCostRecentCount,
        destroy() { context.eventSource?.removeListener?.(context.eventTypes?.CHAT_RENAMED, renamed); } };
}
