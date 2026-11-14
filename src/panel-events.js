/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public License, v. 2.0. */

const INTERACTION_EVENTS = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend'];
const dialogStacks = new WeakMap();

// Delegate dynamic controls inside the panel, before events reach this boundary.
export function isolatePanelEvents(root) {
    const stop = event => event.stopPropagation();
    for (const type of INTERACTION_EVENTS) root.addEventListener(type, stop);
    return () => {
        for (const type of INTERACTION_EVENTS) root.removeEventListener(type, stop);
    };
}

// Bind while visible and dispose on every close path. Only the top dialog owns Escape.
export function isolateDialogEvents(root, { onEscape, isActive = () => root.isConnected } = {}) {
    const doc = root.ownerDocument;
    const stack = dialogStacks.get(doc) ?? [];
    dialogStacks.set(doc, stack);
    const entry = { root, isActive };
    stack.push(entry);
    const disposePanel = isolatePanelEvents(root);
    const native = root.localName === 'dialog';
    const onKey = event => {
        if (event.key !== 'Escape' || !isActive()) return;
        if (stack.findLast(item => item.isActive()) !== entry) return;
        // A host modal can sit above our custom overlay without using this helper.
        const hostDialog = doc.activeElement?.closest?.('dialog[open]');
        if (!native && hostDialog && !hostDialog.contains(root)) return;
        event.stopImmediatePropagation();
        event.stopPropagation();
        if (!native) {
            event.preventDefault();
            onEscape?.(event);
        }
    };
    const onCancel = event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        event.stopPropagation();
        onEscape?.(event);
    };
    const keyTarget = native ? root : doc;
    keyTarget.addEventListener('keydown', onKey, !native);
    if (native) root.addEventListener('cancel', onCancel, true);
    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        // A close button can dispose us before its click reaches the panel root.
        // Keep the boundary until that event has finished bubbling.
        queueMicrotask(disposePanel);
        keyTarget.removeEventListener('keydown', onKey, !native);
        if (native) root.removeEventListener('cancel', onCancel, true);
        stack.splice(stack.indexOf(entry), 1);
        if (!stack.length) dialogStacks.delete(doc);
    };
}
