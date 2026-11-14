/* Official TauriTavern cache tools; SPDX-License-Identifier: MPL-2.0. */
import {
    completionIdentity, describeWorldInfoEntry, isFinalWorldInfoScan,
    worldInfoGroupKey, WORLDINFO_STABILITY_SETTINGS_KEY,
} from './worldinfo-stability.js';
import { createWorldInfoStabilityUi } from './worldinfo-stability-ui.js';
import { installPromptMigrationRuntime } from './prompt-migration-runtime.js';

const ORDERING = 'tauri-deterministic';
const MAX_ENTRIES = 512;
const FOREGROUND = new Set([undefined, null, '', 'normal', 'regenerate', 'swipe', 'continue', 'append', 'appendFinal']);
const emptyReport = reason => ({ valid: false, reason, groups: 0, changed: 0, skipped: 0, before: [], after: [] });
const mapEntries = entries => Array.from(Map.prototype.entries.call(entries));

/** TT's live outlet grammar reads this public entry through the same host ID
 * function. Adapt that read locally when the host keeps its getter private. */
export function createTauriPromptScriptAdapter({ script, constants, getContext } = {}) {
    if (!script || typeof script.getOutletPrompt === 'function'
        || typeof constants?.inject_ids?.CUSTOM_WI_OUTLET !== 'function') return script;
    return { ...script,
        getOutletPrompt(key) {
            try {
                const entries = getContext()?.extensionPrompts;
                const id = constants.inject_ids.CUSTOM_WI_OUTLET(String(key).trim());
                const descriptor = entries && Object.getOwnPropertyDescriptor(entries, id);
                if (!descriptor || !('value' in descriptor)) return '';
                const value = descriptor.value && Object.getOwnPropertyDescriptor(descriptor.value, 'value');
                return value && 'value' in value && typeof value.value === 'string' ? value.value : '';
            } catch { return ''; }
        },
    };
}

/** Sort only already-activated equivalent slots. Tauri positions 0–6 unshift
 * their text during prompt assembly; outlets append it. No text is retained. */
export function stabilizeTauriActivatedWorldInfo(entries) {
    if (!(entries instanceof Map)) return emptyReport('INVALID_SCAN');
    if (entries.size > MAX_ENTRIES) return emptyReport('SCAN_TOO_LARGE');
    const original = mapEntries(entries), result = [...original], grouped = new Map();
    original.forEach(([, entry], index) => {
        const key = worldInfoGroupKey(entry);
        if (key === null) return;
        const positions = grouped.get(key) ?? [];
        positions.push(index); grouped.set(key, positions);
    });
    let groups = 0, skipped = 0;
    for (const positions of grouped.values()) {
        if (positions.length < 2) continue;
        const members = positions.map(index => original[index]);
        if (new Set(members.map(([, entry]) => entry.uid)).size !== members.length) { skipped++; continue; }
        members.sort(([, left], [, right]) => Number(right.constant === true) - Number(left.constant === true) || left.uid - right.uid);
        if (members[0][1].position !== 7) members.reverse();
        positions.forEach((index, rank) => { result[index] = members[rank]; }); groups++;
    }
    const changed = result.filter((pair, index) => pair !== original[index]).length;
    const before = original.map(([, entry]) => describeWorldInfoEntry(entry));
    const after = result.map(([, entry]) => describeWorldInfoEntry(entry));
    if (changed) {
        try {
            entries.clear();
            for (const [key, entry] of result) entries.set(key, entry);
            const stored = mapEntries(entries);
            if (stored.length !== result.length || stored.some(([key, entry], index) => key !== result[index][0] || entry !== result[index][1])) {
                throw new Error('设置写入未生效');
            }
        } catch {
            Map.prototype.clear.call(entries);
            for (const [key, entry] of original) Map.prototype.set.call(entries, key, entry);
            return emptyReport('MAP_WRITE_FAILED');
        }
    }
    return { valid: true, groups, changed, skipped, before, after };
}

/** Fixed ordering for official builds, without claiming final-send receipts or
 * adaptive history. Scanning candidates, budgets and source text stay intact. */
