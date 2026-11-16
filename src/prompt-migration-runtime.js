/* Plugin-only prompt migration through exported host objects; MPL-2.0. */
import { completionIdentity, isFinalWorldInfoScan } from './worldinfo-stability.js';
import { acceptNativeWorldInfoRendering, captureWorldInfoRendering, worldInfoRenderingMatches } from './worldinfo-source-evidence.js';
import { preserveNativeWorldInfoRendering, worldInfoRenderCallSites, worldInfoRenderDefaultDepth } from './worldinfo-native-rendering.js';
import { installNativeOutletEvidence } from './native-outlet-evidence.js';
import { MACROS, MIGRATION_SETTINGS_KEY, occurrences, planMigration, sanitizeChat, setMigrationExpectedCounts, textParts, verifyMigration } from './prompt-migration.js';

const FOREGROUND = new Set([undefined, null, '', 'normal', 'regenerate', 'swipe', 'continue', 'append', 'appendFinal']);
const MAX_MESSAGES = 512;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_WI_BYTES = 128 * 1024;
const REASONS = Object.freeze({
    PUBLIC_PROMPT_APIS_UNAVAILABLE: '缺少公开提示词对象，宏搬迁不可用。',
    AGENT_PROMPT_ASSEMBLY_UNAVAILABLE: '未取得 Agent 组装对象，相关内容保留原位。',
    AGENT_PRIVATE_PROMPT_ASSEMBLY_UNAVAILABLE: '未取得可核验的 Agent 初始组装结果，相关内容保留原位。',
    FINAL_PROMPT_ASSEMBLY_UNMIGRATED: '最终组装结果仍含搬迁宏，未确认完成搬迁。',
    WI_REGEX_UNSUPPORTED: '部分世界书正则结果无法逐条核验，相关绿灯保留原位。',
    WI_SOURCE_UNAVAILABLE: '世界书来源未完整确认，绿灯保留原位。',
    WI_EXAMPLES_OR_OUTLETS_UNSUPPORTED: '部分世界书示例未确认，仅搬迁已确认的绿灯。',
    WI_OUTLET_SOURCE_UNAVAILABLE: '部分世界书出口位置未确认，仅搬迁已确认的绿灯。',
    SOURCE_RETAINED: '部分来源需保留原生结构或无法核验，仅搬迁其余已确认内容。',
    DEPTH_SOURCE_UNAVAILABLE: '@D 聚合来源、位置或宏展开结果未完整核验，@D／作者注释保留原位。',
    SOURCE_CAPTURE_UNAVAILABLE: '未取得预算筛选后的原生提示词对象，相关内容保留原位。',
    SOURCE_LIMIT: '来源超过处理上限，相关内容保留原位。',
    WI_EXAMPLE_LIMIT: '世界书示例超过搬迁上限，相关内容保留原位。',
    HOST_CHAT_CHANGED: '提示词已被其他处理修改，宏搬迁保留原位。',
    REBUILD_FALLBACK: '重新计数或内容核验失败，相关内容保留原位。',
    SETTINGS_SAVE_FAILED: '宏搬迁设置保存失败，已恢复原设置。',
});

export const PLUGIN_MIGRATION_SCOPE = '绿灯支持已确认的世界书前后段、出口及示例（含原生 if/else）；动态正则按逐条实际结果核验，支持蓝绿混合。示例保留原生消息身份与分隔符。@D／作者注释按已确认的原生聚合组整体搬迁，保留组内顺序。支持 TT 独立预设、Session 和子任务初始组装；无法核验的内容保留原位。';
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
const plainMessage = value => typeof value?.content === 'string' && !value.name && !value.tool_calls
    && !value.signature && !value.reasoning && !value.native && !value.agentMessage && !value.reasoning_details
    && !value.reasoning_content && !value.thoughtSignature && value.role !== 'tool';
const plainPayload = value => {
    if (!value || typeof value !== 'object') return false;
    const fields = Object.getOwnPropertyDescriptors(value);
    return typeof fields.content?.value === 'string' && ['system', 'user', 'assistant'].includes(fields.role?.value)
        && Object.entries(fields).every(([key, descriptor]) => !descriptor.enumerable
            || 'value' in descriptor && (descriptor.value === undefined || ['role', 'content'].includes(key)
                || key === '_tauritavern_prompt_component' && descriptor.value === 'agentSystemPrompt'));
};
const wiGroup = entry => entry.nativeFieldGroup ?? JSON.stringify([entry.world, entry.order, entry.position, entry.depth ?? null,
    entry.role ?? null, entry.outletName ?? null]);

