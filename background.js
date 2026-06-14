function sanitizePath(str) {
    if (!str) return 'Generic';
    return str
        .replace(/[/\\:*?"<>|]/g, '_')   // illegal filesystem chars
        .replace(/\s+/g, '_')            // collapse spaces
        .replace(/[.]+$/, '')            // remove trailing dots
        .replace(/^[.]+/, '')            // remove leading dots
        .substring(0, 60)
        .trim() || 'Generic';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function isFileDownloaded(fullPath) {
    return new Promise((resolve) => {
        chrome.downloads.search({ state: 'complete' }, (items) => {
            const normalizedTarget = fullPath.replace(/\\/g, '/').toLowerCase();
            const exists = items.some(i => {
                const normalizedItem = i.filename.replace(/\\/g, '/').toLowerCase();
                return normalizedItem.endsWith(normalizedTarget);
            });
            resolve(exists);
        });
    });
}

const MAX_LOGS = 100;
async function addLog(level, message, details = '') {
    const { loggingEnabled } = await chrome.storage.local.get({ loggingEnabled: false });
    if (!loggingEnabled) return;

    const { logs = [] } = await chrome.storage.local.get('logs');
    const newLog = {
        time: new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        level, // 'info', 'success', 'warn', 'skip'
        message,
        details
    };

    logs.unshift(newLog);
    if (logs.length > MAX_LOGS) logs.pop();
    await chrome.storage.local.set({ logs });
    
    chrome.runtime.sendMessage({ action: 'newLog', log: newLog }).catch(() => { });
}

const pendingPaths = new Map();
const blobUrls = new Map();
const retryCounts = new Map();
const downloadItems = new Map();
const MAX_RETRIES = 3;

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    if (pendingPaths.has(item.url)) {
        const targetPath = pendingPaths.get(item.url);
        pendingPaths.delete(item.url);
        suggest({
            filename: targetPath,
            conflictAction: 'uniquify'
        });
    } else {
        suggest({
            filename: item.filename,
            conflictAction: 'uniquify'
        });
    }
});

let bgInterceptActive = true;

function setBadgeActive(active) {
    bgInterceptActive = active;
    chrome.contextMenus.update("grok-reorder-saved", { visible: active }).catch(() => { });
    if (isDownloading) {
        chrome.action.setBadgeText({ text: (downloadProgress.total - downloadProgress.current).toString() });
        chrome.action.setBadgeBackgroundColor({ color: '#388bfd' });
    } else if (active) {
        chrome.action.setBadgeText({ text: '●' });
        chrome.action.setBadgeBackgroundColor({ color: '#00c57a' });
    } else {
        chrome.action.setBadgeText({ text: '⏸' });
        chrome.action.setBadgeBackgroundColor({ color: '#d29922' });
    }
}

async function syncInterceptionState() {
    const { interceptActive = true } = await chrome.storage.local.get('interceptActive');
    const effectiveActive = interceptActive && !isDownloading;

    const tabs = await chrome.tabs.query({ url: "*://*.grok.com/*" });
    for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { 
            action: 'setEffectiveIntercept', 
            active: effectiveActive 
        }).catch(() => { });
    }
    
    if (isDownloading) {
        addLog('info', 'Intercettazione in PAUSA (download in corso).');
    } else {
        addLog('info', `Intercettazione ${effectiveActive ? 'RIPRESA' : 'DISATTIVATA'}.`);
    }
}

function flashBadge() {
    chrome.action.setBadgeText({ text: '★' });
    chrome.action.setBadgeBackgroundColor({ color: '#388bfd' });
    setTimeout(() => setBadgeActive(bgInterceptActive), 800);
}

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: "grok-reorder-saved",
        title: "Riordina (REORDER) Media per Data",
        contexts: ["page"],
        documentUrlPatterns: ["*://*.grok.com/imagine/saved*"]
    });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "grok-reorder-saved" && bgInterceptActive) {
        chrome.tabs.sendMessage(tab.id, { action: "manualReorder" }).catch(() => { });
    }
});

