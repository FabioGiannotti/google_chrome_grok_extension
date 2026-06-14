'use strict';

const DEFAULTS = {
    delaySingle: 350,
    batchSize: 40,
    delayBatch: 4800,
    thumbW: 150,
    thumbH: 150,
    maxSimultaneous: 5,
    soundEnabled: true,
    reorderEnabled: false,
    saveMetadata: true,
    skipExisting: true,
    turboMode: false
};

const fields = ['delaySingle', 'batchSize', 'delayBatch', 'thumbW', 'thumbH', 'maxSimultaneous', 'soundEnabled', 'reorderEnabled', 'saveMetadata', 'skipExisting', 'turboMode'];

document.addEventListener('DOMContentLoaded', async () => {
    // Load saved settings
    const saved = await chrome.storage.sync.get(DEFAULTS);
    for (const key of fields) {
        const el = document.getElementById(key);
        if (!el) continue;
        if (el.type === 'checkbox') {
            el.checked = saved[key];
        } else {
            el.value = saved[key];
        }
    }

    document.getElementById('saveBtn').addEventListener('click', saveSettings);
});

async function saveSettings() {
    const data = {};
    for (const key of fields) {
        const el = document.getElementById(key);
        if (!el) continue;
        if (el.type === 'checkbox') {
            data[key] = el.checked;
        } else {
            data[key] = Number(el.value);
        }
    }

    await chrome.storage.sync.set(data);

    const fb = document.getElementById('saveFeedback');
    fb.textContent = '✓ Impostazioni salvate';
    setTimeout(() => { fb.textContent = ''; }, 3000);
}
