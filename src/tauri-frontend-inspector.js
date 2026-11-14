/* Current-chat frontend evidence from official Tauri events; MPL-2.0. */
import { createPromptInspectorController } from './prompt-inspector-controller.js';
import { createPromptInspectorUi } from './prompt-inspector-ui.js';
import { createConversationId } from './cost-context.js';
import { createPromptInspectorDismissalStore } from './prompt-inspector-session.js';
import { mountExtensionSettings } from './extension-settings.js';
import { TAURI_REQUEST_STATE } from './tauri-transport.js';

export const TAURI_FRONTEND_PROMPT_NOTICE = '查看当前聊天上一轮的提示词、工具说明和输出格式。记录位置与响应状态会分别标明；已保存的记录可在切回聊天或刷新后恢复。';
const CHAT_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const AGENT_ERRORS = Object.freeze({
    AGENT_CHAT_SCOPE_UNAVAILABLE: '无法确认当前聊天的 Agent 运行身份。',
    AGENT_PROMPT_UNAVAILABLE: '这轮 Agent 的初始输入暂时无法读取。',
    AGENT_PROMPT_INCOMPLETE: '这轮 Agent 的初始输入不完整，没有展示截断内容。',
    AGENT_PROMPT_INVALID: '这轮 Agent 的初始输入格式无法确认。',
    AGENT_PROMPT_TOO_LARGE: '这轮 Agent 的初始输入超过查看上限。',
});

/** Observe a foreground chat's public settings event. Native global logs stay
 * independent: their API does not expose a matching chat/request identifier. */