/** No source-capability globals or persistent host changes are installed. */
export async function installPromptMigrationRuntime({ context, getContext = () => context, stability,
    onChange = () => {}, onSourceSnapshot = () => {},
    loadOpenAi = () => import('../../../../openai.js'),
    loadRegex = () => import('../../../regex/engine.js'),
    loadScript = () => import('../../../../../script.js'),
    loadUtils = () => import('../../../../utils.js'),
    loadConstants = () => import('../../../../constants.js'),
    loadPowerUser = () => import('../../../../power-user.js'),
    loadMacros = () => import('../../../../macros/macro-system.js'),
    loadWorldInfoSource = async () => {
        const response = await fetch(new URL('../../../../world-info.js', import.meta.url));
        return response.ok ? response.text() : null;
    },
    isLegacyMode = () => true,
    importObservedFrame = false,
    privateContextKind = null,
    privateWasSquashed = false,
    captureAgentDryRun = false,
    getNativeChatRef = () => globalThis.__TAURITAVERN__?.api?.chat?.current?.ref?.(),
} = {}) {
    let openAi, regex, script, utils, constants, powerUser;
    try { openAi = await loadOpenAi(); } catch { /* Optional feature. */ }
    try { regex = await loadRegex(); } catch { /* Green provenance fails closed. */ }
    try { script = await loadScript(); } catch { /* Aggregation needs the public host depth contract. */ }
    try { utils = await loadUtils(); } catch { /* Static regex evidence needs the native parser. */ }
    try { constants = await loadConstants(); } catch { /* Other migration sources remain available. */ }
    try { powerUser = await loadPowerUser(); } catch { /* Examples need only the native text normalizer. */ }
    let nativeWorldInfoCallSites = [];
    let nativeWorldInfoDefaultDepth = null;
    if (typeof regex?.getRegexedString === 'function') {
        try {
            const source = await loadWorldInfoSource();
            nativeWorldInfoCallSites = worldInfoRenderCallSites(source);
            nativeWorldInfoDefaultDepth = worldInfoRenderDefaultDepth(source);
        } catch { /* Unknown assets retain the native build. */ }
    }
    let outletEvidence = null;
    if (!importObservedFrame) {
        try { outletEvidence = installNativeOutletEvidence({ macros: (await loadMacros())?.macros,
            getExtensionPrompts: () => getContext()?.extensionPrompts }); } catch { /* The legacy direct grammar remains available. */ }
    }
    const manager = openAi?.promptManager, Message = openAi?.Message,
        MessageCollection = openAi?.MessageCollection, ChatCompletion = openAi?.ChatCompletion;
    const bus = context?.eventSource, events = context?.eventTypes;
    const supported = typeof manager?.preparePrompt === 'function' && typeof manager?.setChatCompletion === 'function'
        && typeof Message?.fromPromptAsync === 'function' && typeof Message?.createAsync === 'function'
        && typeof MessageCollection === 'function' && typeof ChatCompletion === 'function'
        && ['getChat', 'getMessages', 'setTokenBudget', 'canAfford', 'reserveBudget', 'decreaseTokenBudgetBy', 'squashSystemMessages']
            .every(key => typeof ChatCompletion.prototype?.[key] === 'function')
        && ['getTokens', 'flatten', 'getChat'].every(key => typeof MessageCollection.prototype?.[key] === 'function')
        && typeof bus?.on === 'function' && typeof bus?.removeListener === 'function'
        && typeof events?.CHAT_COMPLETION_PROMPT_READY === 'string' && typeof events?.GENERATION_STARTED === 'string'
        && typeof events?.GENERATION_STOPPED === 'string' && typeof events?.GENERATION_ENDED === 'string'
        && !!context?.extensionSettings && typeof context?.saveSettingsDebounced === 'function';
    const supportsDepthAggregation = typeof manager?.getPromptCollection === 'function'
        && typeof openAi?.setOpenAIMessages === 'function' && typeof script?.getExtensionPromptMaxDepth === 'function'
        && script?.extension_prompt_types?.IN_CHAT === 1
        && ['SYSTEM', 'USER', 'ASSISTANT'].every((key, index) => script?.extension_prompt_roles?.[key] === index);
    let generation = null, ordinal = 0, destroyed = false, last = null, lastScope = null, lastOrdinal = null;
    let promptSources = new WeakMap(), messageSources = new WeakMap(), frames = new WeakMap(), chats = new WeakMap();
    let promptContinuations = new WeakMap(), messageContinuations = new WeakMap();
    const subscriptions = [], restorers = [];
    const sourceListeners = new Set();
    const agentReports = new Map();
    let agentReportOrdinal = 0;
    const settings = () => { try { return getContext()?.extensionSettings?.[MIGRATION_SETTINGS_KEY] ?? {}; } catch { return {}; } };
    const enabled = () => ({ green: settings().green === true, depth: settings().depth === true });
    const notify = () => { if (!destroyed) try { onChange(); } catch {} };
    function scope() {
        try {
            const current = getContext(), identity = completionIdentity(current), chat = current?.getCurrentChatId?.();
            if (current?.mainApi !== 'openai' || !identity || typeof chat !== 'string' || !chat) return null;
            const hostSettings = current.chatCompletionSettings;
            return JSON.stringify([current.groupId ?? null, current.characters?.[current.characterId]?.avatar ?? current.characterId ?? null,
                chat, identity, current.extensionSettings?.connectionManager?.selectedProfile ?? null,
                hostSettings.custom_url ?? null, hostSettings.reverse_proxy ?? null,
                identity.source === 'vertexai' ? [hostSettings.vertexai_region ?? null,
                    hostSettings.vertexai_auth_mode ?? null, hostSettings.vertexai_express_project_id ?? null] : null]);
        } catch { return null; }
    }
    const active = token => !destroyed && supported && openAi.promptManager === manager && generation?.active && generation.scope !== null
        && generation.scope === scope() && (!token || token === generation) && !generation.signal?.aborted;
    function publish(value) {
        if (destroyed) return;
        let requestScope = null;
        try {
            const current = getContext(), identity = completionIdentity(current), chatId = current?.getCurrentChatId?.();
            if (identity && typeof chatId === 'string' && chatId) requestScope = { chatId, ...identity };
        } catch { /* Missing scope cannot establish a request boundary. */ }
        const snapshot = { ...value, generationOrdinal: generation?.ordinal ?? null, requestScope };
        for (const callback of [onSourceSnapshot, ...sourceListeners]) {
            try { callback(structuredClone(snapshot)); } catch { /* Observers never alter generation. */ }
        }
    }
    function clear({ preserveLast = false } = {}) {
        generation?.nativeWorldInfo?.stop();
        generation = null; promptSources = new WeakMap(); messageSources = new WeakMap(); frames = new WeakMap(); chats = new WeakMap();
        promptContinuations = new WeakMap(); messageContinuations = new WeakMap();
        if (!preserveLast) { last = null; lastScope = null; lastOrdinal = null; }
        if (!preserveLast) agentReports.clear();
        try { stability?.setGreenRelocated?.(false); stability?.setSourceRelocated?.(false); } catch {}
    }
    function report(reason, statuses = {}, collections = {}) {
        last = { reason, message: REASONS[reason] ?? '', statuses, collections, scopeDetails: PLUGIN_MIGRATION_SCOPE };
        lastScope = generation?.scope ?? scope(); lastOrdinal = generation?.ordinal ?? ordinal;
        notify();
    }
    function noteFinalUnmigrated(owners, { reason = 'AGENT_PRIVATE_PROMPT_ASSEMBLY_UNAVAILABLE', ordinal: expectedOrdinal } = {}) {
        if (destroyed || !last || lastScope === null || lastScope !== scope()
            || expectedOrdinal !== undefined && expectedOrdinal !== lastOrdinal || !Array.isArray(owners)) return false;
        const retained = owners.filter(owner => Object.hasOwn(MACROS, owner) && last.collections?.[owner]?.count > 0);
        if (!retained.length) return false;
        const statuses = { ...last.statuses }, collections = structuredClone(last.collections);
        for (const owner of retained) {
            statuses[owner] = 'provenance-unavailable';
            collections[owner] = { count: 0, groups: 0, preFinalCount: collections[owner].count, finalUnmigrated: true };
        }
        try {
            stability?.setGreenRelocated?.(collections.green?.count > 0);
            stability?.setSourceRelocated?.(Boolean(collections.green?.count || collections.depth?.count));
        } catch {}
        report(Object.hasOwn(REASONS, reason) ? reason : 'FINAL_PROMPT_ASSEMBLY_UNMIGRATED', statuses, collections);
        return true;
    }
    function sameBudget(frame) {
        const current = manager?.serviceSettings;
        if (privateContextKind === 'session' && frame.contextSize === Infinity && frame.responseSize === 0) {
            return current?.openai_max_context === frame.configuredContextSize && current?.openai_max_tokens === frame.configuredResponseSize
                && (current.squash_system_messages === true) === frame.configuredSquash;
        }
        return current?.openai_max_context === frame.contextSize && current.openai_max_tokens === frame.responseSize
            && (current.squash_system_messages === true) === frame.configuredSquash;
    }
    function protectedMessages(frame) {
        const captured = frame.leaves.filter(({ message }) => !plainSourceMessage(message))
            .flatMap(({ message }) => new MessageCollection('proof', message).getChat());
        const keys = new Set(captured.map(payload => JSON.stringify(payload)));
        return frame.originalChat.filter(payload => !plainPayload(payload) || keys.has(JSON.stringify(payload)));
    }
    function plainSourceMessage(message) {
        return plainMessage(message) && new MessageCollection('proof', message).getChat().every(plainPayload);
    }
    function protectsPayloads(chat, protectedPayloads) {
        // Equal protected payloads may legitimately occur more than once. The
        // complete ordered list verifies their count, order and exact content.
        const keys = new Set(protectedPayloads.map(payload => JSON.stringify(payload)));
        return same(chat.filter(message => !plainPayload(message) || keys.has(JSON.stringify(message))), protectedPayloads);
    }
    function listen(name, callback, lastListener = false) {
        if (typeof name !== 'string') return;
        subscriptions.push([name, callback]);
        if (lastListener && typeof bus.makeLast === 'function') bus.makeLast(name, callback);
        else bus.on(name, callback);
    }
    function wrap(object, key, makeWrapper) {
        const original = object[key], descriptor = Object.getOwnPropertyDescriptor(object, key), wrapper = makeWrapper(original);
        restorers.push(() => {
            if (object[key] !== wrapper) return;
            if (descriptor) Object.defineProperty(object, key, descriptor);
            else delete object[key];
        });
        object[key] = wrapper;
        if (object[key] !== wrapper) throw new TypeError('无法观察公开的提示词接口');
    }
    function coreSnapshot(chat) {
        if (!Array.isArray(chat) || chat.length > MAX_MESSAGES) throw new TypeError('无法识别对话来源');
        const field = (object, key) => {
            const descriptor = object && Object.getOwnPropertyDescriptor(object, key);
            if (!descriptor) { if (object && key in object) throw new TypeError('对话来源使用了继承属性'); return undefined; }
            if (!('value' in descriptor)) throw new TypeError('无法识别对话读取接口');
            return descriptor.value;
        };
        const clones = new WeakMap();
        let objects = 0;
        const copy = (value, depth = 0) => {
            if (!value || typeof value !== 'object') {
                if (typeof value === 'function' || typeof value === 'symbol') throw new TypeError('无法识别对话内容');
                return value;
            }
            if (depth > 32 || ++objects > MAX_MESSAGES * 32) throw new RangeError('Source limit');
            if (clones.has(value)) return clones.get(value);
            const result = Array.isArray(value) ? [] : {};
            clones.set(value, result);
            for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
                if (!descriptor.enumerable) continue;
                if (!('value' in descriptor)) throw new TypeError('无法识别对话读取接口');
                Object.defineProperty(result, key, { value: copy(descriptor.value, depth + 1), enumerable: true, configurable: true, writable: true });
            }
            return result;
        };
        const ignored = [], messages = chat.map(message => {
            if (!message || typeof message !== 'object') throw new TypeError('无法识别对话来源');
            const result = {};
            for (const key of ['mes', 'name', 'is_user', 'is_system', 'role', 'tool_calls', 'tool_call_id', 'force_avatar']) result[key] = copy(field(message, key));
            const extra = field(message, 'extra');
            if (extra != null) {
                if (typeof extra !== 'object') throw new TypeError('无法识别对话来源');
                result.extra = {};
                for (const key of ['type', 'media', 'media_display', 'media_index', 'tool_invocations', 'api', 'model', 'reasoning_signature', 'reasoning',
                    'native', 'tool_reasoning_content', 'provider_replay']) {
                    result.extra[key] = copy(field(extra, key));
                }
            }
            ignored.push(Boolean(extra && field(extra, Symbol.for('ignore'))));
            return result;
        });
        if (bytes(messages.map(message => message?.mes)) > MAX_TEXT_BYTES) throw new RangeError('Source limit');
        messages.forEach((message, index) => {
            if (!message || typeof message.mes !== 'string') throw new TypeError('无法识别对话来源');
            if (ignored[index]) { message.extra ??= {}; message.extra[Symbol.for('ignore')] = true; }
        });
        return { messages, ignored };
    }
    function captureCoreSeed(token) {
        if (!supportsDepthAggregation || !token.coreChat || token.coreSeed && token.historySeed) return;
        try {
            const seed = coreSnapshot(token.coreChat), history = openAi.setOpenAIMessages(seed.messages);
            if (!Array.isArray(history) || !Array.from(history).every(message => message && (message.content == null || typeof message.content === 'string')
                && ['system', 'user', 'assistant'].includes(message.role))) throw new TypeError('无法识别格式化后的对话');
            token.coreSeed = seed; token.historySeed = history;
        } catch { token.coreSeed = null; token.historySeed = null; }
    }
    function captureWorldInfoTemplate(token, identifier, templateText) {
        const position = identifier === 'worldInfoBefore' ? 0 : identifier === 'worldInfoAfter' ? 1 : null;
        if (position === null || typeof templateText !== 'string' || !token.worldInfo) return;
        const expected = token.worldInfo.records.filter(entry => entry.position === position && entry.text).reverse().map(entry => entry.text).join('\n');
        const format = manager.serviceSettings?.wi_format;
        let formatted;
        try {
            if (typeof openAi.formatWorldInfo === 'function') formatted = openAi.formatWorldInfo(expected);
            else if (typeof format === 'string' && !format.trim() || format === '{0}') formatted = expected;
            else if (typeof format === 'string' && typeof utils?.stringFormat === 'function') formatted = utils.stringFormat(format, expected);
            if (templateText === formatted) { token.worldInfoText ??= {}; token.worldInfoText[identifier] = expected; }
        } catch { /* Only a matching native template establishes provenance. */ }
    }
    function extensionSnapshot() {
        const prompts = getContext()?.extensionPrompts;
        if (!prompts || typeof prompts !== 'object') throw new TypeError('无法识别扩展提示词来源');
        const records = [], references = [];
        for (const [id, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(prompts)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
            if (!descriptor.enumerable) continue;
            if (!('value' in descriptor)) throw new TypeError('无法识别扩展提示词读取接口');
            const entry = descriptor.value;
            if (!entry || typeof entry !== 'object') throw new TypeError('无法识别扩展提示词来源');
            const fields = Object.getOwnPropertyDescriptors(entry);
            if (['value', 'position', 'depth', 'role', 'filter'].some(key => fields[key] && !('value' in fields[key]))) throw new TypeError('无法识别扩展提示词读取接口');
            if (['value', 'position', 'depth', 'role', 'filter'].some(key => !fields[key] && key in entry)) throw new TypeError('无法识别继承的扩展提示词来源');
            if (!fields.position || !fields.value) throw new TypeError('扩展提示词来源不完整');
            const position = fields.position?.value, value = fields.value?.value;
            if (typeof position !== 'number') throw new TypeError('无法识别扩展提示词位置');
            if (position !== 1 || !value) continue;
            if (typeof value !== 'string' || fields.filter?.value != null && typeof fields.filter.value === 'function') throw new TypeError('未记录扩展提示词筛选过程');
            const depth = fields.depth?.value, role = fields.role?.value;
            if (depth === undefined || role === undefined) throw new TypeError('通配符注入范围未明确');
            if (typeof depth !== 'number' || typeof role !== 'number') throw new TypeError('无法识别扩展提示词的插入位置');
            records.push({ id, text: value, depth, role }); references.push(entry);
        }
        if (records.length > MAX_MESSAGES || bytes(records) > MAX_WI_BYTES) throw new RangeError('Source limit');
        return { records, references };
    }
    function collectionSnapshot(collection, token) {
        if (!Array.isArray(collection?.collection) || collection.collection.length > MAX_MESSAGES) throw new TypeError('无法识别提示词集合');
        const records = collection.collection.map(prompt => {
            const source = promptSources.get(prompt);
            const fields = Object.getOwnPropertyDescriptors(prompt);
            const values = {};
            for (const key of ['identifier', 'content', 'role', 'position', 'extension', 'injection_position', 'injection_depth', 'injection_order']) {
                const descriptor = fields[key];
                if (descriptor && !('value' in descriptor)) throw new TypeError('无法识别提示词读取接口');
                const value = descriptor?.value;
                if (value != null && !['string', 'boolean', 'number'].includes(typeof value)) throw new TypeError('无法识别提示词插入位置');
                values[key] = value;
            }
            if (!source || source.token !== token || source.text !== values.content || source.role !== values.role) throw new TypeError('未记录提示词来源');
            return { identifier: values.identifier, text: values.content, role: values.role,
                position: values.position, extension: values.extension === true,
                injection_position: values.injection_position, injection_depth: values.injection_depth,
                injection_order: values.injection_order, name: source.name, templateText: source.templateText };
        });
        return { records, references: [...collection.collection] };
    }
    function sameReferences(left, right) { return left.length === right.length && left.every((item, index) => item === right[index]); }
    function prepareDepthGraph(token) {
        if (!supportsDepthAggregation || !token.coreSeed || !token.historySeed || !token.promptCollection || token.collectionConflict) throw new TypeError('缺少原生提示词来源关系');
        const maximum = script.getExtensionPromptMaxDepth();
        if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 10000) throw new TypeError('无法确认提示词注入深度规则');
        const collection = collectionSnapshot(token.promptCollection, token), extensions = extensionSnapshot();
        if (!token.extensionSeed || !same(extensions.records, token.extensionSeed.records)
            || !sameReferences(extensions.references, token.extensionSeed.references)
            || !same(coreSnapshot(token.coreChat), token.coreSeed)) throw new TypeError('提示词来源关系已变化');
        const knownExtensions = new Map([['1_memory', 'summary'], ['2_floating_prompt', 'authorsNote'],
            ['3_vectors', 'vectorsMemory'], ['4_vectors_data_bank', 'vectorsDataBank'], ['chromadb', 'smartContext']]);
        const extensionValues = extensions.records.map(entry => {
            const source = collection.records.find(prompt => prompt.identifier === knownExtensions.get(entry.id)
                && prompt.templateText === entry.text);
            // Known extension prompts were already expanded by the native
            // preparePrompt call. Reuse that observed result only when the
            // complete later aggregate template agrees; never rerun the macro.
            return { ...entry, rendered: source && /\{\{|<(?:USER|BOT|CHAR|GROUP|CHARIFNOTGROUP)>/iu.test(entry.text) ? source.text : entry.text };
        });
        const absolute = collection.records.filter(prompt => prompt.injection_position === 1).map(prompt => ({ ...prompt }));
        // Native relative extension prompts follow an absolute main prompt into
        // its depth/order bucket. These are copies of already prepared objects.
        const relative = ['summary', 'authorsNote', 'vectorsMemory', 'vectorsDataBank', 'smartContext']
            .map(id => collection.records.find(prompt => prompt.identifier === id)).filter(Boolean);
        relative.push(...collection.records.filter(prompt => prompt.extension && prompt.position));
        for (const prompt of relative) {
            if (!prompt.position) continue;
            const mainIndex = absolute.findIndex(candidate => candidate.identifier === 'main');
            if (mainIndex < 0) continue;
            const main = absolute[mainIndex];
            absolute.splice(prompt.position === 'end' ? mainIndex + 1 : mainIndex, 0, { ...prompt, role: main.role,
                injection_depth: main.injection_depth, injection_order: main.injection_order });
        }
        const groups = [];
        const depths = [...new Set([...absolute.filter(prompt => prompt.text).map(prompt => prompt.injection_depth),
            ...extensions.records.map(prompt => prompt.depth)])].filter(depth => Number.isSafeInteger(depth) && depth >= 0 && depth <= maximum).sort((a, b) => a - b);
        for (const depth of depths) {
            const bucket = new Map([['100', []]]);
            for (const prompt of absolute.filter(prompt => prompt.injection_depth === depth && prompt.text)) {
                const priority = prompt.injection_order ?? 100;
                if (!Number.isFinite(priority)) throw new TypeError('无法识别提示词注入优先级');
                const order = String(priority), values = bucket.get(order) ?? [];
                values.push(prompt); bucket.set(order, values);
            }
            for (const order of [...bucket.keys()].sort((a, b) => Number(b) - Number(a))) {
                for (const [roleId, role] of ['system', 'user', 'assistant'].entries()) {
                    const prompts = bucket.get(order).filter(prompt => prompt.role === role);
                    const entries = order === '100' ? extensionValues.filter(prompt => prompt.depth === depth && prompt.role === roleId) : [];
                    const promptText = prompts.map(prompt => prompt.text).join('\n');
                    const extensionText = entries.map(prompt => prompt.rendered.trim()).join('\n');
                    const text = [promptText, extensionText].filter(Boolean).map(value => value.trim()).join('\n');
                    if (!text) continue;
                    groups.push({ depth, priority: Number(order), role, text,
                        inputs: [...prompts.map(prompt => ({ id: prompt.identifier, label: prompt.name || prompt.identifier, kind: 'prompt' })),
                            ...entries.map(prompt => ({ id: prompt.id, label: prompt.id, kind: 'extension-prompt' }))] });
                }
            }
        }
        if (groups.length > MAX_MESSAGES || bytes(groups) > MAX_WI_BYTES) throw new RangeError('Source limit');
        const graph = token.historySeed.map(input => ({ input }));
        if (token.type === 'continue' && manager.serviceSettings.continue_prefill === true) graph.shift();
        let inserted = 0;
        for (const depth of depths) {
            const values = groups.filter(group => group.depth === depth).map(group => ({ group, input: { role: group.role, content: group.text } }));
            graph.splice(depth + inserted, 0, ...values); inserted += values.length;
        }
        if (token.type === 'continue' && manager.serviceSettings.continue_prefill !== true && token.continuationReserved) {
            const index = graph.findIndex(entry => !entry.group);
            if (index < 0) throw new TypeError('缺少移位的续写内容');
            graph.splice(index, 1);
        }
        if (graph.length > MAX_MESSAGES) throw new RangeError('Source limit');
        return { graph, next: graph.length, failed: false, collection, extensions };
    }
    function observeHistoryInput(input, token) {
        const fields = Object.getOwnPropertyDescriptors(input ?? {}), identifier = fields.identifier?.value;
        if (typeof identifier !== 'string' || !/^chatHistory-\d+$/u.test(identifier)) return null;
        try {
            if (['role', 'name', 'content'].some(key => fields[key] && !('value' in fields[key]))) throw new TypeError('无法识别历史消息读取接口');
            token.depthGraph ??= prepareDepthGraph(token);
            const proof = token.depthGraph, number = Number(identifier.slice('chatHistory-'.length));
            const entry = proof.graph[proof.graph.length - number];
            if (!entry || number !== proof.next-- || fields.role?.value !== entry.input.role
                || fields.name?.value !== entry.input.name || fields.content?.value !== entry.input.content) {
                proof.failed = true; return null;
            }
            return entry.group ?? null;
        } catch { token.depthGraphFailed = true; return null; }
    }
    function depthGraphMatches(token) {
        const proof = token.depthGraph;
        if (!proof || proof.failed || token.depthGraphFailed || token.collectionConflict) return false;
        try {
            const collection = collectionSnapshot(token.promptCollection, token), extensions = extensionSnapshot();
            return same(coreSnapshot(token.coreChat), token.coreSeed)
                && same(collection.records, proof.collection.records) && sameReferences(collection.references, proof.collection.references)
                && same(extensions.records, proof.extensions.records) && sameReferences(extensions.references, proof.extensions.references);
        } catch { return false; }
    }
    function observedDepthSources(token) {
        if (!supportsDepthAggregation || !token.coreSeed || !token.historySeed || !token.promptCollection || token.collectionConflict) return null;
        try {
            if (!same(coreSnapshot(token.coreChat), token.coreSeed)) return null;
            const observed = token.historyObserved ?? [], raw = [...token.historySeed];
            if (token.type === 'continue' && (manager.serviceSettings.continue_prefill === true || token.continuationReserved)) raw.shift();
            const total = Number(observed[0]?.identifier.slice('chatHistory-'.length)), injected = total - raw.length;
            if (!Number.isSafeInteger(total) || injected < 0 || injected > MAX_MESSAGES || observed.length > total
                || observed.some((value, index) => value.identifier !== 'chatHistory-' + (total - index))) return null;
            let states = new Map([[0, []]]), work = 0;
            for (let index = 0; index < observed.length; index++) {
                const input = observed[index].historyInput, next = new Map();
                const add = (count, marks, kind) => {
                    const path = [...marks, kind], previous = next.get(count);
                    if (previous) path.forEach((value, item) => { previous[item] |= value; });
                    else next.set(count, path);
                };
                for (const [count, marks] of states) {
                    if (++work > 65536) return null;
                    const original = raw[count];
                    if (original && input.role === original.role && input.name === original.name && input.content === original.content) add(count + 1, marks, 1);
                    if (index - count < injected && input.name == null && typeof input.content === 'string' && input.content.length
                        && ['system', 'user', 'assistant'].includes(input.role)) add(count, marks, 2);
                }
                states = next;
                if (!states.size || states.size > 128) return null;
            }
            const marks = Array(observed.length).fill(0);
            for (const path of states.values()) path.forEach((value, index) => { marks[index] |= value; });
            const sources = new Map();
            observed.forEach((source, index) => {
                if (marks[index] === 2) sources.set(source.identifier, { role: source.role, depth: null, priority: null,
                    inputs: [], observed: true });
            });
            return { sources, ambiguous: marks.some(value => value === 3) };
        } catch { return null; }
    }
    function resolveDepthSources(frame) {
        const token = frame.token;
        if (privateContextKind === 'session' && token.sessionCanonicalHistory) {
            // Session history is carried by Message.fromAgentMessage and never
            // prepared as a text chatHistory prompt. These observed plain
            // prompts are the native injection groups, even when a canonical
            // tool group advances sourceCount by more than one.
            for (const { message, source } of frame.leaves) {
                if (!source?.historyInput || !plainSourceMessage(message) || source.name != null) continue;
                source.depthGroup = { role: message.role, depth: null, priority: null, inputs: [], observed: true };
            }
            return true;
        }
        if (depthGraphMatches(token)) return true;
        const observed = observedDepthSources(token);
        if (!observed) return false;
        for (const { source } of frame.leaves) {
            if (!source?.historyInput) continue;
            const group = observed.sources.get(source.identifier);
            source.depthGroup = group ?? null;
            if (group) source.label = '原生 @D 聚合（已展开）';
        }
        return !observed.ambiguous;
    }
    function prepareExampleBlocks(text) {
        if (typeof text !== 'string' || typeof openAi.setOpenAIMessageExamples !== 'function') return null;
        const current = getContext(), power = current?.powerUserSettings ?? powerUser?.power_user;
        let value = text.replace(/\{\{(?:user|char)\}\}|<(?:USER|BOT|CHAR)>/giu, match => {
            const name = /user/iu.test(match) ? current?.name1 : current?.name2;
            return typeof name === 'string' ? name : match;
        });
        if (/\{\{|<(?:USER|BOT|CHAR|GROUP|CHARIFNOTGROUP)>/iu.test(value)) return null;
        if (power?.collapse_newlines) {
            const collapse = powerUser?.collapseNewlines ?? utils?.collapseNewlines;
            if (typeof collapse !== 'function') return null;
            value = collapse(value);
        }
        value = value.replace(/\r/gu, '');
        if (!value || value === '<START>') return [];
        if (!value.startsWith('<START>')) value = '<START>\n' + value.trim();
        const blocks = value.split(/<START>/giu).slice(1).map(block => '<START>\n' + block.trim() + '\n');
        const result = openAi.setOpenAIMessageExamples(blocks);
        return Array.isArray(result) ? result : null;
    }
    function exampleMoves(frame, token) {
        const wi = token.worldInfo;
        const missing = () => ({ moves: [], unconfirmed: true });
        if (!wi || !worldInfoRenderingMatches(wi.rendering, { regex, context: getContext() }) || !frame.wireIndices) return missing();
        const top = [], bottom = [];
        let topKnown = true, bottomKnown = true;
        for (const entry of wi.records.filter(entry => entry.position === 5 && entry.text)) {
            const blocks = prepareExampleBlocks(entry.text);
            if (!blocks) { topKnown = false; break; }
            top.push(...blocks.map(messages => ({ entry, messages })));
        }
        for (const entry of [...wi.records].reverse().filter(entry => entry.position === 6 && entry.text)) {
            const blocks = prepareExampleBlocks(entry.text);
            if (!blocks) { bottomKnown = false; break; }
            bottom.push(...blocks.map(messages => ({ entry, messages })));
        }
        const current = getContext(), character = current?.characters?.[current.characterId];
        const fields = character && Object.getOwnPropertyDescriptors(character);
        const data = fields?.data?.value, raw = fields?.mes_example?.value ?? (data && Object.getOwnPropertyDescriptor(data, 'mes_example')?.value);
        const charBlocks = current?.groupId == null && typeof raw === 'string' ? prepareExampleBlocks(raw) : null;
        const expected = topKnown && charBlocks ? [...top, ...charBlocks.map(messages => ({ entry: null, messages })), ...(bottomKnown ? bottom : [])] : top;
        const blocks = new Map();
        for (const { message } of frame.leaves) {
            const match = /^dialogueExamples (\d+)-(\d+)$/u.exec(message.identifier ?? '');
            if (!match) continue;
            const index = Number(match[1]), position = Number(match[2]), block = blocks.get(index) ?? { nodes: [], index };
            block.nodes[position] = message; blocks.set(index, block);
        }
        const moves = [];
        let unconfirmed = wi.records.some(entry => !entry.constant && entry.text
            && (entry.position === 5 && !topKnown || entry.position === 6 && (!topKnown || !charBlocks || !bottomKnown)));
        for (const [index, block] of blocks) {
            const source = expected[index];
            if (!source) continue;
            if (block.nodes.length !== source.messages.length || block.nodes.some(message => !message)) return missing();
            const projected = block.nodes.map(message => ({ role: message.role, content: message.content, name: message.name }));
            if (!same(projected, source.messages)) return missing();
            if (!source.entry || source.entry.constant) continue;
            const first = block.nodes[0], previous = frame.leaves[frame.leaves.findIndex(leaf => leaf.message === first) - 1]?.message;
            if (previous?.identifier !== 'newChat' || !plainSourceMessage(previous)) { unconfirmed = true; continue; }
            const nodes = [previous, ...block.nodes];
            if (nodes.some(message => {
                const chat = new MessageCollection('proof', message).getChat();
                return !frame.wireIndices.has(message) || chat.length !== 1 || message.native || message.agentMessage || message.signature || message.reasoning || message.tool_calls
                    || chat.some(payload => Object.entries(Object.getOwnPropertyDescriptors(payload)).some(([key, descriptor]) => descriptor.enumerable
                        && (!('value' in descriptor) || descriptor.value !== undefined && !['role', 'content', 'name'].includes(key))));
            })) { unconfirmed = true; continue; }
            if (nodes.some((message, position) => frame.wireIndices.get(message) !== frame.wireIndices.get(previous) + position)) { unconfirmed = true; continue; }
            moves.push({ ...block, nodes, entry: source.entry });
        }
        return { moves, unconfirmed };
    }
    function findParent(collection, message) {
        const index = collection.collection.indexOf(message);
        if (index >= 0) return { collection, index };
        for (const item of collection.collection) if (item instanceof MessageCollection) { const result = findParent(item, message); if (result) return result; }
        return null;
    }
    function structuredProjection(frame, plan, moves, protectedPayloads) {
        const anchor = plan.anchors.green?.slot;
        if (!anchor || !frame.wireIndices?.has(anchor.message) || !findParent(frame.root, anchor.message)) throw new TypeError('无法识别示例对话定位标记');
        const value = plan.output.get(anchor), pieces = typeof value === 'string' ? value.split(MACROS.green) : [];
        if (pieces.length !== 2) throw new TypeError('无法识别示例对话的定位范围');
        const head = pieces[0] + plan.collections.green.body, tail = pieces[1], anchorIndex = frame.wireIndices.get(anchor.message);
        const moving = new Set(), moved = [];
        for (const move of moves) for (const node of move.nodes) {
            const index = frame.wireIndices.get(node);
            if (!Number.isSafeInteger(index) || moving.has(index) || index === anchorIndex || !findParent(frame.root, node)) throw new TypeError('无法识别示例对话来源');
            moving.add(index); moved.push(structuredClone(frame.originalChat[index]));
        }
        const outputs = new Map();
        for (const [slot, output] of plan.output) {
            const index = frame.wireIndices.get(slot.message);
            if (!Number.isSafeInteger(index)) throw new TypeError('无法识别来源位置');
            outputs.set(index, output);
        }
        // Project independently from captured wire payloads and planned ranges;
        // rebuilding the object tree cannot supply its own expected result.
        const desiredChat = [];
        frame.originalChat.forEach((payload, index) => {
            if (moving.has(index)) return;
            if (index === anchorIndex) {
                if (head) desiredChat.push({ role: payload.role, content: head });
                desiredChat.push(...structuredClone(moved));
                if (tail) desiredChat.push({ role: payload.role, content: tail });
            } else if (outputs.has(index)) {
                const content = outputs.get(index);
                if (content) desiredChat.push({ ...structuredClone(payload), content });
            } else desiredChat.push(structuredClone(payload));
        });
        const keys = new Set([...protectedPayloads, ...moved].map(payload => JSON.stringify(payload)));
        const desiredProtected = desiredChat.filter(payload => !plainPayload(payload) || keys.has(JSON.stringify(payload)));
        setMigrationExpectedCounts(plan, desiredChat, moved.flatMap(payload => textParts([payload])));
        return { anchor, head, tail, desiredChat, desiredProtected };
    }
    async function countedText(message, value) {
        const counted = privateContextKind
            ? await Message.createAsync(message.role, value, message.identifier, manager.tokenHandler)
            : await Message.createAsync(message.role, value, message.identifier);
        if (counted?.role !== message.role || counted.content !== value || !plainSourceMessage(counted)
            || !Number.isFinite(counted.tokens) || counted.tokens < 0) throw new TypeError('token 计数未经验证');
        return counted;
    }
    async function insertExampleMoves(frame, projection, moves) {
        const { anchor, head, tail } = projection, nodes = [];
        if (head) {
            const counted = await countedText(anchor.message, head);
            anchor.message.content = head; anchor.message.tokens = counted.tokens; nodes.push(anchor.message);
        } else { anchor.message.content = ''; anchor.message.tokens = 0; }
        for (const move of moves) for (const node of move.nodes) {
            const parent = findParent(frame.root, node);
            if (!parent) throw new TypeError('缺少示例对话来源');
            parent.collection.collection.splice(parent.index, 1); nodes.push(node);
        }
        if (tail) nodes.push(await countedText(anchor.message, tail));
        const parent = findParent(frame.root, anchor.message);
        if (!parent) throw new TypeError('缺少示例对话定位标记');
        parent.collection.collection.splice(parent.index, 1, ...nodes);
    }
    function captureOutlets(templateText, token) {
        if (typeof templateText !== 'string' || typeof constants?.inject_ids?.CUSTOM_WI_OUTLET !== 'function') return [];
        const wi = token.worldInfo;
        if (!wi) return [];
        const rendered = worldInfoRenderingMatches(wi.rendering, { regex, context: getContext() });
        const matches = [];
        for (const match of templateText.matchAll(/\{\{outlet::(.+?)\}\}/giu)) {
            if (matches.length >= MAX_MESSAGES) return [];
            matches.push(match);
        }
        const direct = [], nestedKeys = new Set();
        const delimiters = /\{\{|\}\}/gu;
        let delimiter = delimiters.exec(templateText), nesting = 0;
        for (const match of matches) {
            while (delimiter && delimiter.index < match.index) {
                nesting = delimiter[0] === '{{' ? nesting + 1 : Math.max(0, nesting - 1);
                delimiter = delimiters.exec(templateText);
            }
            if (nesting) nestedKeys.add(match[1].trim()); else direct.push(match);
        }
        const proofs = [];
        for (const match of direct) {
            const key = match[1].trim();
            if (!key || key.length > 256 || /[{}]/u.test(key) || nestedKeys.has(key) || proofs.some(proof => proof.key === key)) continue;
            // A nested macro can consume or indirectly reproduce the outlet.
            // Only a direct top-level outlet occurrence establishes a range.
            const records = wi.records.filter(entry => entry.position === 7 && entry.outletName === key && entry.text);
            if (!records.length || !rendered && records.some(entry => entry.constant)) continue;
            const id = constants.inject_ids.CUSTOM_WI_OUTLET(key);
            if (typeof id !== 'string' || !id) continue;
            const descriptor = Object.getOwnPropertyDescriptor(getContext()?.extensionPrompts ?? {}, id);
            if (!descriptor || !('value' in descriptor) || !descriptor.value || typeof descriptor.value !== 'object') continue;
            const fields = Object.getOwnPropertyDescriptors(descriptor.value);
            const expected = rendered ? records.map(entry => entry.text).join('\n') : fields.value?.value;
            if (typeof expected !== 'string' || !expected || bytes(expected) > MAX_WI_BYTES) continue;
            if (!fields.value || !('value' in fields.value) || fields.value.value !== expected
                || !fields.position || !('value' in fields.position) || fields.position.value !== -1
                || fields.filter && (!('value' in fields.filter) || typeof fields.filter.value === 'function')
                || !fields.filter && 'filter' in descriptor.value) continue;
            proofs.push({ id, key, expected, records, reference: descriptor.value, aggregate: !rendered,
                count: direct.filter(other => other[1].trim() === key).length });
        }
        return proofs;
    }
    function verifiedNativeOutlets(source, content, token) {
        if (!Array.isArray(source?.nativeOutlets) || source.text !== content || !token.worldInfo
            || !worldInfoRenderingMatches(token.worldInfo.rendering, { regex, context: getContext() })) return [];
        const result = [];
        for (const proof of source.nativeOutlets) {
            if (proof.nativeObserved !== true || !Array.isArray(proof.records) || !Array.isArray(proof.segments)) continue;
            const descriptor = Object.getOwnPropertyDescriptor(getContext()?.extensionPrompts ?? {}, proof.id);
            if (!descriptor || !('value' in descriptor) || descriptor.value !== proof.reference) continue;
            const fields = Object.getOwnPropertyDescriptors(proof.reference);
            if (!fields.value || !('value' in fields.value) || fields.value.value !== proof.expected
                || fields.position?.value !== -1 || fields.filter && (!('value' in fields.filter) || typeof fields.filter.value === 'function')
                || !fields.filter && 'filter' in proof.reference) continue;
            if (!Number.isSafeInteger(proof.start) || !Number.isSafeInteger(proof.end)
                || proof.start < 0 || proof.end > content.length || proof.end <= proof.start) continue;
            let cursor = proof.start, valid = true;
            for (const segment of proof.segments) {
                if (!Number.isSafeInteger(segment.start) || !Number.isSafeInteger(segment.end)
                    || segment.start < cursor || segment.end > proof.end || segment.end <= segment.start
                    || content.slice(segment.start, segment.end) !== segment.text
                    || !token.worldInfo.records.includes(segment.entry)
                    || (segment.entry.constant ? null : 'green') !== segment.owner) { valid = false; break; }
                cursor = segment.end;
            }
            if (valid && !result.some(other => proof.start < other.end && proof.end > other.start)) result.push(proof);
        }
        return result;
    }
    function verifiedOutlets(source, content, token) {
        const wi = token.worldInfo;
        const result = typeof content === 'string' ? verifiedNativeOutlets(source, content, token) : [];
        if (!source?.outlets?.length || typeof content !== 'string' || !wi) return result;
        const rendered = worldInfoRenderingMatches(wi.rendering, { regex, context: getContext() });
        const template = source.templateText;
        const replacements = new Map(source.outlets.map(proof => [proof.key, proof]));
        const offsets = new Map();
        let reconstructed = '', last = 0;
        if (typeof template === 'string') {
            for (const match of template.matchAll(/\{\{outlet::(.+?)\}\}/giu)) {
                reconstructed += template.slice(last, match.index);
                const key = match[1].trim(), proof = replacements.get(key);
                if (proof) {
                    const values = offsets.get(key) ?? []; values.push(reconstructed.length); offsets.set(key, values);
                    reconstructed += proof.expected;
                } else reconstructed += match[0];
                if (reconstructed.length > MAX_TEXT_BYTES) return result;
                last = match.index + match[0].length;
            }
            reconstructed += template.slice(last);
        }
        for (const proof of source.outlets) {
            if (!proof.aggregate && !rendered || proof.aggregate && proof.records.some(entry => entry.constant)) continue;
            const descriptor = Object.getOwnPropertyDescriptor(getContext()?.extensionPrompts ?? {}, proof.id);
            if (!descriptor || !('value' in descriptor) || descriptor.value !== proof.reference) continue;
            const fields = Object.getOwnPropertyDescriptors(proof.reference);
            if (!fields.value || !('value' in fields.value) || fields.value.value !== proof.expected
                || !fields.position || !('value' in fields.position) || fields.position.value !== -1
                || fields.filter && (!('value' in fields.filter) || typeof fields.filter.value === 'function')
                || !fields.filter && 'filter' in proof.reference) continue;
            const hits = reconstructed === content ? (offsets.get(proof.key) ?? []).map(index => ({ index }))
                : proof.count === 1 ? occurrences([content], proof.expected, 2) : [];
            if (hits.length !== proof.count) continue;
            for (const hit of hits) {
                if (result.some(native => native.nativeObserved && hit.index < native.end && hit.index + proof.expected.length > native.start)) continue;
                if (proof.aggregate) {
                    result.push({ ...proof, segments: [{ start: hit.index, end: hit.index + proof.expected.length,
                        text: proof.expected, owner: 'green', group: 'native:outlet:' + proof.key,
                        entries: proof.records, preserveWhitespace: true }] });
                    continue;
                }
                let offset = hit.index;
                result.push({ ...proof, segments: proof.records.map(entry => {
                    const segment = { start: offset, end: offset + entry.text.length, text: entry.text,
                        owner: entry.constant ? null : 'green', group: wiGroup(entry), entry };
                    offset += entry.text.length + 1; return segment;
                }) });
            }
        }
        return result;
    }
    function captureWorldInfo(args) {
        if (!active() || !isFinalWorldInfoScan(args) || !(args.activated?.entries instanceof Map)) return;
        try {
            generation.nativeWorldInfo?.stop();
            const values = [...args.activated.entries.values()];
            if (values.length > MAX_MESSAGES) throw new RangeError('Source limit');
            const records = values.map(entry => {
                if (!entry || typeof entry.content !== 'string' || typeof entry.world !== 'string' || !Number.isSafeInteger(entry.uid)) throw new TypeError('无法识别来源');
                return { world: entry.world, uid: entry.uid, order: entry.order, position: entry.position,
                    depth: entry.depth, role: entry.role, outletName: entry.outletName,
                    constant: Boolean(entry.constant), text: entry.content };
            }).sort((left, right) => right.order - left.order);
            if (bytes(records) > MAX_WI_BYTES) throw new RangeError('Source limit');
            const rendering = captureWorldInfoRendering({ records, regex, context: getContext(), parseRegex: utils?.regexFromString });
            generation.worldInfo = { records: rendering.records ?? records, rendering };
            if (rendering.reason === 'WI_REGEX_DYNAMIC') {
                const token = generation;
                token.nativeWorldInfo = preserveNativeWorldInfoRendering({ entries: values, records, regex, getContext,
                    renderCallSites: nativeWorldInfoCallSites, defaultDepth: nativeWorldInfoDefaultDepth, isActive: () => active(token),
                    onRendered(nativeRecords) {
                        if (!active(token)) return;
                        const accepted = acceptNativeWorldInfoRendering(rendering, nativeRecords, { regex, context: getContext() });
                        if (accepted) token.worldInfo = { records: accepted.records, rendering: accepted };
                    } });
            }
        } catch { generation.worldInfo = null; }
    }
    function cloneCompletion(completion) {
        let count = 0;
        const leaves = [], ancestors = new WeakSet();
        const cloneNode = node => {
            if (!node || ++count > MAX_MESSAGES * 2) throw new TypeError('无法识别提示词来源关系');
            if (node instanceof MessageCollection) {
                if (ancestors.has(node)) throw new TypeError('提示词来源关系存在循环');
                ancestors.add(node);
                const collection = new MessageCollection(node.identifier);
                try { collection.collection = node.collection.map(cloneNode); }
                finally { ancestors.delete(node); }
                return collection;
            }
            if (!(node instanceof Message)) throw new TypeError('无法识别来源对象');
            const cloned = Object.create(Message.prototype);
            for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(node))) {
                if (!('value' in descriptor)) throw new TypeError('无法识别来源读取接口');
                Object.defineProperty(cloned, key, { ...descriptor, value: structuredClone(descriptor.value) });
            }
            if (!Number.isFinite(cloned.tokens) || cloned.tokens < 0) throw new TypeError('无法确认 token 计数');
            leaves.push({ message: cloned, source: messageSources.get(node) ?? null });
            return cloned;
        };
        const root = cloneNode(completion.getMessages());
        if (leaves.length > MAX_MESSAGES || bytes(leaves.map(value => value.message.content)) > MAX_TEXT_BYTES) throw new RangeError('Source limit');
        return { root, leaves };
    }
    function captureCompletionFrame(completion, budget = null) {
        if (!active() || manager.error || !(completion instanceof ChatCompletion)) return null;
        const cloned = cloneCompletion(completion), hostSettings = manager.serviceSettings;
        const configuredContextSize = hostSettings.openai_max_context, configuredResponseSize = hostSettings.openai_max_tokens;
        const contextSize = budget?.contextSize ?? configuredContextSize, responseSize = budget?.responseSize ?? configuredResponseSize;
        const session = privateContextKind === 'session' && contextSize === Infinity && responseSize === 0 && completion.tokenBudget === Infinity;
        if (!session && ![contextSize, responseSize, completion.tokenBudget].every(Number.isFinite)) throw new TypeError('无法确认 token 额度');
        const preview = new ChatCompletion(); preview.messages = cloned.root;
        const originalChat = savedGetChat.call(preview);
        const wireParts = new WeakMap(), wireIndices = new WeakMap(), separated = [];
        let part = 0;
        for (const leaf of cloned.leaves) {
            const chat = new MessageCollection('proof', leaf.message).getChat(), texts = textParts(chat);
            if (chat.length === 1) wireIndices.set(leaf.message, separated.length);
            if (texts.length === 1 && texts[0] === leaf.message.content) wireParts.set(leaf.message, part);
            part += texts.length; separated.push(...chat);
        }
        const verifiedWire = same(separated, originalChat);
        const frame = { ...cloned, token: generation, originalChat, wireParts: verifiedWire ? wireParts : null,
            wireIndices: verifiedWire ? wireIndices : null, contextSize, responseSize,
            configuredContextSize, configuredResponseSize,
            remaining: completion.tokenBudget, originalTokens: cloned.root.getTokens(),
            configuredSquash: hostSettings.squash_system_messages === true,
            squash: importObservedFrame ? privateWasSquashed : hostSettings.squash_system_messages === true, used: false };
        frames.set(completion, frame);
        publish({ stage: 'assembled', messages: originalChat, complete: false,
            sources: sourceSnapshot(frame), scopeDetails: PLUGIN_MIGRATION_SCOPE });
        return frame;
    }
    async function adoptObservedFrame(observation, worldInfo) {
        if (!importObservedFrame || !supported || destroyed || observation?.manager !== manager
            || !Array.isArray(observation.frontendMessages) || !observation.promptCollection) return null;
        const inputs = observation.projectedInputs;
        if (!inputs || !Array.isArray(inputs.messages)) return null;
        generation = { active: true, type: observation.collectionArgs?.[0] ?? 'normal', scope: scope(), ordinal: ++ordinal,
            prepared: new Map(), worldInfo, worldInfoText: null, coreChat: [], coreSeed: { messages: [], ignored: [] },
            historySeed: structuredClone(inputs.messages), promptCollection: observation.promptCollection, extensionSeed: null,
            historyObserved: [], continuationReserved: false, collectionConflict: false, depthGraph: null, depthGraphFailed: false };
        generation.sessionCanonicalHistory = privateContextKind === 'session' && inputs.messages.length > 0
            && inputs.messages.every(message => Array.isArray(Object.getOwnPropertyDescriptor(message, 'agentMessages')?.value));
        const token = generation;
        for (const item of observation.prepared ?? []) {
            const prompt = item.prompt;
            if (!prompt || typeof prompt !== 'object') return null;
            const fields = Object.getOwnPropertyDescriptors(prompt);
            const names = ['identifier', 'content', 'name', 'role', 'position', 'injection_position', 'injection_depth', 'injection_order'];
            if (names.some(name => fields[name] && !('value' in fields[name]))) return null;
            const value = name => fields[name]?.value;
            if (typeof value('identifier') !== 'string' || typeof value('content') !== 'string') continue;
            const templateText = item.metadata?.content;
            const meta = { token, identifier: value('identifier'), text: value('content'), role: value('role'),
                name: value('name') ?? null, templateText: typeof templateText === 'string' ? templateText : null,
                position: value('position'), injection_position: value('injection_position'),
                injection_depth: value('injection_depth'), injection_order: value('injection_order'), outlets: [] };
            if (/^chatHistory-\d+$/u.test(meta.identifier)) {
                meta.historyInput = { role: item.metadata?.role, name: item.metadata?.name, content: templateText };
                token.historyObserved.push(meta);
            }
            captureWorldInfoTemplate(token, meta.identifier, templateText);
            if (worldInfo && typeof templateText === 'string') meta.outlets = captureOutlets(templateText, token);
            promptSources.set(prompt, meta); token.prepared.set(meta.identifier, meta);
        }
        for (const item of observation.messageEvents ?? []) {
            const meta = promptSources.get(item.prompt);
            if (meta && item.message && observation.isMessageFromThisAssembly?.(item.message)) messageSources.set(item.message, meta);
        }
        try { token.extensionSeed = extensionSnapshot(); } catch { token.extensionSeed = null; }
        const frame = captureCompletionFrame(observation.completion, observation.budget);
        if (!frame || !same(frame.originalChat, observation.frontendMessages)) return null;
        const chat = structuredClone(frame.originalChat);
        chats.set(chat, { frame, expected: structuredClone(chat) });
        await onPromptReady({ chat, dryRun: false });
        if (observation.isCurrent && !observation.isCurrent()) return null;
        const tokenCounts = privateContextKind === 'session' ? undefined : !same(chat, frame.originalChat)
            ? Object.fromEntries((frame.root.getCollection?.() ?? frame.root.collection).filter(Boolean).map(message =>
                [message.identifier, typeof message.getTokens === 'function' ? message.getTokens() : message.tokens]))
            : { ...(manager.tokenHandler?.getCounts?.() ?? {}) };
        return { messages: chat, report: last, tokenCounts };
    }
    function agentWorldInfo(observation) {
        const inputs = observation.projectedInputs;
        const enabledWI = observation.contextPolicy?.includeActivatedWorldInfo !== false;
        const original = observation.capturedFrozen?.worldInfoActivation?.entries ?? [];
        if (!Array.isArray(original) || original.length > MAX_MESSAGES) return null;
        const positions = ['before', 'after', 'an_top', 'an_bottom', 'depth', 'em_top', 'em_bottom', 'outlet'];
        const records = enabledWI ? original.map((entry, index) => ({ world: entry.world, uid: entry.uid,
            order: Number.isFinite(entry.order) ? entry.order : original.length - index,
            position: typeof entry.position === 'string' ? positions.indexOf(entry.position) : entry.position,
            depth: entry.depth, role: entry.role, outletName: entry.outletName,
            constant: entry.constant === true, text: entry.content ?? '' })) : [];
        if (records.some(entry => typeof entry.world !== 'string' || !Number.isSafeInteger(entry.uid)
            || !Number.isSafeInteger(entry.position) || typeof entry.text !== 'string')) return null;
        const current = generation?.worldInfo;
        if (current && worldInfoRenderingMatches(current.rendering, { regex, context: getContext() })) {
            const selected = records.map(entry => current.records.find(item => item.world === entry.world && item.uid === entry.uid
                && item.position === entry.position && item.constant === entry.constant
                && (item.originalText ?? item.text) === entry.text));
            if (selected.every(Boolean)) {
                const selectedIds = new Set(selected.map(entry => JSON.stringify([entry.world, entry.uid])));
                const candidate = current.records.filter(entry => selectedIds.has(JSON.stringify([entry.world, entry.uid]))).map(entry => ({ ...entry }));
                const fieldsMatch = [0, 1].every(position => candidate.filter(entry => entry.position === position && entry.text)
                    .reverse().map(entry => entry.text).join('\n') === (position === 0 ? inputs.worldInfoBefore : inputs.worldInfoAfter));
                if (fieldsMatch) return { records: candidate, rendering: { ...current.rendering, records: candidate } };
            }
        }
        const rendering = captureWorldInfoRendering({ records, regex, context: getContext(), parseRegex: utils?.regexFromString });
        const candidate = rendering.records ?? records;
        let fieldsMatch = [0, 1].every(position => candidate.filter(entry => entry.position === position && entry.text)
            .sort((left, right) => right.order - left.order).reverse().map(entry => entry.text).join('\n')
            === (position === 0 ? inputs.worldInfoBefore ?? '' : inputs.worldInfoAfter ?? ''));
        if (!fieldsMatch && rendering.supported) {
            const ordered = [0, 1].map(position => orderWorldInfoField(candidate.filter(entry => entry.position === position && entry.text),
                position === 0 ? inputs.worldInfoBefore ?? '' : inputs.worldInfoAfter ?? ''));
            if (ordered.every(Boolean)) {
                const fields = ordered.flatMap((items, position) => [...items].reverse().map(entry =>
                    ({ ...entry, order: 0, nativeFieldGroup: 'native:private-wi:' + position })));
                return { records: [...fields, ...candidate.filter(entry => ![0, 1].includes(entry.position))],
                    rendering: { ...rendering, records: fields } };
            }
        }
        return { records: candidate.sort((left, right) => right.order - left.order),
            rendering: fieldsMatch ? rendering : { ...rendering, supported: false, reason: 'WI_SOURCE_UNAVAILABLE' } };
    }
    function orderWorldInfoField(records, field) {
        if (typeof field !== 'string' || bytes(field) > MAX_WI_BYTES) return null;
        if (!records.length) return field === '' ? [] : null;
        const hits = records.map(entry => ({ entry, hits: occurrences([field], entry.text, 2) }));
        if (hits.every(value => value.hits.length === 1)) {
            const ordered = hits.sort((left, right) => left.hits[0].index - right.hits[0].index).map(value => value.entry);
            if (ordered.map(entry => entry.text).join('\n') === field) return ordered;
        }
        if (records.length > 16) return null;
        const complete = (1 << records.length) - 1, memo = new Map();
        let work = 0;
        function visit(offset, mask) {
            if (++work > 16384) return [];
            if (mask === complete) return offset === field.length ? [[]] : [];
            const key = offset + ':' + mask;
            if (memo.has(key)) return memo.get(key);
            const paths = [];
            for (let index = 0; index < records.length && paths.length < 2; index++) {
                if (mask & (1 << index)) continue;
                const prefix = (mask ? '\n' : '') + records[index].text;
                if (!field.startsWith(prefix, offset)) continue;
                for (const tail of visit(offset + prefix.length, mask | (1 << index))) {
                    paths.push([records[index], ...tail]); if (paths.length >= 2) break;
                }
            }
            memo.set(key, paths); return paths;
        }
        const paths = visit(0, 0);
        return work <= 16384 && paths.length === 1 ? paths[0] : null;
    }
    async function adaptAgentAssembly({ request, result, observation } = {}) {
        if (importObservedFrame || destroyed || !supported || !observation?.manager || observation.manager === manager
            || !observation.projectedInputs || !observation.contextPolicy) return null;
        const switches = enabled(), currentScope = scope(), currentGeneration = generation;
        const isCurrent = () => !destroyed && (observation.contextKind === 'session'
            || scope() === currentScope && generation === currentGeneration)
            && same(enabled(), switches) && observation.isCurrent?.() !== false;
        let worker;
        const stages = [];
        try {
            const privateManager = observation.manager, privateSettings = privateManager.serviceSettings;
            const inputs = observation.projectedInputs;
            const shadowSettings = { disabledExtensions: getContext().extensionSettings?.disabledExtensions ?? [],
                [MIGRATION_SETTINGS_KEY]: switches };
            const localBus = { on() {}, removeListener() {} };
            const localContext = { ...getContext(), mainApi: 'openai', extensionSettings: shadowSettings,
                extensionPrompts: observation.extensionPrompts ?? inputs.extensionPrompts,
                chatCompletionSettings: privateSettings, eventSource: localBus,
                getCurrentChatId: () => 'agent-assembly:' + (request?.profileId ?? 'current'),
                getChatCompletionModel: () => observation.model ?? request?.modelId ?? privateSettings.custom_model,
                saveSettingsDebounced() {} };
            const native = { ...openAi, promptManager: privateManager };
            worker = await installPromptMigrationRuntime({ context: localContext, getContext: () => localContext,
                loadOpenAi: async () => native, loadRegex: async () => regex, loadScript: async () => script,
                loadUtils: async () => utils, loadConstants: async () => constants, loadPowerUser: async () => powerUser,
                loadWorldInfoSource: async () => null, importObservedFrame: true,
                privateContextKind: observation.contextKind, privateWasSquashed: observation.wasSquashed === true, isLegacyMode: () => false,
                onSourceSnapshot: stage => stages.push(stage) });
            const adapted = await worker.adoptObservedFrame({ ...observation, isCurrent }, agentWorldInfo(observation));
            if (!adapted || !isCurrent()) return null;
            const report = adapted.report ?? { reason: null, statuses: { green: switches.green ? 'absent' : 'disabled',
                depth: switches.depth ? 'absent' : 'disabled' }, collections: {} };
            let reportToken;
            if (observation.contextKind === 'chat') {
                const chatRef = getNativeChatRef();
                if (chatRef && currentScope !== null) {
                    reportToken = 'agent-assembly:' + ++agentReportOrdinal;
                    agentReports.set(reportToken, { scope: currentScope, ordinal: generation?.ordinal ?? lastOrdinal ?? ordinal,
                        chatRef: JSON.stringify(chatRef), report: structuredClone(report) });
                    while (agentReports.size > 16) agentReports.delete(agentReports.keys().next().value);
                }
            }
            return { ...adapted, report, reportToken, trace: { version: 1, complete: false,
                sources: stages.at(-1)?.sources ?? [], stages: stages.map(stage => ({ stage: stage.stage, messages: stage.messages })) } };
        } catch { return null; }
        finally { worker?.destroy(); }
    }
    function sourceSnapshot(frame) {
        const verifiedDepth = resolveDepthSources(frame);
        const sources = frame.leaves.filter(({ message, source }) => source && typeof message.content === 'string')
            .map(({ message, source }) => ({
                id: 'prompt:' + source.identifier, identifier: source.identifier, label: verifiedDepth && source.label || source.name || source.identifier,
                text: message.content, role: message.role, position: verifiedDepth && source.depthGroup ? 1 : source.injection_position,
                depth: verifiedDepth && source.depthGroup ? source.depthGroup.depth : source.injection_depth,
                ...(verifiedDepth && source.historyInput && !source.depthGroup ? { kind: 'history', historyInput: true } : {}),
                ...(verifiedDepth && source.depthGroup ? { kind: 'extension', aggregate: true, inputs: source.depthGroup.inputs, priority: source.depthGroup.priority } : {}),
                ...((source.templateText ?? source.text) !== message.content
                    ? { originalText: source.templateText ?? source.text } : {}),
            }));
        const wi = frame.token.worldInfo;
        if (!wi) return sources;
        if (!worldInfoRenderingMatches(wi.rendering, { regex, context: getContext() })) {
            for (const { message, source } of frame.leaves) {
                const position = source?.identifier === 'worldInfoBefore' ? 0 : source?.identifier === 'worldInfoAfter' ? 1 : null;
                const records = position === null ? [] : wi.records.filter(entry => entry.position === position && entry.text);
                if (!records.length || records.some(entry => entry.constant) || !plainSourceMessage(message)) continue;
                const row = sources.find(item => item.id === 'prompt:' + source.identifier);
                if (row) Object.assign(row, { kind: 'worldinfo-green', aggregate: true,
                    label: position === 0 ? '世界书前段 · 完整绿灯组' : '世界书后段 · 完整绿灯组',
                    inputs: records.map(entry => ({ id: `wi:${entry.world}:${entry.uid}`, kind: 'worldinfo-green' })) });
            }
            for (const { message, source } of frame.leaves) {
                if (!plainSourceMessage(message) || source?.token !== frame.token) continue;
                for (const proof of verifiedOutlets(source, message.content, frame.token)) {
                    if (!proof.aggregate) continue;
                    sources.push({ id: 'outlet:' + source.identifier + ':' + proof.key,
                        label: '世界书出口 ' + proof.key + ' · 完整绿灯组', kind: 'worldinfo-green', aggregate: true,
                        text: proof.expected, position: 7, outletName: proof.key, role: message.role,
                        inputs: proof.records.map(entry => ({ id: `wi:${entry.world}:${entry.uid}`, kind: 'worldinfo-green' })) });
                }
            }
            return sources;
        }
        for (const { message, source } of frame.leaves) {
            const position = source?.identifier === 'worldInfoBefore' ? 0 : source?.identifier === 'worldInfoAfter' ? 1 : null;
            if (position === null || !plainSourceMessage(message) || source.token !== frame.token) continue;
            const records = wi.records.filter(entry => entry.position === position && entry.text).reverse();
            const expected = records.map(entry => entry.text).join('\n');
            if (!expected || frame.token.worldInfoText?.[source.identifier] !== expected
                || occurrences([message.content], expected, 2).length !== 1) continue;
            for (const entry of records) sources.push({ id: `wi:${entry.world}:${entry.uid}`,
                label: `${entry.world} · 条目 ${entry.uid}`, kind: entry.constant ? 'worldinfo-blue' : 'worldinfo-green',
                text: entry.text, world: entry.world, uid: entry.uid, constant: entry.constant,
                position: entry.position, role: message.role,
                ...(entry.originalText !== undefined ? { originalText: entry.originalText } : {}) });
        }
        for (const { message, source } of frame.leaves) {
            if (!plainSourceMessage(message) || source?.token !== frame.token) continue;
            for (const proof of verifiedOutlets(source, message.content, frame.token)) {
                for (const entry of proof.records) {
                    const text = proof.nativeObserved ? proof.segments.find(segment => segment.entry === entry)?.text : entry.text;
                    if (typeof text !== 'string') continue;
                    sources.push({ id: `wi:${entry.world}:${entry.uid}`,
                    label: `${entry.world} · 出口 ${proof.key} · 条目 ${entry.uid}`, kind: entry.constant ? 'worldinfo-blue' : 'worldinfo-green',
                    text, world: entry.world, uid: entry.uid, constant: entry.constant,
                    position: 7, outletName: proof.key, role: message.role,
                    ...(entry.originalText !== undefined || text !== entry.text ? { originalText: entry.originalText ?? entry.text } : {}) });
                }
            }
        }
        for (const move of exampleMoves(frame, frame.token).moves) {
            move.nodes.slice(1).forEach((message, index) => sources.push({ id: `wi:${move.entry.world}:${move.entry.uid}:example:${move.index}:${index}`,
                label: `${move.entry.world} · 示例条目 ${move.entry.uid}`, kind: 'worldinfo-green', text: message.content,
                world: move.entry.world, uid: move.entry.uid, constant: false, position: move.entry.position,
                role: message.role, name: message.name }));
        }
        return sources;
    }
    function uncertainDepth(token) {
        if ([...token.prepared.values()].some(meta => meta.injection_position === 1 && meta.text?.trim())) return true;
        if (token.worldInfo?.records.some(entry => entry.position === 4 && entry.text.trim())) return true;
        try {
            const prompts = getContext()?.extensionPrompts;
            if (!prompts || typeof prompts !== 'object') return false;
            for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(prompts))) {
                if (!('value' in descriptor)) return true;
                const entry = descriptor.value;
                if (entry?.position === 1 && entry.value) return true;
            }
        } catch { return true; }
        return false;
    }
    function makeSlots(frame, token, switches, examples) {
        const slots = [], failedOwners = new Set(), partialOwners = new Set(), reasons = [], relocatedOutletEntries = new Set();
        const failOwner = (owner, reason) => { failedOwners.add(owner); if (switches[owner]) reasons.push(reason); };
        const deferOwner = (owner, reason) => { partialOwners.add(owner); if (switches[owner] && !reasons.includes(reason)) reasons.push(reason); };
        const deferGreen = reason => deferOwner('green', reason);
        const wi = token.worldInfo;
        const verifiedDepth = resolveDepthSources(frame);
        if (uncertainDepth(token) && !verifiedDepth) failOwner('depth', 'DEPTH_SOURCE_UNAVAILABLE');
        const greenRecords = wi?.records.filter(entry => !entry.constant && ![2, 3, 4].includes(entry.position) && entry.text.trim()) ?? [];
        const renderingValid = wi && worldInfoRenderingMatches(wi.rendering, { regex, context: getContext() });
        if (!wi) failOwner('green', 'WI_SOURCE_UNAVAILABLE');
        if (examples.unconfirmed && greenRecords.some(entry => [5, 6].includes(entry.position))) deferGreen('WI_EXAMPLES_OR_OUTLETS_UNSUPPORTED');
        if (greenRecords.some(entry => [0, 1].includes(entry.position) && [...token.prepared.values()].some(source =>
            source.identifier === (entry.position === 0 ? 'worldInfoBefore' : 'worldInfoAfter') && source.injection_position === 1))) {
            failOwner('green', 'WI_SOURCE_UNAVAILABLE');
        }
        for (const { message, source } of frame.leaves) {
            if (!source || source.token !== token) continue;
            if (!plainSourceMessage(message) || message.content !== source.text) {
                if (source.identifier === 'authorsNote' && ['start', 'end'].includes(source.position) || verifiedDepth && source.depthGroup) deferOwner('depth', 'SOURCE_RETAINED');
                const position = source.identifier === 'worldInfoBefore' ? 0 : source.identifier === 'worldInfoAfter' ? 1 : null;
                if (position !== null && greenRecords.some(entry => entry.position === position)
                    || source.outlets?.some(proof => proof.records.some(entry => !entry.constant))) deferGreen('SOURCE_RETAINED');
                continue;
            }
            const located = frame.wireParts?.has(message);
            const outlets = verifiedOutlets(source, message.content, token).filter(proof => located || occurrences(textParts(frame.originalChat), proof.expected, 2).length === 1);
            if (/^chatHistory-/u.test(source.identifier) && (!source.depthGroup || !verifiedDepth) && !outlets.length) continue;
            const id = source.identifier;
            const slot = { id: 'prompt:' + id, text: message.content, segments: [], message,
                wirePart: frame.wireParts?.get(message),
                placement: { depth: source.depthGroup?.depth ?? source.injection_depth, role: message.role,
                    priority: source.depthGroup?.priority ?? source.injection_order } };
            const ownsDepth = switches.depth && (id === 'authorsNote' && ['start', 'end'].includes(source.position)
                || source.depthGroup && !failedOwners.has('depth'));
            if (switches.depth && id === 'authorsNote' && ['start', 'end'].includes(source.position)) {
                slot.segments.push({ start: 0, end: slot.text.length, text: slot.text, owner: 'depth', group: slot.id });
            }
            if (switches.depth && source.depthGroup && !failedOwners.has('depth')) {
                slot.segments.push({ start: 0, end: slot.text.length, text: slot.text, owner: 'depth', group: slot.id, preserveWhitespace: true });
            }
            if (['worldInfoBefore', 'worldInfoAfter'].includes(id) && wi && !failedOwners.has('green')) {
                const position = id === 'worldInfoBefore' ? 0 : 1;
                const records = wi.records.filter(entry => entry.position === position && entry.text).reverse();
                if (!renderingValid) {
                    if (records.length && records.every(entry => !entry.constant)) {
                        slot.segments.push({ start: 0, end: slot.text.length, text: slot.text, owner: 'green', group: 'native:' + id, preserveWhitespace: true });
                    } else if (records.some(entry => !entry.constant)) deferGreen('WI_REGEX_UNSUPPORTED');
                    slots.push(slot); continue;
                }
                const expected = records.map(entry => entry.text).join('\n');
                const observed = token.worldInfoText?.[id];
                const hits = expected ? occurrences([slot.text], expected, 2) : [];
                if (expected && (observed !== expected || hits.length !== 1)) {
                    if (records.some(entry => !entry.constant)) failOwner('green', 'WI_SOURCE_UNAVAILABLE');
                } else if (expected) {
                    let offset = hits[0].index;
                    for (const entry of records) {
                        slot.segments.push({ start: offset, end: offset + entry.text.length, text: entry.text,
                            owner: entry.constant ? null : 'green', group: wiGroup(entry) });
                        offset += entry.text.length + 1;
                    }
                }
            }
            if (!ownsDepth && !failedOwners.has('green')) {
                for (const proof of outlets) for (const segment of proof.segments) {
                    if (!located && segment.owner === 'green' && occurrences(textParts(frame.originalChat), segment.text, 2).length !== 1) continue;
                    slot.segments.push(segment);
                    if (segment.owner === 'green') for (const entry of segment.entries ?? [segment.entry])
                        relocatedOutletEntries.add(`${entry.world}:${entry.uid}`);
                }
            }
            slot.segments.sort((left, right) => left.start - right.start || left.end - right.end);
            slots.push(slot);
        }
        if (greenRecords.some(entry => entry.position === 7 && !relocatedOutletEntries.has(`${entry.world}:${entry.uid}`))) deferGreen('WI_OUTLET_SOURCE_UNAVAILABLE');
        return { slots, failedOwners, partialOwners, reasons };
    }
    async function onPromptReady(data) {
        if (!active() || data?.dryRun !== false || !Array.isArray(data.chat)) return;
        const token = generation, bound = chats.get(data.chat), switches = enabled();
        if (!bound || bound.frame.token !== token) {
            if (switches.green || switches.depth) {
                let legacy = true; try { legacy = isLegacyMode(getContext()) !== false; } catch { /* Unknown caller mode. */ }
                report(legacy ? 'SOURCE_CAPTURE_UNAVAILABLE' : 'AGENT_PROMPT_ASSEMBLY_UNAVAILABLE');
            }
            return;
        }
        const frame = bound.frame;
        if (frame.used) return;
        frame.used = true;
        if (!switches.green && !switches.depth) return;
        try {
            if (!same(data.chat, bound.expected) || !sameBudget(frame)) { report('HOST_CHAT_CHANGED'); return; }
            const protectedPayloads = protectedMessages(frame);
            if (!protectsPayloads(bound.expected, protectedPayloads)) { report('REBUILD_FALLBACK'); return; }
            const originalChat = frame.originalChat;
            const examples = switches.green ? exampleMoves(frame, token) : { moves: [], unconfirmed: false };
            const { slots, failedOwners, partialOwners, reasons } = makeSlots(frame, token, switches, examples);
            let plan = planMigration({ slots, chat: originalChat, enabled: switches, failedOwners,
                structuredOwners: examples.moves.length ? new Set(['green']) : new Set() });
            if (plan.collections.green && examples.moves.length) {
                const exampleTexts = examples.moves.flatMap(move => move.nodes.map(message => message.content));
                if (plan.collections.green.count + examples.moves.length > 128
                    || [...(plan.collections.green.sourceTexts ?? []), ...exampleTexts].reduce((sum, text) => sum + bytes(text), 0) > MAX_WI_BYTES
                    || exampleTexts.some(text => text.length > 32768)) {
                    examples.moves = []; partialOwners.add('green'); reasons.push('WI_EXAMPLE_LIMIT');
                    plan = planMigration({ slots, chat: originalChat, enabled: switches, failedOwners });
                }
            }
            const moves = plan.collections.green ? examples.moves : [];
            const projection = moves.length ? structuredProjection(frame, plan, moves, protectedPayloads) : null;
            if (projection) {
                plan.collections.green.count += moves.length;
                plan.collections.green.groups += new Set(moves.map(move => wiGroup(move.entry))).size;
            }
            const statuses = { ...plan.statuses };
            for (const owner of partialOwners) if (statuses[owner] === 'eligible') statuses[owner] = plan.collections[owner]?.count ? 'partial' : 'provenance-unavailable';
            const collections = Object.fromEntries(Object.entries(plan.collections).map(([owner, value]) => [owner,
                { count: value.count, groups: value.groups, ...(partialOwners.has(owner) ? { partial: true } : {}) }]));
            if (!plan.migrated) { report(reasons[0] ?? null, statuses, collections); return; }
            for (const slot of slots) {
                if (slot === projection?.anchor) continue;
                if (!plan.output.has(slot)) continue;
                const value = plan.output.get(slot);
                if (typeof value !== 'string' || value === slot.message.content) continue;
                slot.message.content = value;
                const counted = await countedText(slot.message, value);
                slot.message.tokens = counted.tokens;
                if (!active(token) || !same(enabled(), switches) || !sameBudget(frame) || !same(data.chat, bound.expected)) return;
            }
            if (projection) await insertExampleMoves(frame, projection, moves);
            if (!active(token) || !same(enabled(), switches) || !sameBudget(frame) || !same(data.chat, bound.expected)) return;
            // Preserve accepted source slots before native system-message
            // squashing joins them; a joined message must not become one source.
            const updatedSources = sourceSnapshot(frame);
            const replacement = new ChatCompletion();
            replacement.setTokenBudget(frame.contextSize, frame.responseSize);
            const reserved = privateContextKind === 'session' && frame.contextSize === Infinity ? 0
                : frame.contextSize - frame.responseSize - frame.remaining - frame.originalTokens;
            if (!Number.isFinite(reserved) || reserved < 0) throw new TypeError('无法确认预留的 token 额度');
            replacement.reserveBudget(reserved);
            if (!replacement.canAfford(frame.root)) throw new RangeError('Changed content exceeds original context');
            replacement.decreaseTokenBudgetBy(frame.root.getTokens());
            replacement.messages = frame.root;
            if (frame.squash) await replacement.squashSystemMessages(privateContextKind ? manager.tokenHandler : undefined);
            const rebuilt = savedGetChat.call(replacement);
            if (!verifyMigration(plan, rebuilt) || bytes(rebuilt) > MAX_TEXT_BYTES
                || projection && !frame.squash && !same(rebuilt, projection.desiredChat)
                || replacement.messages.getTokens() > frame.contextSize - frame.responseSize - reserved
                || !protectsPayloads(rebuilt, projection?.desiredProtected ?? protectedPayloads)) throw new TypeError('改动后的内容未通过校验');
            if (!active(token) || !same(enabled(), switches) || !sameBudget(frame) || !same(data.chat, bound.expected)) return;
            const outgoing = sanitizeChat(rebuilt);
            const descriptors = Object.getOwnPropertyDescriptors(data.chat);
            if (!descriptors.length?.writable || Object.entries(descriptors).some(([key, descriptor]) => /^\d+$/u.test(key)
                && (!('value' in descriptor) || !descriptor.writable || !descriptor.configurable))) throw new TypeError('对话内容只读，无法修改');
            const beforeCommit = [...data.chat];
            try {
                Array.prototype.splice.call(data.chat, 0, data.chat.length, ...outgoing);
                if (!same(data.chat, outgoing)) throw new TypeError('对话内容更新未生效');
            } catch (error) {
                try { Array.prototype.splice.call(data.chat, 0, data.chat.length, ...beforeCommit); } catch { /* Frozen host arrays remain unchanged. */ }
                throw error;
            }
            try {
                stability?.setGreenRelocated?.(plan.collections.green?.count > 0);
                stability?.setSourceRelocated?.(Boolean(plan.collections.green?.count || plan.collections.depth?.count));
            } catch {}
            publish({ stage: 'post-plugin', messages: outgoing, sources: updatedSources,
                complete: false, scopeDetails: PLUGIN_MIGRATION_SCOPE });
            report(reasons[0] ?? null, statuses, collections);
        } catch { if (active(token)) report('REBUILD_FALLBACK'); }
    }
    const savedGetChat = supported ? ChatCompletion.prototype.getChat : null;
    if (supported && !importObservedFrame) {
        try {
            if (supportsDepthAggregation) wrap(manager, 'getPromptCollection', original => function (...args) {
                const token = active() ? generation : null;
                token?.nativeWorldInfo?.finish();
                if (token) captureCoreSeed(token);
                const result = original.apply(this, args);
                if (token && active(token)) {
                    if (token.promptCollection && token.promptCollection !== result) token.collectionConflict = true;
                    token.promptCollection = result;
                    try { token.extensionSeed = extensionSnapshot(); } catch { token.extensionSeed = null; }
                }
                return result;
            });
            wrap(ChatCompletion.prototype, 'reserveBudget', original => function (value, ...args) {
                if (active() && value instanceof MessageCollection && value.identifier === 'continueNudge') {
                    const witnesses = value.flatten().filter(message => messageContinuations.get(message)?.token === generation);
                    if (witnesses.length === 1) generation.continuationReserved = true;
                }
                return original.call(this, value, ...args);
            });
            wrap(manager, 'preparePrompt', original => function (input, ...args) {
                const token = active() ? generation : null;
                let templateText = null, depthGroup = null, outlets = [], historyInput = null, continuation = null;
                try {
                    const raw = Object.getOwnPropertyDescriptors(input ?? {});
                    templateText = raw.content?.value;
                    const identifier = raw.identifier?.value;
                    const original = token?.historySeed?.[0];
                    if (['role', 'name', 'content'].every(key => !raw[key] || 'value' in raw[key])) {
                        const shape = { role: raw.role?.value, name: raw.name?.value, content: templateText };
                        if (typeof identifier === 'string' && /^chatHistory-\d+$/u.test(identifier)) historyInput = shape;
                        if (token?.type === 'continue' && manager.serviceSettings.continue_prefill !== true && identifier == null
                            && original && shape.role === original.role && shape.name === original.name && shape.content === original.content) continuation = { token };
                    }
                    depthGroup = token ? observeHistoryInput(input, token) : null;
                    outlets = token ? captureOutlets(templateText, token) : [];
                } catch { /* Observation never prevents native preparation. */ }
                let nativeOutlets = [];
                const observed = token?.worldInfo && outletEvidence
                    ? outletEvidence.capture({ templateText, records: token.worldInfo.records, constants,
                        extensionPrompts: getContext()?.extensionPrompts }, () => original.call(this, input, ...args))
                    : { result: original.call(this, input, ...args), proofs: [] };
                const prepared = observed.result;
                nativeOutlets = observed.proofs;
                if (token && active(token) && prepared) {
                    try {
                        const fields = Object.getOwnPropertyDescriptors(prepared);
                        const keys = ['identifier', 'content', 'name', 'role', 'position', 'injection_position', 'injection_depth', 'injection_order'];
                        if (keys.some(key => fields[key] && !('value' in fields[key]))) return prepared;
                        const value = key => fields[key]?.value;
                        if (continuation) promptContinuations.set(prepared, continuation);
                        if (typeof value('identifier') !== 'string' || typeof value('content') !== 'string') return prepared;
                        captureWorldInfoTemplate(token, value('identifier'), templateText);
                        const meta = { token, identifier: value('identifier'), text: value('content'),
                            name: typeof value('name') === 'string' ? value('name') : null,
                            templateText: typeof templateText === 'string' ? templateText : null,
                            role: value('role'), position: value('position'), injection_position: value('injection_position'),
                            injection_depth: value('injection_depth'), injection_order: value('injection_order'),
                            outlets, nativeOutlets,
                            ...(historyInput ? { historyInput } : {}),
                            ...(depthGroup ? { depthGroup, label: `@D ${depthGroup.depth} / ${depthGroup.role} / ${depthGroup.priority}` } : {}) };
                        promptSources.set(prepared, meta); token.prepared.set(meta.identifier, meta);
                        if (historyInput) token.historyObserved.push(meta);
                    } catch {}
                }
                return prepared;
            });
            wrap(Message, 'fromPromptAsync', original => function (prompt, ...args) {
                const meta = promptSources.get(prompt), continuation = promptContinuations.get(prompt);
                const pending = original.call(this, prompt, ...args);
                if (!meta && !continuation) return pending;
                return Promise.resolve(pending).then(message => {
                    if (meta && active(meta.token) && message) messageSources.set(message, meta);
                    if (continuation && active(continuation.token) && message) messageContinuations.set(message, continuation);
                    return message;
                });
            });
            wrap(manager, 'setChatCompletion', original => function (completion, ...args) {
                const result = original.call(this, completion, ...args);
                if (active() && !manager.error && completion instanceof ChatCompletion) {
                    try {
                        captureCompletionFrame(completion);
                    } catch { if (enabled().green || enabled().depth) report('SOURCE_LIMIT'); }
                }
                return result;
            });
            wrap(ChatCompletion.prototype, 'getChat', original => function (...args) {
                const chat = original.apply(this, args), frame = frames.get(this);
                if (active(frame?.token) && frame && !frame.used && Array.isArray(chat)) {
                    try { chats.set(chat, { frame, expected: structuredClone(chat) }); }
                    catch { /* No snapshot means no migration. */ }
                }
                return chat;
            });
            listen(events.GENERATION_STARTED, (type, options, dryRun) => {
                clear();
                const observationOnly = captureAgentDryRun && dryRun === true && FOREGROUND.has(type);
                generation = { active: (dryRun === false || observationOnly) && FOREGROUND.has(type), type, signal: options?.signal,
                    scope: scope(), ordinal: ++ordinal, prepared: new Map(), worldInfo: null, worldInfoText: null,
                    coreChat: null, coreSeed: null, historySeed: null, promptCollection: null, extensionSeed: null,
                    collectionConflict: false, depthGraph: null, depthGraphFailed: false };
                generation.historyObserved = []; generation.continuationReserved = false;
                notify();
            });
            listen(events.WORLDINFO_SCAN_DONE, captureWorldInfo, true);
            listen(events.WORLD_INFO_ACTIVATED, () => { generation?.nativeWorldInfo?.finish(); }, true);
            listen(events.GENERATE_BEFORE_COMBINE_PROMPTS, value => {
                if (!active() || value?.api !== 'openai') return;
                generation.worldInfoText = { worldInfoBefore: value.worldInfoBefore, worldInfoAfter: value.worldInfoAfter };
                captureCoreSeed(generation);
            }, true);
            listen(events.CHAT_COMPLETION_PROMPT_READY, onPromptReady, true);
            listen(events.GENERATION_ENDED, () => { clear({ preserveLast: true }); notify(); });
            for (const name of ['GENERATION_STOPPED', 'CHAT_CHANGED', 'SETTINGS_LOADED', 'CHATCOMPLETION_SOURCE_CHANGED',
                'CHATCOMPLETION_MODEL_CHANGED', 'CONNECTION_PROFILE_LOADED']) listen(events[name], () => { clear(); notify(); });
        } catch {
            destroyed = true;
            outletEvidence?.destroy();
            for (const [name, callback] of subscriptions) try { bus.removeListener(name, callback); } catch {}
            for (const restore of restorers.reverse()) try { restore(); } catch {}
            clear();
        }
    }
    return {
        adoptObservedFrame,
        adaptAgentAssembly,
        acceptAgentAssemblyReport(evidence, { command, dispatch, requestMetadata } = {}) {
            if (destroyed || command !== 'start_agent_run' || evidence?.contextKind !== 'chat'
                || dispatch?.presentation !== 'foreground' || requestMetadata?.background === true) return false;
            const captured = agentReports.get(evidence.reportToken);
            if (!captured || captured.scope !== scope() || captured.ordinal !== (generation?.ordinal ?? lastOrdinal ?? ordinal)) return false;
            try {
                if (captured.chatRef !== JSON.stringify(dispatch?.chatRef) || captured.chatRef !== JSON.stringify(getNativeChatRef())) return false;
            } catch { return false; }
            agentReports.delete(evidence.reportToken);
            report(captured.report.reason, captured.report.statuses, captured.report.collections);
            return true;
        },
        snapshot() {
            let switches; try { switches = enabled(); } catch { switches = { green: false, depth: false }; }
            const live = supported && !destroyed && openAi.promptManager === manager;
            return { supported: live, enabled: switches, mode: 'plugin-runtime',
                ordinal: generation?.ordinal ?? lastOrdinal,
                supportsDepthAggregation: live && supportsDepthAggregation,
                supportsOutlets: live && typeof constants?.inject_ids?.CUSTOM_WI_OUTLET === 'function',
                scopeDetails: PLUGIN_MIGRATION_SCOPE, limitations: ['无法逐条核对正文的自定义世界书处理', '未能确认位置或完整结构的注入／示例', '无法确认实际展开位置的世界书出口', 'TT Agent 后续原生内部模型轮次'],
                unavailableReason: live ? null : 'PUBLIC_PROMPT_APIS_UNAVAILABLE',
                unavailableMessage: live ? null : REASONS.PUBLIC_PROMPT_APIS_UNAVAILABLE,
                last: last ? structuredClone(last) : null };
        },
        noteFinalUnmigrated,
        confirmFinalPrompt({ messages, ordinal: expectedOrdinal, reason = 'FINAL_PROMPT_ASSEMBLY_UNMIGRATED' } = {}) {
            if (!Array.isArray(messages) || messages.length > MAX_MESSAGES) return false;
            // Residual control macros prove this final build bypassed an earlier
            // migration. Their absence alone cannot prove where sources moved.
            const own = (value, key) => {
                if (!value || typeof value !== 'object') return undefined;
                const descriptor = Object.getOwnPropertyDescriptor(value, key);
                return descriptor && 'value' in descriptor ? descriptor.value : undefined;
            };
            let textBytes = 0, inspectedParts = 0;
            const owners = new Set();
            const inspectText = value => {
                if (typeof value !== 'string') return;
                textBytes += bytes(value);
                if (textBytes > MAX_TEXT_BYTES) throw new RangeError('Final text limit');
                for (const [owner, macro] of Object.entries(MACROS)) if (value.includes(macro)) owners.add(owner);
            };
            const inspectParts = value => {
                if (!Array.isArray(value)) return;
                if (value.length > MAX_MESSAGES * 8) throw new RangeError('Final part limit');
                for (let index = 0; index < value.length; index++) {
                    if (++inspectedParts > MAX_MESSAGES * 8) throw new RangeError('Final part limit');
                    const part = own(value, String(index));
                    if (own(part, 'type') === 'text' && own(part, 'thought') !== true) inspectText(own(part, 'text'));
                }
            };
            try {
                for (let index = 0; index < messages.length; index++) {
                    const message = own(messages, String(index));
                    if (own(message, 'role') === 'tool') continue;
                    const content = own(message, 'content');
                    inspectText(content); inspectParts(content); inspectParts(own(message, 'parts'));
                }
            } catch { return false; }
            return noteFinalUnmigrated([...owners], { ordinal: expectedOrdinal, reason });
        },
        captureMessages(chat) {
            if (!active() || !supportsDepthAggregation || !Array.isArray(chat)) return false;
            if (generation.coreChat && generation.coreChat !== chat) { generation.depthGraphFailed = true; return false; }
            generation.coreChat = chat;
            return true;
        },
        subscribeSources(fn) { if (typeof fn !== 'function') throw new TypeError('缺少来源观察接口。'); if (destroyed) return () => {}; sourceListeners.add(fn); return () => sourceListeners.delete(fn); },
        setEnabled(owner, value) {
            if (!supported || destroyed || openAi.promptManager !== manager || !Object.hasOwn(MACROS, owner)) return false;
            let current; try { current = getContext(); } catch { return false; }
            const root = current?.extensionSettings;
            if (!root || typeof current.saveSettingsDebounced !== 'function') return false;
            const previous = root[MIGRATION_SETTINGS_KEY], entry = { ...(previous ?? {}), [owner]: value === true };
            root[MIGRATION_SETTINGS_KEY] = entry; clear(); notify();
            const restore = () => {
                if (destroyed || root[MIGRATION_SETTINGS_KEY] !== entry) return;
                if (previous === undefined) delete root[MIGRATION_SETTINGS_KEY]; else root[MIGRATION_SETTINGS_KEY] = previous;
                clear(); report('SETTINGS_SAVE_FAILED');
            };
            try { current.saveSettingsDebounced()?.catch?.(restore); } catch { restore(); return false; }
            return true;
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            outletEvidence?.destroy();
            for (const [name, callback] of subscriptions) try { bus.removeListener(name, callback); } catch {}
            for (const restore of restorers.reverse()) try { restore(); } catch { /* Preserve newer wrappers. */ }
            clear(); sourceListeners.clear(); subscriptions.length = 0; restorers.length = 0;
        },
    };
}
