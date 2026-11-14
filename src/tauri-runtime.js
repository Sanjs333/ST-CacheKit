/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public License, v. 2.0. */

import { createCostContext } from './cost-context.js';
import { createCostUi } from './cost-ui.js';
import { createMessageCosts, getMessageCost } from './message-costs.js';
import { createMessageCostUi } from './message-cost-ui.js';
import { createLocalizer } from './i18n.js';
import { MODEL_POLICY_REFRESH_INTERVAL_MS, refreshModelPolicyFromGitHub, restoreCachedModelPolicy } from './model-policy-updater.js';
import { createTauriConnections } from './tauri-connections.js';
import { installTauriTransport } from './tauri-transport.js';
import { createTauriUi } from './tauri-ui.js';
import { createTauriUsageClient } from './tauri-usage.js';

export function assertTauriCapabilities(context, platform) {
    const store = platform?.api?.extension?.store;
    if (!context?.chatCompletionSettings?.additional_parameters_by_source
        || typeof context.saveSettingsDebounced !== 'function'
        || typeof context.eventSource?.on !== 'function' || !context.eventTypes?.CHAT_COMPLETION_SETTINGS_READY
        || typeof context.Popup?.show?.confirm !== 'function' || context.POPUP_RESULT?.AFFIRMATIVE === undefined
        || typeof platform?.api?.llmConnections?.save !== 'function'
        || !['setJson', 'listKeys'].every(key => typeof store?.[key] === 'function')
        || (typeof store?.tryGetJson !== 'function' && typeof store?.getJson !== 'function')) {
        const error = new Error('TauriTavern native parameter and extension storage APIs are required (tested with 2.3.0).');
        error.code = 'TAURI_CAPABILITIES_UNAVAILABLE';
        throw error;
    }
    return store;
}

async function waitForControls(documentRef) {
    const available = () => documentRef.getElementById('extensionsMenu')
        && (documentRef.getElementById('extensions_settings2') || documentRef.getElementById('extensions_settings'));
    if (available()) return;
    await new Promise((resolve, reject) => {
        const observer = new MutationObserver(() => { if (available()) finish(); });
        const timer = setTimeout(() => finish(new Error('TauriTavern extension controls are unavailable.')), 10_000);
        function finish(error) { clearTimeout(timer); observer.disconnect(); error ? reject(error) : resolve(); }
        observer.observe(documentRef.documentElement, { childList: true, subtree: true });
    });
}

