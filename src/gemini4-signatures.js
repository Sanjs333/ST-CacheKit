/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/ */

// ST 1.18's non-streaming signature extractor returns from inside forEach.
// Bind the plugin's complete native signature to the exact chat being generated
// and write it while saveReply emits MESSAGE_RECEIVED, before the host saves.
export function createGemini4SignatureTracker({ getContext, context }) {
    let epoch = 0;
    let pending = null;
    let destroyed = false;
    const events = context.eventTypes ?? {};
    const source = context.eventSource;
    const subscriptions = [];
    const reset = () => {
        if (destroyed) return;
        epoch++; pending = null;
    };
    const receive = messageId => {
        if (destroyed) return;
        const current = getContext();
        const entry = pending;
        if (!entry || entry.epoch !== epoch || entry.chat !== current?.chat
            || entry.chatId !== current?.getCurrentChatId?.()) return;
        const message = current.chat?.[messageId];
        if (!message || message.is_user || message.extra?.api !== entry.source
            || message.extra?.model !== entry.model) return;
        pending = null;
        message.extra.reasoning_signature = entry.signature;
        const variant = message.swipe_info?.[message.swipe_id ?? 0];
        if (variant) {
            variant.extra ??= {};
            variant.extra.reasoning_signature = entry.signature;
        }
    };
    const listeners = [['GENERATION_STARTED', reset], ['CHAT_CHANGED', reset], ['MESSAGE_RECEIVED', receive]];
    const cleanup = () => {
        if (destroyed) return;
        reset(); destroyed = true;
        for (const [event, listener] of subscriptions) {
            try { source?.removeListener?.(event, listener); }
            catch { /* Attempt every removal; a remaining listener is inert after cleanup. */ }
        }
        subscriptions.length = 0;
    };
    try {
        for (const [key, listener] of listeners) {
            if (!events[key] || typeof source?.on !== 'function') continue;
            // Some event buses register the callback before throwing.
            subscriptions.push([events[key], listener]);
            source.on(events[key], listener);
        }
    } catch (error) { cleanup(); throw error; }
    return {
        capture(data, background) {
            if (destroyed || background || data.stream) return null;
            const current = getContext();
            if (!Array.isArray(current?.chat)) return null;
            return { epoch, chat: current.chat, chatId: current.getCurrentChatId?.(),
                source: data.chat_completion_source, model: data.model };
        },
        async observe(token, response) {
            if (destroyed || !token || !response?.ok || typeof response.clone !== 'function') return;
            const data = await response.clone().json();
            if (!destroyed && token.epoch === epoch && typeof data.nativeGeminiSignature === 'string') {
                pending = { ...token, signature: data.nativeGeminiSignature };
            }
        },
        cleanup,
    };
}
