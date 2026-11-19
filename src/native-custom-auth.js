/* Disposable Custom relay authentication; SPDX-License-Identifier: MPL-2.0. */

// The upstream binding is validated by the host before the relay is issued.
// This envelope makes the local hop independent of every stored/active key.
export function isNativeRelayCustomAuth(value) {
    const exactKeys = (object, keys) => object && typeof object === 'object' && !Array.isArray(object)
        && JSON.stringify(Object.keys(object).sort()) === JSON.stringify(keys);
    return Boolean(exactKeys(value, ['auth', 'credential', 'version']) && value.version === 1
        && exactKeys(value.auth, ['mode', 'required']) && value.auth.mode === 'bearer' && value.auth.required === false
        && exactKeys(value.credential, ['id', 'mode']) && value.credential.mode === 'legacy-custom' && value.credential.id === null);
}
