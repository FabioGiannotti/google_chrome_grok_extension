(function () {
    const TARGET_URL = 'https://grok.com/rest/media/post/list';
    let interceptActive = true;

    window.postMessage({ source: 'grok-page', type: 'GET_INTERCEPT_STATE' }, '*');

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        if (!event.data || event.data.source !== 'grok-content') return;
        if (event.data.type === 'SET_INTERCEPT') {
            interceptActive = event.data.active;
        }
    });

    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const response = await originalFetch.apply(this, args);
        if (!interceptActive) return response;

        const url = (typeof args[0] === 'string') ? args[0] : args[0]?.url;
        if (!url || (!url.includes('/rest/') && !url.includes('/imagine/') && !url.includes('x.ai'))) return response;

        const cloned = response.clone();
        cloned.json().then((data) => {
            if (!data) return;
            const items = extractMedia(data);
            if (items.length > 0) {
                window.postMessage({ source: 'grok-injector', type: 'NEW_MEDIA', items }, '*');
            }
        }).catch(e => {});

        return response;
    };

    const originalXHR = window.XMLHttpRequest;
    function GrokXHR() {
        const xhr = new originalXHR();
        const originalOpen = xhr.open;
        xhr.open = function(method, url) {
            this._url = url;
            return originalOpen.apply(this, arguments);
        };
        xhr.addEventListener('load', function() {
            if (!interceptActive || !this._url) return;
            if (!this._url.includes('/rest/') && !this._url.includes('/imagine/') && !this._url.includes('x.ai')) return;
            try {
                const data = JSON.parse(this.responseText);
                if (data) {
                    const items = extractMedia(data);
                    if (items.length > 0) {
                        window.postMessage({ source: 'grok-injector', type: 'NEW_MEDIA', items }, '*');
                    }
                }
            } catch (e) {}
        });
        return xhr;
    }
    window.XMLHttpRequest = GrokXHR;

    function logMessage(level, message, details = '') {
        window.postMessage({ source: 'grok-injector', type: 'LOG', level, message, details }, '*');
    }

    function extractMedia(rootData) {
        logMessage('info', `Avvio analisi risposta API...`);
        const results = [];
        const seen = new Set();
        const suppressedIds = new Set();
        const THUMBNAIL_KEYS = new Set(['thumbnailImageUrl', 'lastFrameThumbnailImageUrl']);

        const postCounts = new Map();

        function countPass(obj, currentPostId) {
            if (!obj || typeof obj !== 'object') return;
            if (Array.isArray(obj)) {
                obj.forEach(item => countPass(item, currentPostId));
                return;
            }

            let activePostId = currentPostId;
            if (obj.id) {
                const myRootId = obj.originalPostId || obj.parentPostId || obj.id;
                if (!currentPostId) {
                    activePostId = myRootId;
                    if (!postCounts.has(activePostId)) {
                        postCounts.set(activePostId, { images: 0, videoResolutions: {}, seenUrls: new Set() });
                    }
                }
            }

            let url = obj.mediaUrl || obj.imageUrl || obj.url || obj.thumbnailImage || obj.thumbnailImageUrl;
            
            if (url && typeof url === 'string') {
                const isVideo = (obj.mediaType && obj.mediaType.includes('VIDEO')) || (obj.mimeType && obj.mimeType.startsWith('video/')) || url.toLowerCase().endsWith('.mp4');
                const isImage = (obj.mediaType && obj.mediaType.includes('IMAGE')) || (obj.mimeType && obj.mimeType.startsWith('image/')) || url.match(/\.(jpg|jpeg|png|webp|gif|svg)([:\?]|$)/i);
                
                if (activePostId && postCounts.has(activePostId)) {
                    const counts = postCounts.get(activePostId);
                    if (!counts.seenUrls.has(url)) {
                        counts.seenUrls.add(url);
                        if (isVideo) {
                            const resName = obj.resolutionName || 'SD';
                            counts.videoResolutions[resName] = (counts.videoResolutions[resName] || 0) + 1;
                        }
                        else if (isImage) counts.images++;
                    }
                }
            }

            const recurseKeys = ['images', 'videos', 'posts', 'childPosts', 'media', 'items', 'imageResults'];
            recurseKeys.forEach(key => obj[key] && countPass(obj[key], activePostId));
        }

        countPass(rootData, null);

        function walk(obj, parentPrompt, parentId, topPostId, typeHint = null, contextIds = []) {
            if (!obj || typeof obj !== 'object') return;
            if (Array.isArray(obj)) {
                obj.forEach(item => walk(item, parentPrompt, parentId, topPostId, typeHint, contextIds));
                return;
            }

            let currentTopPostId = topPostId;
            let currentContextIds = [...contextIds];

            if (obj.id) {
                if (!currentContextIds.includes(obj.id)) {
                    currentContextIds.push(obj.id);
                }
                const myRootId = obj.originalPostId || obj.parentPostId || obj.id;
                if (!topPostId) {
                    currentTopPostId = myRootId;
                }
            }

            if (obj.videoExtensionStartTime != null && obj.videoExtensionStartTime !== '' && obj.videoExtensionStartTime !== 0 && obj.originalPostId) {
                suppressedIds.add(obj.originalPostId);
                logMessage('info', `Rilevata estensione video per post ${obj.originalPostId}`);
            }

            let prompt = (obj.prompt || obj.generationPrompt || obj.caption || '').trim();
            if (prompt.startsWith('Signature:')) {
                prompt = (obj.generationPrompt || obj.caption || '').trim();
                if (prompt.startsWith('Signature:')) prompt = '';
            }
            
            const pPrompt = (parentPrompt || '').trim();
            if (pPrompt && prompt && pPrompt !== prompt) {
                prompt = pPrompt + ' - ' + prompt;
            } else {
                prompt = prompt || pPrompt;
            }

            const candidateUrls = [
                obj.mediaUrl, obj.imageUrl, obj.url, obj.downloadUrl, obj.thumbnailImage, obj.thumbnailImageUrl, obj.sourceUrl
            ].filter(u => typeof u === 'string' && u.trim());
            
            let url = candidateUrls.find(u => !u.includes('preview.jpg')) || candidateUrls[0];

            const mediaType = obj.mediaType;
            const mimeType = obj.mimeType;

            if (url && typeof url === 'string' && !seen.has(url)) {
                const isVideo = typeHint === 'video' || (mediaType && mediaType.includes('VIDEO')) || (mimeType && mimeType.startsWith('video/')) || url.toLowerCase().endsWith('.mp4') || url.includes('/videos/');
                const isImage = typeHint === 'image' || (mediaType && mediaType.includes('IMAGE')) || (mimeType && mimeType.startsWith('image/')) || url.match(/\.(jpg|jpeg|png|webp|gif|svg)([:\?]|$)/i) || url.includes('/images/') || url.includes('pbs.twimg.com/media/');
                
                const type = isVideo ? 'video' : (isImage ? 'image' : null);
                
                if (type) {
                    seen.add(url);
                    
                    const urlNoQuery = url.split('?')[0];
                    const urlParts = urlNoQuery.split('/');
                    let filename = urlParts.pop() || '';
                    if (filename.includes('?')) filename = filename.split('?')[0];

                    const isGeneric = !filename || filename.toUpperCase() === 'CONTENT' || filename.toLowerCase().startsWith('image') || filename.toLowerCase().startsWith('video');
                    const hasExtension = filename.match(/\.(jpg|jpeg|png|webp|mp4|gif|svg)$/i);

                    if (isGeneric || !hasExtension) {
                        const idBase = obj.id || (url.includes('/generated/') ? url.split('/generated/')[1].split('/')[0] : Math.random().toString(36).substring(2, 10));
                        const ext = isVideo ? '.mp4' : '.jpg';
                        filename = `${idBase}${ext}`;
                    }

                    let detailsStr = '';
                    if (isVideo) {
                        const dur = obj.videoDuration ? `${obj.videoDuration}s` : '';
                        const res = obj.resolutionName || (obj.resolution ? `${obj.resolution.width}x${obj.resolution.height}` : '');
                        detailsStr = [res, dur].filter(Boolean).join(' • ');
                    } else if (isImage && obj.resolution) {
                        const w = obj.resolution.width;
                        const h = obj.resolution.height;
                        detailsStr = `${w}x${h}`;
                        if (!obj.aspectRatio && w && h) {
                            const ratio = w / h;
                            if (Math.abs(ratio - 1) < 0.05) obj.aspectRatio = "1:1";
                            else if (Math.abs(ratio - 1.77) < 0.1) obj.aspectRatio = "16:9";
                            else if (Math.abs(ratio - 0.56) < 0.1) obj.aspectRatio = "9:16";
                            else if (Math.abs(ratio - 1.33) < 0.1) obj.aspectRatio = "4:3";
                            else if (Math.abs(ratio - 0.75) < 0.1) obj.aspectRatio = "3:4";
                            else if (Math.abs(ratio - 1.5) < 0.1) obj.aspectRatio = "3:2";
                            else if (Math.abs(ratio - 0.66) < 0.1) obj.aspectRatio = "2:3";
                            else obj.aspectRatio = `${Math.round(ratio * 10) / 10}:1`;
                        }
                    }

                    const counts = postCounts.get(currentTopPostId) || { images: 0, videoResolutions: {} };

                    const goodImageUrl = candidateUrls.find(u => !u.includes('preview.jpg') && (u.match(/\.(jpg|jpeg|png|webp)/i) || u.includes('image'))) || candidateUrls.find(u => !u.includes('preview.jpg')) || url;
                    
                    results.push({
                        id: obj.id || Math.random().toString(36).substring(2, 10),
                        parentId: parentId || obj.id || 'root',
                        url,
                        imageUrl: isImage ? goodImageUrl : (obj.imageUrl || ''),
                        videoUrl: obj.videoUrl || (isVideo ? url : ''),
                        thumbnailUrl: obj.thumbnailImageUrl || obj.thumbnailImage || (isImage ? goodImageUrl : ''),
                        type,
                        prompt,
                        filename,
                        details: detailsStr,
                        createTime: obj.createTime || new Date().toISOString(),
                        isExtended: !!obj.videoExtensionStartTime,
                        originalPostId: obj.originalPostId || '',
                        extensionStartTime: obj.videoExtensionStartTime || '',
                        aspectRatio: obj.aspectRatio || '',
                        postImageCount: counts.images,
                        postVideoCount: counts.videoResolutions,
                        associatedIds: Array.from(new Set([
                            obj.id, 
                            obj.originalPostId, 
                            obj.parentPostId, 
                            currentTopPostId, 
                            parentId,
                            ...currentContextIds
                        ].filter(Boolean)))
                    });
                }
            }

            const imageKeys = ['images', 'imageResults'];
            const videoKeys = ['videos'];
            const genericKeys = ['posts', 'childPosts', 'media', 'result', 'data', 'content', 'items', 'attachments', 'components'];

            imageKeys.forEach(key => obj[key] && walk(obj[key], prompt, parentId, currentTopPostId, 'image', currentContextIds));
            videoKeys.forEach(key => obj[key] && walk(obj[key], prompt, parentId, currentTopPostId, 'video', currentContextIds));
            genericKeys.forEach(key => {
                if (!obj[key]) return;
                const nextParentId = obj.id || parentId;
                walk(obj[key], prompt, nextParentId, currentTopPostId, typeHint, currentContextIds);
            });
        }

        walk(rootData, '', null, null, null, []);

        if (suppressedIds.size > 0) {
            results.forEach(item => {
                if (suppressedIds.has(item.id)) item.isSuperseded = true;
            });
        }

        return results;
    }

})();