chrome.storage.local.get({ interceptActive: true }, (data) => {
    setBadgeActive(data.interceptActive);
    runStorageMigration().catch(console.error);
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'interceptActive' in changes) {
        setBadgeActive(changes.interceptActive.newValue);
        syncInterceptionState();
    }
});

async function runStorageMigration() {
    const { libraryItems = [] } = await chrome.storage.local.get('libraryItems');
    if (libraryItems.length === 0) return;

    let modified = false;
    const newLibrary = [];

    for (const item of libraryItems) {
        // If image data is still embedded in the manifest, extract it
        const hasLargeData = (item.url && item.url.startsWith('data:')) || (item.imageUrl && item.imageUrl.startsWith('data:'));
        
        if (hasLargeData) {
            const id = item.id || `lib_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
            const dataUrl = item.url || item.imageUrl;
            
            await chrome.storage.local.set({ [`lib_img_${id}`]: dataUrl });
            
            const cleanItem = { ...item, id: id, url: null, imageUrl: null };
            newLibrary.push(cleanItem);
            modified = true;
            console.log(`[Migration] Migrato elemento library: ${id}`);
        } else {
            if (!item.id) {
                item.id = `lib_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
                modified = true;
            }
            newLibrary.push(item);
        }
    }

    if (modified) {
        await chrome.storage.local.set({ libraryItems: newLibrary });
        addLog('info', `Migrazione biblioteca completata: ${newLibrary.length} elementi ottimizzati.`);
    }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!tab.url) return;
    const isGrok = tab.url.includes('grok.com');
    chrome.action.setIcon({
        tabId,
        path: isGrok
            ? { "16": "icons/icon_active_16.png", "32": "icons/icon_active_32.png", "48": "icons/icon_active_48.png", "128": "icons/icon_active_128.png" }
            : { "16": "icons/icon_inactive_16.png", "32": "icons/icon_inactive_32.png", "48": "icons/icon_inactive_48.png", "128": "icons/icon_inactive_128.png" }
    });
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab.url) return;
        const isGrok = tab.url.includes('grok.com');
        chrome.action.setIcon({
            tabId,
            path: isGrok
                ? { "16": "icons/icon_active_16.png", "32": "icons/icon_active_32.png", "48": "icons/icon_active_48.png", "128": "icons/icon_active_128.png" }
                : { "16": "icons/icon_inactive_16.png", "32": "icons/icon_inactive_32.png", "48": "icons/icon_inactive_48.png", "128": "icons/icon_inactive_128.png" }
        });
    } catch (e) { }
});

