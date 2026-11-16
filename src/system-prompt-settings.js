/* SPDX-License-Identifier: MPL-2.0 */
import { isGoogleSource } from './constants.js';
import { mountExtensionSettings } from './extension-settings.js';

export const SYSTEM_PROMPT_SETTINGS_KEY = 'vertex-paygo-system-prompt';
const settingsRoot = context => {
    const root = context?.extensionSettings;
    return root && typeof root === 'object' && !Array.isArray(root) ? root : null;
};

// Apply the default once, only on a Google connection. Subsequent host/profile
// choices are authoritative; generation hooks never force the switch back on.
export function initializeSystemPromptPreference(context) {
    const root = settingsRoot(context);
    const host = context?.chatCompletionSettings;
    if (!root || !host || !isGoogleSource(host.chat_completion_source)) return false;
    if (root[SYSTEM_PROMPT_SETTINGS_KEY] && (typeof root[SYSTEM_PROMPT_SETTINGS_KEY] !== 'object'
        || Array.isArray(root[SYSTEM_PROMPT_SETTINGS_KEY]))) return false;
    const setting = root[SYSTEM_PROMPT_SETTINGS_KEY] ??= { version: 1 };
    if (setting.initialized === true) return false;
    setting.initialized = true;
    const changed = host.use_sysprompt !== true;
    host.use_sysprompt = true;
    context.saveSettingsDebounced?.();
    return changed;
}

// A host checkbox/preset is a user choice even when the active provider is not
// Google. Remember it before the first later Google source activation.
export function rememberSystemPromptPreference(context) {
    const root = settingsRoot(context), host = context?.chatCompletionSettings;
    if (!root || !host) return false;
    const previous = root[SYSTEM_PROMPT_SETTINGS_KEY];
    if (previous?.initialized === true) return false;
    root[SYSTEM_PROMPT_SETTINGS_KEY] = { version: 1, initialized: true };
    context.saveSettingsDebounced?.();
    return true;
}

export function createSystemPromptSettings({ getContext, documentRef = globalThis.document, mountSettings = mountExtensionSettings } = {}) {
    const make = (tag, text = '') => { const element = documentRef.createElement(tag); element.textContent = text; return element; };
    const root = make('section'); root.className = 'vertex-paygo-settings';
    const label = make('label'); label.className = 'checkbox_label';
    const toggle = make('input'); toggle.type = 'checkbox'; toggle.id = 'vertex-paygo-use-system-prompt';
    label.append(toggle, make('span', '使用独立系统提示词（Google）'));
    const note = make('small', '开头连续的系统消息单独发送，保持原顺序。历史与迁移到后面的世界书仍按原位置发送。首次启用默认为开，之后保留你的选择。');
    root.append(label, note);
    const context = () => getContext?.();
    const hostControl = () => documentRef.getElementById('use_sysprompt');
    let destroyed = false, presetLoading = false;
    let linkedControl = null, unlinkControl = () => {};
    const disposers = [];
    const hostChanged = () => {
        if (destroyed) return;
        const current = context(), control = hostControl();
        if (settingsRoot(current) && current.chatCompletionSettings && control) {
            current.chatCompletionSettings.use_sysprompt = control.checked;
            rememberSystemPromptPreference(current);
        }
        render({ applyDefault: false });
    };
    const linkHostControl = () => {
        const control = hostControl();
        if (control === linkedControl) return;
        unlinkControl(); linkedControl = control;
        if (!control) { unlinkControl = () => {}; return; }
        control.addEventListener('change', hostChanged);
        control.addEventListener('input', hostChanged);
        unlinkControl = () => { control.removeEventListener('change', hostChanged); control.removeEventListener('input', hostChanged); };
    };
    const render = ({ applyDefault = !presetLoading } = {}) => {
        if (destroyed) return;
        linkHostControl();
        const current = context();
        if (applyDefault && initializeSystemPromptPreference(current)) {
            const control = hostControl();
            if (control) control.checked = true;
        }
        const host = current?.chatCompletionSettings;
        toggle.disabled = !settingsRoot(current) || !host || !isGoogleSource(host.chat_completion_source);
        toggle.checked = host?.use_sysprompt === true;
    };
    const change = () => {
        const current = context();
        if (!settingsRoot(current) || !current.chatCompletionSettings || !isGoogleSource(current.chatCompletionSettings.chat_completion_source)) return;
        rememberSystemPromptPreference(current);
        current.chatCompletionSettings.use_sysprompt = toggle.checked;
        const control = hostControl();
        if (control) {
            control.checked = toggle.checked;
            const EventClass = documentRef.defaultView?.Event ?? globalThis.Event;
            if (EventClass) control.dispatchEvent(new EventClass('change', { bubbles: true }));
        }
        current.saveSettingsDebounced?.();
        render();
    };
    toggle.addEventListener('change', change); disposers.push(() => toggle.removeEventListener('change', change));
    const current = context();
    const loaded = () => {
        presetLoading = false;
        rememberSystemPromptPreference(context());
        render({ applyDefault: false });
    };
    const listeners = [
        ['CHATCOMPLETION_SOURCE_CHANGED', () => render()],
        ['OAI_PRESET_CHANGED_BEFORE', () => { presetLoading = true; }],
        ['OAI_PRESET_CHANGED_AFTER', loaded],
        ['CONNECTION_PROFILE_LOADED', loaded],
        ['SETTINGS_LOADED', () => render()],
    ];
    for (const [key, handler] of listeners) {
        const event = current?.eventTypes?.[key];
        if (typeof event !== 'string' || !current?.eventSource?.on) continue;
        current.eventSource.on(event, handler); disposers.push(() => current.eventSource.removeListener?.(event, handler));
    }
    render();
    let unmount;
    try { unmount = mountSettings(root, { documentRef, tab: 'cache', onShow: render }); }
    catch (error) { destroyed = true; unlinkControl(); for (const dispose of disposers) dispose(); throw error; }
    return { render, destroy() { destroyed = true; unlinkControl(); for (const dispose of disposers) dispose(); unmount(); } };
}
