// content.js — runs in the isolated world, injects a script into the main page world

(function () {
    // Listen for messages from the injected script (in main world)
    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        if (!event.data) return;

        // Messages from inject.js carrying intercepted media
        if (event.data.source === 'grok-injector' && event.data.type === 'NEW_MEDIA') {
            const newItems = event.data.items || [];
            // console.log(`[Grok Downloader] Ricevuti ${newItems.length} nuovi elementi multimediali.`);
            // Update local cache
            newItems.forEach(item => {
                const idx = localMediaItems.findIndex(m => m.url === item.url);
                if (idx > -1) localMediaItems[idx] = item;
                else localMediaItems.push(item);
            });

                if (chrome.runtime?.id) {
                    chrome.runtime.sendMessage({ action: 'storeMedia', items: newItems }, (resp) => {
                        if (chrome.runtime.lastError) return;
                        debouncedInject();
                    });
                }
        }

        // Relay logs
        if (event.data.source === 'grok-injector' && event.data.type === 'LOG') {
            // console.log('[Grok Relay] LOG:', event.data.message);
            if (chrome.runtime?.id) {
                chrome.runtime.sendMessage({
                    action: 'addLog',
                    level: event.data.level,
                    message: event.data.message,
                    details: event.data.details
                }).catch(() => { });
            }
        }

        // inject.js asking for the current intercept state on load
        if (event.data.source === 'grok-page' && event.data.type === 'GET_INTERCEPT_STATE') {
            if (chrome.runtime?.id) {
                chrome.runtime.sendMessage({ action: 'getEffectiveIntercept' }, (resp) => {
                    const active = resp ? resp.active : true;
                    window.postMessage({
                        source: 'grok-content',
                        type: 'SET_INTERCEPT',
                        active: active
                    }, '*');
                });
            }
        }
    });

    // Listen for interception state changes broadcast from storage
    chrome.storage.onChanged.addListener((changes, area) => {
        if (!chrome.runtime?.id) return;
        if (area === 'local' && 'mediaItems' in changes) {
            localMediaItems = changes.mediaItems.newValue || [];
            updateMediaMap();
            debouncedInject();
        }
        if (area === 'local' && 'libraryItems' in changes) {
            libraryItems = changes.libraryItems.newValue || [];
            debouncedInject();
        }
        if (area === 'local' && 'interceptActive' in changes) {
            window.postMessage({
                source: 'grok-content',
                type: 'SET_INTERCEPT',
                active: changes.interceptActive.newValue
            }, '*');
        }
        if (area === 'sync' && 'reorderEnabled' in changes) {
            reorderEnabled = changes.reorderEnabled.newValue;
        }
    });



    // Listen for messages from background script
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === 'manualReorder') {
            const list = document.querySelector('div[role="list"]') || document.querySelector('.grid[style*="grid-template-columns"]');
            if (list) reorderList(list);
        } else if (msg.action === 'setEffectiveIntercept') {
            window.postMessage({
                source: 'grok-content',
                type: 'SET_INTERCEPT',
                active: msg.active
            }, '*');
        }
    });

    let localMediaItems = [];
    let libraryItems = [];
    let mediaMap = new Map();

    const debounce = (func, wait) => {
        let timeout;
        return (...args) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => func(...args), wait);
        };
    };

    let _debouncedInject = null;
    function debouncedInject() {
        if (!_debouncedInject) {
            _debouncedInject = debounce(injectBadges, 250);
        }
        _debouncedInject();
    }

    function updateMediaMap() {
        mediaMap.clear();
        localMediaItems.forEach(item => {
            if (item.id) mediaMap.set(item.id, item);
            if (item.originalPostId) mediaMap.set(item.originalPostId, item);
            if (item.url) {
                const u = item.url.split('?')[0];
                mediaMap.set(u, item);
            }
            if (item.associatedIds) {
                item.associatedIds.forEach(id => mediaMap.set(id, item));
            }
        });
    }

    // ─── Media Fetching & Processing ──────────────────────────────────────────
    async function fetchMediaAsDataUrl(url) {
        try {
            const response = await new Promise((resolve) => {
                chrome.runtime.sendMessage({ action: 'proxyFetch', url: url }, resolve);
            });

            if (response && response.dataUrl) {
                // Security check: if dataUrl is too small, it's likely an error page (JSON/HTML)
                if (response.dataUrl.length < 1024) {
                    console.warn('[Grok Downloader] Proxy fetch returned suspiciously small data, likely an error page.');
                    return null;
                }
                return response.dataUrl;
            } else if (response && response.error) {
                console.warn('[Grok Downloader] Proxy fetch error:', response.error);
            }
        } catch (e) {
            console.warn('[Grok Downloader] Failed to proxy fetch:', e);
        }
        return null;
    }

    async function resizeImage(imageUrl, maxWidth = 1280) {
        const finalDataUrl = await fetchMediaAsDataUrl(imageUrl) || imageUrl;

        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                let width = img.width;
                let height = img.height;

                // Always calculate final aspect ratio
                const ratio = width / height;
                let finalRatio = '';
                if (Math.abs(ratio - 1) < 0.05) finalRatio = "1:1";
                else if (Math.abs(ratio - 1.77) < 0.1) finalRatio = "16:9";
                else if (Math.abs(ratio - 0.56) < 0.1) finalRatio = "9:16";
                else if (Math.abs(ratio - 1.33) < 0.1) finalRatio = "4:3";
                else if (Math.abs(ratio - 0.75) < 0.1) finalRatio = "3:4";
                else if (Math.abs(ratio - 1.5) < 0.1) finalRatio = "3:2";
                else if (Math.abs(ratio - 0.66) < 0.1) finalRatio = "2:3";
                else finalRatio = `${Math.round(ratio * 10) / 10}:1`;

                // Determine if we need to scale down
                let targetWidth = width;
                let targetHeight = height;

                if (width > maxWidth || height > maxWidth) {
                    if (width > height) {
                        targetHeight *= maxWidth / width;
                        targetWidth = maxWidth;
                    } else {
                        targetWidth *= maxWidth / height;
                        targetHeight = maxWidth;
                    }
                }

                const canvas = document.createElement('canvas');
                canvas.width = targetWidth;
                canvas.height = targetHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

                const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
                resolve({ dataUrl, aspectRatio: finalRatio });
            };
            img.onerror = (e) => {
                console.warn('[Grok Downloader] Errore caricamento immagine per resize:', e);
                resolve({ dataUrl: finalDataUrl, aspectRatio: '' }); 
            };
            img.src = finalDataUrl;
        });
    }

    if (chrome.runtime?.id) {
        chrome.storage.local.get(['mediaItems', 'libraryItems'], (data) => {
            if (!chrome.runtime?.id) return;
            localMediaItems = data.mediaItems || [];
            libraryItems = data.libraryItems || [];
            updateMediaMap();
            debouncedInject();
        });
    }

    const BADGE_CSS = `
        .grok-filter-drawer {
            position: fixed !important;
            top: 20px !important;
            right: -240px !important;
            width: 280px !important;
            background: rgba(0, 0, 0, 0.8) !important;
            backdrop-filter: blur(16px) !important;
            -webkit-backdrop-filter: blur(16px) !important;
            color: #fff !important;
            padding: 16px !important;
            border-radius: 12px 0 0 12px !important;
            border: 1px solid rgba(255, 255, 255, 0.15) !important;
            border-right: none !important;
            box-shadow: -5px 0 25px rgba(0, 0, 0, 0.5) !important;
            z-index: 2147483647 !important;
            transition: right 0.4s cubic-bezier(0.19, 1, 0.22, 1) !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 12px !important;
            font-family: Inter, apple-system, system-ui, sans-serif !important;
            pointer-events: auto !important;
        }
        .grok-filter-drawer:hover, .grok-filter-drawer.open {
            right: 0 !important;
        }
        .grok-filter-tab {
            position: absolute !important;
            left: -32px !important;
            top: 40px !important;
            width: 32px !important;
            padding: 15px 0 !important;
            background: rgba(0, 0, 0, 0.8) !important;
            backdrop-filter: blur(16px) !important;
            border: 1px solid rgba(255, 255, 255, 0.15) !important;
            border-right: none !important;
            border-radius: 0 8px 8px 0 !important;
            cursor: pointer !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            writing-mode: vertical-rl !important;
            transform: rotate(180deg) !important;
            font-size: 11px !important;
            font-weight: 700 !important;
            letter-spacing: 0.1em !important;
            color: #fff !important;
            text-transform: uppercase !important;
            pointer-events: auto !important;
        }

        .grok-media-badge {
            position: absolute !important;
            top: 10px !important;
            left: 50% !important;
            transform: translateX(-50%) !important;
            background: rgba(0, 0, 0, 0.6) !important;
            backdrop-filter: blur(12px) !important;
            -webkit-backdrop-filter: blur(12px) !important;
            color: #fff !important;
            padding: 3px 7px !important;
            border-radius: 6px !important;
            font-size: 11px !important;
            font-weight: 700 !important;
            display: flex !important;
            align-items: center !important;
            gap: 8px !important;
            z-index: 50 !important;
            pointer-events: none !important;
            border: 1px solid rgba(255, 255, 255, 0.2) !important;
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.3) !important;
            font-family: Inter, apple-system, system-ui, sans-serif !important;
            text-shadow: 0 1px 2px rgba(0,0,0,0.5) !important;
        }
        button[aria-label="Rimuovi"], 
        button[aria-label="Rimuovi"] svg {
            opacity: 1;
            color: red;
            border-color: rgba(255, 0, 0, 0.15);
        }
        button[aria-label="Rimuovi"] {
           background-color: rgba(255, 0, 0, 0.1);
        }
        .grok-media-badge.error-badge {
            background: rgba(220, 38, 38, 0.8) !important;
            border-color: rgba(255, 255, 255, 0.4) !important;
        }
        div[role="list"] button.bg-black\/25,
        div[role="list"] button.border-white\/15 {
            background-color: rgba(220, 38, 38, 0.75) !important;
            border-color: rgba(220, 38, 38, 0.75) !important;
        }
        div[role="list"] button.border-opacity-10 {
            --tw-border-opacity: 1 !important;
        }

        .grok-action-container {
            position: absolute !important;
            bottom: 10px !important;
            left: 10px !important;
            display: flex !important;
            gap: 8px !important;
            z-index: 51 !important;
            pointer-events: auto !important;
        }

        .grok-action-icon {
            width: 28px !important;
            height: 28px !important;
            background: rgba(0, 0, 0, 0.6) !important;
            backdrop-filter: blur(12px) !important;
            -webkit-backdrop-filter: blur(12px) !important;
            color: #fff !important;
            border-radius: 50% !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            font-size: 14px !important;
            cursor: pointer !important;
            border: 1px solid rgba(255, 255, 255, 0.2) !important;
            transition: all 0.2s ease !important;
            position: relative !important;
        }

        .grok-action-icon:hover {
            background: rgba(255, 255, 255, 0.2) !important;
            transform: scale(1.1) !important;
        }

        .grok-save-photo {
            background: rgba(56, 139, 253, 0.7) !important;
            border-color: rgba(56, 139, 253, 0.4) !important;
        }
        .grok-save-video {
            background: rgba(163, 113, 247, 0.7) !important;
            border-color: rgba(163, 113, 247, 0.4) !important;
        }
        .grok-info-icon {
            background: rgba(0, 197, 122, 0.6) !important;
        }

        .grok-action-icon::after {
            content: attr(data-tooltip);
            position: absolute !important;
            bottom: 35px !important;
            left: 50% !important;
            transform: translateX(-50%) !important;
            background: rgba(0, 0, 0, 0.9) !important;
            color: #fff !important;
            padding: 8px 12px !important;
            border-radius: 8px !important;
            font-size: 12px !important;
            white-space: pre-wrap !important;
            width: max-content !important;
            max-width: 250px !important;
            opacity: 0 !important;
            visibility: hidden !important;
            transition: opacity 0.2s ease !important;
            pointer-events: none !important;
            z-index: 100 !important;
            border: 1px solid rgba(255, 255, 255, 0.2) !important;
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.5) !important;
            line-height: 1.4 !important;
            font-weight: 400 !important;
            font-family: Inter, apple-system, system-ui, sans-serif !important;
        }

        .grok-action-icon:hover::after {
            opacity: 1 !important;
            visibility: visible !important;
        }

        .grok-toast {
            position: fixed !important;
            bottom: 20px !important;
            right: 20px !important;
            background: rgba(0, 0, 0, 0.8) !important;
            backdrop-filter: blur(10px) !important;
            color: white !important;
            padding: 12px 20px !important;
            border-radius: 12px !important;
            font-size: 14px !important;
            z-index: 10000 !important;
            display: flex !important;
            align-items: center !important;
            gap: 10px !important;
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
            box-shadow: 0 4px 15px rgba(0,0,0,0.5) !important;
            transform: translateY(100px);
            transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        }
        .grok-toast.visible {
            transform: translateY(0);
        }
        .grok-toast-icon { font-size: 20px; }
    `;

    const style = document.createElement('style');
    style.textContent = BADGE_CSS;
    (document.head || document.documentElement).appendChild(style);

    let isInjecting = false;
    let currentFilter = 'all';
    let currentViewMode = 'normal'; // 'normal' | 'force_image'
    let currentSearchQuery = '';
    let currentSaveFilter = 'all'; // 'all' | 'img_saved' | 'vid_saved' | 'both_saved' | 'any_saved'
    let cachedUserData = null;

    function extractGrokUserData() {
        if (cachedUserData) return cachedUserData;
        const scripts = Array.from(document.querySelectorAll('script'));
        for (const s of scripts) {
            const content = s.textContent;
            if (content.includes('"email":') && content.includes('"givenName":')) {
                try {
                    // Cleaner extraction logic inspired by user script
                    const clean = content.replace(/\\"/g, '"');
                    const email = clean.match(/"email"\s*:\s*"([^"]+)"/)?.[1];
                    const nome = clean.match(/"givenName"\s*:\s*"([^"]+)"/)?.[1];
                    const cognome = clean.match(/"familyName"\s*:\s*"([^"]+)"/)?.[1];
                    if (email) {
                        cachedUserData = { email, nome, cognome };
                        return cachedUserData;
                    }
                } catch (e) {}
            }
        }
        return null;
    }

    function injectFilterPanel() {
        if (!window.location.href.includes('/imagine/saved')) return;
        if (document.getElementById('grok-filter-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'grok-filter-panel';
        panel.className = 'grok-filter-drawer';
        
        // Tab element
        const tab = document.createElement('div');
        tab.className = 'grok-filter-tab';
        tab.textContent = 'Filtri';
        panel.appendChild(tab);

        const contentWrapper = document.createElement('div');

        // ── Sezione label style ──────────────────────────────────────────────
        const sectionLabelStyle = 'font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; margin: 6px 0 4px; padding: 2px 0;';
        const radioLabelStyle   = 'display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 12px; padding: 1px 0;';

        contentWrapper.innerHTML = `
            <div style="font-weight: 700; margin-bottom: 2px; font-size: 14px; display: flex; justify-content: space-between; align-items: center;">
                Filtra Risultati
                <span style="font-size: 12px; opacity: 0.7;">🔍</span>
            </div>
            <div style="margin-bottom: 8px;">
                <input type="text" id="grok-search-input" placeholder="Cerca nel prompt..." value="${currentSearchQuery}" style="width: 100%; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: #fff; padding: 4px 8px; font-size: 12px; outline: none;">
            </div>

            <div style="${sectionLabelStyle} color: #ff6b6b;">Tipo di contenuto</div>
            <label style="${radioLabelStyle}" title="Mostra solo le generazioni che non contengono video (solo immagini statiche)">
                <input type="radio" name="grok-filter" value="photo_only" ${currentFilter === 'photo_only' ? 'checked' : ''}>
                Solo foto (senza video)
            </label>
            <label style="${radioLabelStyle}" title="Mostra solo le generazioni che includono almeno un video">
                <input type="radio" name="grok-filter" value="has_video" ${currentFilter === 'has_video' ? 'checked' : ''}>
                Almeno un video
            </label>
            <label style="${radioLabelStyle}" title="Mostra solo le generazioni con più di un video">
                <input type="radio" name="grok-filter" value="multiple_videos" ${currentFilter === 'multiple_videos' ? 'checked' : ''}>
                Più di un video
            </label>
            <label style="${radioLabelStyle}" title="Nessun filtro attivo – mostra tutti i contenuti">
                <input type="radio" name="grok-filter" value="all" ${currentFilter === 'all' ? 'checked' : ''}>
                Tutti
            </label>

            <hr style="border: none; border-top: 1px solid rgba(255,255,255,0.15); margin: 6px 0 2px;">

            <div style="${sectionLabelStyle} color: #ff6b6b;">Modalità visualizzazione</div>
            <label style="${radioLabelStyle}" title="Nasconde il video e mostra sempre l'immagine statica al suo posto, per ogni card">
                <input type="radio" name="grok-view-mode" value="force_image" ${currentViewMode === 'force_image' ? 'checked' : ''}>
                Forza immagini
            </label>
            <label style="${radioLabelStyle}" title="Lascia la visualizzazione predefinita di Grok (video e immagine come vengono caricati)">
                <input type="radio" name="grok-view-mode" value="normal" ${currentViewMode === 'normal' ? 'checked' : ''}>
                Normale
            </label>

            <hr style="border: none; border-top: 1px solid rgba(255,255,255,0.15); margin: 6px 0 2px;">

            <div style="${sectionLabelStyle} color: #ff6b6b;">Stato salvataggio</div>
            <label style="${radioLabelStyle}" title="Nessun filtro – mostra tutti i risultati indipendentemente dal salvataggio">
                <input type="radio" name="grok-save-filter" value="all" ${currentSaveFilter === 'all' ? 'checked' : ''}>
                Tutti
            </label>
            <label style="${radioLabelStyle}" title="Mostra solo le card in cui l'immagine è già stata salvata in biblioteca">
                <input type="radio" name="grok-save-filter" value="img_saved" ${currentSaveFilter === 'img_saved' ? 'checked' : ''}>
                Immagine salvata
            </label>
            <label style="${radioLabelStyle}" title="Mostra solo le card in cui il video è già stato salvato in biblioteca">
                <input type="radio" name="grok-save-filter" value="vid_saved" ${currentSaveFilter === 'vid_saved' ? 'checked' : ''}>
                Video salvato
            </label>
            <label style="${radioLabelStyle}" title="Mostra solo le card in cui sia l'immagine che il video sono stati salvati in biblioteca">
                <input type="radio" name="grok-save-filter" value="both_saved" ${currentSaveFilter === 'both_saved' ? 'checked' : ''}>
                Entrambi salvati
            </label>
            <label style="${radioLabelStyle}" title="Mostra le card in cui almeno uno tra immagine e video è stato salvato in biblioteca">
                <input type="radio" name="grok-save-filter" value="any_saved" ${currentSaveFilter === 'any_saved' ? 'checked' : ''}>
                Almeno uno salvato
            </label>
            <label style="${radioLabelStyle}" title="Mostra solo le card che non hanno ancora nulla salvato in biblioteca">
                <input type="radio" name="grok-save-filter" value="none_saved" ${currentSaveFilter === 'none_saved' ? 'checked' : ''}>
                Nessuno salvato
            </label>
        `;
        panel.appendChild(contentWrapper);

        if (document.documentElement) {
            document.documentElement.appendChild(panel);
        } else if (document.body) {
            document.body.appendChild(panel);
        }

        panel.querySelectorAll('input[name="grok-filter"]').forEach(input => {
            input.addEventListener('change', (e) => {
                currentFilter = e.target.value;
                // Esecuzione immediata (scavalca il debounce) testando che isInjecting non blocchi
                isInjecting = false; 
                injectBadges();

                // Forza il ricalcolo della griglia se Grok usa una viewport virtualizzata/masonry
                const triggerReflow = () => {
                    window.dispatchEvent(new Event('resize'));
                    window.dispatchEvent(new Event('scroll'));
                    document.dispatchEvent(new Event('scroll'));
                };
                setTimeout(triggerReflow, 50);
                setTimeout(triggerReflow, 250);
            });
        });

        panel.querySelectorAll('input[name="grok-view-mode"]').forEach(input => {
            input.addEventListener('change', (e) => {
                currentViewMode = e.target.value;
                isInjecting = false;
                applyViewMode();
                injectBadges();
            });
        });

        panel.querySelectorAll('input[name="grok-save-filter"]').forEach(input => {
            input.addEventListener('change', (e) => {
                currentSaveFilter = e.target.value;
                isInjecting = false;
                injectBadges();
                const triggerReflow = () => {
                    window.dispatchEvent(new Event('resize'));
                    window.dispatchEvent(new Event('scroll'));
                };
                setTimeout(triggerReflow, 50);
                setTimeout(triggerReflow, 250);
            });
        });

        const searchInput = panel.querySelector('#grok-search-input');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                currentSearchQuery = e.target.value.toLowerCase();
                isInjecting = false;
                injectBadges();
            });
        }
    }

    function applyViewMode() {
        const listContainer = document.querySelector('div[role="list"]') || document.querySelector('.grid[style*="grid-template-columns"]');
        if (!listContainer) return;
        
        // Use a safer selector to avoid SyntaxErrors with Tailwind slashes and :has
        const allContainers = listContainer.querySelectorAll('.relative');
        allContainers.forEach(container => {
            // Filter only masonry cards or items with images
            const isMasonry = container.classList.contains('group/media-post-masonry-card');
            const hasImg = container.querySelector('img');
            if (!isMasonry && !hasImg) return;
            
            const video = container.querySelector('video');
            const img = container.querySelector('img');
            if (!video || !img) return;
            if (currentViewMode === 'force_image') {
                video.style.setProperty('display', 'none', 'important');
                img.style.removeProperty('display');
            } else {
                video.style.removeProperty('display');
                // Only restore img display if it was hidden by us (it has display:none set inline)
                if (img.style.display === 'none') img.style.removeProperty('display');
            }
        });
    }

    function setupVideoRevealOnHover(btn, container) {
        const videoEl = container.querySelector('video');
        const imgEl = container.querySelector('img');
        if (!videoEl || !imgEl) return;

        let tempImg = null;

        btn.addEventListener('mouseenter', (e) => {
            e.stopPropagation();
            videoEl.style.setProperty('opacity', '0', 'important');
            videoEl.style.setProperty('pointer-events', 'none', 'important');
            
            if (!tempImg) {
                tempImg = document.createElement('img');
                tempImg.src = imgEl.src;
                tempImg.className = 'grok-temp-reveal-img';
                tempImg.style.cssText = `
                    position: absolute !important;
                    top: 0 !important;
                    left: 0 !important;
                    width: 100% !important;
                    height: 100% !important;
                    object-fit: cover !important;
                    z-index: 49 !important; /* Below action icons (51) */
                    pointer-events: none !important;
                    border-radius: inherit !important;
                `;
                container.appendChild(tempImg);
            }
        });

        btn.addEventListener('mouseleave', (e) => {
            e.stopPropagation();
            videoEl.style.removeProperty('opacity');
            videoEl.style.removeProperty('pointer-events');
            
            if (tempImg) {
                tempImg.remove();
                tempImg = null;
            }
        });

        // Ensure video is restored if mouse exits card while hovering btn
        container.addEventListener('mouseleave', () => {
            videoEl.style.removeProperty('opacity');
            videoEl.style.removeProperty('pointer-events');
            
            if (tempImg) {
                tempImg.remove();
                tempImg = null;
            }
        });
    }

    function showToast(message, icon = '✅') {
        let toast = document.querySelector('.grok-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.className = 'grok-toast';
            document.body.appendChild(toast);
        }
        toast.innerHTML = `<span class="grok-toast-icon">${icon}</span> <span>${message}</span>`;
        toast.classList.add('visible');
        setTimeout(() => toast.classList.remove('visible'), 3000);
    }


    function injectBadges() {
        if (isInjecting) return;
        if (!window.location.href.includes('/imagine/saved')) {
            const panel = document.getElementById('grok-filter-panel');
            if (panel) panel.remove();
            return;
        }

        injectFilterPanel();

        const listContainer = document.querySelector('div[role="list"]') || document.querySelector('.grid[style*="grid-template-columns"]');
        if (!listContainer) return;

        // Seleziona tutti i container potenziali e filtra manualmente per evitare SyntaxError
        const allRelatives = listContainer.querySelectorAll('.relative');
        const items = Array.from(allRelatives).filter(el => 
            el.classList.contains('group/media-post-masonry-card') || el.querySelector('img')
        );
        
        if (items.length === 0) return;

        if (localMediaItems.length === 0) {
            // Avoid flooding logs and don't show "0" badges yet if cache is completely empty
            // as it's likely still loading from storage or waiting for the first JSON.
            return;
        }

        isInjecting = true;
        try {
            items.forEach(container => {

                const mediaEl = container.querySelector('img, video');
                if (!mediaEl) return;

                const src = mediaEl.src || mediaEl.currentSrc;
                if (!src || src.startsWith('blob:')) return;

                const urlNoQuery = src.split('?')[0];
                const allIdsInUrl = src.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/gi) || [];

                const currentBadgeId = allIdsInUrl[0] || urlNoQuery;
                const existingBadge = container.querySelector('.grok-media-badge');

                // Fast Map Lookup
                let match = mediaMap.get(allIdsInUrl[0]) || mediaMap.get(urlNoQuery);
                if (!match) {
                    for (const id of allIdsInUrl) {
                        match = mediaMap.get(id);
                        if (match) break;
                    }
                }

                const listItem = container.closest('div[role="listitem"]') || container;

                if (currentSearchQuery) {
                    const promptText = (match && match.prompt) ? match.prompt.toLowerCase() : '';
                    if (!promptText.includes(currentSearchQuery)) {
                        listItem.style.setProperty('display', 'none', 'important');
                        return;
                    }
                }

                if (!match) {
                    if (currentFilter !== 'all') {
                        listItem.style.setProperty('display', 'none', 'important');
                    } else {
                        // Se non c'è filtro ma c'è ricerca, display è già gestito sopra? 
                        // No, se arriviamo qui e non c'è ricerca, resettiamo display.
                        if (!currentSearchQuery) listItem.style.removeProperty('display');
                    }

                    // Only add "0" if there isn't one already. 
                    // This prevents the infinite removal/re-addition loop.
                    if (existingBadge) {
                        if (existingBadge.dataset.id === currentBadgeId && existingBadge.classList.contains('error-badge')) return;
                        existingBadge.remove();
                    }

                    const badge = document.createElement('div');
                    badge.className = 'grok-media-badge error-badge';
                    badge.dataset.id = currentBadgeId;
                    badge.innerHTML = '<span>0</span>';
                    container.appendChild(badge);
                    return;
                }

                const imgCount = parseInt(match.postImageCount) || 0;
                const vidCounts = match.postVideoCount || 0;

                // Check for videos (Metadata + DOM fallback for accuracy)
                let totalVideos = 0;
                if (typeof vidCounts === 'object') {
                    totalVideos = Object.values(vidCounts).reduce((sum, c) => sum + (parseInt(c) || 0), 0);
                } else {
                    totalVideos = parseInt(vidCounts) || 0;
                }
                const hasVideos = totalVideos > 0 || !!container.querySelector('video');
                const multipleVideos = totalVideos > 1;

                // --- 1. Apply Filtering Logic ---
                // We do this before the early return to ensure UI updates immediately on filter change
                if (currentFilter === 'photo_only') {
                    if (!hasVideos) listItem.style.removeProperty('display');
                    else listItem.style.setProperty('display', 'none', 'important');
                } else if (currentFilter === 'has_video') {
                    if (hasVideos) listItem.style.removeProperty('display');
                    else listItem.style.setProperty('display', 'none', 'important');
                } else if (currentFilter === 'multiple_videos') {
                    if (multipleVideos) listItem.style.removeProperty('display');
                    else listItem.style.setProperty('display', 'none', 'important');
                } else {
                    listItem.style.removeProperty('display');
                }

                // --- 2. Apply Save-State Filtering Logic ---
                if (currentSaveFilter !== 'all') {
                    // Collect all IDs associated with this card's match
                    const candidateIds = new Set();
                    if (match.id) candidateIds.add(match.id);
                    if (match.originalPostId) candidateIds.add(match.originalPostId);
                    if (match.parentId) candidateIds.add(match.parentId);
                    if (match.associatedIds) match.associatedIds.forEach(id => candidateIds.add(id));

                    // Check library for saved image / saved video by matching IDs
                    const imgSaved = libraryItems.some(li =>
                        li.type === 'image' && (
                            (li.id && candidateIds.has(li.id)) ||
                            (match.prompt && li.prompt === match.prompt)
                        )
                    );
                    const vidSaved = libraryItems.some(li =>
                        li.type === 'video' && (
                            (li.id && candidateIds.has(li.id)) ||
                            (match.prompt && li.prompt === match.prompt)
                        )
                    );

                    let passeSaveFilter = false;
                    if (currentSaveFilter === 'img_saved')   passeSaveFilter = imgSaved;
                    else if (currentSaveFilter === 'vid_saved')  passeSaveFilter = vidSaved;
                    else if (currentSaveFilter === 'both_saved') passeSaveFilter = imgSaved && vidSaved;
                    else if (currentSaveFilter === 'any_saved')  passeSaveFilter = imgSaved || vidSaved;
                    else if (currentSaveFilter === 'none_saved') passeSaveFilter = !imgSaved && !vidSaved;

                    if (!passeSaveFilter) {
                        listItem.style.setProperty('display', 'none', 'important');
                        return;
                    }
                }

                // Only return early if BOTH the badge and the action container are already present and correct
                const actionContainerExists = container.querySelector('.grok-action-container');
                if (existingBadge && existingBadge.dataset.id === currentBadgeId && actionContainerExists) {
                    if (!existingBadge.classList.contains('error-badge')) return;
                }

                // -- Action Icons (Info & Save) --
                let actionContainer = container.querySelector('.grok-action-container');
                if (actionContainer) actionContainer.remove();

                if (match.prompt || match.url) {
                    actionContainer = document.createElement('div');
                    actionContainer.className = 'grok-action-container';
                    
                    // 1. Info Icon (Prompt)
                    if (match.prompt) {
                        const infoIcon = document.createElement('div');
                        infoIcon.className = 'grok-action-icon grok-info-icon';
                        infoIcon.innerHTML = 'ℹ️';
                        infoIcon.setAttribute('data-tooltip', match.prompt);
                        infoIcon.onclick = (e) => {
                            e.stopPropagation();
                            if (!chrome.runtime?.id) return;
                            navigator.clipboard.writeText(match.prompt).then(() => {
                                const oldHtml = infoIcon.innerHTML;
                                infoIcon.innerHTML = '✅';
                                setTimeout(() => { if (infoIcon) infoIcon.innerHTML = oldHtml; }, 1500);
                            });
                        };
                        actionContainer.appendChild(infoIcon);
                    }

                    // 2. Save Icons (Photo & Video)
                    const imageItem = (match.type === 'image') ? match : localMediaItems.find(item => 
                        item.type === 'image' && (
                            (match.parentId && item.parentId === match.parentId) || 
                            (match.originalPostId && item.originalPostId === match.originalPostId) || 
                            (match.id && item.associatedIds && item.associatedIds.includes(match.id)) || 
                            (item.id && match.associatedIds && match.associatedIds.includes(item.id))
                        )
                    );

                    const videoItem = (match.type === 'video') ? match : localMediaItems.find(item => 
                        item.type === 'video' && (
                            (match.parentId && item.parentId === match.parentId) || 
                            (match.originalPostId && item.originalPostId === match.originalPostId) || 
                            (match.id && item.associatedIds && item.associatedIds.includes(match.id)) || 
                            (item.id && match.associatedIds && match.associatedIds.includes(item.id))
                        )
                    );

                    const createSaveButton = (targetItem, type) => {
                        const isPhoto = type === 'photo';
                        const isAlreadySaved = libraryItems.some(li => 
                            (targetItem.id && li.id === targetItem.id) ||
                            (targetItem.originalPostId && li.id === targetItem.originalPostId)
                        );

                        const btn = document.createElement('div');
                        btn.className = `grok-action-icon grok-save-icon ${isPhoto ? 'grok-save-photo' : 'grok-save-video'}`;
                        
                        if (isAlreadySaved) {
                            btn.innerHTML = '✅'; 
                            btn.style.border = '2px solid var(--success, #3fb950)';
                            btn.setAttribute('data-tooltip', `Già salvato (${isPhoto ? 'Foto' : 'Video'})`);
                            btn.onclick = (e) => e.stopPropagation();
                        } else {
                            btn.innerHTML = isPhoto ? '📸' : '🎥';
                            btn.setAttribute('data-tooltip', isPhoto ? 'Salva Foto in Biblioteca' : 'Salva Video in Biblioteca');
                            let isSaving = false;
                            
                            btn.onclick = async (e) => {
                                e.stopPropagation();
                                if (isSaving || !chrome.runtime?.id) return;

                                isSaving = true;
                                const oldHtml = btn.innerHTML;
                                btn.innerHTML = '⌛';
                                btn.style.opacity = '0.5';

                                try {
                                    console.log('[Grok Downloader] Tentativo salvataggio:', { type, id: targetItem.id, url: targetItem.imageUrl || targetItem.videoUrl });
                                    
                                    let dataUrl = null;
                                    let aspectRatio = targetItem.aspectRatio || '';

                                    if (isPhoto) {
                                        const candidateUrls = [targetItem.imageUrl, targetItem.thumbnailUrl, targetItem.url].filter(u => typeof u === 'string' && u.trim());
                                        let rawImageUrl = candidateUrls.find(u => !u.includes('preview.jpg')) || candidateUrls[0];
                                        if (!rawImageUrl) throw new Error('No image URL found');
                                        
                                        const res = await resizeImage(rawImageUrl, 1280);
                                        dataUrl = res.dataUrl;
                                        aspectRatio = res.aspectRatio || aspectRatio;
                                    } else {
                                        dataUrl = await fetchMediaAsDataUrl(targetItem.videoUrl || targetItem.url);
                                        if (!dataUrl) throw new Error('Failed to fetch video data');
                                    }

                                    const userData = extractGrokUserData();
                                    const saveItem = {
                                        id: targetItem.id || `lib_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                                        url: dataUrl,
                                        aspectRatio: aspectRatio,
                                        prompt: targetItem.prompt || '',
                                        type: isPhoto ? 'image' : 'video',
                                        filename: targetItem.filename,
                                        createTime: targetItem.createTime || new Date().toISOString(),
                                        savedAt: Date.now(),
                                        user: userData,
                                        details: targetItem.details
                                    };
                                    
                                    chrome.runtime.sendMessage({ action: 'saveToLibrary', item: saveItem }, (response) => {
                                        isSaving = false;
                                        btn.style.opacity = '1';
                                        if (response && response.ok) {
                                            btn.innerHTML = '✅';
                                            btn.style.border = '2px solid var(--success, #3fb950)';
                                            btn.setAttribute('data-tooltip', 'Salvato!');
                                            showToast(isPhoto ? 'Foto salvata in Biblioteca' : 'Video salvato in Biblioteca');
                                            debouncedInject();
                                        } else {
                                            btn.innerHTML = '❌';
                                            showToast('Errore durante il salvataggio', '⚠️');
                                            setTimeout(() => { if (btn) btn.innerHTML = oldHtml; }, 1500);
                                        }
                                    });
                                } catch (err) {
                                    console.error('[Grok Downloader] Errore salvataggio:', err);
                                    isSaving = false;
                                    btn.style.opacity = '1';
                                    btn.innerHTML = '❌';
                                    setTimeout(() => { if (btn) btn.innerHTML = oldHtml; }, 1500);
                                }
                            };
                            if (isPhoto) setupVideoRevealOnHover(btn, container);
                        }
                        return btn;
                    };

                    if (imageItem) actionContainer.appendChild(createSaveButton(imageItem, 'photo'));
                    if (videoItem) actionContainer.appendChild(createSaveButton(videoItem, 'video'));
                    
                    container.appendChild(actionContainer);
                }

                if (imgCount > 0 || hasVideos) {
                    if (existingBadge) existingBadge.remove();

                    const badge = document.createElement('div');
                    badge.className = 'grok-media-badge';
                    badge.dataset.id = currentBadgeId;

                    let html = '';
                    if (imgCount > 0) {
                        html += `<span>🖼️ ${imgCount}</span>`;
                    }
                    
                    if (typeof vidCounts === 'object') {
                        const resEntries = Object.entries(vidCounts).filter(([_, count]) => count > 0);
                        if (resEntries.length > 0) {
                            if (html) html += '<span style="opacity: 0.4">|</span>';
                            const vidHtml = resEntries.map(([res, count]) => {
                                let displayRes = `x ${res}`;
                                if (res === '480p') displayRes = ' SD';
                                else if (res === '720p') displayRes = ' HD';
                                return `<span>🎥 ${count}<span style="color: #9ca3af; font-weight: 500; font-size: 10px">${displayRes}</span></span>`;
                            }).join(' ');
                            html += vidHtml;
                        }
                    } else {
                        const vCount = parseInt(vidCounts) || 0;
                        if (vCount > 0) {
                            if (html) html += '<span style="opacity: 0.4">|</span>';
                            html += `<span>🎥 ${vCount}</span>`;
                        }
                    }

                    badge.innerHTML = html;
                    container.appendChild(badge);
                } else {
                    if (existingBadge) existingBadge.remove();
                }
            });
        } finally {
            isInjecting = false;
        }

        // Apply view mode after badge injection completes
        applyViewMode();
    }

    // ─── Injection ─────────────────────────────────────────────────────────────
    if (chrome.runtime?.id) {
        const s = document.createElement('script');
        s.src = chrome.runtime.getURL('inject.js');
        s.onload = function () { this.remove(); };
        (document.head || document.documentElement).appendChild(s);
    }


    // ─── Observers ─────────────────────────────────────────────────────────────
    let reorderEnabled = false;
    if (chrome.runtime?.id) {
        chrome.storage.sync.get({ reorderEnabled: false }, (data) => {
            reorderEnabled = data.reorderEnabled;
            initGlobalObserver();
        });
    }

    let globalObserver = null;
    function initGlobalObserver() {
        if (globalObserver) return;

        globalObserver = new MutationObserver((mutations) => {
            // Apply badges only on saved page
            if (window.location.href.includes('/imagine/saved')) {
                debouncedInject();
            } else {
                const panel = document.getElementById('grok-filter-panel');
                if (panel) panel.remove();
            }

            // Reorder only on saved page if enabled
            if (reorderEnabled && window.location.href.includes('/imagine/saved')) {
                const list = document.querySelector('div[role="list"]') || document.querySelector('.grid[style*="grid-template-columns"]');
                if (list) reorderList(list);
            }
        });

        globalObserver.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src']
        });

        // Initial check
        if (window.location.href.includes('/imagine/saved')) {
            debouncedInject();

            // Follow-up checks as things load
            setTimeout(debouncedInject, 500);
            setTimeout(debouncedInject, 1500);
            setTimeout(debouncedInject, 3000);
            setTimeout(debouncedInject, 6000);
        }

        if (reorderEnabled && window.location.href.includes('/imagine/saved')) {
            const list = document.querySelector('div[role="list"]') || document.querySelector('.grid[style*="grid-template-columns"]');
            if (list) reorderList(list);
        }
    }

    // Run again when everything is likely ready
    window.addEventListener('load', () => {
        if (window.location.href.includes('/imagine/saved')) {
            debouncedInject();
            setTimeout(debouncedInject, 2000);
        }
    });

    // Scroll listener for lazy-loaded Masonry items
    window.addEventListener('scroll', () => {
        debouncedInject();
    }, { passive: true });

    let isReordering = false;
    async function reorderList(list) {
        if (isReordering) return;

        let items = Array.from(list.querySelectorAll('div[role="listitem"]'));
        if (items.length === 0) {
            items = Array.from(list.children).filter(el => el.classList.contains('relative'));
        }
        if (items.length <= 1) return;

        if (!chrome.runtime?.id) return;
        let mediaItems = [];
        try {
            const data = await chrome.storage.local.get('mediaItems');
            if (!chrome.runtime?.id) return;
            mediaItems = data.mediaItems || [];
        } catch (e) {
            if (globalObserver) {
                globalObserver.disconnect();
                globalObserver = null;
            }
            return;
        }

        if (mediaItems.length === 0) return;

        // Filter out items that are placeholders or don't have a reliable source yet
        const validItems = items.filter(el => {
            const mediaEl = el.querySelector('img, video');
            return mediaEl && (mediaEl.src || mediaEl.currentSrc);
        });

        if (validItems.length <= 1) return;

        const itemData = validItems.map(el => {
            const mediaEl = el.querySelector('img, video');
            const src = mediaEl.src || mediaEl.currentSrc;

            let idMatch = src.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
            const id = idMatch ? idMatch[1] : null;

            const match = id ? mediaItems.find(m => {
                if (m.associatedIds && m.associatedIds.includes(id)) return true;
                return m.id === id || m.originalPostId === id;
            }) : null;

            return {
                el,
                createTime: match && match.createTime ? new Date(match.createTime).getTime() : 0,
                id: id
            };
        });

        const knownItems = itemData.filter(d => d.createTime > 0);
        const unknownItems = itemData.filter(d => d.createTime === 0);

        knownItems.sort((a, b) => b.createTime - a.createTime);
        const sorted = [...knownItems, ...unknownItems];

        const currentOrder = validItems;
        const newOrder = sorted.map(d => d.el);

        const isDifferent = newOrder.some((el, i) => el !== currentOrder[i]);
        if (!isDifferent) return;

        isReordering = true;

        const fragment = document.createDocumentFragment();
        newOrder.forEach(el => fragment.appendChild(el));
        items.filter(el => !validItems.includes(el)).forEach(el => fragment.appendChild(el));

        list.innerHTML = '';
        list.appendChild(fragment);

        setTimeout(() => { isReordering = false; }, 150);
    }
    // ─── Delete Shortcut ──────────────────────────────────────────────────────
    window.addEventListener('keydown', async (e) => {
        if (e.key === 'Delete' || e.key === 'Del') {
            const url = window.location.href;
            if (!url.includes('grok.com/imagine/post/')) return;

            // Don't trigger if typing in an input
            const target = e.target;
            if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

            // Check DOM structure for specific warning
            let showWarning = false;
            const article = document.querySelector('article');
            if (article) {
                const selectedEl = article.querySelector('[tabindex="0"]');
                if (selectedEl) {
                    const children = Array.from(selectedEl.children);
                    // Check Case 1: Series container (tabindex="0" on a div with exactly 2 scroll-gradient-sentinel children)
                    const isSentinelContainer = selectedEl.tagName === 'DIV' && 
                        children.length === 2 && 
                        children.every(child => child.classList.contains('scroll-gradient-sentinel'));
                    
                    if (isSentinelContainer) {
                        showWarning = true;
                    } else {
                        // Check Case 2: tabindex="0" on a button
                        const allButtons = Array.from(article.querySelectorAll('button'));
                        if (allButtons.length > 0 && selectedEl === allButtons[0] && selectedEl.tagName === 'BUTTON') {
                            showWarning = true;
                        }
                    }
                }
            }

            let confirmMsg = 'Sei sicuro di voler eliminare questo post?';
            if (showWarning) {
                confirmMsg = '⚠️ CANCELLANDO QUELLA FOTO VERRA\' CANCELLATA TUTTA LA SERIE DI QUELLA, VIDEO COMPRESI';
            }

            const confirmed = window.confirm(confirmMsg);
            if (!confirmed) return;

            // 1. Find the "Altre opzioni" button (take the last one visible)
            const moreBtns = Array.from(document.querySelectorAll('button[aria-label="Altre opzioni"]'));
            if (moreBtns.length === 0) {
                console.warn('[Grok Downloader] Pulsante "Altre opzioni" non trovato.');
                alert('Pulsante "Altre opzioni" non trovato.');
                return;
            }
            const moreBtn = moreBtns[moreBtns.length - 1];

            // 2. Click it to open the menu
            moreBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            moreBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            moreBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
            moreBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            moreBtn.click();

            // 3. Wait for the menu item to appear
            let attempts = 0;
            const findAndClickDelete = () => {
                const menuItems = Array.from(document.querySelectorAll('[role="menuitem"]'));
                const deleteItem = menuItems.find(item => 
                    item.classList.contains('text-fg-danger') || 
                    item.textContent.toLowerCase().includes('elimina')
                );

                if (deleteItem) {
                    deleteItem.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
                    deleteItem.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                    deleteItem.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
                    deleteItem.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                    deleteItem.click();
                    console.log('[Grok Downloader] Comando di eliminazione inviato.');
                    
                    setTimeout(() => {
                        const confirmBtns = Array.from(document.querySelectorAll('button'));
                        const finalBtn = confirmBtns.find(b => 
                            (b.textContent.toLowerCase().includes('elimina') || b.classList.contains('bg-danger')) &&
                            b !== deleteItem
                        );
                        if(finalBtn) finalBtn.click();
                    }, 200);

                } else if (attempts < 60) {
                    attempts++;
                    setTimeout(findAndClickDelete, 50);
                } else {
                    console.warn('[Grok Downloader] Pulsante "Elimina" non trovato nel menu.');
                    alert('Non è stato possibile trovare il pulsante Elimina (forse il menu non si è aperto correttamente). Riprova.');
                }
            };

            setTimeout(findAndClickDelete, 100);
        }
    });

})();
