/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createClientLogger, getSafeErrorContext } from './src/client-logger.js';
import { CLIENT_VERSION, EXTENSION_DISPLAY_NAME, PROTOCOL_VERSION } from './src/constants.js';
import { createLocalizer } from './src/i18n.js';
import {
    MODEL_POLICY_REFRESH_INTERVAL_MS,
    refreshModelPolicyFromGitHub,
    restoreCachedModelPolicy,
} from './src/model-policy-updater.js';
import { installRequestTransport } from './src/request-transport.js';
import { createServerClient } from './src/server-client.js';
import { createPayGoUi } from './src/ui.js';
import { createCostContext } from './src/cost-context.js';
import { createCostUi } from './src/cost-ui.js';
import { createMessageCosts, getMessageCost } from './src/message-costs.js';
import { createMessageCostUi } from './src/message-cost-ui.js';
import { isTauriTavern, showTauriTavernNotice } from './src/tauritavern.js';
import { installGemini4HostCompatibility } from './src/gemini4-host.js';
import { installPromptMigrationRuntime } from './src/prompt-migration-runtime.js';
import { captureWorldInfoRendering } from './src/worldinfo-source-evidence.js';
import { installWorldInfoStability } from './src/worldinfo-stability.js';
import { createWorldInfoStabilityUi } from './src/worldinfo-stability-ui.js';
import { createCacheDiagnosticsUi } from './src/cache-diagnostics.js';
import { createPromptInspectorController } from './src/prompt-inspector-controller.js';
import { createPromptInspectorUi } from './src/prompt-inspector-ui.js';
import { createSystemPromptSettings } from './src/system-prompt-settings.js';
import { createBillingUi } from './src/billing-ui.js';
import { createCachePrefixBoundary, createCachePrefixBoundarySettings } from './src/cache-prefix-boundary.js';

let initialized = false;
let controller = null;
let modelPolicyRefreshTimer = null;
let clientLogger = null;
let costUi = null;
let costContext = null;
let messageCosts = null;
let messageCostUi = null;
let gemini4Host = null;
let worldInfoStability = null;
let promptMigration = null;
let worldInfoStabilityUi = null;
let cacheDiagnosticsUi = null;
let promptInspectorController = null;
let promptInspectorUi = null;
let requestHook = null;
let requestHookContext = null;
let systemPromptSettings = null;
let billingUi = null;
let cachePrefixBoundary = null;
let cachePrefixBoundarySettings = null;

globalThis.vertexPayGoGemini4GenerateInterceptor = chat => {
    try { gemini4Host?.captureMessages(chat); }
    catch { console.warn('[提示词缓存优化] Gemini media observation is unavailable for this generation.'); }
    try { promptMigration?.captureMessages?.(chat); }
    catch { console.warn('[提示词缓存优化] Prompt source observation is unavailable for this generation.'); }
    if (controller?.mode === 'tauri') {
        try { controller.captureMessages?.(chat); }
        catch { console.warn('[提示词缓存优化] Tauri prompt source observation is unavailable for this generation.'); }
    }
};

function notify(kind, message) {
    const toaster = globalThis.toastr?.[kind];
    if (typeof toaster === 'function') {
        toaster.call(globalThis.toastr, message, EXTENSION_DISPLAY_NAME, { preventDuplicates: true, timeOut: 10_000 });
    } else {
        console[kind === 'error' ? 'error' : 'warn'](`[提示词缓存优化] ${message}`);
    }
}

async function waitForVertexControls(timeoutMs = 10_000, localize = createLocalizer()) {
    if (document.getElementById('vertexai_region') && document.getElementById('model_vertexai_select')) {
        return;
    }

    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            observer.disconnect();
            reject(new Error(localize('vertex_paygo.error.controls_timeout')));
        }, timeoutMs);
        const observer = new MutationObserver(() => {
            if (document.getElementById('vertexai_region') && document.getElementById('model_vertexai_select')) {
                clearTimeout(timeout);
                observer.disconnect();
                resolve();
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    });
}