export function installTauriWorldInfoStability({ context, getContext = () => context, onChange = () => {} } = {}) {
    const bus = context?.eventSource, events = context?.eventTypes;
    const supported = typeof events?.WORLDINFO_SCAN_DONE === 'string'
        && typeof events?.GENERATION_STARTED === 'string'
        && typeof events?.GENERATION_STOPPED === 'string' && typeof events?.GENERATION_ENDED === 'string'
        && typeof bus?.on === 'function' && typeof bus?.removeListener === 'function'
        && !!context?.extensionSettings && typeof context?.saveSettingsDebounced === 'function';
    const subscriptions = [];
    let generation = null, lastScan = null, destroyed = false, settingError = false;
    const enabled = () => {
        try { return getContext()?.extensionSettings?.[WORLDINFO_STABILITY_SETTINGS_KEY]?.enabled !== false; }
        catch { return false; }
    };
    function scope() {
        try {
            const current = getContext(), identity = completionIdentity(current), chat = current?.getCurrentChatId?.();
            if (current?.mainApi !== 'openai' || !identity || typeof chat !== 'string' || !chat) return null;
            const settings = current.chatCompletionSettings;
            return JSON.stringify([current.groupId ?? null,
                current.characters?.[current.characterId]?.avatar ?? current.characterId ?? null, chat, identity,
                current.extensionSettings?.connectionManager?.selectedProfile ?? null,
                settings.custom_url ?? null, settings.reverse_proxy ?? null,
                identity.source === 'vertexai' ? [settings.vertexai_region ?? null,
                    settings.vertexai_auth_mode ?? null, settings.vertexai_express_project_id ?? null] : null]);
        } catch { return null; }
    }
    const snapshot = () => ({ supported: supported && !destroyed, enabled: enabled(), ordering: ORDERING,
        hookKind: 'tauri-native', lastScan: lastScan ? structuredClone(lastScan) : null,
        lastConfirmation: null, pending: 0, memoryOnly: true, sendHistoryAvailable: false, settingError });
    const changed = () => { if (!destroyed) try { onChange(snapshot()); } catch { /* UI cannot affect prompt assembly. */ } };
    const reset = () => { generation = null; lastScan = null; changed(); };
    function listen(name, callback, last = false) {
        if (typeof name !== 'string') return;
        subscriptions.push([name, callback]);
        try {
            if (last && typeof bus.makeLast === 'function') bus.makeLast(name, callback);
            else bus.on(name, callback);
        } catch (error) {
            destroyed = true;
            for (const [event, listener] of subscriptions) {
                try { bus.removeListener(event, listener); } catch {}
            }
            subscriptions.length = 0;
            throw error;
        }
    }
    if (supported) {
        listen(events.GENERATION_STARTED, (type, options, dryRun) => {
            if (destroyed) return;
            generation = { active: dryRun === false && FOREGROUND.has(type), scope: scope(), signal: options?.signal };
            lastScan = null; changed();
        });
        listen(events.WORLDINFO_SCAN_DONE, args => {
            if (destroyed || !enabled() || !generation?.active || generation.signal?.aborted
                || !generation.scope || generation.scope !== scope()
                || !isFinalWorldInfoScan(args)) return;
            try { lastScan = stabilizeTauriActivatedWorldInfo(args.activated?.entries); }
            catch { lastScan = emptyReport('SCAN_PLAN_FAILED'); }
            changed();
        }, true);
        listen(events.GENERATION_ENDED, () => { generation = null; changed(); });
        for (const name of ['GENERATION_STOPPED', 'CHAT_CHANGED', 'SETTINGS_LOADED',
            'MESSAGE_SWIPED', 'CHATCOMPLETION_SOURCE_CHANGED', 'CHATCOMPLETION_MODEL_CHANGED', 'CONNECTION_PROFILE_LOADED']) {
            listen(events[name], reset);
        }
    }
    return {
        snapshot,
        setEnabled(value) {
            if (destroyed || !supported) return false;
            let current;
            try { current = getContext(); } catch { return false; }
            const root = current?.extensionSettings;
            if (!root || typeof current.saveSettingsDebounced !== 'function') return false;
            const previous = root[WORLDINFO_STABILITY_SETTINGS_KEY];
            const entry = { ...(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}), enabled: value === true };
            root[WORLDINFO_STABILITY_SETTINGS_KEY] = entry;
            settingError = false; reset();
            const restore = () => {
                if (destroyed || root[WORLDINFO_STABILITY_SETTINGS_KEY] !== entry) return;
                if (previous === undefined) delete root[WORLDINFO_STABILITY_SETTINGS_KEY];
                else root[WORLDINFO_STABILITY_SETTINGS_KEY] = previous;
                settingError = true; reset();
            };
            try { current.saveSettingsDebounced()?.catch?.(restore); }
            catch { restore(); return false; }
            return true;
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            for (const [name, callback] of subscriptions) {
                try { bus.removeListener(name, callback); } catch {}
            }
            subscriptions.length = 0; generation = null; lastScan = null;
        },
    };
}

/** Official Legacy chat assembly exports the same prompt objects used by the
 * plugin runtime. Headless Agent/Session assembly is not bound to those objects. */
export async function createTauriCacheTools({ context, getContext = () => context, documentRef = globalThis.document,
    clipboard = globalThis.navigator?.clipboard, createUi = createWorldInfoStabilityUi, onChange = () => {},
    createMigration = installPromptMigrationRuntime,
    loadOpenAi = () => import('../../../../openai.js'), loadRegex = () => import('../../../regex/engine.js'),
    loadScript = () => import('../../../../../script.js'), loadUtils = () => import('../../../../utils.js'),
    loadConstants = () => import('../../../../constants.js'),
    onSourceSnapshot = () => {},
} = {}) {
    let ui, destroyed = false;
    const feature = installTauriWorldInfoStability({ context, getContext,
        onChange: state => { ui?.render(); onChange(state); } });
    let migration;
    let scriptPromise, constantsPromise;
    const getConstants = () => constantsPromise ??= Promise.resolve().then(loadConstants);
    const getScript = () => scriptPromise ??= Promise.all([Promise.resolve().then(loadScript), getConstants().catch(() => null)])
        .then(([script, constants]) => createTauriPromptScriptAdapter({ script, constants, getContext }));
    const release = () => {
        for (const component of [migration, feature, ui]) {
            try { component?.destroy?.(); } catch { /* Release all optional tools. */ }
        }
    };
    try {
        migration = await createMigration({ context, getContext, stability: feature, loadOpenAi, loadRegex,
            loadScript: getScript, loadUtils, loadConstants: getConstants,
            captureAgentDryRun: true,
            onSourceSnapshot, onChange: () => { ui?.render(); onChange(feature.snapshot()); } });
        ui = createUi({ feature, migration, documentRef, clipboard });
    } catch (error) { release(); throw error; }
    return {
        feature, migration,
        render() { if (!destroyed) ui.render(); },
        destroy() {
            if (destroyed) return;
            destroyed = true; release();
        },
    };
}
