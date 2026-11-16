/*
 * Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0.
 */

import { formatMessageCostLabel, formatMessageMoney, summarizeMessageCost } from './message-cost-view.js';
import { formatCacheHitRate } from './cost-model.js';
import { createLocalizer, getTierLabel } from './i18n.js';
import { bindExtensionTheme, subscribeThemeChanges } from './theme.js';
import { isolateDialogEvents } from './panel-events.js';
import { DEFAULT_MESSAGE_COST_PLACEMENT, DEFAULT_MESSAGE_COST_RECENT_COUNT, normalizeMessageCostPlacement, isModelReply, recentModelReplyIndices } from "./message-cost-settings.js";

const ROOT_CLASS = 'vertex-paygo-message-cost';
const messageKey = name => `vertex_paygo.message_cost.${name}`;

function node(documentRef, tag, className = '', text = '') {
    const result = documentRef.createElement(tag);
    if (className) result.className = className;
    if (text !== '') result.textContent = text;
    return result;
}

function formatTokens(value) {
    return value == null ? '—' : Number(value).toLocaleString();
}

function formatDuration(value, localize) {
    if (value == null) return '—';
    return value < 1000 ? localize(messageKey('unit_ms'), { value: Math.round(value) })
        : localize(messageKey('unit_seconds'), { value: (value / 1000).toFixed(2) });
}

function formatTps(value, localize) {
    return value == null ? '—' : localize(messageKey('unit_tps'), { value: value.toFixed(1) });
}

function addMetric(documentRef, parent, label, value, note = '') {
    const item = node(documentRef, 'div', 'vertex-paygo-message-cost-metric');
    item.append(node(documentRef, 'span', 'vertex-paygo-message-cost-metric-label', label));
    item.append(node(documentRef, 'strong', '', value));
    if (note) item.append(node(documentRef, 'small', '', note));
    parent.append(item);
}

const REASON_LABELS = new Set([
    'pending', 'unavailable', 'usage_missing', 'usage_incomplete', 'tauri_normalized',
    'price_missing', 'long_price_missing', 'traffic_tier_mismatch', 'provisioned_throughput',
    'unsupported_modality', 'cache_exceeds_prompt', 'amount_out_of_range', 'request_pending',
    'request_incomplete', 'request_failed', 'tool_use', 'timing_missing',
    'cache_count_missing', 'cache_count_mixed', 'cache_count_invalid',
]);