async function storeMediaItems(newItems) {
    const stored = await chrome.storage.local.get({ mediaItems: [] });
    const existing = stored.mediaItems;

    const existingUrls = new Set(existing.map(item => item.url));
    const existingKeys = new Set(existing.map(item => `${item.filename}|${item.parentId || ''}`));

    const toAdd = [];
    const duplicates = [];
    let updatedCount = 0;

    for (const item of newItems) {
        const idx = existing.findIndex(e => e.url === item.url);
        if (idx > -1) {
            const oldItem = existing[idx];
            
            const combinedIds = Array.from(new Set([
                ...(oldItem.associatedIds || []),
                ...(item.associatedIds || [])
            ])).filter(Boolean);

            existing[idx] = { 
                ...oldItem, 
                ...item, 
                associatedIds: combinedIds 
            };
            updatedCount++;
            duplicates.push(item);
            continue;
        }

        const secondaryKey = `${item.filename}|${item.parentId || ''}`;
        if (existingKeys.has(secondaryKey)) {
            toAdd.push({ ...item, isDuplicate: true });
        } else {
            toAdd.push(item);
        }
        existingUrls.add(item.url);
        existingKeys.add(secondaryKey);
    }

    if (toAdd.length === 0 && updatedCount === 0) {
        if (duplicates.length > 0) {
            const dImages = duplicates.filter(i => i.type === 'image').length;
            const dVideos = duplicates.filter(i => i.type === 'video').length;
            const details = [dImages ? `${dImages} img` : '', dVideos ? `${dVideos} vid` : ''].filter(Boolean).join(', ');
            // addLog('skip', `Già presenti in lista: ${duplicates.length} elementi (${details}).`);
        }
        return 0;
    }

    const merged = toAdd.length > 0 ? [...existing, ...toAdd] : existing;
    await chrome.storage.local.set({ mediaItems: merged });
    flashBadge();

    if (updatedCount > 0) addLog('info', `Aggiornati conteggi per ${updatedCount} elementi.`);
    flashBadge();

    const normalCount = toAdd.filter(i => !i.isDuplicate).length;
    const fuzzyDupCount = toAdd.filter(i => i.isDuplicate).length;

    if (normalCount > 0) addLog('success', `Aggiunti ${normalCount} nuovi elementi.`);
    if (fuzzyDupCount > 0) addLog('warn', `Rilevato ${fuzzyDupCount} duplicati (stesso nome/parent) - aggiunti con flag.`);
    if (duplicates.length > 0) addLog('skip', `Saltati ${duplicates.length} duplicati esatti.`);

    const settings = await chrome.storage.sync.get({ soundEnabled: true });
    const newImages = toAdd.filter(i => i.type === 'image').length;
    const newVideos = toAdd.filter(i => i.type === 'video').length;

    let msgLines = [`Trovati ${toAdd.length} nuovi elementi!`];
    const details = [];
    if (newVideos > 0) details.push(`+${newVideos} video`);
    if (newImages > 0) details.push(`+${newImages} immagini`);
    if (details.length) msgLines.push(details.join(' e '));

    chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon_active_128.png',
        title: 'Grok Media Downloader',
        message: msgLines.join('\n'),
        priority: 1,
        silent: !settings.soundEnabled
    });

    return toAdd.length;
}

let isDownloading = false;
let downloadProgress = { 
    total: 0, 
    current: 0, 
    speed: 0,           // items/s
    speedBytes: 0,      // bytes/s
    bytesReceived: 0, 
    bytesTotal: 0,
    eta: 0,
    skippedCount: 0
};
let downloadQueue = [];
let downloadStartTime = 0;
let downloadCompletedCount = 0;
let activeDownloads = new Set();
let downloadByteStats = new Map();
let completedBytes = 0;
let activeDownloadFilter = 'none';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'addLog') {
        addLog(message.level, message.message, message.details);
        return false;
    }
    if (message.action === 'storeMedia') {
        storeMediaItems(message.items).then(n => sendResponse({ ok: true, newCount: n || 0 }));
        return true;
    }
    if (message.action === 'startDownload') {
        startDownloadProcess(message.items, message.filter || 'all');
        sendResponse({ status: 'started' });
        return true;
    }
    if (message.action === 'getQueueStatus') {
        sendResponse({ isDownloading, progress: downloadProgress, filter: activeDownloadFilter });
        return true;
    }
    if (message.action === 'getEffectiveIntercept') {
        chrome.storage.local.get({ interceptActive: true }, (data) => {
            sendResponse({ active: data.interceptActive && !isDownloading });
        });
        return true;
    }
    if (message.action === 'saveToLibrary') {
        enqueueLibrarySave(message.item, sendResponse);
        return true;
    }
    if (message.action === 'stopDownload') {
        if (isDownloading) {
            downloadQueue = [];
            isDownloading = false;
            activeDownloadFilter = 'none';
            syncInterceptionState();
            console.log('[Grok] Queue cleared by user.');
        }
        sendResponse({ ok: true });
        return true;
    }
});

