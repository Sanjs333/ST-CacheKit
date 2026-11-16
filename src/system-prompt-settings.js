/* SPDX-License-Identifier: MPL-2.0 */
import { isGoogleSource } from './constants.js';
import { createLocalizer } from './i18n.js';
import { mountExtensionSettings } from './extension-settings.js';

export const SYSTEM_PROMPT_SETTINGS_KEY = 'vertex-paygo-system-prompt';
const settingsRoot = context => {
    const root = context?.extensionSettings;
    return root && typeof root === 'object' && !Array.isArray(root) ? root : null;
};

function preference(context) {
    const root = settingsRoot(context);
    if (!root) return null;
    let setting = root[SYSTEM_PROMPT_SETTINGS_KEY];
    if (!setting || typeof setting !== 'object' || Array.isArray(setting) || typeof setting.enabled !== 'boolean') {
        setting = root[SYSTEM_PROMPT_SETTINGS_KEY] = { version: 2, enabled: true };
        context.saveSettingsDebounced?.();
    }
    return setting;
}

export function systemPromptEnabled(context) { return preference(context)?.enabled; }

// The extension's persistent switch controls Google requests independently of
// preset flags. Do not mutate other providers sharing the host setting object.
export function applySystemPromptPreference(data, context) {
    if (!data || !isGoogleSource(data.chat_completion_source)) return false;
    const enabled = systemPromptEnabled(context);
    if (typeof enabled !== 'boolean') return false;
    const changed = data.use_sysprompt !== enabled;
    data.use_sysprompt = enabled;
    return changed;
}

export function initializeSystemPromptPreference(context) {
    preference(context);
    return applySystemPromptPreference(context?.chatCompletionSettings, context);
}

export function createSystemPromptSettings({ getContext, documentRef = globalThis.document,
    mountSettings = mountExtensionSettings, localize = createLocalizer((fallback, key) => getContext?.()?.translate?.(fallback, key)) } = {}) {
    const make = (tag, text = '') => { const element = documentRef.createElement(tag); element.textContent = text; return element; };
    const root = make('section'); root.id = 'vertex-paygo-system-prompt-settings'; root.className = 'vertex-paygo-group';
    const title = make('h4', localize('vertex_paygo.system_prompt.title')); title.className = 'vertex-paygo-group-title';
    const label = make('label'); label.className = 'vertex-paygo-toggle-row';
    const toggle = make('input'); toggle.type = 'checkbox'; toggle.id = 'vertex-paygo-use-system-prompt';
    toggle.className = 'vertex-paygo-compact-switch'; toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-label', localize('vertex_paygo.system_prompt.enabled'));
    label.append(make('span', localize('vertex_paygo.system_prompt.enabled')), toggle);
    const note = make('p', localize('vertex_paygo.system_prompt.help')); note.className = 'vertex-paygo-guidance';
    root.append(title, label, note);
    let destroyed = false, presetLoading = false, syncing = false, linkedControl = null;
    let unlinkControl = () => {};
    const disposers = [];
    const context = () => getContext?.();
    const hostControl = () => documentRef.getElementById('use_sysprompt');
    const syncHost = ({ notify = false } = {}) => {
        if (destroyed || presetLoading || syncing) return;
        const current = context(), host = current?.chatCompletionSettings;
        if (!host || !isGoogleSource(host.chat_completion_source)) return;
        const control = hostControl();
        const changed = applySystemPromptPreference(host, current);
        const mismatch = control && control.checked !== host.use_sysprompt;
        syncing = true;
        try {
            if (control) {
                control.checked = host.use_sysprompt;
                if (notify && (changed || mismatch)) {
                    const EventClass = documentRef.defaultView?.Event ?? globalThis.Event;
                    if (EventClass) control.dispatchEvent(new EventClass('change', { bubbles: true }));
                }
            }
            if (changed || mismatch) current.saveSettingsDebounced?.();
        } finally { syncing = false; }
    };
    const hostChanged = () => { if (!destroyed && !syncing && !presetLoading) render(); };
    const linkHostControl = () => {
        const control = hostControl();
        if (control === linkedControl) return;
        unlinkControl(); linkedControl = control;
        if (!control) { unlinkControl = () => {}; return; }
        control.addEventListener('change', hostChanged); control.addEventListener('input', hostChanged);
        unlinkControl = () => { control.removeEventListener('change', hostChanged); control.removeEventListener('input', hostChanged); };
    };
    const render = () => {
        if (destroyed) return;
        linkHostControl();
        const enabled = systemPromptEnabled(context());
        toggle.disabled = typeof enabled !== 'boolean'; toggle.checked = enabled === true;
        syncHost();
    };
    const change = () => {
        const current = context(), setting = preference(current);
        if (!setting) return;
        setting.enabled = toggle.checked;
        current.saveSettingsDebounced?.();
        syncHost({ notify: true }); render();
    };
    toggle.addEventListener('change', change); disposers.push(() => toggle.removeEventListener('change', change));
    const current = context();
    const loaded = () => { presetLoading = false; render(); };
    for (const [key, handler] of [
        ['CHATCOMPLETION_SOURCE_CHANGED', render], ['SETTINGS_LOADED', render],
        ['OAI_PRESET_CHANGED_BEFORE', () => { presetLoading = true; }],
        ['OAI_PRESET_CHANGED_AFTER', loaded], ['CONNECTION_PROFILE_LOADED', loaded],
    ]) {
        const event = current?.eventTypes?.[key];
        if (typeof event !== 'string' || !current?.eventSource?.on) continue;
        current.eventSource.on(event, handler); disposers.push(() => current.eventSource.removeListener?.(event, handler));
    }
    render();
    let unmount;
    try { unmount = mountSettings(root, { documentRef, tab: 'cache', label: localize('vertex_paygo.settings.tab.cache'), onShow: render }); }
    catch (error) { destroyed = true; unlinkControl(); for (const dispose of disposers) dispose(); throw error; }
    return { root, render, destroy() { destroyed = true; unlinkControl(); for (const dispose of disposers) dispose(); unmount(); } };
}
