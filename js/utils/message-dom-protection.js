function protectsActiveViewer(messageEl) {
    const modal = document.getElementById('image-viewer-modal');
    if (!modal?.classList.contains('open')) return false;
    const viewerUrl = document.getElementById('image-viewer-img')?.src;
    if (!viewerUrl) return false;
    return Array.from(messageEl.querySelectorAll('img')).some(
        (image) =>
            image.dataset.src === viewerUrl ||
            image.currentSrc === viewerUrl ||
            image.src === viewerUrl
    );
}

export function isMessageElementInteractionProtected(messageEl) {
    if (!messageEl || typeof document === 'undefined') return false;
    if (messageEl.classList.contains('editing')) return true;
    if (messageEl.contains(document.activeElement)) return true;

    const selection =
        typeof globalThis.getSelection === 'function' ? globalThis.getSelection() : null;
    if (
        selection?.rangeCount &&
        !selection.isCollapsed &&
        messageEl.contains(selection.getRangeAt(0).commonAncestorContainer)
    ) {
        return true;
    }
    if (
        Array.from(messageEl.querySelectorAll('audio, video')).some(
            (media) => !media.paused && !media.ended
        )
    ) {
        return true;
    }
    return protectsActiveViewer(messageEl);
}