chrome.downloads.onChanged.addListener((delta) => {
    if (activeDownloads.has(delta.id)) {
        if (delta.bytesReceived || delta.totalBytes) {
            const stats = downloadByteStats.get(delta.id) || { received: 0, total: 0 };
            if (delta.bytesReceived) stats.received = delta.bytesReceived.current;
            if (delta.totalBytes) stats.total = delta.totalBytes.current;
            downloadByteStats.set(delta.id, stats);
            updateByteProgress();
        }

        if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
            const stats = downloadByteStats.get(delta.id);
            if (stats && delta.state.current === 'complete') {
                completedBytes += stats.total || stats.received;
            }
            activeDownloads.delete(delta.id);
            downloadByteStats.delete(delta.id);
            
            downloadCompletedCount++;
            downloadProgress.current++;
            
            const elapsedSec = (Date.now() - downloadStartTime) / 1000;
            if (elapsedSec > 0) {
                downloadProgress.speed = downloadCompletedCount / elapsedSec;
                const remaining = downloadProgress.total - downloadProgress.current;
                downloadProgress.eta = Math.round(remaining / downloadProgress.speed) || 0;
            }
            updateByteProgress();
            broadcastProgress();

            if (isDownloading && downloadQueue.length === 0 && activeDownloads.size === 0) {
                finishDownloadProcess();
            }
        }
    }

    if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
        const downloadId = delta.id;
        
        activeDownloads.delete(downloadId);
        
        if (blobUrls.has(downloadId)) {
            const url = blobUrls.get(downloadId);
            URL.revokeObjectURL(url);
            blobUrls.delete(downloadId);
            pendingPaths.delete(url);
        }

        if (delta.state.current === 'interrupted' && delta.error && delta.error.current === 'NETWORK_FAILED') {
            handleRetry(downloadId);
        } else {
            retryCounts.delete(downloadId);
        }

        broadcastProgress();
    }
});

async function handleRetry(downloadId) {
    const item = downloadItems.get(downloadId);
    if (!item) return;

    const count = (retryCounts.get(downloadId) || 0) + 1;
    if (count <= MAX_RETRIES) {
        console.log(`[Grok] Retrying download for ${item.filename} (Attempt ${count}/${MAX_RETRIES})`);
        retryCounts.delete(downloadId);
        downloadItems.delete(downloadId);
        
        await sleep(2000 * count);
        
        downloadQueue.unshift(item);
    } else {
        console.error(`[Grok] Max retries reached for ${item.filename}`);
        retryCounts.delete(downloadId);
        downloadItems.delete(downloadId);
    }
}

function updateByteProgress() {
    let currentBatchReceived = 0;
    let currentBatchTotalKnown = completedBytes;
    
    for (const stats of downloadByteStats.values()) {
        currentBatchReceived += stats.received;
        if (stats.total > 0) currentBatchTotalKnown += stats.total;
        else currentBatchTotalKnown += stats.received; // fallback
    }
    
    downloadProgress.bytesReceived = completedBytes + currentBatchReceived;
    downloadProgress.bytesTotal = currentBatchTotalKnown;
    
    const elapsedSec = (Date.now() - downloadStartTime) / 1000;
    if (elapsedSec > 0) {
        downloadProgress.speedBytes = downloadProgress.bytesReceived / elapsedSec;
    }
}

function finishDownloadProcess() {
    isDownloading = false;
    activeDownloadFilter = 'none';
    downloadProgress = { 
        total: 0, current: 0, speed: 0, speedBytes: 0, 
        bytesReceived: 0, bytesTotal: 0, eta: 0, skippedCount: 0
    };
    downloadByteStats.clear();
    completedBytes = 0;
    stopKeepAlive();
    syncInterceptionState();
    broadcastProgress();
    addLog('success', 'Tutti i download completati.');
}

function updateDownloadBadge() {
    if (!isDownloading) { setBadgeActive(bgInterceptActive); return; }
    const count = Math.max(0, downloadProgress.total - downloadProgress.current);
    if (count > 0) {
        chrome.action.setBadgeText({ text: count.toString() });
        chrome.action.setBadgeBackgroundColor({ color: '#388bfd' });
    } else {
        setBadgeActive(bgInterceptActive);
    }
}

function broadcastProgress() {
    chrome.runtime.sendMessage({ 
        action: 'downloadProgress', 
        progress: downloadProgress,
        filter: activeDownloadFilter
    }).catch(() => { });
    updateDownloadBadge();
}

function startKeepAlive() {
    chrome.alarms.create('grok-keep-alive', { periodInMinutes: 0.4 });
}
function stopKeepAlive() {
    chrome.alarms.clear('grok-keep-alive');
}
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'grok-keep-alive') console.debug('[Grok] SW Alive');
});