export async function initTauriTavern({ target = globalThis, documentRef = target.document,
    getContext = () => target.SillyTavern?.getContext?.(),
    loadLibrary = () => import('/lib.js'), notifyError = () => {}, notifyWarning = () => {},
    factories = {},
} = {}) {
    await (target.__TAURITAVERN__?.ready ?? target.__TAURITAVERN_MAIN_READY__);
    let context;
    try { context = getContext(); }
    catch (cause) {
        const error = new Error('TauriTavern extension context is unavailable.', { cause });
        error.code = 'TAURI_CAPABILITIES_UNAVAILABLE';
        throw error;
    }
    const localize = createLocalizer((fallback, key) => context?.translate?.(fallback, key));
    const store = assertTauriCapabilities(context, target.__TAURITAVERN__);
    const { yaml } = await loadLibrary();
    if (typeof yaml?.parse !== 'function' || typeof yaml?.stringify !== 'function') {
        throw new Error(localize('vertex_paygo.tauri.yaml_missing'));
    }
    await waitForControls(documentRef);
    let controller;
    let costs;
    let costUi;
    let messageCosts;
    let messageCostUi;
    let usage;
    let transport;
    let cacheTools;
    let promptInspector;
    let frontendPromptInspector;
    let agentPromptCapture;
    let agentSettingsListener;
    let agentModeEnabled = false, agentModeKnown = false, agentSettingsSerial = 0;
    let timer;
    let destroyed = false;
    const eventName = context.eventTypes.CHAT_COMPLETION_SETTINGS_READY;
    const destroy = () => {
        if (destroyed) return;
        destroyed = true;
        if (timer !== undefined) target.clearInterval(timer);
        try { if (agentSettingsListener) target.removeEventListener?.('tauritavern-agent-system-settings-changed', agentSettingsListener); }
        catch { /* Release the remaining components even if a host event hook failed. */ }
        try { if (transport) context.eventSource.removeListener?.(eventName, transport); }
        catch { console.warn('[提示词缓存优化] Could not remove the Tauri request listener.'); }
        for (const component of [transport, frontendPromptInspector, agentPromptCapture, promptInspector, cacheTools, controller, messageCosts, messageCostUi, costUi, costs, usage]) {
            try { component?.destroy?.(); }
            catch { console.warn('[提示词缓存优化] Could not release a Tauri extension component.'); }
        }
    };
    async function refreshCatalog() {
        const result = await (factories.refreshPolicy ?? refreshModelPolicyFromGitHub)();
        if (!destroyed && result.changed) controller?.onModelPolicyChanged();
        return result;
    }
    try {
        restoreCachedModelPolicy();
        const connections = (factories.connections ?? createTauriConnections)({ getContext, api: target.__TAURITAVERN__.api, yaml });
        costs = (factories.costContext ?? createCostContext)({ getContext });
        const agentApi = target.__TAURITAVERN__.api.agent;
        agentModeKnown = !agentApi;
        agentSettingsListener = event => {
            const settings = event?.detail?.settings;
            if (!settings || typeof settings !== 'object' || Array.isArray(settings) || destroyed) return;
            agentSettingsSerial++; agentModeKnown = true; agentModeEnabled = Boolean(settings.agentModeEnabled);
            frontendPromptInspector?.controller?.onModeChanged?.();
        };
        target.addEventListener?.('tauritavern-agent-system-settings-changed', agentSettingsListener);
        if (agentApi && typeof store.tryGetJson === 'function') {
            const readingSerial = agentSettingsSerial;
            try {
                const saved = await store.tryGetJson({ namespace: 'agent-system', key: 'settings' });
                if (readingSerial === agentSettingsSerial && typeof saved?.found === 'boolean') {
                    agentModeKnown = true; agentModeEnabled = saved.found && Boolean(saved.value?.agentModeEnabled);
                }
            } catch { /* Public prompt events remain usable if the optional mode setting cannot be read. */ }
        }
        controller = (factories.ui ?? createTauriUi)({ getContext, connections, yaml, documentRef, localize, notifyError, notifyWarning,
            getMessageCostRecentCount: costs.getMessageCostRecentCount,
            setMessageCostRecentCount(value) {
                costs.setMessageCostRecentCount(value);
                messageCostUi?.render();
            },
            getMessageCostPlacement: costs.getMessageCostPlacement,
            setMessageCostPlacement(value) {
                costs.setMessageCostPlacement(value);
                messageCostUi?.render();
            },
        });
        usage = (factories.usage ?? createTauriUsageClient)({ store,
            notifyWarning: () => notifyWarning(localize('vertex_paygo.costs.recording_unavailable')) });
        messageCostUi = (factories.messageCostUi ?? createMessageCostUi)({ getContext, getMessageCost,
            documentRef, getPrices: costs.getPrices, localize,
            getPlacement: costs.getMessageCostPlacement,
            getRecentCount: costs.getMessageCostRecentCount,
            onOpen: () => void messageCosts?.refresh({ retry: true }),
        });
        messageCosts = (factories.messageCosts ?? createMessageCosts)({ getContext,
            getChatId: costs.getChatId, serverClient: usage, documentRef,
            onChange: () => messageCostUi.render(),
        });
        messageCostUi.render();
        costUi = (factories.costUi ?? createCostUi)({ context, serverClient: usage, documentRef,
            getChatId: costs.getChatId, getPrices: costs.getPrices, getPriceInfo: costs.getPriceInfo,
            setPrice: costs.setPrice, resetPrice: costs.resetPrice, refreshCatalog,
            getCurrentPricingKey: controller.getPricingKey,
            coverageNotice: localize('vertex_paygo.tauri.cost_coverage'),
        });
        transport = (factories.transport ?? installTauriTransport)({ context, target, yaml,
            stateProvider: controller.getState, usageClient: usage, messageCosts,
            getPromptInspector: () => frontendPromptInspector?.controller,
            getPromptMigration: () => cacheTools?.migration,
            captureUsageContext: costs.captureUsageContext, getUsagePrice: costs.getUsagePrice,
            notifyError, notifyWarning, localize,
        });
        if (typeof context.eventSource.makeLast === 'function') context.eventSource.makeLast(eventName, transport);
        else context.eventSource.on(eventName, transport);

        // Official builds expose these tools independently of the tier and
        // usage APIs. Older builds can still use the existing Google controls.
        try {
            const createCacheTools = factories.cacheTools
                ?? (await import('./tauri-cache-tools.js')).createTauriCacheTools;
            cacheTools = await createCacheTools({ context, getContext, documentRef,
                createMigration: factories.promptMigration,
                loadOpenAi: factories.loadOpenAi, loadRegex: factories.loadRegex,
                loadScript: factories.loadScript, loadUtils: factories.loadUtils, loadConstants: factories.loadConstants });
        } catch {
            console.warn('[提示词缓存优化] Tauri world-info tools are unavailable.');
        }
        try {
            const createAgentCapture = factories.agentPromptCapture
                ?? (await import('./tauri-agent-prompt-capture.js')).createTauriAgentPromptCapture;
            agentPromptCapture = createAgentCapture({ api: target.__TAURITAVERN__.api,
                getCurrentChat: async () => {
                    const chatApi = target.__TAURITAVERN__.api.chat;
                    const ref = chatApi?.current?.ref?.();
                    const frozenRef = ref && typeof ref === 'object' ? { ...ref } : ref;
                    const chatId = costs.captureUsageContext();
                    const stableChatId = await chatApi?.open?.(frozenRef)?.stableId?.();
                    if (JSON.stringify(chatApi?.current?.ref?.()) !== JSON.stringify(frozenRef)
                        || costs.captureUsageContext() !== chatId) throw Object.assign(new Error('Agent chat changed.'), { code: 'AGENT_SCOPE_CHANGED' });
                    return { chatRef: frozenRef, stableChatId, chatId };
                },
                getOwnerKey: () => {
                    const chatId = costs.captureUsageContext();
                    return typeof chatId === 'string' && chatId ? 'tauri-local-conversation:' + chatId : null;
                }, cryptoRef: target.crypto ?? globalThis.crypto });
        } catch {
            console.warn('[提示词缓存优化] Tauri Agent input tools are unavailable.');
        }
        try {
            const createFrontendInspector = factories.frontendPromptInspector
                ?? (await import('./tauri-frontend-inspector.js')).createTauriFrontendInspector;
            frontendPromptInspector = await createFrontendInspector({ context, getContext,
                migration: cacheTools?.migration, getChatId: costs.captureUsageContext, target, documentRef,
                finalRequestCapture: true, agentCapture: agentPromptCapture,
                isAgentMode: () => agentModeKnown && agentModeEnabled,
                getPromptMode: () => agentModeKnown ? agentModeEnabled ? 'agent' : 'legacy' : 'unknown' });
        } catch {
            console.warn('[提示词缓存优化] Tauri frontend prompt tools are unavailable.');
        }
        try {
            const createPromptInspector = factories.promptInspector
                ?? (await import('./tauri-prompt-inspector.js')).createTauriPromptInspector;
            promptInspector = await createPromptInspector({ context, getContext,
                api: target.__TAURITAVERN__.api, documentRef });
        } catch {
            console.warn('[提示词缓存优化] Tauri request-log tools are unavailable.');
        }

        void refreshCatalog().catch(error => console.warn('[提示词缓存优化] Model policy refresh failed.', error));
        timer = target.setInterval(() => void refreshCatalog().catch(error =>
            console.warn('[提示词缓存优化] Model policy refresh failed.', error)), MODEL_POLICY_REFRESH_INTERVAL_MS);
        return { ...controller, destroy, usageClient: usage, cacheTools, promptInspector, frontendPromptInspector,
            agentPromptCapture, mode: 'tauri',
            captureMessages(chat) { if (!destroyed) return cacheTools?.migration?.captureMessages?.(chat); } };
    } catch (error) { destroy(); throw error; }
}
