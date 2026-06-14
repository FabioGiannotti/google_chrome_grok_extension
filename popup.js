'use strict';

const el = (id) => document.getElementById(id);

let mediaItems = [];
let interceptActive = true;
let currentSearchQuery = '';
let currentTypeFilter = 'all';
let currentTimeFilter = 'all';  // 'all' | 'today' | 'yesterday' | '3days' | 'week' | 'month'
let currentViewMode = 'table';   // 'table' | 'grid'
let currentSortKey = null;       // 'type' | 'filename' | 'details'
let currentSortDir = 'asc';      // 'asc' | 'desc'
let loggingEnabled = false;
let selectedIndices = new Set(); // Stores globalIdx of selected items
let lastCheckedIdx = -1;         // For Shift+Click range

let currentPreviewIndex = -1;
let currentDisplayItems = [];    // filtered+sorted items visible in the current view

document.addEventListener('DOMContentLoaded', async () => {
    await loadInterceptState();
    await loadAndRender();
    await checkDownloadStatus();

    if (window.location.search.includes('popout=true')) {
        document.body.classList.add('popout-mode');
    }

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === 'downloadProgress') {
            updateProgressUI(msg.progress, msg.filter);
        }
        if (msg.action === 'newLog') {
            appendLogToUI(msg.log);
        }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && 'mediaItems' in changes) {
            mediaItems = changes.mediaItems.newValue || [];
            const oldItems = changes.mediaItems.oldValue || [];
            if (mediaItems.length > oldItems.length) {
                const diff = mediaItems.length - oldItems.length;
                showToast(`Rilevati ${diff} nuovi elementi!`, 'success');
            }
            renderView(mediaItems);
        }
    });

    // Logging listeners
    el('logToggle').addEventListener('click', openLogModal);
    el('closeLogModal').addEventListener('click', () => el('logModal').style.display = 'none');
    el('clearLogsBtn').addEventListener('click', clearLogs);
    el('loggingEnabled').addEventListener('change', (e) => {
        loggingEnabled = e.target.checked;
        chrome.storage.local.set({ loggingEnabled });
        if (loggingEnabled) addLogMessage('info', 'Registrazione log attivata.');
    });

    // Settings & Library links
    el('settingsBtn').addEventListener('click', (e) => {
        e.preventDefault();
        chrome.runtime.openOptionsPage();
    });

    el('libraryBtn').addEventListener('click', () => {
        chrome.tabs.create({ url: 'library.html' });
    });

    el('popOutBtn').addEventListener('click', () => {
        console.log('[Grok] Pop-out requested');
        const url = chrome.runtime.getURL('popup.html?popout=true');
        chrome.windows.create({
            url: url,
            type: 'popup',
            width: 1000,
            height: 1200,
            focused: true
        }, (win) => {
            if (chrome.runtime.lastError) {
                console.error('[Grok] Pop-out failed:', chrome.runtime.lastError.message);
                chrome.tabs.create({ url: url });
            } else {
                // Set alwaysOnTop via update
                chrome.windows.update(win.id, { alwaysOnTop: true }, () => {
                    if (chrome.runtime.lastError) {
                        console.warn('[Grok] Could not set alwaysOnTop:', chrome.runtime.lastError.message);
                    }
                    window.close();
                });
            }
        });
    });

    // Download buttons
    el('dlAll').addEventListener('click', () => startDownload('all'));
    el('dlSelected').addEventListener('click', () => startDownload('selected'));
    el('dlImages').addEventListener('click', () => startDownload('image'));
    el('dlVideos').addEventListener('click', () => startDownload('video'));

    // Select all checkbox
    el('selectAll').addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        const visibleItems = currentDisplayItems;
        if (isChecked) {
            visibleItems.forEach(item => selectedIndices.add(item.globalIdx));
        } else {
            visibleItems.forEach(item => selectedIndices.delete(item.globalIdx));
        }
        updateSelectionUI();
    });

    // Stop
    el('stopDownloadBtn').addEventListener('click', async () => {
        const confirmed = await showConfirm('Stoppa Download', 'Vuoi fermare i download rimanenti? Quelli già avviati non verranno bloccati.');
        if (confirmed) {
            chrome.runtime.sendMessage({ action: 'stopDownload' }, () => {
                updateProgressUI({ total: 0, current: 0, speed: 0, eta: 0 });
            });
        }
    });

    // Management buttons
    el('clearList').addEventListener('click', clearList);
    el('pauseIntercept').addEventListener('click', () => setIntercept(false));
    el('resumeIntercept').addEventListener('click', () => setIntercept(true));

    // Export JSON / CSV
    el('exportJson').addEventListener('click', () => exportData('json'));
    el('exportCsv').addEventListener('click', () => exportData('csv'));

    // Type filter
    el('typeFilter').addEventListener('change', (e) => {
        currentTypeFilter = e.target.value;
        chrome.storage.local.set({ currentTypeFilter });
        renderView(mediaItems);
    });

    // Time filter
    el('timeFilter').addEventListener('change', (e) => {
        currentTimeFilter = e.target.value;
        chrome.storage.local.set({ currentTimeFilter });
        renderView(mediaItems);
    });

    // Search input
    el('searchInput').addEventListener('input', (e) => {
        currentSearchQuery = e.target.value.toLowerCase().trim();
        chrome.storage.local.set({ currentSearchQuery });
        renderView(mediaItems);
    });

    // View toggle (table / grid)
    el('viewToggle').addEventListener('click', () => {
        currentViewMode = currentViewMode === 'table' ? 'grid' : 'table';
        el('viewToggle').textContent = currentViewMode === 'table' ? '🔲 Griglia' : '☰ Lista';
        chrome.storage.local.set({ currentViewMode });
        renderView(mediaItems);
    });

    // Column sort (delegated on thead)
    document.querySelector('.media-table thead').addEventListener('click', (e) => {
        const th = e.target.closest('[data-sort]');
        if (!th) return;
        const key = th.getAttribute('data-sort');
        if (currentSortKey === key) {
            currentSortDir = currentSortDir === 'asc' ? 'desc' : 'asc';
        } else {
            currentSortKey = key;
            currentSortDir = 'asc';
        }
        chrome.storage.local.set({ currentSortKey, currentSortDir });
        updateSortHeaders();
        renderView(mediaItems);
    });

    // Sort toggle button in search bar (shortcut for filename sort)
    el('sortToggle').addEventListener('click', () => {
        if (currentSortKey === 'filename') {
            currentSortDir = currentSortDir === 'asc' ? 'desc' : 'asc';
        } else {
            currentSortKey = 'filename';
            currentSortDir = 'asc';
        }
        chrome.storage.local.set({ currentSortKey, currentSortDir });
        updateSortHeaders();
        renderView(mediaItems);
    });

    initPreviewHover();
});