async function startDownloadProcess(itemsToDownload, filter = 'all') {
    if (itemsToDownload.length === 0) return;
    
    if (isDownloading) {
        downloadProgress.total += itemsToDownload.length;
        downloadQueue.push(...itemsToDownload);
        broadcastProgress();
        return;
    }

    isDownloading = true;
    activeDownloadFilter = filter;
    downloadQueue.push(...itemsToDownload);
    downloadProgress = { 
        total: itemsToDownload.length, 
        current: 0, 
        speed: 0, 
        speedBytes: 0,
        bytesReceived: 0, 
        bytesTotal: 0,
        eta: 0,
        skippedCount: 0
    };
    downloadStartTime = Date.now();
    downloadCompletedCount = 0;
    completedBytes = 0;
    activeDownloads.clear();
    downloadByteStats.clear();
    
    syncInterceptionState();
    startKeepAlive();
    broadcastProgress();

    const settings = await chrome.storage.sync.get({
        delaySingle: 300,
        batchSize: 50,
        delayBatch: 3000,
        maxSimultaneous: 5,
        skipExisting: true,
        turboMode: false
    });

    const delaySingle = settings.turboMode ? 50 : settings.delaySingle;
    const delayBatch = settings.turboMode ? 500 : settings.delayBatch;
    const maxSimultaneous = settings.turboMode ? 10 : settings.maxSimultaneous;

    let batchCount = 0;
    
    while (isDownloading && (downloadQueue.length > 0 || activeDownloads.size > 0)) {
        if (activeDownloads.size < maxSimultaneous && downloadQueue.length > 0) {
            
            if (batchCount > 0 && batchCount % settings.batchSize === 0) {
                addLog('info', `Pausa Batch (${delayBatch}ms)...`);
                await sleep(delayBatch);
            }

            const item = downloadQueue.shift();
            try {
                const result = await triggerDownload(item, settings.saveMetadata, settings.skipExisting);
                
                if (result && result.skipped) {
                    addLog('skip', `Saltato: ${item.filename} (già esistente).`);
                    downloadProgress.current++;
                    downloadProgress.skippedCount++;
                    broadcastProgress();
                } else {
                    activeDownloads.add(result);
                    batchCount++;
                }
                
                if (downloadQueue.length > 0) await sleep(delaySingle);
            } catch (error) {
                console.error('[Grok] Download trigger failed:', item.filename, error);
                downloadProgress.current++;
                broadcastProgress();
            }
        } else {
            await sleep(200);
            if (!isDownloading) break;
            
            if (downloadQueue.length === 0 && activeDownloads.size === 0) {
                break;
            }
        }
    }

    if (activeDownloads.size === 0) {
        finishDownloadProcess();
    }
}

