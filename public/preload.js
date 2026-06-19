const { ipcRenderer } = require('electron');

let activeInput = null;

// We use 'focusin' so it catches both clicks and controller tab-navigation
document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (!el) return;

    const isTextInput = el.tagName === 'INPUT' && ['text', 'search', 'url', 'password', 'email', 'number'].includes(el.type);
    const isTextArea = el.tagName === 'TEXTAREA';
    const isContentEditable = el.isContentEditable;
    
    if (isTextInput || isTextArea || isContentEditable) {
        activeInput = el;
        
        const isPassword = el.type === 'password';
        const initialValue = isContentEditable ? el.innerText : el.value || "";
        
        // Try to find a smart title for the keyboard based on the website's HTML
        let title = el.placeholder || el.name || el.ariaLabel || document.title || "Web Input";
        if (title.length > 25) title = title.substring(0, 25) + '...';

        // Send a secure message OUT to our Game OS
        ipcRenderer.sendToHost('open-web-osk', { title, isPassword, initialValue });
    }
}, true); // 'true' forces it to catch the event before React/Vue sites block it

// Listen for the Game OS sending text BACK to the website
ipcRenderer.on('insert-web-text', (event, text) => {
    if (activeInput) {
        if (activeInput.isContentEditable) {
            activeInput.innerText = text;
        } else {
            activeInput.value = text;
        }
        // Force the website to recognize the new text
        activeInput.dispatchEvent(new Event('input', { bubbles: true }));
        activeInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
});
