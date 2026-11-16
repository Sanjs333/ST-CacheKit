/* Tauri native model bindings; SPDX-License-Identifier: MPL-2.0 */
import { isGoogleSource } from './constants.js';
import { applySystemPromptPreference } from './system-prompt-settings.js';

const sourceName = value => {
    const source = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return ({ google: 'makersuite', gemini: 'makersuite', 'vertex-ai': 'vertexai', 'vertex ai': 'vertexai' })[source] ?? source;
};

// A profile can replace the snapshot's provider after JS dispatch. Resolve its
// public binding instead of using the currently selected chat connection.
export async function applyTauriAgentSystemPromptPreference(parameters, { api, getContext, dispatch } = {}) {
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return parameters;
    const dto = dispatch?.dto;
    let source = sourceName(parameters.chat_completion_source ?? parameters.source ?? parameters.provider
        ?? dto?.promptAssemblyRequest?.settings?.chat_completion_source
        ?? dto?.frozenRunInputSnapshot?.currentModelConnection?.settings?.chat_completion_source);
    const profileId = dto?.profileId;
    if (dto?.profile || (typeof profileId === 'string' && profileId && typeof api?.agent?.profiles?.load === 'function')) {
        try {
            const loadedProfile = dto?.profile ?? await api.agent.profiles.load({ profileId });
            const profile = loadedProfile?.profile ?? loadedProfile;
            const binding = profile?.model;
            if (binding?.mode === 'connectionRef') {
                if (typeof binding.connectionRef !== 'string' || typeof api?.llmConnections?.load !== 'function') return parameters;
                const loadedConnection = await api.llmConnections.load({ connectionId: binding.connectionRef });
                const connection = loadedConnection?.connection ?? loadedConnection;
                source = sourceName(connection?.provider?.chatCompletionSource ?? connection?.chatCompletionSource ?? connection?.source);
                if (!source) return parameters;
            }
        } catch { return parameters; }
    }
    if (!isGoogleSource(source)) return parameters;
    const prepared = { ...parameters, chat_completion_source: source };
    applySystemPromptPreference(prepared, getContext?.());
    return prepared.use_sysprompt === parameters.use_sysprompt ? parameters
        : { ...parameters, use_sysprompt: prepared.use_sysprompt };
}
