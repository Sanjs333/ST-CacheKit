/* Scoped adaptation of shipped Agent initial prompt assembly; MPL-2.0. */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => {
    const descriptor = value && (typeof value === 'object' || typeof value === 'function')
        ? Object.getOwnPropertyDescriptor(value, key) : null;
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
};
const LIMIT = Object.freeze({ bytes: 16 * 1024 * 1024, nodes: 65536, depth: 64, events: 8192 });
const SOURCE_FIELDS = ['identifier', 'content', 'name', 'role', 'injection_position', 'injection_depth',
    'injection_order', 'position', 'marker', 'system_prompt', 'extension'];

// Evidence checks never execute accessors, toJSON hooks, macros or regular expressions.
function dataCopy(value, budget = { bytes: 0, nodes: 0 }, depth = 0, seen = new WeakSet()) {
    if (depth > LIMIT.depth || ++budget.nodes > LIMIT.nodes) throw new RangeError('Agent assembly evidence limit.');
    if (typeof value === 'string') {
        budget.bytes += new TextEncoder().encode(value).length;
        if (budget.bytes > LIMIT.bytes) throw new RangeError('Agent assembly evidence limit.');
        return value;
    }
    if (value === null || value === undefined || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || seen.has(value)) throw new TypeError('Unknown Agent assembly evidence.');
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== null && Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value?.name !== 'Object')
        throw new TypeError('Unknown Agent assembly evidence object.');
    seen.add(value);
    const copy = array ? [] : {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (!descriptor.enumerable) continue;
        if (!('value' in descriptor)) throw new TypeError('Unknown Agent assembly accessor.');
        budget.bytes += key.length;
        Object.defineProperty(copy, key, { value: dataCopy(descriptor.value, budget, depth + 1, seen),
            enumerable: true, configurable: true, writable: true });
    }
    seen.delete(value);
    if (array) copy.length = value.length;
    return copy;
}
function equalData(left, right) {
    return JSON.stringify(dataCopy(left)) === JSON.stringify(dataCopy(right));
}
function observationSettings(value) {
    // Generation parameter/account fields are not needed to prove prompt layout.
    const fields = ['openai_max_context', 'openai_max_tokens', 'squash_system_messages', 'wi_format', 'continue_prefill',
        'assistant_prefill', 'continue_nudge_prompt', 'new_chat_prompt', 'new_group_chat_prompt', 'send_if_empty',
        'names_behavior', 'chat_completion_source', 'prompts', 'prompt_order', 'scenario_format', 'personality_format'];
    const result = {};
    for (const field of fields) {
        const valueAt = own(value, field);
        if (valueAt !== undefined) result[field] = dataCopy(valueAt);
    }
    return result;
}
function capturedInput(request) {
    const frozen = own(request, 'frozenRunInputSnapshot') ?? own(request, 'frozen_run_input_snapshot');
    if (!object(frozen)) throw new TypeError('Captured Agent frozen input unavailable.');
    const capturedFrozen = {};
    for (const field of ['schemaVersion', 'kind', 'generationType', 'contextKind', 'promptInputs', 'worldInfoActivation']) {
        const value = own(frozen, field);
        if (value !== undefined) capturedFrozen[field] = dataCopy(value);
    }
    if (!Object.hasOwn(capturedFrozen, 'promptInputs') && own(frozen, 'prompt_inputs') !== undefined)
        capturedFrozen.promptInputs = dataCopy(own(frozen, 'prompt_inputs'));
    if (!Object.hasOwn(capturedFrozen, 'worldInfoActivation') && own(frozen, 'world_info_activation') !== undefined)
        capturedFrozen.worldInfoActivation = dataCopy(own(frozen, 'world_info_activation'));
    if (!Object.hasOwn(capturedFrozen, 'generationType') && own(frozen, 'generation_type') !== undefined)
        capturedFrozen.generationType = dataCopy(own(frozen, 'generation_type'));
    const input = { frozenRunInputSnapshot: capturedFrozen };
    for (const field of ['profileId', 'generationType', 'modelId', 'agentContextPolicy', 'contextPolicy',
        'agentSystemPrompt', 'agentTaskPrompt', 'requiredAgentPromptComponents', 'jsonSchema']) {
        const value = own(request, field);
        if (value !== undefined) input[field] = dataCopy(value);
    }
    for (const [field, alias] of [['profileId', 'profile_id'], ['generationType', 'generation_type'], ['modelId', 'model_id'],
        ['agentSystemPrompt', 'agent_system_prompt'], ['agentTaskPrompt', 'agent_task_prompt'],
        ['requiredAgentPromptComponents', 'required_agent_prompt_components'], ['jsonSchema', 'json_schema']]) {
        if (Object.hasOwn(input, field) || own(request, alias) === undefined) continue;
        input[field] = dataCopy(own(request, alias));
    }
    input.settings = observationSettings(own(request, 'settings') ?? own(request, 'presetSettings') ?? own(request, 'preset_settings'));
    return input;
}
function sourceMetadata(template) {
    const result = {};
    for (const field of SOURCE_FIELDS) {
        const value = own(template, field);
        if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) result[field] = value;
    }
    return result;
}
function replaceMessages(result, snapshot, messages, tokenCounts) {
    const nextSnapshot = { ...snapshot, messages };
    return { ...result, promptSnapshot: nextSnapshot,
        ...(tokenCounts !== undefined && object(result.assembly) ? { assembly: { ...result.assembly, tokenCounts } } : {}) };
}
const fallbackReport = reason => ({ reason, statuses: { green: 'provenance-unavailable', depth: 'provenance-unavailable' },
    collections: { green: { count: 0, groups: 0 }, depth: { count: 0, groups: 0 } } });