function updateSortHeaders() {
    document.querySelectorAll('.media-table th[data-sort]').forEach(th => {
        th.classList.remove('sort-asc', 'sort-desc');
        if (th.getAttribute('data-sort') === currentSortKey) {
            th.classList.add(currentSortDir === 'asc' ? 'sort-asc' : 'sort-desc');
        }
    });
}

function initPreviewHover() {
    const overlay = el('previewOverlay');
    const content = el('previewContent');
    const tbody = el('mediaBody');
    const prevBtn = el('previewPrev');
    const nextBtn = el('previewNext');

    function openPreviewAt(idx) {
        const item = currentDisplayItems[idx];
        if (!item) return;
        currentPreviewIndex = idx;

        content.innerHTML = '';
        overlay.style.display = 'flex';
        overlay.offsetHeight;
        overlay.classList.add('active');

        if (item.type === 'video') {
            const video = document.createElement('video');
            video.src = item.url;
            video.autoplay = true;
            video.loop = true;
            video.muted = false;
            video.volume = 1.0;
            video.controls = true;
            video.playsInline = true;
            content.appendChild(video);
        } else {
            const img = document.createElement('img');
            img.src = item.url;
            content.appendChild(img);
        }
    }

    tbody.addEventListener('mouseover', (e) => {
        const thumbCell = e.target.closest('.thumb-cell');
        if (!thumbCell) return;
        const row = thumbCell.closest('.tree-item');
        if (!row) return;
        const gIdx = parseInt(row.getAttribute('data-idx'));
        // gIdx is the global mediaItems idx; find position in currentDisplayItems
        const pos = currentDisplayItems.findIndex(i => i.globalIdx === gIdx);
        if (pos === -1) return;
        openPreviewAt(pos);
    });

    el('mediaGrid').addEventListener('click', (e) => {
        const card = e.target.closest('.grid-card');
        if (!card || e.target.closest('.grid-copy-btn')) return;
        const gIdx = parseInt(card.getAttribute('data-idx'));
        const pos = currentDisplayItems.findIndex(i => i.globalIdx === gIdx);
        if (pos === -1) return;
        openPreviewAt(pos);
    });

    // Close on mouse leave table thumb cell
    tbody.addEventListener('mouseout', (e) => {
        const thumbCell = e.target.closest('.thumb-cell');
        if (!thumbCell) return;
        const related = e.relatedTarget;
        if (related && (overlay.contains(related) || overlay === related)) return;
        closePreview();
    });

    // Close on mouse leave grid card (only for hover, but we moved grid to click)
    // removed mouseout listener for grid card to prevent accidental closing

    overlay.addEventListener('mouseleave', () => closePreview());
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closePreview();
    });

    // Arrow navigation buttons
    prevBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (currentPreviewIndex > 0) openPreviewAt(currentPreviewIndex - 1);
    });

    nextBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (currentPreviewIndex < currentDisplayItems.length - 1) openPreviewAt(currentPreviewIndex + 1);
    });

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
        if (!overlay.classList.contains('active')) return;
        if (e.key === 'ArrowLeft') { e.preventDefault(); if (currentPreviewIndex > 0) openPreviewAt(currentPreviewIndex - 1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); if (currentPreviewIndex < currentDisplayItems.length - 1) openPreviewAt(currentPreviewIndex + 1); }
        if (e.key === 'Escape') closePreview();
    });

    function closePreview() {
        if (!overlay.classList.contains('active')) return;
        overlay.classList.remove('active');
        setTimeout(() => {
            if (!overlay.classList.contains('active')) {
                overlay.style.display = 'none';
                content.innerHTML = '';
                currentPreviewIndex = -1;
            }
        }, 200);
    }
}

