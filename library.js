let allItems = [];
let currentFilter = { text: '', type: 'image', ratio: 'all', date: '3days', dateStart: '', dateEnd: '', userEmail: 'all' };

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Lazy-load queue ──────────────────────────────────────────────────────────
// Limits concurrent chrome.runtime.sendMessage('getLibraryItemData') calls to
// MAX_CONCURRENT to avoid flooding the message bus when many cards are visible.
const MAX_CONCURRENT = 3;
let _activeLoads = 0;
const _loadQueue = [];   // {item, container, resolve}

function _drainLoadQueue() {
    while (_activeLoads < MAX_CONCURRENT && _loadQueue.length > 0) {
        const { item, container, resolve } = _loadQueue.shift();
        _activeLoads++;
        chrome.runtime.sendMessage({ action: 'getLibraryItemData', id: item.id }, (resp) => {
            _activeLoads--;
            resolve(resp);
            _drainLoadQueue();
        });
    }
}

function getLibraryItemDataQueued(item) {
    return new Promise(resolve => {
        _loadQueue.push({ item, resolve });
        _drainLoadQueue();
    });
}



document.addEventListener('DOMContentLoaded', async () => {
    // UI Elements
    const mediaGrid = document.getElementById('mediaGrid');
    const emptyState = document.getElementById('emptyState');
    const statsText = document.getElementById('statsText');
    const searchInput = document.getElementById('searchInput');
    const typeFilter = document.getElementById('typeFilter');
    if (typeFilter) typeFilter.value = 'image';
    const ratioFilter = document.getElementById('ratioFilter');
    const dateFilter = document.getElementById('dateFilter');
    if (dateFilter) dateFilter.value = '3days';
    const userFilter = document.getElementById('userFilter');
    const customDateRange = document.getElementById('customDateRange');
    const dateStartInput = document.getElementById('dateStart');
    const dateEndInput = document.getElementById('dateEnd');
    const clearAllBtn = document.getElementById('clearAllBtn');
    const exportBtn = document.getElementById('exportBtn');
    const closeBtn = document.getElementById('closeBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const statsBtn = document.getElementById('statsBtn');
    const statsDashboardOverlay = document.getElementById('statsDashboardOverlay');
    const closeStatsBtn = document.getElementById('closeStatsBtn');
    const batchVideoBtn = document.getElementById('batchVideoBtn');

    if (refreshBtn) {
        refreshBtn.onclick = async () => {
            const oldHtml = refreshBtn.innerHTML;
            refreshBtn.innerHTML = '⌛ Aggiornamento...';
            refreshBtn.style.opacity = '0.7';
            await loadLibrary();
            setTimeout(() => {
                refreshBtn.innerHTML = oldHtml;
                refreshBtn.style.opacity = '1';
            }, 500);
        };
    }

    // Preview Elements
    const previewOverlay = document.getElementById('previewOverlay');
    const previewMedia = document.getElementById('previewMedia');
    const previewPrompt = document.getElementById('previewPrompt');
    const previewDate = document.getElementById('previewDate');
    const previewCopyBtn = document.getElementById('previewCopyBtn');
    const previewDlBtn = document.getElementById('previewDlBtn');
    const closePreview = document.getElementById('closePreview');

    // Confirm Modal
    const confirmModal = document.getElementById('confirmModal');
    const confirmOk = document.getElementById('confirmOk');
    const confirmCancel = document.getElementById('confirmCancel');
    let confirmCallback = null;

    // Load Data
    async function loadLibrary() {
        // Density initialization
        const savedDensity = localStorage.getItem('grok_lib_density') || 'normal';
        applyDensity(savedDensity);

        const data = await chrome.storage.local.get({ libraryItems: [] });
        allItems = data.libraryItems;
        populateUserFilter();
        renderLibrary();
        updateStorageQuota();
    }

    // Density Grid Logic
    function applyDensity(mode) {
        const grids = document.querySelectorAll('.media-grid');
        grids.forEach(grid => {
            // Robust class clearing: remove any class starting with grid-
            const toRemove = Array.from(grid.classList).filter(c => c.startsWith('grid-'));
            grid.classList.remove(...toRemove);
            grid.classList.add(`grid-${mode}`);
        });

        const densityBtns = [densityCompact, densityNormal, densityLarge];
        densityBtns.forEach(btn => btn?.classList.remove('active'));

        if (mode === 'compact') densityCompact?.classList.add('active');
        else if (mode === 'large') densityLarge?.classList.add('active');
        else densityNormal?.classList.add('active');
        
        localStorage.setItem('grok_lib_density', mode);
    }

    const densityCompact = document.getElementById('densityCompact');
    const densityNormal = document.getElementById('densityNormal');
    const densityLarge = document.getElementById('densityLarge');

    if (densityCompact) densityCompact.onclick = () => applyDensity('compact');
    if (densityNormal) densityNormal.onclick = () => applyDensity('normal');
    if (densityLarge) densityLarge.onclick = () => applyDensity('large');

    function populateUserFilter() {
        if (!userFilter) return;
        const users = new Map(); // email -> name
        allItems.forEach(item => {
            if (item.user && item.user.email) {
                const name = item.user.nome && item.user.cognome 
                            ? `${item.user.nome} ${item.user.cognome}` 
                            : (item.user.nome || item.user.email);
                users.set(item.user.email, name);
            }
        });

        const currentValue = userFilter.value;
        userFilter.innerHTML = '<option value="all">Filtra per Utente: TUTTI</option>';
        
        users.forEach((name, email) => {
            const option = document.createElement('option');
            option.value = email;
            option.textContent = `${name} (${email})`;
            userFilter.appendChild(option);
        });

        if ([...users.keys()].includes(currentValue)) {
            userFilter.value = currentValue;
        }
    }

    async function updateStorageQuota() {
        const container = document.getElementById('storageQuotaContainer');
        const percentEl = document.getElementById('quotaPercent');
        const barFillEl = document.getElementById('quotaBarFill');

        if (!container || !percentEl || !barFillEl) return;

        chrome.storage.local.getBytesInUse(null, async (bytesUsed) => {
            let maxBytes = 5242880; // Default 5MB

            if (navigator.storage && navigator.storage.estimate) {
                try {
                    const estimate = await navigator.storage.estimate();
                    if (estimate && estimate.quota) {
                        maxBytes = estimate.quota; 
                    }
                } catch (e) {
                    console.error('Error getting storage estimate', e);
                }
            }

            if (maxBytes <= 0) maxBytes = 1;

            let usagePercent = (bytesUsed / maxBytes) * 100;
            let visualPercent = Math.min(usagePercent, 100).toFixed(2);
            let mbUsed = (bytesUsed / (1024 * 1024)).toFixed(2);

            percentEl.textContent = `${visualPercent}% (${mbUsed} MB)`;
            barFillEl.style.width = `${visualPercent}%`;

            barFillEl.classList.remove('warning', 'danger');
            if (usagePercent >= 90) {
                barFillEl.classList.add('danger');
            } else if (usagePercent >= 75) {
                barFillEl.classList.add('warning');
            }

            container.style.display = 'flex';
        });
    }

    function renderLibrary() {
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        
        // Preparation for date intervals
        const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
        const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
        const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59).getTime();
        const fourMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 4, now.getDate()).getTime();
        const startOfLastYear = new Date(now.getFullYear() - 1, 0, 1).getTime();
        const endOfLastYear = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59).getTime();

        const filtered = allItems.filter(item => {
            const matchesType = currentFilter.type === 'all' || item.type === currentFilter.type;
            const matchesText = !currentFilter.text || 
                                (item.prompt && item.prompt.toLowerCase().includes(currentFilter.text)) ||
                                (item.filename && item.filename.toLowerCase().includes(currentFilter.text));
            
            const matchesRatio = currentFilter.ratio === 'all' || (item.aspectRatio && item.aspectRatio === currentFilter.ratio);
            
            const matchesUser = currentFilter.userEmail === 'all' || (item.user && item.user.email === currentFilter.userEmail);

            let matchesDate = true;
            if (currentFilter.date !== 'all') {
                const itemTime = new Date(item.savedAt || item.createTime || 0).getTime();
                if (currentFilter.date === 'today') {
                    matchesDate = itemTime >= startOfToday;
                } else if (currentFilter.date === '3days') {
                    matchesDate = itemTime >= startOfToday - (3 * 24 * 60 * 60 * 1000);
                } else if (currentFilter.date === 'week') {
                    matchesDate = itemTime >= startOfToday - (7 * 24 * 60 * 60 * 1000);
                } else if (currentFilter.date === 'this_month') {
                    matchesDate = itemTime >= startOfThisMonth;
                } else if (currentFilter.date === 'last_month') {
                    matchesDate = itemTime >= startOfLastMonth && itemTime <= endOfLastMonth;
                } else if (currentFilter.date === 'older_4m') {
                    matchesDate = itemTime < fourMonthsAgo;
                } else if (currentFilter.date === 'last_year') {
                    matchesDate = itemTime >= startOfLastYear && itemTime <= endOfLastYear;
                } else if (currentFilter.date === 'custom') {
                    if (currentFilter.dateStart) {
                        const start = new Date(currentFilter.dateStart).getTime();
                        if (itemTime < start) matchesDate = false;
                    }
                    if (currentFilter.dateEnd) {
                        const end = new Date(currentFilter.dateEnd).setHours(23, 59, 59, 999);
                        if (itemTime > end) matchesDate = false;
                    }
                }
            }

            return matchesType && matchesText && matchesDate && matchesRatio && matchesUser;
        }).sort((a, b) => {
            const dateA = new Date(a.savedAt || a.createTime || 0).getTime();
            const dateB = new Date(b.savedAt || b.createTime || 0).getTime();
            return dateB - dateA;
        });

        statsText.textContent = `${allItems.length} elementi salvati permanentemente`;
        
        if (filtered.length === 0) {
            mediaGrid.style.display = 'none';
            emptyState.style.display = 'block';
        } else {
            mediaGrid.style.display = 'block';
            emptyState.style.display = 'none';
            // Disconnect old observer so stale containers are not watched
            if (_lazyObserver) { _lazyObserver.disconnect(); _lazyObserver = null; }
            mediaGrid.innerHTML = '';

            let lastDateStr = null;
            let currentDayGrid = null;

            filtered.forEach(item => {
                const date = new Date(item.savedAt || item.createTime || 0);
                const dateStr = date.toLocaleDateString('it-IT', { 
                    weekday: 'long', 
                    day: 'numeric', 
                    month: 'long', 
                    year: 'numeric' 
                });
                const capitalizedDate = dateStr.charAt(0).toUpperCase() + dateStr.slice(1);

                if (capitalizedDate !== lastDateStr) {
                    // Create Day Section
                    const section = document.createElement('div');
                    section.className = 'day-section';
                    
                    const header = document.createElement('div');
                    header.className = 'day-header';
                    header.innerHTML = `<span>${capitalizedDate}</span>`;
                    section.appendChild(header);
                    
                    currentDayGrid = document.createElement('div');
                    currentDayGrid.className = 'media-grid'; // Each day gets its own masonry grid
                    section.appendChild(currentDayGrid);
                    
                    mediaGrid.appendChild(section);
                    lastDateStr = capitalizedDate;

                    // Apply current density to the new grid
                    const currentDensity = localStorage.getItem('grok_lib_density') || 'normal';
                    currentDayGrid.classList.add(`grid-${currentDensity}`);
                }

                const card = createMediaCard(item);
                currentDayGrid.appendChild(card);
            });
        }
    }

    function createMediaCard(item) {
        const card = document.createElement('div');
        card.className = 'media-card';
        
        const isVideo = item.type === 'video';
        // Use thumbnailUrl as an instant preview for videos (no storage fetch needed)
        const thumbUrl = item.thumbnailUrl || item.imageUrl || null;
        
        // Build the preview area: show thumbnail immediately if available
        const thumbHtml = thumbUrl
            ? (isVideo
                ? `<img src="${thumbUrl}" loading="lazy" class="video-thumb-placeholder">`
                : `<img src="${thumbUrl}" loading="lazy">`)
            : `<div class="media-preview-loading">⌛</div>`;

        card.innerHTML = `
            <div class="media-preview" id="preview-container-${item.id}">
                ${thumbHtml}
                <div class="media-type-icon">${isVideo ? '🎬' : '🖼️'}</div>
            </div>
            <div class="media-footer">
                <div class="media-meta-row">
                    <div class="media-info-left">
                        <span class="media-date">${new Date(item.savedAt || item.createTime).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' })}</span>
                        <span class="media-ratio-label">${item.aspectRatio || ''}</span>
                    </div>
                    ${item.user && item.user.email ? `<span class="media-user-badge" title="${item.user.email}">${item.user.nome || 'Utente'}</span>` : ''}
                </div>
                <div class="card-actions">
                    <button class="btn-card-icon btn-copy-prompt" title="Copia Prompt">📋</button>
                    <button class="btn-card-icon btn-download" title="Scarica">⬇️</button>
                    <button class="btn-card-icon btn-delete" title="Rimuovi">🗑️</button>
                </div>
            </div>
        `;

        // Lazy-load full data only when card enters viewport
        const previewContainer = card.querySelector('.media-preview');
        previewContainer._lazyItem = item;
        getLazyObserver().observe(previewContainer);

        // Click on card to preview
        card.onclick = (e) => {
            if (e.target.closest('.card-actions')) return;
            showPreview(item);
        };

        // Copy Prompt
        card.querySelector('.btn-copy-prompt').onclick = (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(item.prompt || '');
            const btn = e.target;
            const oldText = btn.textContent;
            btn.textContent = '✅';
            setTimeout(() => btn.textContent = oldText, 1500);
        };

        // Download
        card.querySelector('.btn-download').onclick = async (e) => {
            e.stopPropagation();
            const btn = e.currentTarget;
            const oldInner = btn.innerHTML;
            btn.innerHTML = '⌛';
            
            getLibraryItemDataQueued(item).then(resp => {
                if (resp && resp.dataUrl) {
                    chrome.runtime.sendMessage({
                        action: 'downloadWithPath',
                        dataUrl: resp.dataUrl,
                        filename: `Grok_Media/Library/${item.filename || 'media.png'}`
                    }, () => {
                        btn.innerHTML = oldInner;
                    });
                } else {
                    btn.innerHTML = '❌';
                    setTimeout(() => btn.innerHTML = oldInner, 2000);
                }
            });
        };

        // Delete
        card.querySelector('.btn-delete').onclick = (e) => {
            e.stopPropagation();
            showConfirm('Vuoi rimuovere questo elemento dalla biblioteca?', () => {
                deleteItem(item.id);
            });
        };

        return card;
    }

    async function loadMediaData(item, container) {
        const isVideo = item.type === 'video';

        // For videos that already show a thumbnail placeholder, swap to full
        // data only when needed. Use the queued loader to cap concurrency.
        const resp = await getLibraryItemDataQueued(item);
        let dataUrl = resp?.dataUrl;

        // Fallback: if dataUrl is null but we have a valid remote URL
        if (!dataUrl && item.url && !item.url.startsWith('data:')) dataUrl = item.url;
        if (!dataUrl && item.imageUrl && !item.imageUrl.startsWith('data:')) dataUrl = item.imageUrl;

        if (dataUrl) {
            const card = container.closest('.media-card');

            if (isVideo) {
                // preload="metadata" → browser shows first frame without decoding full video.
                // poster = thumbnailUrl/imageUrl so something is visible instantly.
                const posterAttr = (item.thumbnailUrl || item.imageUrl)
                    ? `poster="${item.thumbnailUrl || item.imageUrl}"`
                    : '';
                // No "muted" attribute — extension pages bypass autoplay restrictions,
                // so audio works on hover without any policy block.
                container.innerHTML =
                    `<video src="${dataUrl}" preload="metadata" ${posterAttr}></video>` +
                    `<div class="media-type-icon">🎬</div>`;
                const video = container.querySelector('video');
                if (card && video) {
                    card.onmouseenter = () => {
                        video.muted = false;
                        video.preload = 'auto';
                        video.play().catch(() => {
                            // Fallback: if browser still blocks unmuted, play muted
                            video.muted = true;
                            video.play().catch(() => {});
                        });
                    };
                    card.onmouseleave = () => { video.pause(); video.currentTime = 0; };
                }
            } else {
                container.innerHTML =
                    `<img src="${dataUrl}" loading="lazy">` +
                    `<div class="media-type-icon">🖼️</div>`;

                // Recalculate aspect ratio if missing
                if (!item.aspectRatio) {
                    const img = container.querySelector('img');
                    if (img) {
                        img.onload = () => {
                            const ratio = img.naturalWidth / img.naturalHeight;
                            let finalRatio = '';
                            if (Math.abs(ratio - 1) < 0.05)    finalRatio = "1:1";
                            else if (Math.abs(ratio - 1.77) < 0.1) finalRatio = "16:9";
                            else if (Math.abs(ratio - 0.56) < 0.1) finalRatio = "9:16";
                            else if (Math.abs(ratio - 1.33) < 0.1) finalRatio = "4:3";
                            else if (Math.abs(ratio - 0.75) < 0.1) finalRatio = "3:4";
                            else if (Math.abs(ratio - 1.5)  < 0.1) finalRatio = "3:2";
                            else if (Math.abs(ratio - 0.66) < 0.1) finalRatio = "2:3";
                            else finalRatio = `${Math.round(ratio * 10) / 10}:1`;

                            if (finalRatio && card) {
                                const label = card.querySelector('.media-ratio-label');
                                if (label) {
                                    label.textContent = `📐 ${finalRatio}`;
                                    label.setAttribute('title', 'Aspect Ratio');
                                }
                            }
                        };
                    }
                }
            }
        } else {
            container.innerHTML = `<div class="media-preview-error">❌ Errore caricamento</div>`;
        }
    }

    // IntersectionObserver: fires loadMediaData only when card enters viewport
    // Defined HERE (inside DOMContentLoaded) so it can close over loadMediaData.
    let _lazyObserver = null;
    function getLazyObserver() {
        if (!_lazyObserver) {
            _lazyObserver = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const container = entry.target;
                        _lazyObserver.unobserve(container);
                        const item = container._lazyItem;
                        if (item) loadMediaData(item, container);
                    }
                });
            }, { rootMargin: '200px 0px' }); // pre-load 200px before visible
        }
        return _lazyObserver;
    }

    async function deleteItem(id) {
        chrome.runtime.sendMessage({ action: 'deleteLibraryItem', id }, (resp) => {
            if (resp && resp.ok) {
                allItems = allItems.filter(i => i.id !== id);
                renderLibrary();
                updateStorageQuota();
            }
        });
    }

    function showPreview(item) {
        previewMedia.innerHTML = '<div class="preview-loading">Caricamento...</div>';
        
        chrome.runtime.sendMessage({ action: 'getLibraryItemData', id: item.id }, (resp) => {
            const previewContainer = previewMedia.closest('.preview-container');
            // Reset layout
            previewContainer.classList.remove('is-portrait');

            if (resp && resp.dataUrl) {
                const isVideo = item.type === 'video';
                const mediaEl = isVideo 
                    ? document.createElement('video') 
                    : document.createElement('img');
                
                mediaEl.src = resp.dataUrl;
                if (isVideo) {
                    mediaEl.controls = true;
                    mediaEl.autoplay = true;
                }

                const checkOrientation = (width, height) => {
                    const ratio = width / height;
                    if (ratio < 1.0) {
                        previewContainer.classList.add('is-portrait');
                    }
                };

                if (isVideo) {
                    mediaEl.onloadedmetadata = () => checkOrientation(mediaEl.videoWidth, mediaEl.videoHeight);
                } else {
                    mediaEl.onload = () => checkOrientation(mediaEl.naturalWidth, mediaEl.naturalHeight);
                }

                // If we already have aspectRatio, use it immediately for faster layout
                if (item.aspectRatio) {
                    const [w, h] = item.aspectRatio.split(':').map(Number);
                    if (w && h && w < h) {
                        previewContainer.classList.add('is-portrait');
                    }
                }

                previewMedia.innerHTML = '';

                // Add Blur Layer
                const blurLayer = document.createElement('div');
                blurLayer.id = 'customBlurLayer';
                const bgUrl = isVideo ? (item.imageUrl || item.thumbnailUrl || '') : resp.dataUrl;
                if (bgUrl) blurLayer.style.backgroundImage = `url(${bgUrl})`;
                previewMedia.appendChild(blurLayer);

                previewMedia.appendChild(mediaEl);
                
                previewDlBtn.onclick = () => {
                    let finalFilename = item.filename || 'media.png';
                    const hasExtension = finalFilename.match(/\.(jpg|jpeg|png|webp|mp4|gif|svg)$/i);
                    if (!hasExtension) {
                        finalFilename += (item.type === 'video' ? '.mp4' : '.jpg');
                    }

                    chrome.runtime.sendMessage({
                        action: 'downloadWithPath',
                        dataUrl: resp.dataUrl,
                        filename: `Grok_Media/Library/${finalFilename}`
                    });
                };
            } else {
                previewMedia.innerHTML = '<div class="preview-error">Errore: Impossibile recuperare i dati dell\'immagine.</div>';
            }
        });
        
        previewPrompt.textContent = item.prompt || 'Nessun prompt';
        previewDate.textContent = `Salvato il: ${new Date(item.savedAt || item.createTime).toLocaleString('it-IT')}`;

        // Show aspect ratio as dedicated element
        let ratioEl = document.getElementById('previewRatio');
        if (!ratioEl) {
            ratioEl = document.createElement('div');
            ratioEl.id = 'previewRatio';
            ratioEl.style.cssText = 'font-size:12px; color: var(--accent); font-weight:600; margin-top:4px; letter-spacing:0.05em;';
            previewDate.insertAdjacentElement('afterend', ratioEl);
        }
        ratioEl.textContent = item.aspectRatio ? `📐 ${item.aspectRatio}` : '';
        
        previewCopyBtn.onclick = () => {
            navigator.clipboard.writeText(item.prompt || '');
            const oldText = previewCopyBtn.textContent;
            previewCopyBtn.textContent = 'Copiato!';
            setTimeout(() => previewCopyBtn.textContent = oldText, 2000);
        };

        previewOverlay.style.display = 'flex';
        document.body.classList.add('no-scroll');
    }

    // Filters
    searchInput.oninput = (e) => {
        currentFilter.text = e.target.value.toLowerCase();
        renderLibrary();
    };

    typeFilter.onchange = (e) => {
        currentFilter.type = e.target.value;
        renderLibrary();
    };

    ratioFilter.onchange = (e) => {
        currentFilter.ratio = e.target.value;
        renderLibrary();
    };

    dateFilter.onchange = (e) => {
        currentFilter.date = e.target.value;
        if (currentFilter.date === 'custom') {
            customDateRange.style.display = 'flex';
        } else {
            customDateRange.style.display = 'none';
        }
        renderLibrary();
    };

    dateStartInput.onchange = (e) => {
        currentFilter.dateStart = e.target.value;
        renderLibrary();
    };

    dateEndInput.onchange = (e) => {
        currentFilter.dateEnd = e.target.value;
        renderLibrary();
    };

    if (userFilter) {
        userFilter.onchange = (e) => {
            currentFilter.userEmail = e.target.value;
            renderLibrary();
        };
    }

    // Actions
    clearAllBtn.onclick = () => {
        showConfirm('Sei sicuro di voler svuotare TUTTA la biblioteca? Questa azione non è reversibile.', async () => {
            allItems = [];
            await chrome.storage.local.set({ libraryItems: [] });
            renderLibrary();
            updateStorageQuota();
        });
    };

    exportBtn.onclick = () => {
        const blob = new Blob([JSON.stringify(allItems, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        chrome.downloads.download({
            url: url,
            filename: 'grok_library_export.json'
        }, () => URL.revokeObjectURL(url));
    };

    closeBtn.onclick = () => window.close();

    closePreview.onclick = () => {
        previewOverlay.style.display = 'none';
        previewMedia.innerHTML = '';
        document.body.classList.remove('no-scroll');
    };

    // Close on overlay click
    previewOverlay.onclick = (e) => {
        if (e.target === previewOverlay) {
            closePreview.click();
        }
    };

    // Confirm Modal
    function showConfirm(text, callback) {
        document.getElementById('confirmText').textContent = text;
        confirmCallback = callback;
        confirmModal.style.display = 'flex';
    }

    confirmOk.onclick = () => {
        if (confirmCallback) confirmCallback();
        confirmModal.style.display = 'none';
    };

    confirmCancel.onclick = () => {
        confirmModal.style.display = 'none';
    };

    // --- Stats Dashboard Logic ---
    async function calculateStats() {
        if (!allItems.length) return;

        // 1. Storage Size
        chrome.storage.local.getBytesInUse(null, (bytes) => {
            const sizeMB = (bytes / (1024 * 1024)).toFixed(2);
            document.getElementById('stat-storage-size').textContent = `${sizeMB} MB`;
        });

        // 2. Total Count & Media Mix
        const total = allItems.length;
        const images = allItems.filter(i => i.type !== 'video').length;
        const videos = total - images;
        document.getElementById('stat-total-count').textContent = total;
        document.getElementById('stat-media-mix').textContent = `${images} 🖼️ / ${videos} 🎬`;

        // 3. Keywords Cloud
        const stopWords = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'for', 'with', 'in', 'on', 'at', 'by', 'to', 'is', 'it', 'from', 'this', 'that', 'my', 'your', 'his', 'her', 'their', 'our', 'its']);
        const wordFreq = {};
        
        allItems.forEach(item => {
            if (item.prompt) {
                const words = item.prompt.toLowerCase()
                                .replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, "")
                                .split(/\s+/);
                words.forEach(word => {
                    if (word.length > 3 && !stopWords.has(word)) {
                        wordFreq[word] = (wordFreq[word] || 0) + 1;
                    }
                });
            }
        });

        const sortedWords = Object.entries(wordFreq)
                            .sort((a, b) => b[1] - a[1])
                            .slice(0, 30);

        const cloud = document.getElementById('stats-keywords-cloud');
        cloud.innerHTML = '';
        if (sortedWords.length) {
            const maxFreq = sortedWords[0][1];
            sortedWords.forEach(([word, freq]) => {
                const span = document.createElement('span');
                span.className = 'keyword-pill';
                const ratio = freq / maxFreq;
                if (ratio > 0.8) span.classList.add('size-xl');
                else if (ratio > 0.5) span.classList.add('size-lg');
                else if (ratio > 0.3) span.classList.add('size-md');
                span.textContent = `${word} (${freq})`;
                cloud.appendChild(span);
            });
        }

        // 4. Activity Chart (Last 7 Days)
        const chart = document.getElementById('stats-activity-chart');
        chart.innerHTML = '';
        const last7Days = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            last7Days.push(d.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric' }));
        }

        const dailyCounts = new Array(7).fill(0);
        allItems.forEach(item => {
            const date = new Date(item.savedAt || item.createTime || 0);
            const diffDays = Math.floor((new Date() - date) / (1000 * 60 * 60 * 24));
            if (diffDays >= 0 && diffDays < 7) {
                dailyCounts[6 - diffDays]++;
            }
        });

        const maxCount = Math.max(...dailyCounts, 1);
        last7Days.forEach((day, i) => {
            const count = dailyCounts[i];
            const height = (count / maxCount) * 100;
            const container = document.createElement('div');
            container.className = 'chart-bar-container';
            container.innerHTML = `
                <div class="chart-bar" style="height: ${height}%">
                    <span class="chart-bar-value">${count || ''}</span>
                </div>
                <span class="chart-label">${day}</span>
            `;
            chart.appendChild(container);
        });
    }

    statsBtn.onclick = () => {
        calculateStats();
        statsDashboardOverlay.style.display = 'flex';
        document.body.classList.add('no-scroll');
    };

    closeStatsBtn.onclick = () => {
        statsDashboardOverlay.style.display = 'none';
        document.body.classList.remove('no-scroll');
    };

    statsDashboardOverlay.onclick = (e) => {
        if (e.target === statsDashboardOverlay) closeStatsBtn.click();
    };

    let batchDownloadRunning = false;
    let batchDownloadStop    = false;

    const batchProgressBar   = document.getElementById('batchProgressBar');
    const batchProgressFill  = document.getElementById('batchProgressFill');
    const batchProgressText  = document.getElementById('batchProgressText');
    const batchProgressCount = document.getElementById('batchProgressCount');
    const batchProgressSub   = document.getElementById('batchProgressSub');
    const batchProgressIcon  = document.getElementById('batchProgressIcon');

    function showBatchProgress(done, total) {
        batchProgressBar.style.display = 'block';
        updateBatchProgress(done, total);
    }

    function updateBatchProgress(done, total) {
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        batchProgressFill.style.width = `${pct}%`;
        batchProgressCount.textContent = `${done} / ${total}`;
    }

    function setBatchStatusText(text, sub = '') {
        batchProgressText.textContent = text;
        batchProgressSub.textContent  = sub;
    }

    function hideBatchProgress() {
        batchProgressBar.style.display = 'none';
    }

    // --- Toast notification ---
    let _toastEl = null;
    let _toastTimer = null;
    function showToast(msg, type = 'success') {
        if (!_toastEl) {
            _toastEl = document.createElement('div');
            _toastEl.className = 'lib-toast';
            document.body.appendChild(_toastEl);
        }
        _toastEl.className = `lib-toast toast-${type}`;
        _toastEl.textContent = msg;
        requestAnimationFrame(() => {
            requestAnimationFrame(() => _toastEl.classList.add('show'));
        });
        clearTimeout(_toastTimer);
        _toastTimer = setTimeout(() => _toastEl.classList.remove('show'), 4000);
    }

    // --- Check if a video item has a companion image in the library ---
    function hasCompanionImage(videoItem) {
        if (!videoItem.prompt) return false;
        const vPrompt = videoItem.prompt.trim();
        const vTime   = new Date(videoItem.savedAt || videoItem.createTime || 0).getTime();
        return allItems.some(other =>
            other.id !== videoItem.id &&
            other.type === 'image' &&
            other.prompt &&
            other.prompt.trim() === vPrompt &&
            Math.abs(new Date(other.savedAt || other.createTime || 0).getTime() - vTime) < 2 * 60 * 60 * 1000 // same session (2h)
        );
    }

    // --- Stop handler ---
    function stopBatchDownload() {
        batchDownloadStop = true;
        setBatchStatusText('⏹ Interruzione in corso...', '');
        batchProgressIcon.textContent = '⏹';
    }

    async function startBatchVideoDownload() {
        if (batchDownloadRunning) return;

        const videoItems = allItems.filter(i => i.type === 'video');
        if (videoItems.length === 0) {
            showToast('⚠️ Nessun video presente in biblioteca!', 'warn');
            return;
        }

        const BATCH_SIZE  = 40;
        const DELAY_ITEM  = 166;   // ms tra ognuno (tripla velocità)
        const DELAY_EVERY = 333;   // ms pausa ogni 3 (tripla velocità)
        const EVERY_N     = 3;

        const batch = videoItems.slice(0, BATCH_SIZE);
        const total = batch.length;

        batchDownloadRunning = true;
        batchDownloadStop    = false;

        // UI: switch button to Stop mode
        batchVideoBtn.innerHTML  = '⏹ Stop Download';
        batchVideoBtn.classList.add('is-running');
        batchVideoBtn.onclick    = stopBatchDownload;

        showBatchProgress(0, total);
        setBatchStatusText(`Avvio download ${total} video...`, `Ritmo: 0.5s tra ognuno · pausa 1s ogni ${EVERY_N}`);
        batchProgressIcon.textContent = '📥';

        const promptsBuffer = [];   // prompts for videos without companion image
        let downloadedCount = 0;
        let skippedCount    = 0;

        for (let i = 0; i < batch.length; i++) {
            if (batchDownloadStop) break;

            const item = batch[i];
            const companion = hasCompanionImage(item);

            setBatchStatusText(
                `Scaricando video ${i + 1} di ${total}${ companion ? ' (ha immagine companion)' : '' }`,
                item.filename || item.prompt?.substring(0, 60) || ''
            );

            // Highlight the card being downloaded
            const cardEl = document.getElementById(`preview-container-${item.id}`)?.closest('.media-card');
            if (cardEl) cardEl.classList.add('is-downloading');

            // Fetch data from background
            const dataUrl = await new Promise(resolve => {
                chrome.runtime.sendMessage({ action: 'getLibraryItemData', id: item.id }, resp => {
                    resolve(resp?.dataUrl || null);
                });
            });

            if (dataUrl) {
                let filename = item.filename || `grok_video_${i + 1}.mp4`;
                if (!/\.(mp4|webm|mov|avi)$/i.test(filename)) filename += '.mp4';

                // Trigger the download
                await new Promise(resolve => {
                    chrome.runtime.sendMessage({
                        action: 'downloadWithPath',
                        dataUrl: dataUrl,
                        filename: `Grok_Media/Library/${filename}`
                    }, () => resolve());
                });

                downloadedCount++;

                // Collect prompt only if no companion image exists
                if (!companion && item.prompt) {
                    const ts = new Date(item.savedAt || item.createTime || 0)
                        .toLocaleString('it-IT');
                    promptsBuffer.push(`--- [${downloadedCount}] ${filename} ---\nData: ${ts}\n${item.prompt}\n`);
                }

                // Remove video from library (keep image companion if present)
                await new Promise(resolve => {
                    chrome.runtime.sendMessage({ action: 'deleteLibraryItem', id: item.id }, () => {
                        allItems = allItems.filter(it => it.id !== item.id);
                        resolve();
                    });
                });

                // Remove card from DOM smoothly
                if (cardEl) {
                    cardEl.style.transition = 'opacity 0.4s, transform 0.4s';
                    cardEl.style.opacity    = '0';
                    cardEl.style.transform  = 'scale(0.85)';
                    setTimeout(() => cardEl.remove(), 420);
                }

                updateBatchProgress(downloadedCount + skippedCount, total);
            } else {
                // No data available — skip
                skippedCount++;
                console.warn('[Batch] Nessun dato per:', item.id, item.filename);
            }

            // Timing: after every EVERY_N-th download pause longer, else short delay
            const isDone = (i === batch.length - 1) || batchDownloadStop;
            if (!isDone) {
                const isEveryN = (i + 1) % EVERY_N === 0;
                const waitMs   = isEveryN ? DELAY_EVERY : DELAY_ITEM;
                if (isEveryN) {
                    setBatchStatusText(
                        `Pausa di 1s dopo ${i + 1} download...`,
                        `Ripresa tra poco`
                    );
                }
                await sleep(waitMs);
            }
        }

        // ── Download prompts .txt if any were collected ──────────────────────
        if (promptsBuffer.length > 0) {
            setBatchStatusText('📄 Scaricando file prompts...', `${promptsBuffer.length} prompt senza immagine companion`);
            const header = [
                'Grok Library – Prompts Video senza Immagine',
                `Esportato il: ${new Date().toLocaleString('it-IT')}`,
                `Totale prompts: ${promptsBuffer.length}`,
                '='.repeat(60)
            ].join('\n');
            const content = header + '\n\n' + promptsBuffer.join('\n');
            const blob    = new Blob([content], { type: 'text/plain;charset=utf-8' });
            const blobUrl = URL.createObjectURL(blob);
            await new Promise(resolve => {
                chrome.runtime.sendMessage({
                    action: 'downloadWithPath',
                    dataUrl: blobUrl,
                    filename: `Grok_Media/Library/prompts_${Date.now()}.txt`
                }, () => { URL.revokeObjectURL(blobUrl); resolve(); });
            });
        }

        // ── Wrap up ─────────────────────────────────────────────────────────
        const stopped = batchDownloadStop;
        batchDownloadRunning = false;
        batchDownloadStop    = false;

        // Reset button
        batchVideoBtn.innerHTML = '📥 Scarica 40 Video';
        batchVideoBtn.classList.remove('is-running');
        batchVideoBtn.onclick   = startBatchVideoDownload;

        setTimeout(() => hideBatchProgress(), 2500);

        if (stopped) {
            showToast(`⏹ Interrotto: ${downloadedCount} video scaricati`, 'warn');
        } else {
            const extra = promptsBuffer.length > 0 ? ` + prompts.txt (${promptsBuffer.length})` : '';
            showToast(`✅ ${downloadedCount} video scaricati${extra}!`, 'success');
        }

        // Re-render stats
        statsText.textContent = `${allItems.length} elementi salvati permanentemente`;
    }

    if (batchVideoBtn) {
        batchVideoBtn.onclick = startBatchVideoDownload;
    }

    // Initial Load
    loadLibrary();
});