export function installTauriAgentAssembly({ target = globalThis, getPromptMigration = () => null,
    loadModules = async () => {
        const [openAi, promptManager, messages, contextPolicy] = await Promise.all([
            import('../../../../openai.js'), import('../../../../PromptManager.js'),
            import('../../../../tauritavern/agent/agent-model-messages.js'),
            import('../../../../tauritavern/agent/agent-context-policy.js'),
        ]);
        return { openAi, PromptManager: promptManager.PromptManager, toAgentModelMessage: messages.toAgentModelMessage,
            projectAgentPromptInputs: contextPolicy.projectAgentPromptInputs };
    }, onAssembly = () => {} } = {}) {
    const api = target?.__TAURITAVERN__?.api?.agent?.promptAssembly;
    const original = own(api, 'buildSnapshot');
    if (typeof original !== 'function') return { available: false, getEvidence: () => null, destroy() {} };
    const descriptor = Object.getOwnPropertyDescriptor(api, 'buildSnapshot');
    let destroyed = false, modulesPromise = null, currentJob = null, serial = 0;
    let queue = Promise.resolve(), evidence = new WeakMap();
    const observedMessages = new WeakMap();
    const restorers = [];
    function wrap(owner, key, create) {
        const previous = Object.getOwnPropertyDescriptor(owner, key), method = previous?.value;
        if (typeof method !== 'function') throw new TypeError('Shipped Agent prompt method unavailable: ' + key);
        const wrapped = create(method);
        Object.defineProperty(owner, key, { ...previous, value: wrapped });
        restorers.push(() => { if (owner[key] === wrapped) Object.defineProperty(owner, key, previous); });
    }
    function add(job, values, value) {
        if (values.length >= LIMIT.events) { job.limited = true; return; }
        values.push(value);
    }
    function bindManager(job, manager, modules) {
        if (!job || destroyed || manager === modules.openAi?.promptManager) return false;
        if (job.manager && job.manager !== manager) { job.ambiguous = true; return false; }
        job.manager = manager;
        if (!job.tokenHandler) {
            const handler = manager?.tokenHandler;
            if (!handler || typeof handler.countAsync !== 'function') { job.ambiguous = true; return false; }
            job.tokenHandler = handler; job.countAsync = handler.countAsync;
            const descriptor = Object.getOwnPropertyDescriptor(handler, 'countAsync');
            if (descriptor && 'value' in descriptor) {
                const countWrapper = function (...args) {
                    if (!destroyed && currentJob === job && job.phase === 'building') add(job, job.nativeCounts, { args });
                    return job.countAsync.apply(this, args);
                };
                try {
                    Object.defineProperty(handler, 'countAsync', { ...descriptor, value: countWrapper });
                    job.restoreCount = () => { if (handler.countAsync === countWrapper) Object.defineProperty(handler, 'countAsync', descriptor); };
                } catch { /* Count observations are supplemental; the native counter remains authoritative. */ }
            }
        }
        return job.phase === 'building';
    }
    async function modules() {
        modulesPromise ??= Promise.resolve().then(loadModules).then(value => {
            const Message = value?.openAi?.Message, ChatCompletion = value?.openAi?.ChatCompletion;
            const prototype = value?.PromptManager?.prototype;
            if (!prototype || !Message || !ChatCompletion || typeof value.toAgentModelMessage !== 'function'
                || typeof value.projectAgentPromptInputs !== 'function') throw new TypeError('Agent assembly modules unavailable.');
            const start = restorers.length;
            try {
                wrap(prototype, 'preparePrompt', native => function (template, ...rest) {
                    const job = currentJob, capturing = bindManager(job, this, value);
                    let metadata;
                    try { metadata = capturing ? sourceMetadata(template) : null; }
                    catch { if (capturing) job.limited = true; }
                    const prompt = native.call(this, template, ...rest);
                    if (capturing && currentJob === job && prompt && typeof prompt === 'object') {
                        const entry = { prompt, template, metadata };
                        add(job, job.prepared, entry); job.preparedByPrompt.set(prompt, entry);
                    }
                    return prompt;
                });
                wrap(prototype, 'getPromptCollection', native => function (...args) {
                    const job = currentJob, capturing = bindManager(job, this, value);
                    const collection = native.apply(this, args);
                    if (capturing && currentJob === job) {
                        if (job.promptCollection && job.promptCollection !== collection) job.ambiguous = true;
                        job.promptCollection = collection; job.collectionArgs = args;
                    }
                    return collection;
                });
                wrap(prototype, 'setChatCompletion', native => function (completion, ...rest) {
                    const job = currentJob, capturing = bindManager(job, this, value);
                    if (capturing) {
                        if (job.completion && job.completion !== completion) job.ambiguous = true;
                        job.completion = completion;
                    }
                    return native.call(this, completion, ...rest);
                });
                wrap(Message, 'fromPromptAsync', native => async function (prompt, ...rest) {
                    const job = currentJob;
                    const message = await native.call(this, prompt, ...rest);
                    if (!destroyed && currentJob === job && job?.phase === 'building' && job.preparedByPrompt.has(prompt)) {
                        add(job, job.messageEvents, { prompt, message });
                        if (message && typeof message === 'object') observedMessages.set(message, job.id);
                    }
                    return message;
                });
                wrap(Message, 'createAsync', native => async function (...args) {
                    const job = currentJob;
                    const message = await native.apply(this, args);
                    if (!destroyed && currentJob === job && job?.phase === 'building') {
                        add(job, job.createdMessages, { message, args });
                        if (message && typeof message === 'object') observedMessages.set(message, job.id);
                    }
                    return message;
                });
                wrap(ChatCompletion.prototype, 'setTokenBudget', native => function (...args) {
                    const job = currentJob;
                    if (!destroyed && job?.phase === 'building') job.budgets.set(this, { contextSize: args[0], responseSize: args[1], args });
                    return native.apply(this, args);
                });
                wrap(ChatCompletion.prototype, 'reserveBudget', native => function (...args) {
                    const job = currentJob;
                    if (!destroyed && job?.phase === 'building') add(job, job.reservations, { completion: this, args });
                    return native.apply(this, args);
                });
                wrap(ChatCompletion.prototype, 'getChat', native => function (...args) {
                    const chat = native.apply(this, args), job = currentJob;
                    if (!destroyed && job?.phase === 'building') job.chats.set(this, chat);
                    return chat;
                });
                wrap(ChatCompletion.prototype, 'squashSystemMessages', native => async function (...args) {
                    const job = currentJob;
                    const result = await native.apply(this, args);
                    if (!destroyed && currentJob === job && job?.phase === 'building') job.squashed.add(this);
                    return result;
                });
                return value;
            } catch (error) {
                for (const restore of restorers.splice(start).reverse()) try { restore(); } catch { /* Release all partial hooks. */ }
                throw error;
            }
        });
        return modulesPromise;
    }
    async function execute(thisValue, args) {
        if (destroyed) return original.apply(thisValue, args);
        let nativeModules;
        try { nativeModules = await modules(); } catch { return original.apply(thisValue, args); }
        if (destroyed) return original.apply(thisValue, args);
        const request = args[0] ?? {}, job = { id: ++serial, phase: 'building', manager: null, completion: null,
            promptCollection: null, collectionArgs: null, prepared: [], messageEvents: [], createdMessages: [], reservations: [],
            preparedByPrompt: new WeakMap(), budgets: new WeakMap(), chats: new WeakMap(), squashed: new WeakSet(),
            nativeCounts: [], ambiguous: false, limited: false,
            startingScope: (() => { try { return JSON.stringify(target.__TAURITAVERN__?.api?.chat?.current?.ref?.() ?? null); } catch { return null; } })() };
        let capturedRequest;
        try { capturedRequest = capturedInput(request); } catch { job.inputUnavailable = true; }
        currentJob = job;
        try {
            const result = await original.apply(thisValue, args);
            job.phase = 'adapting';
            try { job.restoreCount?.(); job.restoreCount = null; } catch { /* Stop native count observation before adapted recounting. */ }
            const snapshot = own(result, 'promptSnapshot'), frontendMessages = job.completion ? job.chats.get(job.completion) : null;
            let adapted = null, next = result, reason = 'AGENT_PROMPT_ASSEMBLY_UNAVAILABLE';
            let observation;
            try {
                if (destroyed || job.ambiguous || job.limited || job.inputUnavailable || !job.manager || !job.completion
                    || !Array.isArray(frontendMessages) || !object(snapshot) || !Array.isArray(own(snapshot, 'messages')))
                    throw new TypeError('Agent assembly source observations unavailable.');
                const frozen = own(capturedRequest, 'frozenRunInputSnapshot') ?? own(capturedRequest, 'frozen_run_input_snapshot');
                const projectedInputs = nativeModules.projectAgentPromptInputs(own(frozen, 'promptInputs'), own(snapshot, 'contextPolicy'));
                const originalCanonical = frontendMessages.map(nativeModules.toAgentModelMessage);
                if (!equalData(originalCanonical, snapshot.messages)) throw new TypeError('Agent payload differs from captured native frame.');
                observation = { manager: job.manager, completion: job.completion, promptCollection: job.promptCollection,
                    collectionArgs: job.collectionArgs, prepared: job.prepared, messageEvents: job.messageEvents,
                    createdMessages: job.createdMessages, reservations: job.reservations,
                    frontendMessages, budget: job.budgets.get(job.completion), projectedInputs,
                    capturedRequest, capturedFrozen: frozen, contextKind: own(frozen, 'contextKind') ?? 'chat',
                    contextPolicy: own(snapshot, 'contextPolicy'), extensionPrompts: projectedInputs.extensionPrompts,
                    model: own(own(snapshot, 'generationParameters'), 'model'),
                    wasSquashed: job.squashed.has(job.completion),
                    nativeCounts: job.nativeCounts, tokenHandler: job.tokenHandler,
                    isCurrent: () => {
                        if (destroyed || currentJob !== job || job.ambiguous || job.phase !== 'adapting') return false;
                        if (own(frozen, 'contextKind') === 'session') return true;
                        try { return job.startingScope === JSON.stringify(target.__TAURITAVERN__?.api?.chat?.current?.ref?.() ?? null); }
                        catch { return false; }
                    },
                    isMessageFromThisAssembly: message => observedMessages.get(message) === job.id };
                const migration = getPromptMigration();
                if (typeof migration?.adaptAgentAssembly !== 'function') throw new TypeError('Agent migration adapter unavailable.');
                const originalSnapshot = dataCopy(snapshot), originalFrozen = own(result, 'frozenRunInputSnapshot');
                const originalSettings = dataCopy(observationSettings(job.manager.serviceSettings));
                adapted = await migration.adaptAgentAssembly({ request: capturedRequest, result, observation });
                if (observation.isCurrent() && adapted && Array.isArray(adapted.messages)) {
                    if (!equalData(originalSnapshot, snapshot) || originalFrozen !== own(result, 'frozenRunInputSnapshot'))
                        throw new TypeError('Agent adapter mutated the native snapshot.');
                    if (!equalData(originalSettings, observationSettings(job.manager.serviceSettings)))
                        throw new TypeError('Agent assembly settings changed during adaptation.');
                    const messages = adapted.messages.map(nativeModules.toAgentModelMessage);
                    dataCopy(messages); // Reject unknown/accessor-backed replacement evidence.
                    next = replaceMessages(result, snapshot, messages, observation.contextKind === 'session' ? undefined : adapted.tokenCounts);
                    reason = adapted.report?.reason ?? null;
                }
            } catch { /* Original native assembly stays available; unsupported evidence is reported below. */ }
            const evidenceSnapshot = own(next, 'promptSnapshot');
            if (!destroyed && object(evidenceSnapshot)) {
                const item = { kind: 'agent-initial-assembly', jobId: job.id, contextKind: observation?.contextKind ?? 'unknown',
                    profileId: own(capturedRequest, 'profileId') ?? own(capturedRequest, 'profile_id') ?? null,
                    source: own(own(evidenceSnapshot, 'generationParameters'), 'chat_completion_source') ?? null,
                    model: own(own(evidenceSnapshot, 'generationParameters'), 'model') ?? null,
                    association: observation?.contextKind === 'session' ? 'session-initial-assembly' : 'scoped-agent-initial-assembly',
                    supported: next !== result, trace: next !== result ? adapted?.trace ?? null : null,
                    ...(next !== result && typeof adapted?.reportToken === 'string' ? { reportToken: adapted.reportToken } : {}),
                    report: next !== result ? adapted?.report ?? fallbackReport(reason) : fallbackReport(reason) };
                try { evidence.set(evidenceSnapshot, dataCopy(item)); } catch { /* Evidence limits never alter accepted native prompts. */ }
                try { onAssembly(item); } catch { /* Diagnostics cannot affect a native request. */ }
            }
            return next;
        } finally {
            job.phase = 'finished'; if (currentJob === job) currentJob = null;
            try { job.restoreCount?.(); } catch { /* Release the isolated native counter observer. */ }
        }
    }
    function wrapper(...args) {
        if (destroyed) return original.apply(this, args);
        const thisValue = this, work = queue.then(() => execute(thisValue, args), () => execute(thisValue, args));
        queue = work.catch(() => {}); return work;
    }
    function getEvidence(snapshot) {
        try { const item = object(snapshot) ? evidence.get(snapshot) : null; return item ? dataCopy(item) : null; }
        catch { return null; }
    }
    try { Object.defineProperty(api, 'buildSnapshot', { ...descriptor, value: wrapper }); }
    catch { return { available: false, getEvidence: () => null, destroy() {} }; }
    return {
        get available() { return !destroyed; },
        getEvidence,
        getEvidenceSnapshot: getEvidence,
        destroy() {
            if (destroyed) return;
            destroyed = true; evidence = new WeakMap();
            try { if (api.buildSnapshot === wrapper) Object.defineProperty(api, 'buildSnapshot', descriptor); }
            catch { /* A later wrapper may make the host property read-only; it still delegates transparently. */ }
            for (const restore of restorers.reverse()) try { restore(); } catch { /* Release every available hook. */ }
            restorers.length = 0;
        },
    };
}