// ─── Load ─────────────────────────────────────────────────────────────────────
async function loadAndRender() {
    const data = await chrome.storage.local.get({
        mediaItems: [],
        currentSearchQuery: '',
        currentTypeFilter: 'all',
        currentTimeFilter: 'all',
        currentViewMode: 'table',
        currentSortKey: null,
        currentSortDir: 'asc'
    });

    mediaItems = data.mediaItems;
    currentSearchQuery = data.currentSearchQuery;
    currentTypeFilter = data.currentTypeFilter;
    currentTimeFilter = data.currentTimeFilter;
    currentViewMode = data.currentViewMode;
    currentSortKey = data.currentSortKey;
    currentSortDir = data.currentSortDir;

    // Sync UI
    if (el('typeFilter')) el('typeFilter').value = currentTypeFilter;
    if (el('timeFilter')) el('timeFilter').value = currentTimeFilter;
    if (el('searchInput')) el('searchInput').value = currentSearchQuery;
    el('viewToggle').textContent = currentViewMode === 'table' ? '🔲 Griglia' : '☰ Lista';
    updateSortHeaders();

    renderView(mediaItems);
}

async function loadInterceptState() {
    const data = await chrome.storage.local.get({ interceptActive: true });
    interceptActive = data.interceptActive;
    updateInterceptUI();
}

// ─── View Router ──────────────────────────────────────────────────────────────
function renderView(items) {
    if (currentViewMode === 'grid') {
        el('mediaTable').style.display = 'none';
        el('mediaGrid').style.display = '';
        renderGrid(items);
    } else {
        el('mediaTable').style.display = '';
        el('mediaGrid').style.display = 'none';
        renderTable(items);
    }
}

// ─── Filter + Sort Helper ─────────────────────────────────────────────────────
function getDisplayItems(items) {
    let displayItems = items.map((item, globalIdx) => ({ ...item, globalIdx }));

    if (currentTypeFilter !== 'all') {
        displayItems = displayItems.filter(i => i.type === currentTypeFilter);
    }

    if (currentTimeFilter !== 'all') {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const yesterday = today - 86400000;
        const threeDays = today - (3 * 86400000);
        const week = today - (7 * 86400000);
        const month = today - (30 * 86400000); // approssimativo

        displayItems = displayItems.filter(i => {
            if (!i.createTime) return false;
            const time = new Date(i.createTime).getTime();
            if (currentTimeFilter === 'today') return time >= today;
            if (currentTimeFilter === 'yesterday') return time >= yesterday && time < today;
            if (currentTimeFilter === '3days') return time >= threeDays;
            if (currentTimeFilter === 'week') return time >= week;
            if (currentTimeFilter === 'month') return time >= month;
            return true;
        });
    }

    if (currentSearchQuery) {
        displayItems = displayItems.filter(i => {
            return (i.filename && i.filename.toLowerCase().includes(currentSearchQuery)) ||
                (i.prompt && i.prompt.toLowerCase().includes(currentSearchQuery)) ||
                (i.url && i.url.toLowerCase().includes(currentSearchQuery));
        });
    }

    // Sorting
    if (currentSortKey) {
        displayItems.sort((a, b) => {
            const va = (a[currentSortKey] || '').toString().toLowerCase();
            const vb = (b[currentSortKey] || '').toString().toLowerCase();
            return currentSortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
        });
    }

    // Keep a global ref for preview navigation
    currentDisplayItems = displayItems;
    return displayItems;
}