export function createTauriFrontendInspectorController({ context, getContext = () => context, migration,
    getChatId, getOwner, getSessionStorage = () => target.sessionStorage, finalRequestCapture = false,
    isAgentMode = () => false, getPromptMode, agentCapture = null,
    target = globalThis, createController = createPromptInspectorController } = {}) {
    const scopes = new Map(), subscriptions = [], candidates = new Map(), listeners = new Set(), dismissalLoads = new Set();
    const bus = context?.eventSource, events = context?.eventTypes;
    const eventAvailable = typeof events?.CHAT_COMPLETION_SETTINGS_READY === 'string'
        && typeof bus?.on === 'function' && typeof bus?.removeListener === 'function';
    let destroyed = false, enabled = true, signal = null, unsubscribeSources, unsubscribeBase, unsubscribeAgent;
    let generationAgent = null;
    let cachedBaseRecord = null, cachedRecord = null;
    let cachedAgentRecord = null, mappedAgentRecord = null;
    const releaseRecord = () => { cachedBaseRecord = null; cachedRecord = null; cachedAgentRecord = null; mappedAgentRecord = null; };
    const emit = () => { if (!destroyed) for (const listener of listeners) { try { listener(); } catch { /* View observers cannot affect generation. */ } } };
    const configuredAgentMode = () => { try { return isAgentMode() === true; } catch { return false; } };
    const agentMode = () => generationAgent === true || configuredAgentMode();
    const configuredMode = () => { try { return getPromptMode?.() ?? (configuredAgentMode() ? 'agent' : 'legacy'); } catch { return 'unknown'; } };
    function localScope() {
        if (destroyed) return null;
        try {
            const current = getContext(), chat = current?.getCurrentChatId?.();
            if (typeof chat !== 'string' || !chat) return null;
            const key = JSON.stringify([chat, current.groupId ?? null,
                current.characters?.[current.characterId]?.avatar ?? current.characterId ?? null]);
            let supplied;
            try { supplied = getChatId?.(); } catch { /* Frontend evidence does not require cost metadata. */ }
            const stable = typeof supplied === 'string' && CHAT_ID.test(supplied);
            const cached = scopes.get(key);
            // Once an ephemeral scope is armed, a late cost ID must not move its
            // active generation to another scope. Stable IDs can change with an account.
            if (cached && (!cached.stable || !stable || cached.id === supplied)) return cached;
            const value = { id: stable ? supplied : createConversationId(target.crypto ?? globalThis.crypto), stable, key };
            scopes.set(key, value);
            while (scopes.size > 64) scopes.delete(scopes.keys().next().value);
            return value;
        } catch { return null; }
    }
    const localChatId = () => localScope()?.id ?? null;
    function localOwner() {
        try {
            const supplied = getOwner?.();
            if (typeof supplied === 'string' && supplied && supplied.length <= 256) return supplied;
            const current = localScope();
            // The persisted conversation UUID belongs to this installation's settings;
            // no shared account placeholder is used for cross-refresh restoration.
            return current?.stable ? 'tauri-local-conversation:' + current.id : null;
        } catch { return null; }
    }
    const base = createController({ context, getContext, getChatId: localChatId, serverClient: {}, target,
        getOwner: localOwner, getSessionStorage: () => localOwner() ? getSessionStorage() : null, frontendChatScope: true });
    const dismissals = createPromptInspectorDismissalStore({
        getStorage: () => localOwner() ? getSessionStorage() : null,
        cryptoRef: target.crypto ?? globalThis.crypto });
    const dismissalKey = () => { const chatId = localChatId(); return chatId ? JSON.stringify([localOwner(), chatId]) : null; };
    function currentDismissal() {
        const key = dismissalKey();
        if (!key) return { key: null, cutoffMs: 0, loading: false };
        const value = dismissals.peek(key);
        if (!value && !dismissalLoads.has(key)) {
            dismissalLoads.add(key);
            void dismissals.load(key).then(() => { dismissalLoads.delete(key); emit(); });
        }
        return { key, cutoffMs: value?.cutoffMs ?? 0, loading: !value };
    }
    const recordTime = value => {
        const time = value?.metadata?.initialAssemblyOnly === true ? value.createdAtMs
            : Date.parse(value?.dispatchAt ?? value?.capturedAt ?? '');
        return Number.isFinite(time) ? time : -Infinity;
    };
    function visibleRecord(value, dismissal) {
        return value && enabled && !destroyed && !dismissal.loading
            && (!dismissal.cutoffMs || recordTime(value) > dismissal.cutoffMs) ? value : null;
    }
    const clearCandidates = () => {
        for (const candidate of candidates.values()) base.cancelRequest(candidate);
        candidates.clear();
    };
    function listen(name, callback, last = false) {
        if (typeof name !== 'string') return;
        subscriptions.push([name, callback]);
        if (last && typeof bus.makeLast === 'function') bus.makeLast(name, callback);
        else bus.on(name, callback);
    }
    const destroy = () => {
        if (destroyed) return;
        destroyed = true;
        for (const unsubscribe of [unsubscribeSources, unsubscribeBase, unsubscribeAgent]) {
            try { unsubscribe?.(); } catch {}
        }
        for (const [name, callback] of subscriptions) {
            try { bus.removeListener(name, callback); } catch {}
        }
        subscriptions.length = 0; clearCandidates(); scopes.clear(); signal = null; releaseRecord(); listeners.clear();
        try { agentCapture?.destroy?.(); } catch { /* The independent artifact reader is optional. */ }
        dismissals.destroy(); dismissalLoads.clear();
        base.destroy();
    };
    async function capturePayload(data) {
        if (destroyed || !enabled || !eventAvailable) return null;
        let reservation;
        try {
            const captureSignal = signal;
            reservation = await base.reserveRequest(data, { providerCapture: false, signal: captureSignal,
                background: data?.[TAURI_REQUEST_STATE]?.background === true, capturePhase: 'settings-ready' });
            if (!reservation) return null;
            if (destroyed || captureSignal?.aborted) { base.cancelRequest(reservation); return null; }
            if (finalRequestCapture) {
                try {
                    const existing = data[TAURI_REQUEST_STATE];
                    data[TAURI_REQUEST_STATE] = { ...(existing && typeof existing === 'object' ? existing : {}),
                        promptInspectorTicket: reservation.ticket };
                    candidates.set(reservation.ticket, reservation);
                    return null;
                } catch { base.cancelRequest(reservation); return null; }
            }
            await base.finishRequest(reservation);
            return controller.snapshot().record;
        } catch {
            if (reservation) base.cancelRequest(reservation);
            return null; // Observation must not affect the host request.
        }
    }
    function agentRecord() {
        const captured = agentCapture?.snapshot?.()?.record ?? null;
        if (captured?.scope?.kind !== 'chat' || captured.scope.chatId !== localChatId()) return null;
        if (captured !== cachedAgentRecord) {
            cachedAgentRecord = captured;
            const raw = typeof captured?.rawRequest === 'string' ? captured.rawRequest : captured?.rawRequest?.bodyText;
            mappedAgentRecord = captured && typeof raw === 'string' ? {
                ...captured, version: 1, kind: 'agent-initial-snapshot', id: captured.id ?? captured.ticket ?? captured.runId,
                chatId: captured.chatId ?? captured.scope?.chatId ?? captured.scope?.stableChatId,
                sequence: Number.isSafeInteger(captured.sequence) && captured.sequence > 0 ? captured.sequence : 1,
                state: 'observed', complete: true, rawRequest: raw,
                capturedAt: captured.capturedAt ?? (Number.isFinite(captured.createdAtMs) ? new Date(captured.createdAtMs).toISOString() : undefined),
                trace: captured.trace ?? { version: 1, complete: false, reason: 'AGENT_INITIAL_SNAPSHOT', sources: [], stages: [], events: [] },
                metadata: { ...captured.metadata, captureKind: 'frontend-messages', capturePhase: 'agent-initial-snapshot',
                    transport: 'tauri-agent-artifact', association: 'agent-run-chat-identity', initialAssemblyOnly: true,
                    runId: captured.runId, networkBytesVerified: false, providerBodyAvailable: false, frontendMessagesComplete: true },
            } : null;
        }
        return mappedAgentRecord;
    }
    const controller = {
        snapshot() {
            const state = base.snapshot(), captured = state.record;
            if (captured !== cachedBaseRecord) {
                cachedBaseRecord = captured;
                cachedRecord = captured ? { ...captured, metadata: { ...captured.metadata,
                    capturePhase: captured.metadata?.capturePhase ?? 'settings-ready', transport: 'tauri-frontend',
                    association: captured.metadata?.association ?? 'current-chat-frontend',
                    networkBytesVerified: false, providerBodyAvailable: false } } : null;
            }
            const dismissal = currentDismissal(), legacyRecord = visibleRecord(cachedRecord, dismissal);
            const agentState = agentCapture?.snapshot?.() ?? { supported: false, status: 'unavailable', error: null };
            const initialRecord = visibleRecord(agentRecord(), dismissal);
            // Both candidates carry this chat's actual UUID. Compare the original
            // dispatch/run times, never the time an artifact happened to be read.
            const selectedAgent = initialRecord && (!legacyRecord || recordTime(initialRecord) > recordTime(legacyRecord));
            const selected = selectedAgent ? initialRecord : legacyRecord;
            const scopedAgentError = agentState.scope?.kind === 'chat' && agentState.scope.chatId === localChatId() ? agentState.error : null;
            let error = state.error ?? (scopedAgentError ? { ...scopedAgentError,
                message: AGENT_ERRORS[scopedAgentError.code] ?? AGENT_ERRORS.AGENT_PROMPT_UNAVAILABLE } : null);
            if (error && selected && !error.message?.includes('保留')) error = { ...error, message: (error.message ?? '这轮提示词暂时无法读取。') + ' 已保留此前的提示词。' };
            if (selectedAgent || (!selected && agentMode() && agentState.supported)) {
                return { ...state, ...agentState, supported: !destroyed && (agentState.supported === true || Boolean(selected)), enabled,
                    status: dismissal.loading ? 'loading' : ['recording', 'pending'].includes(state.status) ? state.status : agentState.status,
                    record: selected, error, recordAvailable: Boolean(selected), sourceAvailable: Boolean(selected?.trace?.sources?.length),
                    frontendAvailable: agentState.supported === true, backendAvailable: false, requiresHostPatch: false,
                    captureKind: 'frontend-messages', privacyMode: 'host-artifact', initialAssemblyOnly: true, generationMode: 'agent',
                    persistence: { status: 'host-artifact' }, restored: Boolean(selected), dismissalLoading: dismissal.loading,
                    notice: '这是当前聊天上一轮 Agent 的初始组装提示词，来自该运行保存的输入快照。未记录运行中的后续模型轮次，服务商网络请求字节未核验。' };
            }
            return { ...state, supported: !destroyed && (state.supported && eventAvailable || Boolean(selected)),
                record: selected, error, recordAvailable: Boolean(selected), status: dismissal.loading ? 'loading' : state.status,
                captureKind: 'frontend-messages', privacyMode: localOwner() ? 'tab-session' : 'memory-only',
                generationMode: selected ? 'legacy' : configuredMode(), dismissalLoading: dismissal.loading,
                notice: TAURI_FRONTEND_PROMPT_NOTICE };
        },
        subscribe(listener) {
            if (typeof listener !== 'function') throw new TypeError('A listener is required.');
            if (destroyed) return () => {};
            listeners.add(listener); return () => listeners.delete(listener);
        },
        async setEnabled(value) {
            enabled = value === true;
            if (!enabled) await controller.clear();
            agentCapture?.setEnabled?.(enabled);
            const result = await base.setEnabled(enabled); emit();
            if (enabled) void controller.refresh({ automatic: true }).catch(() => {});
            return agentStateSupported() ? enabled : result;
        },
        async refresh({ automatic = false } = {}) {
            if (destroyed || !enabled) return null;
            const key = dismissalKey();
            await Promise.allSettled([base.refresh(), agentCapture?.refresh?.(undefined, { automatic }), key ? dismissals.load(key) : null]);
            emit();
            return controller.snapshot().record;
        },
        async clear() {
            const key = dismissalKey();
            const dismissal = key ? dismissals.dismiss(key, Date.now()) : null;
            clearCandidates(); releaseRecord();
            agentCapture?.clear?.();
            await Promise.allSettled([base.clear(), dismissal]);
            emit();
        },
        onModeChanged() {
            if (destroyed) return;
            generationAgent = null; emit();
            void controller.refresh({ automatic: true }).catch(() => {});
        },
        reserveRequest(data, { signal: requestSignal, background = false, chatId, capturePhase, requestMetadata } = {}) {
            if (!finalRequestCapture || destroyed || !enabled || capturePhase !== 'tauri-dispatch') return null;
            const ticket = requestMetadata?.promptInspectorTicket;
            const candidate = typeof ticket === 'string' ? candidates.get(ticket) : null;
            if (!candidate) return null; // Unmarked native/global requests have no proven chat association.
            candidates.delete(ticket);
            const value = base.updateFrontendRequest(candidate, data, { signal: requestSignal, background, chatId, capturePhase });
            if (!value) base.cancelRequest(candidate);
            return value;
        },
        ownsCandidate(ticket) {
            if (destroyed || !enabled || signal?.aborted || typeof ticket !== 'string') return false;
            const candidate = candidates.get(ticket);
            return candidate ? base.ownsFrontendCandidate(candidate) : false;
        },
        markDispatched: base.markDispatched,
        finishRequest: base.finishRequest,
        cancelRequest(value) { candidates.delete(value?.ticket); return base.cancelRequest(value); },
        capturePayload,
        destroy,
    };
    try {
        unsubscribeBase = base.subscribe(emit);
        unsubscribeAgent = agentCapture?.subscribe?.(emit);
        if (eventAvailable) {
            listen(events.GENERATION_STARTED, (_type, options) => {
                clearCandidates(); signal = options?.signal ?? null;
                generationAgent = options?.agentMode === true || options?.agentResume === true ? true : null;
                if (agentStateSupported()) void controller.refresh({ automatic: true }).catch(() => {});
            });
            for (const name of ['GENERATION_ENDED', 'GENERATION_STOPPED']) listen(events[name], () => {
                clearCandidates(); signal = null;
                if (agentStateSupported()) void controller.refresh({ automatic: true }).catch(() => {});
            });
            listen(events.CHAT_CHANGED, () => {
                clearCandidates(); signal = null; generationAgent = null; releaseRecord(); agentCapture?.clear?.({ dismiss: false });
                void controller.refresh({ automatic: true }).catch(() => {});
            });
            listen(events.CHAT_COMPLETION_SETTINGS_READY, capturePayload, true);
            unsubscribeSources = migration?.subscribeSources?.(value => {
                if (!destroyed) base.observer.captureRuntimeSnapshot(value);
            });
        }
    } catch (error) { destroy(); throw error; }
    function agentStateSupported() { try { return agentCapture?.snapshot?.()?.supported === true; } catch { return false; } }
    if (agentStateSupported()) void controller.refresh({ automatic: true }).catch(() => {}); else currentDismissal();
    return controller;
}