async function triggerDownload(item, shouldInjectMetadata = true, skipExisting = false) {
    const parentFolder = sanitizePath(item.parentId || item.parentPrompt || 'Generic');
    const safeFilename = item.filename.replace(/[/\\:*?"<>|]/g, '_');
    const fullPath = `Grok_Media/${parentFolder}/${safeFilename}`;

    if (skipExisting) {
        const alreadyExists = await isFileDownloaded(fullPath);
        if (alreadyExists) {
            console.log(`[Grok] Skipping ${fullPath} (already exists in history)`);
            return { skipped: true };
        }
    }

    console.log(`[Grok] Queueing download: ${fullPath} from ${item.url.substring(0, 50)}...`);

    let downloadUrl = item.url;
    let blobUrl = null;

    if (shouldInjectMetadata && item.prompt && (item.url.includes('.jpg') || item.url.includes('.jpeg') || item.url.includes('.png') || item.url.includes('/imagine/') )) {
        try {
            const resp = await fetch(item.url, { cache: 'force-cache' });
            const buffer = await resp.arrayBuffer();
            const modifiedBuffer = injectMetadata(buffer, item.prompt);
            const blob = new Blob([modifiedBuffer], { type: resp.headers.get('content-type') });
            blobUrl = URL.createObjectURL(blob);
            downloadUrl = blobUrl;
            console.log(`[Grok] Metadata injected for ${item.filename}`);
        } catch (e) {
            console.warn('[Grok] Metadata injection failed, falling back to original URL:', e);
        }
    }

    pendingPaths.set(downloadUrl, fullPath);

    return new Promise((resolve, reject) => {
        chrome.downloads.download({
            url: downloadUrl,
            filename: fullPath,
            conflictAction: 'uniquify',
            saveAs: false
        }, (id) => {
            if (blobUrl) {
                blobUrls.set(id, blobUrl);
            }
            downloadItems.set(id, item);
            if (chrome.runtime.lastError) {
                console.error('[Grok] API Error:', chrome.runtime.lastError.message);
                pendingPaths.delete(downloadUrl);
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve(id);
            }
        });
    });
}

function injectMetadata(buffer, prompt) {
    const view = new DataView(buffer);
    const uint8 = new Uint8Array(buffer);
    
    if (view.getUint16(0) === 0xFFD8) {
        console.log('[Grok] Processing JPEG for COM injection');
        const comment = `Prompt: ${prompt}`;
        const commentBytes = new TextEncoder().encode(comment);
        const markerSize = commentBytes.length + 2;
        
        const newUint8 = new Uint8Array(uint8.length + markerSize + 2);
        newUint8.set(uint8.subarray(0, 2));
        
        const offset = 2;
        newUint8[offset] = 0xFF;
        newUint8[offset + 1] = 0xFE;
        newUint8[offset + 2] = (markerSize >> 8) & 0xFF;
        newUint8[offset + 3] = markerSize & 0xFF;
        newUint8.set(commentBytes, offset + 4);
        
        newUint8.set(uint8.subarray(2), offset + markerSize + 2);
        return newUint8.buffer;
    }
    
    if (uint8[0] === 0x89 && uint8[1] === 0x50 && uint8[2] === 0x4E && uint8[3] === 0x47) {
        console.log('[Grok] Processing PNG for tEXt injection');
        const keyword = "Description";
        const text = prompt;
        const chunkData = new TextEncoder().encode(`${keyword}\0${text}`);
        const chunkLength = chunkData.length;
        
        const totalChunkSize = 4 + 4 + chunkLength + 4;
        const newUint8 = new Uint8Array(uint8.length + totalChunkSize);
        
        newUint8.set(uint8.subarray(0, 8));
        
        let offset = 8;
        new DataView(newUint8.buffer).setUint32(offset, chunkLength);
        newUint8[offset + 4] = 116;
        newUint8[offset + 5] = 69;
        newUint8[offset + 6] = 88;
        newUint8[offset + 7] = 116;
        
        newUint8.set(chunkData, offset + 8);
        
        const crc = calculateCRC32(newUint8.subarray(offset + 4, offset + 8 + chunkLength));
        new DataView(newUint8.buffer).setUint32(offset + 8 + chunkLength, crc);
        
        newUint8.set(uint8.subarray(8), offset + totalChunkSize);
        return newUint8.buffer;
    }
    
    return buffer;
}

function calculateCRC32(data) {
    let crc = -1;
    for (let i = 0; i < data.length; i++) {
        let byte = data[i];
        crc ^= byte;
        for (let j = 0; j < 8; j++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
        }
    }
    return (crc ^ -1) >>> 0;
}

async function getMediaSize(url) {
    try {
        const response = await fetch(url, { method: 'HEAD' });
        if (response.ok) {
            return parseInt(response.headers.get('content-length') || '0', 10);
        }
    } catch (e) {
        console.warn('[Grok] Failed to get size for:', url);
    }
    return 0;
}

const librarySaveQueue = [];
let isProcessingLibraryQueue = false;

function enqueueLibrarySave(item, sendResponse) {
    librarySaveQueue.push({ item, sendResponse });
    processLibraryQueue();
}

async function processLibraryQueue() {
    if (isProcessingLibraryQueue || librarySaveQueue.length === 0) return;
    isProcessingLibraryQueue = true;

    while (librarySaveQueue.length > 0) {
        const { item, sendResponse } = librarySaveQueue.shift();
        try {
            const result = await executeSaveToLibrary(item);
            if (sendResponse) sendResponse(result);
        } catch (e) {
            console.error('[Library] Save Error:', e);
            if (sendResponse) sendResponse({ ok: false, error: e.message });
        }
        // Small cooldown to let the process breathe
        await sleep(100);
    }
    isProcessingLibraryQueue = false;
}

async function executeSaveToLibrary(item) {
    const { libraryItems = [] } = await chrome.storage.local.get('libraryItems');
    
    // Check if thumbnail/url matches existing to prevent duplicates
    const isDuplicate = libraryItems.some(li => 
        (li.id === item.id) || 
        (item.prompt && li.prompt === item.prompt && Math.abs(new Date(li.createTime) - new Date(item.createTime)) < 10000)
    );

    if (isDuplicate) {
        return { ok: true, alreadySaved: true };
    }

    const id = item.id || `lib_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const dataUrl = item.url || item.imageUrl || item.videoUrl;

    // 1. Store the heavy data in a dedicated key
    await chrome.storage.local.set({ [`lib_img_${id}`]: dataUrl });

    // 2. Update library metadata manifest
    const metadata = {
        ...item,
        id,
        // We clear the big data from metadata to keep 'libraryItems' array small
        url: null,
        // But for videos, we might want to keep a small thumbnail if available
        imageUrl: item.type === 'video' ? (item.thumbnailUrl || null) : null,
        videoUrl: null,
        savedAt: new Date().toISOString()
    };

    libraryItems.unshift(metadata);
    await chrome.storage.local.set({ libraryItems });
    
    addLog('success', `Salvato in Biblioteca: ${item.type === 'video' ? 'Video' : 'Foto'} 💾`, metadata.prompt?.substring(0, 50) + '...');
    return { ok: true };
}

// ─── Communication ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'getMediaSize') {
        getMediaSize(message.url).then(size => sendResponse({ size }));
        return true; // async response
    }
    if (message.action === 'getLibraryItemData') {
        const key = `lib_img_${message.id}`;
        chrome.storage.local.get(key, (data) => {
            sendResponse({ dataUrl: data[key] });
        });
        return true;
    }
    if (message.action === 'proxyFetch') {
        fetch(message.url)
            .then(res => res.blob())
            .then(blob => {
                const reader = new FileReader();
                reader.onloadend = () => sendResponse({ dataUrl: reader.result });
                reader.onerror = () => sendResponse({ error: 'FileReader failed' });
                reader.readAsDataURL(blob);
            })
            .catch(err => {
                console.error('[Grok Proxy] Fetch failed:', err);
                sendResponse({ error: err.message });
            });
        return true;
    }
    if (message.action === 'downloadWithPath') {
        // Handles downloads from library.js — converts data: URLs to blob:
        // so that Chrome respects the filename parameter.
        const { dataUrl, filename } = message;
        fetch(dataUrl)
            .then(resp => resp.blob())
            .then(blob => {
                const blobUrl = URL.createObjectURL(blob);
                pendingPaths.set(blobUrl, filename);

                chrome.downloads.download({
                    url: blobUrl,
                    filename: filename,
                    conflictAction: 'uniquify',
                    saveAs: false
                }, (id) => {
                    if (chrome.runtime.lastError) {
                        pendingPaths.delete(blobUrl);
                        URL.revokeObjectURL(blobUrl);
                        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                    } else {
                        blobUrls.set(id, blobUrl);
                        sendResponse({ ok: true, id });
                    }
                });
            })
            .catch(e => {
                console.error('[Grok] downloadWithPath error:', e);
                sendResponse({ ok: false, error: e.message });
            });
        return true;
    }
    if (message.action === 'deleteLibraryItem') {
        chrome.storage.local.get({ libraryItems: [] }, async (data) => {
            const filtered = data.libraryItems.filter(i => i.id !== message.id);
            await chrome.storage.local.set({ libraryItems: filtered });
            await chrome.storage.local.remove(`lib_img_${message.id}`);
            sendResponse({ ok: true });
        });
        return true;
    }
});