function buildCard(documentRef, summary, onClose, localize) {
    const card = node(documentRef, 'section', 'vertex-paygo-message-cost-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', localize(messageKey('dialog_label')));
    card.tabIndex = -1;

    const header = node(documentRef, 'header');
    const heading = node(documentRef, 'div', 'vertex-paygo-message-cost-heading');
    heading.append(node(documentRef, 'strong', '', localize(messageKey('title'))));
    heading.append(node(documentRef, 'span', '', localize(messageKey(summary.complete ? 'estimate_complete' : 'estimate_partial'))));
    const closeButton = node(documentRef, 'button', 'vertex-paygo-message-cost-close', '×');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', localize(messageKey('close')));
    closeButton.onclick = onClose;
    header.append(heading, closeButton);
    card.append(header);

    const top = node(documentRef, 'div', 'vertex-paygo-message-cost-top');
    addMetric(documentRef, top, localize(messageKey('input')), summary.hasUsage ? formatTokens(summary.promptTokens) : '—', localize(messageKey('unit_tokens')));
    const thinkingKnown = summary.thinkingTokens != null;
    addMetric(documentRef, top, localize(messageKey(thinkingKnown ? 'output_with_thinking' : 'output_reported')),
        summary.hasUsage ? formatTokens(summary.outputTokens + (summary.thinkingTokens ?? 0)) : '—',
        summary.hasUsage ? thinkingKnown ? localize(messageKey('output_breakdown'), {
            output: formatTokens(summary.outputTokens), thinking: formatTokens(summary.thinkingTokens),
        }) : localize(messageKey('thinking_unreported')) : localize(messageKey('unit_tokens')));
    const generationNote = summary.generationTps != null ? localize(messageKey('client_observed'))
        : summary.reasons.includes('timing_missing') ? localize(messageKey('stream_timing_missing')) : localize(messageKey('stream_only'));
    addMetric(documentRef, top, localize(messageKey('generation_speed')), formatTps(summary.generationTps, localize), generationNote);
    card.append(top);

    const cost = node(documentRef, 'div', 'vertex-paygo-message-cost-amount');
    cost.append(node(documentRef, 'span', '', localize(messageKey('local_cost'))));
    cost.append(node(documentRef, 'strong', '', summary.hasAmount ? formatMessageMoney(summary.amount)
        : localize(messageKey(summary.awaitingPrice ? 'label_unpriced' : 'cost_unavailable'))));
    const qualifiers = [];
    if (summary.priceSource === 'current' || summary.priceSource === 'mixed') qualifiers.push(localize(messageKey('current_price')));
    for (const reason of summary.reasons) {
        const label = REASON_LABELS.has(reason) ? localize(messageKey(`reason.${reason}`)) : null;
        if (label && !qualifiers.includes(label)) qualifiers.push(label);
    }
    if (qualifiers.length) cost.append(node(documentRef, 'small', '', qualifiers.join(' · ')));
    card.append(cost);

    const cache = node(documentRef, 'div', 'vertex-paygo-message-cost-cache');
    addMetric(documentRef, cache, localize(messageKey('cached')), summary.hasUsage ? formatTokens(summary.cachedTokens) : '—');
    addMetric(documentRef, cache, localize('vertex_paygo.costs.cache_hit_rate'),
        formatCacheHitRate(summary.cacheHitRate),
        localize('vertex_paygo.costs.cache_hit_rate_hint'));
    addMetric(documentRef, cache, localize(messageKey('uncached')), summary.hasUsage ? formatTokens(summary.uncachedTokens) : '—');
    card.append(cache);

    const details = node(documentRef, 'div', 'vertex-paygo-message-cost-details');
    addMetric(documentRef, details, localize(messageKey('thinking')), summary.hasUsage ? formatTokens(summary.thinkingTokens) : '—');
    addMetric(documentRef, details, localize(messageKey('first_content')), formatDuration(summary.firstTokenMs, localize),
        localize(messageKey(summary.firstTokenMs == null ? 'first_content_unavailable' : 'client_observed')));
    addMetric(documentRef, details, localize(messageKey('duration')), formatDuration(summary.durationMs, localize));
    addMetric(documentRef, details, localize(messageKey('end_to_end_speed')), formatTps(summary.endToEndTps, localize));
    card.append(details);

    const footer = node(documentRef, 'footer');
    const model = summary.models.join(' · ') || localize(messageKey('model_unknown'));
    const tier = summary.tiers.length ? summary.tiers.map(value => getTierLabel(localize, value)).join(' · ')
        : localize(messageKey('tier_unknown'));
    footer.append(node(documentRef, 'span', '', localize(messageKey('model_tier'), { model, tier })));
    footer.append(node(documentRef, 'span', '', localize(messageKey('request_count'), { count: summary.requestCount })));
    card.append(footer);
    return card;
}