export function createTauriFrontendInspector({ context, getContext = () => context, migration, getChatId,
    getOwner, getSessionStorage, finalRequestCapture = false, isAgentMode, getPromptMode, agentCapture,
    target = globalThis, documentRef = target.document, clipboard = target.navigator?.clipboard,
    createUi = createPromptInspectorUi } = {}) {
    if (typeof documentRef?.createElement !== 'function') throw new TypeError('A document is required.');
    const controller = createTauriFrontendInspectorController({ context, getContext, migration, getChatId,
        getOwner, getSessionStorage, finalRequestCapture, isAgentMode, getPromptMode, agentCapture, target });
    const root = documentRef.createElement('section');
    root.id = 'vertex-paygo-tauri-current-prompt';
    root.className = 'vertex-paygo-settings vertex-paygo-log-settings';
    let viewer, unmount, destroyed = false;
    const release = () => {
        for (const component of [viewer, controller]) {
            try { component?.destroy?.(); } catch {}
        }
        try { unmount?.(); } catch { /* Remove our root below as well. */ }
        root.remove();
    };
    try {
        viewer = createUi({ controller, mountPoint: root, context, documentRef, clipboard, presentation: 'tauri-frontend' });
        const notice = documentRef.createElement('small');
        notice.className = 'vertex-paygo-guidance'; notice.textContent = TAURI_FRONTEND_PROMPT_NOTICE;
        root.append(notice);
        unmount = mountExtensionSettings(root, { documentRef, tab: 'logs', label: '日志' });
        return { root, controller, open: viewer.open, refresh: controller.refresh, clear: controller.clear,
            destroy() {
                if (destroyed) return;
                destroyed = true; release();
            } };
    } catch (error) { release(); throw error; }
}
