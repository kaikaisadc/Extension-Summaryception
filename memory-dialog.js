// The primary action is opt-in. Escape, cancellation and the secondary button
// all leave the original memory untouched.
export function showMemoryDialog(title, content, closeLabel, actionLabel, signal) {
    if (signal?.aborted) return Promise.resolve(false);
    const dialog = document.createElement('dialog');
    dialog.className = 'sc-memory-dialog';
    dialog.setAttribute('aria-label', title);
    const heading = document.createElement('h3');
    heading.textContent = title;
    const footer = document.createElement('div');
    footer.className = 'sc-dialog-actions';
    const button = (label, value) => {
        const element = document.createElement('button');
        element.type = 'button';
        element.className = 'menu_button';
        element.textContent = label;
        element.onclick = () => dialog.close(value);
        footer.append(element);
    };
    button(closeLabel, '');
    if (actionLabel) button(actionLabel, 'accept');
    dialog.append(heading, content, footer);
    document.body.append(dialog);
    return new Promise(resolve => {
        const cancel = () => dialog.close('');
        dialog.addEventListener('close', () => {
            signal?.removeEventListener('abort', cancel);
            dialog.remove();
            resolve(dialog.returnValue === 'accept' && !signal?.aborted);
        }, { once: true });
        signal?.addEventListener('abort', cancel, { once: true });
        dialog.showModal();
    });
}