// ─── Render Table ─────────────────────────────────────────────────────────────
function renderTable(items) {
    const tbody = el('mediaBody');
    const emptyState = el('emptyState');

    const displayItems = getDisplayItems(items);

    const images = displayItems.filter(i => i.type === 'image');
    const videos = displayItems.filter(i => i.type === 'video');
    el('countImages').textContent = `🖼 ${images.length} immagini`;
    el('countVideos').textContent = `🎬 ${videos.length} video`;

    if (displayItems.length === 0) {
        el('mediaTable').style.display = 'none';
        emptyState.style.display = 'flex';
        el('emptyState').innerHTML = currentSearchQuery && items.length > 0
            ? `<div class="empty-icon">🔍</div><div>Nessun risultato per "${escHtml(currentSearchQuery)}"</div>`
            : `<div class="empty-icon">📭</div><div>Nessun media intercettato</div><div class="empty-sub">Vai su grok.com e genera immagini o video</div>`;
        return;
    }

    el('mediaTable').style.display = '';
    emptyState.style.display = 'none';

    chrome.storage.sync.get({ thumbW: 60, thumbH: 40 }, ({ thumbW, thumbH }) => {
        const groups = {};
        displayItems.forEach((item) => {
            const pid = item.parentId || 'Generico';
            if (!groups[pid]) groups[pid] = { items: [], id: pid };
            groups[pid].items.push(item);
        });

        let html = '';
        for (const pid in groups) {
            const group = groups[pid];
            const groupPrompt = group.items.find(i => i.prompt)?.prompt || 'Nessun prompt / Default';

            html += `<tr class="group-header" data-parent-id="${escHtml(pid)}">
                <td colspan="8">
                    <span class="toggle-icon">▼</span>
                    <span class="group-title" title="${escHtml(groupPrompt)}">${escHtml(groupPrompt)}</span>
                    <span class="group-count">${group.items.length} elementi</span>
                    <div class="source-info" style="margin-left: 20px; margin-top: 2px; font-size: 11px;">ID: ${escHtml(pid)}</div>
                </td>
            </tr>`;

            html += group.items.map((item) => {
                const isVideo = item.type === 'video';
                const badgeClass = isVideo ? 'type-video' : 'type-image';
                const badgeLabel = isVideo ? '🎬 Video' : '🖼 Immagine';
                const thumb = item.thumbnailUrl
                    ? `<img src="${escHtml(item.thumbnailUrl)}" alt="" loading="lazy" style="width:${thumbW}px;height:${thumbH}px;object-fit:cover;border-radius:4px">`
                    : `<div class="thumb-placeholder" style="width:${thumbW}px;height:${thumbH}px">${isVideo ? '🎬' : '🖼'}</div>`;
                const promptText = item.prompt ? escHtml(item.prompt) : '—';
                const promptClass = item.prompt ? 'prompt-cell' : 'prompt-cell no-prompt';
                const detailsText = item.details ? escHtml(item.details) : '—';

                const promptHtml = item.prompt
                    ? `<div class="prompt-wrapper">
                        <button class="copy-btn" title="Copia prompt" data-prompt="${escHtml(item.prompt)}">📋</button>
                        <span class="prompt-text">${promptText}</span>
                       </div>`
                    : `<span class="prompt-text">—</span>`;

                const dupClass = item.isDuplicate ? ' is-duplicate' : '';
                const supClass = item.isSuperseded ? ' is-superseded' : '';

                const extendedBadge = item.isExtended ? '<div class="extended-badge">ESTESO</div>' : '';
                const supersededBadge = item.isSuperseded ? '<div class="superseded-badge">OLD</div>' : '';

                const sourceInfo = (item.isExtended && item.originalPostId)
                    ? `<div class="source-info">Sorgente: ${escHtml(item.originalPostId)}</div>`
                    : '';

                const extensionInfo = (item.isExtended && item.extensionStartTime)
                    ? `<div class="source-info">Start from: ${escHtml(item.extensionStartTime)}s</div>`
                    : '';

                const isSelected = selectedIndices.has(item.globalIdx);
                const selectRowClass = isSelected ? 'item-selected' : '';

                const sizeId = `size-${item.globalIdx}`;
                fetchMediaSize(item.url, sizeId);

                return `<tr class="tree-item${dupClass}${supClass} ${selectRowClass}" data-parent-id="${escHtml(pid)}" data-idx="${item.globalIdx}">
                    <td class="select-cell">
                        <input type="checkbox" class="select-checkbox" data-idx="${item.globalIdx}" ${isSelected ? 'checked' : ''}>
                    </td>
                    <td>
                        <span class="type-badge ${badgeClass}">${badgeLabel}</span>
                        ${extendedBadge}
                        ${supersededBadge}
                    </td>
                    <td class="thumb-cell">${thumb}</td>
                    <td class="filename-cell" title="${escHtml(item.filename)}">
                        ${escHtml(item.filename)}
                        ${sourceInfo}
                    </td>
                    <td class="details-cell">
                        ${detailsText}
                        ${extensionInfo}
                    </td>
                    <td class="date-cell">${formatItalianDate(item.createTime)}</td>
                    <td class="size-cell" id="${sizeId}">...</td>
                    <td class="${promptClass}" title="${escHtml(item.prompt || '')}">${promptHtml}</td>
                </tr>`;
            }).join('');
        }

        tbody.innerHTML = html;

        // Checkbox click handler (with Shift support)
        tbody.addEventListener('click', (e) => {
            const cb = e.target.closest('.select-checkbox');
            if (!cb) return;
            handleSelectionClick(e, parseInt(cb.getAttribute('data-idx')));
        });

        // Group collapse
        tbody.querySelectorAll('.group-header').forEach(header => {
            header.addEventListener('click', () => {
                const pid = header.getAttribute('data-parent-id');
                const isCollapsed = header.classList.toggle('collapsed');
                tbody.querySelectorAll(`.tree-item[data-parent-id="${pid}"]`).forEach(row => {
                    row.classList.toggle('hidden', isCollapsed);
                });
            });
        });

        // Copy handler (event delegation avoids re-adding)
        tbody.onclick = (e) => {
            const btn = e.target.closest('.copy-btn');
            if (!btn) return;
            const prompt = btn.getAttribute('data-prompt');
            if (!prompt) return;
            navigator.clipboard.writeText(prompt).then(() => {
                const old = btn.textContent;
                btn.textContent = '✅';
                btn.classList.add('copy-success');
                setTimeout(() => { btn.textContent = old; btn.classList.remove('copy-success'); }, 1500);
            }).catch(() => {
                btn.textContent = '❌';
                setTimeout(() => { btn.textContent = '📋'; }, 1500);
            });
        };
    });
}

