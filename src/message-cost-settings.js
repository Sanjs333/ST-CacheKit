/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public License, v. 2.0. */

export const DEFAULT_MESSAGE_COST_RECENT_COUNT = 20;

export function normalizeMessageCostRecentCount(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return DEFAULT_MESSAGE_COST_RECENT_COUNT;
    const count = Number(value);
    return Number.isFinite(count) ? Math.min(1000, Math.max(1, Math.trunc(count))) : DEFAULT_MESSAGE_COST_RECENT_COUNT;
}

export const DEFAULT_MESSAGE_COST_PLACEMENT = 'header';
export const MESSAGE_COST_PLACEMENTS = Object.freeze(['header', 'avatar', 'footer', 'hidden']);

export function normalizeMessageCostPlacement(value) {
    return MESSAGE_COST_PLACEMENTS.includes(value) ? value : DEFAULT_MESSAGE_COST_PLACEMENT;
}

export function createMessageCostPlacementControl({ documentRef = globalThis.document, localize,
    getMessageCostPlacement = () => DEFAULT_MESSAGE_COST_PLACEMENT, setMessageCostPlacement = () => {},
    getMessageCostRecentCount = () => DEFAULT_MESSAGE_COST_RECENT_COUNT, setMessageCostRecentCount = () => {} }) {
    const element = (tag, attributes, key) => {
        const node = documentRef.createElement(tag);
        for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
        if (key) { node.setAttribute('data-i18n', key); node.textContent = localize(key); }
        return node;
    };
    const root = element('div', { class: 'vertex-paygo-message-cost-setting' });
    const label = element('label', { for: 'vertex-paygo-message-cost-placement' }, 'vertex_paygo.message_cost.placement');
    const select = element('select', { id: 'vertex-paygo-message-cost-placement', class: 'text_pole' });
    for (const value of MESSAGE_COST_PLACEMENTS) {
        select.append(element('option', { value }, `vertex_paygo.message_cost.placement.${value}`));
    }
    const recentLabel = element('label', { for: 'vertex-paygo-message-cost-recent-count' }, 'vertex_paygo.message_cost.recent_count');
    const recentInput = element('input', { id: 'vertex-paygo-message-cost-recent-count', type: 'number',
        min: '1', max: '1000', step: '1', class: 'text_pole' });
    const positionRow = element('div', { class: 'vertex-paygo-display-setting-row' });
    positionRow.append(label, select);
    const recentRow = element('div', { class: 'vertex-paygo-display-setting-row' });
    recentRow.append(recentLabel, recentInput);
    root.append(positionRow, recentRow);
    const render = () => {
        select.value = normalizeMessageCostPlacement(getMessageCostPlacement());
        recentInput.value = String(normalizeMessageCostRecentCount(getMessageCostRecentCount()));
    };
    const change = () => {
        setMessageCostPlacement(normalizeMessageCostPlacement(select.value));
        render();
    };
    const recentChange = () => {
        setMessageCostRecentCount(normalizeMessageCostRecentCount(recentInput.value));
        render();
    };
    select.addEventListener('change', change);
    recentInput.addEventListener('change', recentChange);
    render();
    return { root, select, recentInput, render, destroy() {
        select.removeEventListener('change', change);
        recentInput.removeEventListener('change', recentChange);
    } };
}

export function isModelReply(message) {
    return Boolean(message && typeof message === 'object' && !Array.isArray(message)
        && !message.is_user && !message.is_system);
}

export function recentModelReplyIndices(messages, count) {
    if (!Array.isArray(messages)) return [];
    const limit = normalizeMessageCostRecentCount(count);
    const indices = [];
    for (let index = messages.length - 1; index >= 0 && indices.length < limit; index--) {
        if (isModelReply(messages[index])) indices.push(index);
    }

    return indices.reverse();
}
