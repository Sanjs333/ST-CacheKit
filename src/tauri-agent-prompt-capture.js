/* Read actual, scoped Agent input snapshots through the shipped host API.
 * SPDX-License-Identifier: MPL-2.0 */
'use strict';

const SNAPSHOT_PATH = 'input/prompt_snapshot.json';
const TERMINAL = new Set(['completed', 'partial_success', 'failed', 'cancelled', 'transferred']);
const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);
const PROMPT_FIELDS = ['tools', 'tool_choice', 'functions', 'function_call', 'json_schema', 'response_format',
    'instructions', 'system', 'input', 'prompt'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const label = (value, maximum = 1024) => typeof value === 'string' && value.length > 0 && value.length <= maximum
    && value.trim() === value && !/[\x00-\x1f\x7f]/u.test(value);
const problem = code => Object.assign(new Error(code), { code });
const ERROR_CODES = new Set(['AGENT_CHAT_SCOPE_UNAVAILABLE', 'AGENT_SESSION_SCOPE_UNAVAILABLE', 'AGENT_PROMPT_UNAVAILABLE',
    'AGENT_PROMPT_INCOMPLETE', 'AGENT_PROMPT_INVALID', 'AGENT_PROMPT_TOO_LARGE']);

function chatRef(value) {
    if (!object(value)) throw problem('AGENT_CHAT_SCOPE_UNAVAILABLE');
    if (value.kind === 'character' && label(value.characterId) && label(value.fileName)) {
        return { kind: 'character', characterId: value.characterId, fileName: value.fileName };
    }
    if (value.kind === 'group' && label(value.chatId)) return { kind: 'group', chatId: value.chatId };
    throw problem('AGENT_CHAT_SCOPE_UNAVAILABLE');
}
const sameRef = (left, right) => { try { return JSON.stringify(chatRef(left)) === JSON.stringify(chatRef(right)); } catch { return false; } };
const scopeKey = (scope, owner) => JSON.stringify([owner, scope.kind, scope.chatRef ?? null, scope.stableChatId ?? null, scope.sessionId ?? null]);
function chatScope(value) {
    const ref = chatRef(value?.chatRef);
    if (!identifier(value?.stableChatId)) throw problem('AGENT_CHAT_SCOPE_UNAVAILABLE');
    const chatId = value.chatId ?? value.stableChatId;
    if (!identifier(chatId)) throw problem('AGENT_CHAT_SCOPE_UNAVAILABLE');
    return { kind: 'chat', chatRef: ref, stableChatId: value.stableChatId, chatId };
}
function runSummary(value, scope) {
    if (!object(value) || !identifier(value.runId) || value.stableChatId !== scope.stableChatId
        || !sameRef(value.chatRef, scope.chatRef) || value.presentation !== 'foreground'
        || !['normal', 'regenerate', 'swipe'].includes(value.generationType)
        || !label(value.status, 128)) return null;
    const createdAtMs = Date.parse(value.createdAt), updatedAtMs = Date.parse(value.updatedAt);
    if (!Number.isFinite(createdAtMs) || !Number.isFinite(updatedAtMs)) return null;
    return { runId: value.runId, status: value.status, generationType: value.generationType,
        profileId: label(value.profileId, 256) ? value.profileId : null, createdAtMs, updatedAtMs };
}
function promptBody(snapshot) {
    if (!object(snapshot)) throw problem('AGENT_PROMPT_INVALID');
    let parameters, messages;
    if (Object.hasOwn(snapshot, 'generationParameters')) {
        parameters = snapshot.generationParameters;
        messages = snapshot.messages;
    } else {
        const payload = ['chatCompletionPayload', 'chat_completion_payload', 'generateData', 'generate_data']
            .map(key => snapshot[key]).find(object) ?? snapshot;
        parameters = payload;
        messages = Array.isArray(payload.messages) ? payload.messages : payload.prompt;
    }
    if (!object(parameters) || !Array.isArray(messages) || messages.length > 4096
        || messages.some(message => !object(message) || !ROLES.has(message.role)
            || (!Array.isArray(message.parts) && !Object.hasOwn(message, 'content') && !Object.hasOwn(message, 'tool_calls')))) {
        throw problem('AGENT_PROMPT_INVALID');
    }
    const source = parameters.chat_completion_source ?? 'unknown';
    const model = parameters.model ?? null;
    if (!label(source, 128) || (model !== null && !label(model, 512))) throw problem('AGENT_PROMPT_INVALID');
    // Only prompt evidence is retained. generationParameters can contain the
    // selected proxy's credentials, so it never enters records or metadata.
    const body = { model, messages };
    for (const field of PROMPT_FIELDS) if (Object.hasOwn(parameters, field)) body[field] = parameters[field];
    return { source, model, bodyText: JSON.stringify(body) };
}

export function supportsTauriAgentPromptCapture(api) {
    return typeof api?.agent?.listRuns === 'function' && typeof api.agent.readWorkspaceFile === 'function';
}

export function createTauriAgentPromptCapture({ api, context,
    getCurrentChat, getOwnerKey = () => null, cryptoRef = globalThis.crypto,
    maxBodyBytes = 16 * 1024 * 1024, maxInputCodeUnits = 32 * 1024 * 1024,
    listLimit = 16, now = Date.now } = {}) {
    if (![maxBodyBytes, maxInputCodeUnits, listLimit].every(value => Number.isSafeInteger(value) && value > 0)
        || listLimit > 200) throw new TypeError('Agent 提示词捕获限制无效。');
    const agent = api?.agent, supported = supportsTauriAgentPromptCapture(api), listeners = new Set(), subscriptions = [], dismissals = new Map();
    const externalCurrentChat = typeof getCurrentChat === 'function';
    let enabled = true, destroyed = false, serial = 0, record = null, selectedScope = null, selectedRun = null, selectedOwner = null;
    let watchSerial = 0;
    let status = supported ? 'idle' : 'unavailable', error = null, unsubscribe = null, watchedRun = null;
    const owner = () => { try { const value = getOwnerKey(); return label(value, 512) ? value : null; } catch { return null; } };
    const notify = () => { for (const fn of listeners) { try { fn(); } catch {} } };
    const stopWatching = () => {
        watchSerial++;
        watchedRun = null;
        const previous = unsubscribe; unsubscribe = null;
        try { Promise.resolve(previous?.()).catch(() => {}); } catch {}
    };
    async function resolveCurrentChat() {
        if (externalCurrentChat) return chatScope(await getCurrentChat());
        const ref = chatRef(api?.chat?.current?.ref?.());
        const handle = api.chat.open(ref);
        if (typeof handle?.stableId !== 'function') throw problem('AGENT_CHAT_SCOPE_UNAVAILABLE');
        const stableChatId = await handle.stableId();
        if (!sameRef(ref, api.chat.current.ref())) throw problem('AGENT_SCOPE_CHANGED');
        return chatScope({ chatRef: ref, stableChatId });
    }
    async function remainsCurrent(token, scope, owned, defaultScope) {
        if (destroyed || !enabled || serial !== token) return false;
        if (owner() !== owned) { clear({ dismiss: false }); return false; }
        if (defaultScope) {
            try {
                const current = await resolveCurrentChat();
                const matches = !destroyed && enabled && serial === token && owner() === owned
                    && scopeKey(current, owned) === scopeKey(scope, owned);
                if (!matches && serial === token) clear({ dismiss: false });
                return matches;
            } catch { if (serial === token) clear({ dismiss: false }); return false; }
        }
        return true;
    }
    function watch(run, scope, owned) {
        if (TERMINAL.has(run.status) || typeof agent?.subscribe !== 'function') { stopWatching(); return; }
        if (watchedRun === run.runId && unsubscribe) return;
        stopWatching(); watchedRun = run.runId;
        const watchToken = ++watchSerial;
        const watchKey = scopeKey(scope, owned);
        try {
            const result = agent.subscribe(run.runId, event => {
                if (destroyed || !enabled || watchedRun !== run.runId || watchSerial !== watchToken || owner() !== owned
                    || scopeKey(selectedScope, owned) !== watchKey || (event?.runId && event.runId !== run.runId)) return;
                if (!['workspace_initialized', 'run_completed', 'run_partial_success', 'run_failed', 'run_cancelled'].includes(event?.type)) return;
                if (event.type !== 'workspace_initialized') stopWatching();
                void refresh(scope, { automatic: true });
            });
            if (typeof result === 'function') { unsubscribe = result; return; }
            Promise.resolve(result).then(dispose => {
                if (destroyed || !enabled || watchedRun !== run.runId || watchSerial !== watchToken || owner() !== owned) {
                    try { Promise.resolve(dispose?.()).catch(() => {}); } catch {}
                } else if (typeof dispose === 'function') unsubscribe = dispose;
            }).catch(() => { if (watchedRun === run.runId && watchSerial === watchToken) stopWatching(); });
        } catch { stopWatching(); }
    }
    function isDismissed(scope, owned, run) {
        const dismissed = dismissals.get(scopeKey(scope, owned));
        return Boolean(dismissed && (dismissed.runIds.has(run.runId)
            || (Number.isFinite(run.createdAtMs) && run.createdAtMs < dismissed.beforeMs)));
    }
    async function readSnapshot(run, scope, reopenedFromHost = false) {
        const file = await agent.readWorkspaceFile({ runId: run.runId, path: SNAPSHOT_PATH });
        if (!object(file) || file.path !== SNAPSHOT_PATH || typeof file.text !== 'string'
            || file.text.length > maxInputCodeUnits || file.truncated === true
            || !Number.isSafeInteger(file.chars) || file.chars < 0 || file.chars > file.text.length
            || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(file.sha256)) throw problem('AGENT_PROMPT_UNAVAILABLE');
        let chars = 0;
        for (const _character of file.text) chars++;
        if (chars !== file.chars) throw problem('AGENT_PROMPT_INCOMPLETE');
        let sourceDocumentVerified = false;
        if (typeof cryptoRef?.subtle?.digest === 'function') {
            const digest = await cryptoRef.subtle.digest('SHA-256', new TextEncoder().encode(file.text));
            const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
            if (actual !== file.sha256.toLowerCase()) throw problem('AGENT_PROMPT_INCOMPLETE');
            sourceDocumentVerified = true;
        }
        let parsed;
        try { parsed = JSON.parse(file.text); } catch { throw problem('AGENT_PROMPT_INVALID'); }
        const body = promptBody(parsed);
        if (new TextEncoder().encode(body.bodyText).length > maxBodyBytes) throw problem('AGENT_PROMPT_TOO_LARGE');
        const immutableScope = { ...scope, ...(scope.chatRef ? { chatRef: Object.freeze({ ...scope.chatRef }) } : {}) };
        return Object.freeze({ kind: 'agent-initial-snapshot', id: 'tauri-agent-' + run.runId,
            ticket: 'tauri-agent-' + run.runId, runId: run.runId,
            scope: Object.freeze(immutableScope), source: body.source, model: body.model,
            rawRequest: Object.freeze({ bodyText: body.bodyText, url: null, method: null }),
            metadata: Object.freeze({ captureKind: 'frontend-messages', capturePhase: 'agent-initial-snapshot',
                bodyEvidence: 'agent-initial-snapshot', initialAssemblyOnly: true,
                networkBytesVerified: false, providerBodyAvailable: false,
                runId: run.runId, runStatus: run.status, profileId: run.profileId,
                ...(scope.kind === 'chat' ? { chatId: scope.chatId, stableChatId: scope.stableChatId }
                    : { sessionId: scope.sessionId }),
                inputArtifact: SNAPSHOT_PATH, sourceDocumentVerified, sourceDocumentSha256: file.sha256.toLowerCase(),
                ...(reopenedFromHost ? { reopenedFromHost: true } : {}) }),
            createdAtMs: run.createdAtMs, updatedAtMs: run.updatedAtMs, observedAtMs: now(), state: 'observed' });
    }
    async function getLatestPromptForChat(input, { automatic = false } = {}) {
        if (destroyed || !enabled || !supported) return null;
        const token = ++serial, owned = owner(), defaultScope = input === undefined;
        let scope, pendingRun;
        try {
            scope = defaultScope ? await resolveCurrentChat() : chatScope(input);
            if (!await remainsCurrent(token, scope, owned, defaultScope)) return null;
            if (!selectedScope || scopeKey(selectedScope, selectedOwner) !== scopeKey(scope, owned)) { record = null; stopWatching(); }
            selectedScope = scope; selectedOwner = owned; selectedRun = null; status = 'loading'; error = null; notify();
            const listed = await agent.listRuns({ chatRef: scope.chatRef, stableChatId: scope.stableChatId, limit: listLimit });
            if (!await remainsCurrent(token, scope, owned, defaultScope)) return null;
            if (!object(listed) || !Array.isArray(listed.runs) || listed.runs.length > 200) throw problem('AGENT_PROMPT_UNAVAILABLE');
            const matching = listed.runs.map(value => runSummary(value, scope)).filter(Boolean)
                .sort((left, right) => right.createdAtMs - left.createdAtMs || right.runId.localeCompare(left.runId));
            const run = matching[0];
            if (!run) { record = null; status = 'idle'; stopWatching(); notify(); return null; }
            const dismissed = isDismissed(scope, owned, run);
            if (automatic && dismissed) { record = null; selectedRun = null; status = 'cleared'; stopWatching(); notify(); return null; }
            selectedRun = run.runId; pendingRun = run;
            const next = await readSnapshot(run, scope, !automatic && dismissed);
            if (!await remainsCurrent(token, scope, owned, defaultScope)) return null;
            if (!automatic && dismissed) dismissals.delete(scopeKey(scope, owned));
            record = next; status = 'ready'; error = null; notify(); watch(run, scope, owned); return record;
        } catch (failure) {
            if (destroyed || !enabled || serial !== token || owner() !== owned) return null;
            if (!scope || failure?.code === 'AGENT_SCOPE_CHANGED') { clear({ dismiss: false }); return null; }
            status = 'unavailable'; error = { code: ERROR_CODES.has(failure?.code) ? failure.code : 'AGENT_PROMPT_UNAVAILABLE' };
            if (pendingRun) watch(pendingRun, scope, owned);
            // A failed read never fabricates a current prompt or replaces it
            // with another run. A prior observed record remains explicit.
            notify(); return null;
        }
    }
    async function getLatestPromptForSession(input, { automatic = false } = {}) {
        if (destroyed || !enabled || !supported || typeof agent?.sessions?.read !== 'function') return null;
        const token = ++serial, owned = owner();
        let scope, pendingRun;
        try {
            if (!identifier(input?.sessionId)) throw problem('AGENT_SESSION_SCOPE_UNAVAILABLE');
            scope = { kind: 'session', sessionId: input.sessionId };
            if (!selectedScope || scopeKey(selectedScope, selectedOwner) !== scopeKey(scope, owned)) { record = null; stopWatching(); }
            selectedScope = scope; selectedOwner = owned; status = 'loading'; error = null; notify();
            const page = await agent.sessions.read({ sessionId: scope.sessionId, limit: listLimit });
            if (!await remainsCurrent(token, scope, owned, false)) return null;
            if (page?.session?.id !== scope.sessionId || !Array.isArray(page.messages)) throw problem('AGENT_SESSION_SCOPE_UNAVAILABLE');
            const active = page.activeRun?.sessionId === scope.sessionId && identifier(page.activeRun.runId) ? page.activeRun : null;
            const latest = page.messages.filter(value => identifier(value?.runId) && Number.isSafeInteger(value.seq))
                .sort((left, right) => right.seq - left.seq)[0];
            const chosen = active ?? latest;
            if (!chosen) { record = null; selectedRun = null; status = 'idle'; notify(); return null; }
            if (input.runId !== undefined && input.runId !== chosen.runId) throw problem('AGENT_SESSION_SCOPE_UNAVAILABLE');
            const createdAtMs = Date.parse(chosen.createdAt), run = { runId: chosen.runId,
                status: active?.status ?? 'unknown', profileId: null, generationType: 'normal',
                createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : null,
                updatedAtMs: Number.isFinite(createdAtMs) ? createdAtMs : null };
            const dismissed = isDismissed(scope, owned, run);
            if (automatic && dismissed) { record = null; selectedRun = null; status = 'cleared'; stopWatching(); notify(); return null; }
            selectedRun = run.runId; pendingRun = active ? run : null;
            const next = await readSnapshot(run, scope, !automatic && dismissed);
            if (!await remainsCurrent(token, scope, owned, false)) return null;
            if (!automatic && dismissed) dismissals.delete(scopeKey(scope, owned));
            record = next; status = 'ready'; error = null; notify(); if (active) watch(run, scope, owned); else stopWatching(); return record;
        } catch (failure) {
            if (destroyed || !enabled || serial !== token || owner() !== owned) return null;
            status = 'unavailable'; error = { code: ERROR_CODES.has(failure?.code) ? failure.code : 'AGENT_PROMPT_UNAVAILABLE' };
            if (pendingRun) watch(pendingRun, scope, owned);
            notify(); return null;
        }
    }
    function refresh(input, options) { return input?.kind === 'session' ? getLatestPromptForSession(input, options) : getLatestPromptForChat(input, options); }
    function clear({ dismiss = true } = {}) {
        if (dismiss && selectedScope && selectedOwner === owner()) {
            const key = scopeKey(selectedScope, selectedOwner), prior = dismissals.get(key);
            const runIds = new Set(prior?.runIds ?? []);
            for (const id of [selectedRun, record?.runId]) if (identifier(id)) runIds.add(id);
            while (runIds.size > 16) runIds.delete(runIds.values().next().value);
            const beforeMs = now();
            dismissals.delete(key); dismissals.set(key, { runIds, beforeMs: Number.isFinite(beforeMs) ? beforeMs : 0 });
            while (dismissals.size > 32) dismissals.delete(dismissals.keys().next().value);
        }
        serial++; record = null; selectedRun = null; selectedScope = null; selectedOwner = null;
        stopWatching(); error = null; status = supported && enabled ? 'idle' : 'unavailable'; notify();
    }
    for (const name of ['CHAT_CHANGED', 'GENERATION_ENDED', 'GENERATION_STOPPED']) {
        const event = context?.eventTypes?.[name];
        if (typeof event !== 'string' || typeof context.eventSource?.on !== 'function') continue;
        const listener = () => {
            if (destroyed || !enabled || selectedScope?.kind === 'session') return;
            if (name === 'CHAT_CHANGED') clear({ dismiss: false });
            if (listeners.size) void refresh(undefined, { automatic: true });
        };
        context.eventSource.on(event, listener); subscriptions.push([event, listener]);
    }
    return {
        getLatestPromptForChat, getLatestPromptForSession, refresh, clear,
        snapshot() { const matchesOwner = owner() === selectedOwner; return { supported: supported && !destroyed, enabled,
            status: matchesOwner ? status : 'idle', record: matchesOwner ? record : null,
            error: matchesOwner && error ? { ...error } : null, scope: matchesOwner && selectedScope ? clone(selectedScope) : null,
            runId: matchesOwner ? selectedRun : null, initialAssemblyOnly: true, privacyMode: 'memory-only' }; },
        subscribe(fn) { if (typeof fn !== 'function') throw new TypeError('缺少事件监听函数。'); if (destroyed) return () => {}; listeners.add(fn); return () => listeners.delete(fn); },
        setEnabled(value) { enabled = value === true; clear(); return enabled; },
        destroy() {
            if (destroyed) return;
            destroyed = true; serial++; stopWatching(); record = null; selectedRun = null; selectedScope = null; selectedOwner = null;
            status = 'unavailable'; error = null;
            for (const [event, listener] of subscriptions) { try { context.eventSource.removeListener?.(event, listener); } catch {} }
            subscriptions.length = 0; listeners.clear(); dismissals.clear();
        },
    };
}