// ─── Render Grid ──────────────────────────────────────────────────────────────
function renderGrid(items) {
    const grid = el('mediaGrid');
    const emptyState = el('emptyState');

    const displayItems = getDisplayItems(items);

    const images = displayItems.filter(i => i.type === 'image');
    const videos = displayItems.filter(i => i.type === 'video');
    el('countImages').textContent = `🖼 ${images.length} immagini`;
    el('countVideos').textContent = `🎬 ${videos.length} video`;

    if (displayItems.length === 0) {
        grid.style.display = 'none';
        emptyState.style.display = 'flex';
        el('emptyState').innerHTML = currentSearchQuery && items.length > 0
            ? `< div class="empty-icon" >🔍</div > <div>Nessun risultato per "${escHtml(currentSearchQuery)}"</div>`
            : `< div class="empty-icon" >📭</div ><div>Nessun media intercettato</div><div class="empty-sub">Vai su grok.com e genera immagini o video</div>`;
        return;
    }

    grid.style.display = '';
    emptyState.style.display = 'none';

    grid.innerHTML = displayItems.map((item) => {
        const isVideo = item.type === 'video';
        const isSelected = selectedIndices.has(item.globalIdx);
        const selectCardClass = isSelected ? 'item-selected' : '';
        const badgeClass = isVideo ? 'type-video' : 'type-image';
        const badgeLabel = isVideo ? '🎬' : '🖼';
        const thumbEl = item.thumbnailUrl
            ? `<img class="grid-thumb" src="${escHtml(item.thumbnailUrl)}" alt="" loading="lazy">`
            : `<div class="grid-thumb-placeholder">${isVideo ? '🎬' : '🖼'}</div>`;
        const dupBadge = item.isDuplicate ? `<span class="grid-dup-badge">DUP</span>` : '';
        const copyBtn = item.prompt
            ? `<button class="grid-copy-btn" data-prompt="${escHtml(item.prompt)}" title="Copia prompt">📋</button>`
            : '';

        const sizeId = `grid-size-${item.globalIdx}`;
        fetchMediaSize(item.url, sizeId);

        return `<div class="grid-card ${selectCardClass}" data-idx="${item.globalIdx}" title="${escHtml(item.filename)}">
                    <div class="grid-select-wrap">
                        <input type="checkbox" class="grid-checkbox select-checkbox" data-idx="${item.globalIdx}" ${isSelected ? 'checked' : ''}>
                    </div>
                    ${thumbEl}
                    <div class="grid-size-tag" id="${sizeId}">...</div>
                <span class="grid-badge ${badgeClass}" style="background:${isVideo ? 'rgba(210,153,34,0.85)' : 'rgba(56,139,253,0.85)'}; color:#fff">${badgeLabel}</span>
            ${dupBadge}
            ${copyBtn}
                <div class="grid-info">
                    <div class="grid-filename">${escHtml(item.filename)}</div>
                </div>
        </div>`;
    }).join('');

    // Grid checkbox handling
    grid.addEventListener('click', (e) => {
        const cb = e.target.closest('.select-checkbox');
        if (cb) {
            e.stopPropagation();
            handleSelectionClick(e, parseInt(cb.getAttribute('data-idx')));
        }
    });

    // Copy in grid
    grid.onclick = (e) => {
        const btn = e.target.closest('.grid-copy-btn');
        if (!btn) return;
        e.stopPropagation();
        const prompt = btn.getAttribute('data-prompt');
        if (prompt) {
            navigator.clipboard.writeText(prompt).then(() => {
                btn.textContent = '✅';
                setTimeout(() => { btn.textContent = '📋'; }, 1500);
            });
        }
    };
}