export function createMessageCostUi({ getContext, getMessageCost, getPrices, getPlacement = () => DEFAULT_MESSAGE_COST_PLACEMENT,
    getRecentCount = () => DEFAULT_MESSAGE_COST_RECENT_COUNT,
    documentRef = globalThis.document, onOpen, localize } = {}) {
    localize ??= createLocalizer((fallback, key) => getContext?.()?.translate?.(fallback, key));
    let openCard = null;
    let openButton = null;
    let cardTheme = null;
    let disposeCardEvents = null;
    let destroyed = false;
    const chat = documentRef?.getElementById?.('chat');
    const mountedMessages = new Map();
    const mountedIds = new WeakMap();
    const attachedButtons = new Map();
    let lastWindow = null;

    function indexMessage(element, remove = false) {
        const previous = mountedIds.get(element);
        if (mountedMessages.get(previous) === element) mountedMessages.delete(previous);
        mountedIds.delete(element);
        if (remove) return;
        if (!element?.matches?.('.mes[mesid]') || (chat && !chat.contains(element))) return;
        const id = element.getAttribute?.('mesid');
        if (!/^(0|[1-9]\d*)$/.test(id ?? '')) return;
        mountedMessages.set(id, element);
        mountedIds.set(element, id);
    }

    function indexTree(element, remove = false) {
        if (element?.matches?.('.mes[mesid]')) indexMessage(element, remove);
        for (const message of element?.querySelectorAll?.('.mes[mesid]') ?? []) indexMessage(message, remove);
    }

    // Index mounted roots once, then maintain the index from DOM mutations.
    // Regular cost refreshes must not walk an entire long chat's DOM.
    function rebuildIndex() {
        mountedMessages.clear();
        for (const element of documentRef?.querySelectorAll?.('.mes[mesid]') ?? []) indexMessage(element);
    }
    rebuildIndex();

    function close() {
        documentRef?.removeEventListener?.('pointerdown', outside, true);
        disposeCardEvents?.(); disposeCardEvents = null;
        cardTheme?.destroy(); cardTheme = null;
        openCard?.remove();
        openButton?.setAttribute('aria-expanded', 'false');
        openCard = null;
        openButton = null;
    }

    function position(card, button) {
        const rect = button.getBoundingClientRect?.();
        if (!rect || !documentRef.defaultView) return;
        const view = documentRef.defaultView;
        const margin = 8;
        const width = Math.min(520, view.innerWidth - margin * 2);
        card.style.width = `${width}px`;
        card.style.left = `${Math.max(margin, Math.min(rect.left, view.innerWidth - width - margin))}px`;
        const measuredHeight = card.offsetHeight || 360;
        const below = rect.bottom + margin;
        card.style.top = `${below + measuredHeight <= view.innerHeight
            ? below : Math.max(margin, rect.top - measuredHeight - margin)}px`;
    }

    function open(button, summary) {
        close();
        const card = buildCard(documentRef, summary, close, localize);
        documentRef.body.append(card);
        cardTheme = bindExtensionTheme(card, { skipBg: false });
        openCard = card;
        openButton = button;
        documentRef.addEventListener('pointerdown', outside, true);
        disposeCardEvents = isolateDialogEvents(card, { onEscape: () => {
            const trigger = openButton;
            close();
            trigger?.focus?.();
        } });
        button.setAttribute('aria-expanded', 'true');
        position(card, button);
        card.focus?.();
        onOpen?.(summary);
    }

    function refreshOpenCard(summary) {
        if (!openCard || !openButton) return;
        const fresh = buildCard(documentRef, summary, close, localize);
        openCard.replaceChildren(...fresh.children);
        openCard.setAttribute('aria-label', fresh.getAttribute('aria-label'));
        cardTheme?.sync();
        openButton.setAttribute('aria-expanded', 'true');
        position(openCard, openButton);
    }

    function isVisible(element) {
        if (!element || element.offsetParent === null) return false;
        const style = documentRef.defaultView?.getComputedStyle?.(element);
        return style?.visibility !== 'hidden' && style?.visibility !== 'collapse' && style?.display !== 'none';
    }

    function placeButton(messageElement, button, placement) {
        // Select the content block explicitly: a selector list chooses in DOM
        // order, so '.mes_text, .mes_block' returns the outer block first.
        const block = messageElement.querySelector?.('.mes_block')
            ?? messageElement.querySelector?.('.mes_text')?.parentElement;
        if (!block) { button.remove(); return false; }
        let target = block;
        let actualPlacement = 'footer';
        if (placement === 'avatar') {
            const avatar = messageElement.querySelector?.('.mesAvatarWrapper, .avatar-container');
            if (isVisible(avatar)) { target = avatar; actualPlacement = placement; }
        } else if (placement === 'header') {
            const header = block.querySelector?.('.ch_name');

            const metadata = header?.querySelector?.('.timestamp')?.parentElement ?? header;
            if (isVisible(header) && isVisible(metadata)) { target = metadata; actualPlacement = placement; }
        }
        button.dataset.placement = actualPlacement;
        // Stay outside .mes_text, which the host rewrites during streaming,
        // editing and swipes. The footer follows media, attachments and bias.
        if (button.parentElement !== target || target.children[target.children.length - 1] !== button) target.append(button);
        return true;
    }

    function attach(messageElement, message, id, placement) {
        const snapshot = isModelReply(message) ? getMessageCost?.(message) : null;
        const existing = messageElement.querySelector?.(`.${ROOT_CLASS}-trigger`);
        if (!snapshot || placement === 'hidden') {
            existing?.remove();
            return;
        }
        const summary = summarizeMessageCost(snapshot, getPrices?.() ?? {});
        const label = formatMessageCostLabel(summary, localize);
        const button = existing ?? node(documentRef, 'button', `${ROOT_CLASS}-trigger`);
        button.type = 'button';
        button.dataset.messageId = id;
        button.setAttribute('aria-haspopup', 'dialog');
        button.setAttribute('aria-expanded', openButton === button ? 'true' : 'false');
        const triggerLabel = localize(messageKey('trigger_label'), { cost: label });
        if (button.getAttribute('aria-label') !== triggerLabel) button.setAttribute('aria-label', triggerLabel);
        if (button.textContent !== label) button.textContent = label;
        button.onclick = event => {
            event.stopPropagation?.();
            if (openButton === button) close();
            else {

                const current = summarizeMessageCost(getMessageCost?.(message), getPrices?.() ?? {});
                const currentLabel = formatMessageCostLabel(current, localize);
                if (button.textContent !== currentLabel) button.textContent = currentLabel;
                const triggerLabel = localize(messageKey('trigger_label'), { cost: currentLabel });
                if (button.getAttribute('aria-label') !== triggerLabel) button.setAttribute('aria-label', triggerLabel);
                open(button, current);
            }
        };
        if (!placeButton(messageElement, button, placement)) return;
        if (openButton === button) refreshOpenCard(summary);
        return button;
    }

    function render(messageId) {
        if (destroyed || !documentRef) return;
        if (!messageObserver) rebuildIndex();
        const placement = normalizeMessageCostPlacement(getPlacement());
        const messages = getContext?.()?.chat ?? [];
        // Count model replies, not all chat floors. Only the selected replies
        // read cost snapshots; regular refreshes still use the mounted DOM index.
        const indices = placement === 'hidden' ? [] : recentModelReplyIndices(messages, getRecentCount());
        const selectedIds = new Set(indices.map(String));
        const windowChanged = !lastWindow || lastWindow.messages !== messages
            || lastWindow.placement !== placement || lastWindow.indices.length !== indices.length
            || lastWindow.indices.some((index, position) => index !== indices[position]);
        lastWindow = { messages, indices, placement };
        for (const [element, button] of attachedButtons) {
            const id = button.dataset.messageId;
            if (selectedIds.has(id) && mountedMessages.get(id) === element) continue;
            if (button === openButton) close();
            button.remove();
            attachedButtons.delete(element);
        }
        if (placement === 'hidden') return;
        const requested = messageId == null ? null : Number(messageId);
        for (const index of indices) {
            if (!windowChanged && requested !== null && requested !== index) continue;
            const element = mountedMessages.get(String(index));
            if (!element) continue;
            const previous = attachedButtons.get(element);
            const attached = attach(element, messages[index], String(index), placement);
            if (previous && previous !== attached) {
                if (previous === openButton) close();
                previous.remove();
            }
            if (attached) attachedButtons.set(element, attached);
            else {
                attachedButtons.delete(element);
            }
        }
    }

    const outside = event => {
        if (openCard && !openCard.contains(event.target) && !openButton?.contains(event.target)) close();
    };
    const reposition = () => { if (openCard && openButton) position(openCard, openButton); };
    const resize = () => { render(); reposition(); };
    documentRef?.defaultView?.addEventListener?.('resize', resize);
    documentRef?.defaultView?.addEventListener?.('scroll', reposition, true);
    const context = getContext?.();
    const chatChanged = context?.eventTypes?.CHAT_CHANGED;
    if (chatChanged) context.eventSource?.on?.(chatChanged, close);
    // Theme/layout switches can hide the avatar column without rerendering any
    // messages. Move existing triggers when the host changes its body classes.
    const Observer = documentRef?.defaultView?.MutationObserver;
    const stopThemeTracking = subscribeThemeChanges(documentRef, render);
    // Native chat virtualization can remount a message without a generation
    // event. Only react to message roots, ignoring our own button/card changes.
    const containsMessage = element => element?.matches?.('.mes[mesid]')
        || element?.querySelector?.('.mes[mesid]');
    let renderQueued = false;
    const messageObserver = Observer && chat ? new Observer(records => {
        let changed = false;
        for (const record of records) {
            if (record.type === 'attributes') {
                indexMessage(record.target);
                changed = true;
                continue;
            }
            for (const element of record.removedNodes) {
                if (!containsMessage(element)) continue;
                indexTree(element, true);
                changed = true;
            }
            for (const element of record.addedNodes) {
                if (!containsMessage(element)) continue;
                indexTree(element);
                changed = true;
            }
        }
        if (!changed) return;
        if (renderQueued) return;
        renderQueued = true;
        queueMicrotask(() => { renderQueued = false; render(); });
    }) : null;
    messageObserver?.observe(chat, { childList: true, subtree: true, attributes: true, attributeFilter: ['mesid'] });

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        close();
        documentRef?.removeEventListener?.('pointerdown', outside, true);
        documentRef?.defaultView?.removeEventListener?.('resize', resize);
        documentRef?.defaultView?.removeEventListener?.('scroll', reposition, true);
        if (chatChanged) context.eventSource?.removeListener?.(chatChanged, close);
        stopThemeTracking();
        messageObserver?.disconnect();
        for (const trigger of attachedButtons.values()) trigger.remove();
        attachedButtons.clear();
        mountedMessages.clear();
    }

    return { render, close, destroy };
}