export async function init() {
    if (initialized) return;
    initialized = true;

    try {
        if (isTauriTavern()) {
            try {
                const { initTauriTavern } = await import('./src/tauri-runtime.js');
                controller = await initTauriTavern({
                    notifyError: message => notify('error', message),
                    notifyWarning: message => notify('warning', message),
                });
            } catch (error) {
                if (error?.code !== 'TAURI_CAPABILITIES_UNAVAILABLE') throw error;
                let context;
                try { context = globalThis.SillyTavern?.getContext?.(); } catch { /* Use native fallback dialog. */ }
                void showTauriTavernNotice({ context }).catch(error =>
                    console.error('[提示词缓存优化] Could not display the compatibility notice.', error));
            }
            return;
        }
        const context = globalThis.SillyTavern?.getContext?.();
        const localize = createLocalizer(
            typeof context?.translate === 'function'
                ? (fallback, key) => context.translate(fallback, key)
                : undefined,
        );
        if (!context) {
            throw new Error(localize('vertex_paygo.error.context_unavailable'));
        }
        const serverClient = createServerClient({
            fetchImpl: globalThis.fetch.bind(globalThis),
            getRequestHeaders: context.getRequestHeaders,
            localize,
        });
        clientLogger = createClientLogger({
            sendEntry: entry => serverClient.writeClientLog(entry),
            clientVersion: CLIENT_VERSION,
            protocolVersion: PROTOCOL_VERSION,
            deliveryEnabled: false,
        });
        clientLogger.event('info', 'extension.init_started', { phase: 'started' });

        const restoredPolicy = restoreCachedModelPolicy({ logger: clientLogger });
        clientLogger.event('info', 'policy.restore_completed', {
            phase: restoredPolicy.applied
                ? (restoredPolicy.changed ? 'cache_changed' : 'cache_unchanged')
                : 'bundled',
            ...getSafeErrorContext(restoredPolicy.error),
        });
        await waitForVertexControls(10_000, localize);
        gemini4Host = await installGemini4HostCompatibility({ context });
        try { systemPromptSettings = createSystemPromptSettings({ getContext: () => globalThis.SillyTavern.getContext(), localize }); }
        catch { console.warn('[提示词缓存优化] System prompt settings are unavailable.'); }

        costContext = createCostContext({ getContext: () => globalThis.SillyTavern.getContext() });
        try { billingUi = createBillingUi({ context, serverClient, getChatId: costContext.getChatId, localize }); }
        catch { console.warn('[提示词缓存优化] Billing settings are unavailable.'); }
        controller = createPayGoUi({
            context,
            serverClient,
            notifyError: message => notify('error', message),
            notifyWarning: message => notify('warning', message),
            logger: clientLogger,
            localize,
            getMessageCostRecentCount: costContext.getMessageCostRecentCount,
            setMessageCostRecentCount(value) {
                costContext.setMessageCostRecentCount(value);
                messageCostUi?.render();
            },
            getMessageCostPlacement: costContext.getMessageCostPlacement,
            setMessageCostPlacement(value) {
                costContext.setMessageCostPlacement(value);
                messageCostUi?.render();
            },
        });

        // Each optional tool uses the host's public runtime APIs. A missing
        // capability must not disable the other tools or change generation.
        try {
            const userModule = await import('../../../user.js');
            promptInspectorController = createPromptInspectorController({ context, serverClient,
                getContext: () => globalThis.SillyTavern.getContext(),
                getChatId: () => costContext.captureUsageContext(),
                getOwner: () => userModule.accountsEnabled ? userModule.currentUser?.handle ?? null : 'default-user',
                getPluginState: () => ({ sorting: worldInfoStability?.snapshot(), migration: promptMigration?.snapshot() }),
            });
        } catch {
            console.warn('[提示词缓存优化] Prompt recording is unavailable.');
        }
        try {
            const [regex, { DEFAULT_DEPTH, world_info_position }, { regexFromString }] = await Promise.all([
                import('../../regex/engine.js'), import('../../../world-info.js'), import('../../../utils.js'),
            ]);
            worldInfoStability = installWorldInfoStability({
                context,
                renderEntryText: entry => {
                    const evidence = captureWorldInfoRendering({
                        records: [{ position: entry.position, depth: entry.depth, text: entry.content }],
                        regex, context: globalThis.SillyTavern.getContext(), parseRegex: regexFromString, defaultDepth: DEFAULT_DEPTH,
                    });
                    return evidence.supported ? evidence.records[0]?.text : undefined;
                },
                reverseFor: entry => entry.position !== world_info_position.outlet,
                getContext: () => globalThis.SillyTavern.getContext(),
                onChange: () => worldInfoStabilityUi?.render(),
            });
        } catch {
            console.warn('[提示词缓存优化] World-info sorting is unavailable.');
        }
        try {
            cachePrefixBoundary = createCachePrefixBoundary({ getContext: () => globalThis.SillyTavern.getContext(),
                onChange: () => cachePrefixBoundarySettings?.render() });
            cachePrefixBoundarySettings = createCachePrefixBoundarySettings({ boundary: cachePrefixBoundary,
                getContext: () => globalThis.SillyTavern.getContext(), localize });
        } catch { console.warn('[提示词缓存优化] Source-backed prefix boundary is unavailable.'); }
        try {
            promptMigration = await installPromptMigrationRuntime({ context, stability: worldInfoStability,
                getContext: () => globalThis.SillyTavern.getContext(), onChange: () => worldInfoStabilityUi?.render(),
                onSourceSnapshot: snapshot => {
                    promptInspectorController?.observer?.captureRuntimeSnapshot?.(snapshot);
                    cachePrefixBoundary?.captureRuntimeSnapshot(snapshot);
                } });
        } catch {
            console.warn('[提示词缓存优化] Prompt migration is unavailable.');
        }
        try {
            const feature = worldInfoStability ?? { snapshot: () => ({ supported: false, enabled: false }), setEnabled: () => false };
            worldInfoStabilityUi = createWorldInfoStabilityUi({ feature, migration: promptMigration, localize });
        } catch {
            console.warn('[提示词缓存优化] Cache settings are unavailable.');
        }
        if (promptInspectorController) {
            try { promptInspectorUi = createPromptInspectorUi({ controller: promptInspectorController, context }); }
            catch { console.warn('[提示词缓存优化] Prompt viewer is unavailable.'); }
        }

        try {
            cacheDiagnosticsUi = createCacheDiagnosticsUi({ context, serverClient, getChatId: costContext.getChatId });
        } catch (error) {
            console.warn('[提示词缓存优化] Cache diagnostics UI is unavailable.', error);
        }

        messageCostUi = createMessageCostUi({
            getContext: () => globalThis.SillyTavern.getContext(),
            getMessageCost,
            getPrices: costContext.getPrices,
            getPlacement: costContext.getMessageCostPlacement,
            getRecentCount: costContext.getMessageCostRecentCount,
            localize,
            onOpen: () => void messageCosts?.refresh({ retry: true }),
        });
        messageCosts = createMessageCosts({
            getContext: () => globalThis.SillyTavern.getContext(),
            getChatId: costContext.getChatId,
            serverClient,
            onChange: () => messageCostUi.render(),
        });
        messageCostUi.render();
        costUi = createCostUi({
            context,
            serverClient,
            getChatId: costContext.getChatId,
            getPrices: costContext.getPrices,
            getPriceInfo: costContext.getPriceInfo,
            setPrice: costContext.setPrice,
            resetPrice: costContext.resetPrice,
            refreshCatalog: () => refreshModelPolicy(),
            getCurrentPricingKey: () => {
                const current = globalThis.SillyTavern.getContext();
                return {
                    source: current.chatCompletionSettings?.chat_completion_source,
                    model: current.getChatCompletionModel?.(),
                    tier: controller.getState().tier,
                    region: current.chatCompletionSettings?.chat_completion_source === 'vertexai'
                        ? (current.chatCompletionSettings.vertexai_region || 'us-central1') : '',
                };
            },
        });

        requestHook = installRequestTransport({
            context,
            stateProvider: controller.getState,
            serverClient,
            origin: globalThis.location.origin,
            notifyError: message => notify('error', message),
            notifyWarning: message => notify('warning', message),
            logger: clientLogger,
            localize,
            captureUsageContext: costContext.captureUsageContext,
            getUsagePrice: costContext.getUsagePrice,
            messageCosts,
            worldInfoStability,
            promptInspector: promptInspectorController,
            cachePrefixBoundary,
        });
        requestHookContext = context;

        const eventName = context.eventTypes.CHAT_COMPLETION_SETTINGS_READY;
        if (typeof context.eventSource.makeLast === 'function') {
            context.eventSource.makeLast(eventName, requestHook);
        } else {
            context.eventSource.on(eventName, requestHook);
        }

        const refreshModelPolicy = async () => {
            clientLogger?.event('info', 'policy.refresh_started', { phase: 'started' });
            try {
                const result = await refreshModelPolicyFromGitHub({ logger: clientLogger });
                if (result.changed) controller?.onModelPolicyChanged();
                clientLogger?.event(result.applied ? 'info' : 'warn', result.applied
                    ? 'policy.refresh_completed'
                    : 'policy.refresh_failed', {
                    phase: result.applied ? (result.changed ? 'changed' : 'unchanged') : 'failed',
                    ...getSafeErrorContext(result.error),
                });
                return result;
            } catch (error) {
                clientLogger?.event('error', 'policy.refresh_failed', {
                    phase: 'failed',
                    ...getSafeErrorContext(error),
                });
                console.warn('[提示词缓存优化] Could not apply the refreshed model policy.', error);
                return { applied: false, error };
            }
        };
        void refreshModelPolicy();
        modelPolicyRefreshTimer ??= setInterval(refreshModelPolicy, MODEL_POLICY_REFRESH_INTERVAL_MS);
        clientLogger.event('info', 'extension.init_ready', { phase: 'ready' });
    } catch (error) {
        const release = callback => { try { callback(); } catch { /* Continue releasing the other components. */ } };
        release(() => requestHookContext?.eventSource?.removeListener?.(requestHookContext.eventTypes?.CHAT_COMPLETION_SETTINGS_READY, requestHook));
        release(() => requestHook?.destroy?.());
        requestHook = null; requestHookContext = null;
        release(() => systemPromptSettings?.destroy()); systemPromptSettings = null;
        release(() => cachePrefixBoundarySettings?.destroy()); cachePrefixBoundarySettings = null;
        release(() => cachePrefixBoundary?.destroy()); cachePrefixBoundary = null;
        release(() => billingUi?.destroy()); billingUi = null;
        release(() => cacheDiagnosticsUi?.destroy());
        cacheDiagnosticsUi = null;
        release(() => promptInspectorUi?.destroy()); promptInspectorUi = null;
        release(() => promptInspectorController?.destroy()); promptInspectorController = null;
        release(() => worldInfoStabilityUi?.destroy());
        worldInfoStabilityUi = null;
        release(() => promptMigration?.destroy()); promptMigration = null;
        release(() => worldInfoStability?.destroy());
        worldInfoStability = null;
        release(() => gemini4Host?.cleanup());
        gemini4Host = null;
        release(() => messageCosts?.destroy()); messageCosts = null;
        release(() => messageCostUi?.destroy()); messageCostUi = null;
        release(() => costUi?.destroy()); costUi = null;
        release(() => costContext?.destroy()); costContext = null;
        release(() => controller?.destroy?.()); controller = null;
        initialized = false;
        if (modelPolicyRefreshTimer !== null) {
            clearInterval(modelPolicyRefreshTimer);
            modelPolicyRefreshTimer = null;
        }
        clientLogger?.event('error', 'extension.init_failed', {
            phase: 'failed',
            ...getSafeErrorContext(error),
        });
        console.error('[提示词缓存优化] Extension initialization failed.', error);
        notify('error', error instanceof Error ? error.message : String(error));
    }
}

export function getControllerForDebug() {
    return controller;
}

export function installLegacyActivationFallback({
    documentRef = globalThis.document,
    activate = init,
    logger = console,
} = {}) {
    if (!documentRef || typeof activate !== 'function') return false;

    const run = () => {
        Promise.resolve()
            .then(activate)
            .catch(error => logger.error('[提示词缓存优化] Legacy activation fallback failed.', error));
    };

    if (documentRef.readyState === 'loading') {
        documentRef.addEventListener('DOMContentLoaded', run, { once: true });
    } else {
        run();
    }
    return true;
}

installLegacyActivationFallback();