// ─── Export ───────────────────────────────────────────────────────────────────
function exportData(format) {
    const displayItems = getDisplayItems(mediaItems);
    if (displayItems.length === 0) {
        el('statusText').textContent = 'Nessun elemento da esportare';
        return;
    }

    let content, mime, ext;

    if (format === 'json') {
        content = JSON.stringify(displayItems.map(({ globalIdx, ...rest }) => rest), null, 2);
        mime = 'application/json';
        ext = 'json';
    } else {
        const cols = ['type', 'filename', 'url', 'thumbnailUrl', 'prompt', 'parentId', 'details'];
        const rows = displayItems.map(item =>
            cols.map(c => `"${(item[c] || '').toString().replace(/"/g, '""')}"`).join(',')
        );
        content = [cols.join(','), ...rows].join('\n');
        mime = 'text/csv';
        ext = 'csv';
    }

    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `grok_media_${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
    el('statusText').textContent = `Esportati ${displayItems.length} elementi`;
}

// ─── Modal ────────────────────────────────────────────────────────────────────
function showConfirm(title, message) {
    return new Promise((resolve) => {
        const overlay = el('confirmModal');
        el('modalTitle').textContent = title;
        el('modalBody').textContent = message;
        overlay.style.display = 'flex';

        const onConfirm = () => { cleanup(); resolve(true); };
        const onCancel = () => { cleanup(); resolve(false); };
        const cleanup = () => {
            overlay.style.display = 'none';
            el('modalConfirm').removeEventListener('click', onConfirm);
            el('modalCancel').removeEventListener('click', onCancel);
        };

        el('modalConfirm').addEventListener('click', onConfirm);
        el('modalCancel').addEventListener('click', onCancel);
    });
}

// ─── Selection Logic ─────────────────────────────────────────────────────────
function handleSelectionClick(e, globalIdx) {
    const isChecked = e.target.checked;

    if (e.shiftKey && lastCheckedIdx !== -1) {
        // Range selection
        const visibleItems = currentDisplayItems;
        const start = visibleItems.findIndex(i => i.globalIdx === lastCheckedIdx);
        const end = visibleItems.findIndex(i => i.globalIdx === globalIdx);

        if (start !== -1 && end !== -1) {
            const min = Math.min(start, end);
            const max = Math.max(start, end);
            for (let i = min; i <= max; i++) {
                if (isChecked) selectedIndices.add(visibleItems[i].globalIdx);
                else selectedIndices.delete(visibleItems[i].globalIdx);
            }
        }
    } else {
        // Single selection
        if (isChecked) selectedIndices.add(globalIdx);
        else selectedIndices.delete(globalIdx);
    }

    lastCheckedIdx = globalIdx;
    updateSelectionUI();
}

function updateSelectionUI() {
    const count = selectedIndices.size;
    el('selectedCount').textContent = count;
    el('dlSelected').disabled = (count === 0);

    // Sync checkboxes and backgrounds in current view
    if (currentViewMode === 'table') {
        renderTable(mediaItems);
    } else {
        renderGrid(mediaItems);
    }
}

// ─── Download ─────────────────────────────────────────────────────────────────
async function startDownload(filter) {
    let filtered;
    if (filter === 'selected') {
        filtered = mediaItems.filter((item, idx) => selectedIndices.has(idx) && !item.isSuperseded);
    } else if (filter === 'all') {
        filtered = mediaItems.filter(i => !i.isSuperseded);
    } else {
        filtered = mediaItems.filter(i => i.type === filter && !i.isSuperseded);
    }

    if (filtered.length === 0) {
        showToast('Nessun elemento da scaricare', 'info');
        return;
    }

    const typeLabels = {
        all: 'elementi',
        selected: 'elementi selezionati',
        image: 'immagini',
        video: 'video'
    };
    const typeLabel = typeLabels[filter] || 'elementi';
    const confirmed = await showConfirm('Avvia Download', `Sei sicuro di voler scaricare ${filtered.length} ${typeLabel}? Il processo avverrà in background.`);
    if (!confirmed) return;

    el('statusText').textContent = `Avvio download di ${filtered.length} elementi…`;
    chrome.runtime.sendMessage({ action: 'startDownload', items: filtered, filter }, (resp) => {
        if (resp && resp.status === 'started') {
            showToast(`Download avviato: ${filtered.length} file`, 'success');
            el('statusText').textContent = 'In coda per il download...';
        }
    });
}

function formatETA(seconds) {
    if (!seconds || seconds <= 0) return '';
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}

function formatBytes(bytes, decimals = 2) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function updateProgressUI(progress, activeFilter = 'none') {
    const pCont = el('progressContainer');
    const pFill = el('progressFill');
    const pText = el('progressText');
    const pMeta = el('progressMeta');
    const statusText = el('statusText');

    const btnAll = el('dlAll');
    const btnSelected = el('dlSelected');
    const btnImages = el('dlImages');
    const btnVideos = el('dlVideos');

    if (!progress || progress.total === 0) {
        pCont.style.display = 'none';
        pMeta.textContent = '';
        statusText.textContent = 'Pronto';

        // Re-enable and reset active state
        [btnAll, btnSelected, btnImages, btnVideos].forEach(b => {
            b.disabled = b.id === 'dlSelected' ? (selectedIndices.size === 0) : false;
            b.classList.remove('btn-active-state');
        });
        btnAll.classList.add('btn-primary');
        [btnSelected, btnImages, btnVideos].forEach(b => b.classList.add('btn-accent'));
        return;
    }

    pCont.style.display = 'block';
    statusText.textContent = 'Download in corso...';

    // Disable all and highlight active
    [btnAll, btnSelected, btnImages, btnVideos].forEach(b => {
        b.disabled = true;
        b.classList.remove('btn-active-state', 'btn-primary');
        b.classList.add('btn-accent');
    });

    if (activeFilter === 'all') {
        btnAll.classList.add('btn-active-state', 'btn-primary');
        btnAll.classList.remove('btn-accent');
    } else if (activeFilter === 'selected') {
        btnSelected.classList.add('btn-active-state', 'btn-primary');
        btnSelected.classList.remove('btn-accent');
    } else if (activeFilter === 'image') {
        btnImages.classList.add('btn-active-state', 'btn-primary');
        btnImages.classList.remove('btn-accent');
    } else if (activeFilter === 'video') {
        btnVideos.classList.add('btn-active-state', 'btn-primary');
        btnVideos.classList.remove('btn-accent');
    }

    const pct = Math.round((progress.current / progress.total) * 100);
    pFill.style.width = `${pct}%`;

    let textStr = `${progress.current} / ${progress.total} (${pct}%)`;
    if (progress.skippedCount > 0) {
        textStr += ` <span class="skipped-count" style="color: #ff4d4d; font-weight: 600;">(${progress.skippedCount} saltati)</span>`;
    }
    if (progress.bytesReceived > 0) {
        textStr += `  ·  ${formatBytes(progress.bytesReceived)}`;
        if (progress.bytesTotal > progress.bytesReceived) {
            textStr += ` / ${formatBytes(progress.bytesTotal)}`;
        }
    }
    pText.innerHTML = textStr;

    // Speed + ETA
    const speedStr = progress.speedBytes
        ? `${formatBytes(progress.speedBytes)}/s`
        : (progress.speed ? `${progress.speed.toFixed(1)} it/s` : '');

    const etaStr = progress.eta ? `ETA ${formatETA(progress.eta)}` : '';
    pMeta.textContent = [speedStr, etaStr].filter(Boolean).join('  ·  ');
}

async function checkDownloadStatus() {
    chrome.runtime.sendMessage({ action: 'getQueueStatus' }, (resp) => {
        if (chrome.runtime.lastError) return;
        if (resp && resp.isDownloading && resp.progress) {
            updateProgressUI(resp.progress, resp.filter);
        } else {
            updateProgressUI(null);
        }
    });
}

// ─── Clear ────────────────────────────────────────────────────────────────────
async function clearList() {
    const confirmed = await showConfirm('Svuota elenco', 'Sei sicuro? Tutti i media intercettati verranno eliminati dalla lista.');
    if (!confirmed) return;
    await chrome.storage.local.set({ mediaItems: [] });
    mediaItems = [];
    renderView([]);
    el('statusText').textContent = 'Elenco svuotato';
}

// ─── Interception Control ─────────────────────────────────────────────────────
async function setIntercept(active) {
    interceptActive = active;
    await chrome.storage.local.set({ interceptActive: active });
    updateInterceptUI();
}

function updateInterceptUI() {
    const chip = el('interceptState');
    if (interceptActive) {
        chip.textContent = '● Intercettazione attiva';
        chip.className = 'stat-chip chip-active';
        el('pauseIntercept').classList.add('btn-active-state');
        el('resumeIntercept').classList.remove('btn-active-state');
    } else {
        chip.textContent = '⏸ Intercettazione in pausa';
        chip.className = 'stat-chip chip-paused';
        el('pauseIntercept').classList.remove('btn-active-state');
        el('resumeIntercept').classList.add('btn-active-state');
    }
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function escHtml(str) {
    if (str === null || str === undefined) return '';
    const s = String(str);
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Date Formatter (Italian locale) ─────────────────────────────────────────
function formatItalianDate(str) {
    if (!str) return '—';
    const d = new Date(str);
    if (isNaN(d.getTime())) return str;
    return d.toLocaleString('it-IT', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// ─── Logging UI ──────────────────────────────────────────────────────────────
async function openLogModal() {
    const data = await chrome.storage.local.get({ logs: [], loggingEnabled: false });
    loggingEnabled = data.loggingEnabled;
    el('loggingEnabled').checked = loggingEnabled;
    el('logModal').style.display = 'flex';
    renderLogs(data.logs);
}

function renderLogs(logs) {
    const container = el('logList');
    container.innerHTML = '';
    logs.forEach(log => appendLogToUI(log, true));
}

function appendLogToUI(log, isBatch = false) {
    const container = el('logList');
    if (!container) return;
    const entry = document.createElement('div');
    entry.className = `log-entry log-${log.level}`;
    entry.innerHTML = `<span class="log-time">[${log.time}]</span> <span class="log-msg">${escHtml(log.message)}</span>`;
    if (log.details) {
        entry.title = log.details;
        entry.style.cursor = 'help';
    }

    if (isBatch) {
        container.appendChild(entry);
    } else {
        container.prepend(entry);
    }
}

async function clearLogs() {
    await chrome.storage.local.set({ logs: [] });
    renderLogs([]);
}

function addLogMessage(level, message, details = '') {
    chrome.runtime.sendMessage({ action: 'addLog', level, message, details }).catch(() => { });
}
// ─── Toast System ─────────────────────────────────────────────────────────────
function showToast(message, type = 'info') {
    const container = el('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    if (type === 'error') icon = '❌';

    toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => toast.remove(), 3000);
    }, 3000);
}

// ─── Size Detection ──────────────────────────────────────────────────────────
const sizeCache = new Map();

async function fetchMediaSize(url, elementId) {
    if (sizeCache.has(url)) {
        updateSizeElement(elementId, sizeCache.get(url));
        return;
    }

    chrome.runtime.sendMessage({ action: 'getMediaSize', url }, (response) => {
        if (response && response.size !== undefined) {
            sizeCache.set(url, response.size);
            updateSizeElement(elementId, response.size);
        } else {
            updateSizeElement(elementId, 0);
        }
    });
}

function updateSizeElement(id, bytes) {
    const element = document.getElementById(id);
    if (!element) return;
    element.textContent = bytes > 0 ? formatBytes(bytes) : 'N/A';
}
