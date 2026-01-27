document.addEventListener('DOMContentLoaded', () => {
    // Session Management
    const urlParams = new URLSearchParams(window.location.search);
    let sessionId = urlParams.get('sessionId') || localStorage.getItem('mp3toyt_sessionId');
    if (!sessionId) {
        sessionId = 'sess_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }
    localStorage.setItem('mp3toyt_sessionId', sessionId);

    // Check for success redirects (v188)
    const success = urlParams.get('success');
    if (success) {
        // Use a slight delay to ensure the UI is ready
        setTimeout(() => {
            if (success === 'youtube' || success === 'youtube-callback') showNotification('YouTube account connected successfully!');
            if (success === 'facebook' || success === 'facebook-callback') showNotification('Facebook account connected successfully!');
            if (success === 'credentials_updated') showNotification('YouTube API Credentials updated! You can now connect your account.');
            // Clean up the URL
            window.history.replaceState({}, document.title, window.location.pathname);
        }, 500);
    }

    // DOM Elements
    const audioUrlInput = document.getElementById('audio-url');
    const imageUrlInput = document.getElementById('image-url');
    const pasteAudioBtn = document.getElementById('paste-audio-button');
    const pasteImageBtn = document.getElementById('paste-image-button');
    const audioStatus = document.getElementById('audio-status');
    const imageStatus = document.getElementById('image-status');
    const channelSelector = document.getElementById('channelSelector');
    const createVideoBtn = document.getElementById('create-video-btn');

    // Instant UI check for admin buttons (prevents flicker)
    const wasAdmin = localStorage.getItem('mp3toyt_isAdmin') === 'true';
    if (wasAdmin) {
        const automationBtn = document.getElementById('automation-btn');
        const managementBtn = document.getElementById('management-btn');
        if (automationBtn) automationBtn.style.display = 'flex';
        if (managementBtn) managementBtn.style.display = 'flex';
    }

    const jobProgress = document.getElementById('job-progress');
    const progressBar = document.querySelector('.progress-bar');
    const progressStatus = document.getElementById('progress-status');
    const fileUpload = document.getElementById('file-upload');
    const uploadButton = document.getElementById('upload-button');


    const state = { audioReady: false, imageReady: false, audioCount: 0 };

    // Initialize Default Schedule Data (v178)
    const now = new Date();
    const dateInput = document.getElementById('schedule-date');
    const timeInput = document.getElementById('schedule-time');
    if (dateInput) dateInput.value = now.toISOString().split('T')[0];
    if (timeInput) timeInput.value = now.toTimeString().split(' ')[0].substring(0, 5);

    function updateCreateButton() {
        const missing = [];
        if (!state.audioReady) missing.push('Audio');
        if (!state.imageReady) missing.push('Image');
        const statusEl = document.getElementById('final-status');

        // If we have missing items, we must ALWAYS update status to "Waiting..."
        // This overrides "Upload Failed" AND "Watch on YouTube" (if user deleted a file to start over)
        if (missing.length > 0) {
            statusEl.textContent = `Waiting for you to upload: ${missing.join(' and ')}.`;
            statusEl.className = "final-status"; // Resets any 'error' or 'success' classes
            statusEl.style.backgroundColor = "";
            statusEl.style.color = "";
        }
        // If ready, show "Ready to Create Video!" ONLY if we aren't already showing the Success message
        else if (!statusEl.innerHTML.includes('Watch on YouTube')) {
            statusEl.textContent = "Ready to Create Video!";
            statusEl.className = "final-status status-box success";
            statusEl.style.backgroundColor = "";
            statusEl.style.color = "";
        }

        createVideoBtn.disabled = !(state.audioReady && state.imageReady && channelSelector.value);
    }

    function setStatus(element, type, message, onRemove = null) {
        element.className = `status-box ${type}`;
        element.style.backgroundColor = "";
        element.style.color = "";

        let iconClass = 'info-circle';
        if (type === 'success') iconClass = 'check-circle';
        else if (type === 'error') iconClass = 'times-circle';
        else if (type === 'loading') iconClass = 'spinner fa-spin';
        let content = `<i class="fas fa-${iconClass}"></i> <span class="status-text">${message}</span>`;
        if (type === 'success' && onRemove) content += `<i class="fas fa-times remove-icon" title="Remove"></i>`;
        element.innerHTML = content;
        if (type === 'success' && onRemove) {
            const icon = element.querySelector('.remove-icon');
            if (icon) icon.addEventListener('click', (e) => { e.stopPropagation(); onRemove(); });
        }
    }

    function updateAudioStatus(count, duration, isRestored = false) {
        // Clear error state on new action
        jobProgress.style.display = 'none';
        progressStatus.textContent = '';
        if (progressBar) { progressBar.style.backgroundColor = ''; progressBar.style.width = '0%'; }

        state.audioCount = count;
        state.audioReady = count > 0;
        const prefix = isRestored ? 'Audio restored' : 'Audio Added';
        const message = `${prefix} (${count})${duration ? ' - duration: ' + duration : ''}`;
        setStatus(audioStatus, 'success', message, () => resetAudio());
        updateCreateButton(); // Force main status to re-evaluate
    }

    function updateImagePreview(url) {
        const container = document.getElementById('image-preview-container');
        if (!container) return;
        container.innerHTML = `
            <div class="image-preview-wrapper">
                <img src="${url}" style="max-height: 200px;">
                <div class="image-preview-overlay">
                    <i class="fas fa-edit"></i>
                    <span>Click to edit</span>
                </div>
            </div>
        `;
    }

    async function loadChannels() {
        try {
            const res = await fetch('/channels');
            const channels = await res.json();
            const channelSelector = document.getElementById('channelSelector');
            const channelList = document.getElementById('channel-list');
            if (channelSelector && channelList) {
                channelSelector.innerHTML = '';
                channelList.innerHTML = '';

                function selectChannel(id, platform) {
                    document.querySelectorAll('.channel-item').forEach(i => i.classList.remove('selected'));
                    const item = document.querySelector(`.channel-item[data-id="${id}"]`);
                    if (item) item.classList.add('selected');
                    channelSelector.value = id;
                    channelSelector.dataset.platform = platform;
                    localStorage.setItem('selectedChannelId', id);
                    localStorage.setItem('selectedChannelPlatform', platform);

                    // Toggle platform-specific fields
                    const tagsField = document.getElementById('tags')?.closest('.form-group');
                    const visibilityField = document.querySelector('.visibility-options')?.closest('.form-group');

                    if (platform === 'facebook') {
                        if (tagsField) tagsField.style.display = 'none';
                        if (visibilityField) {
                            visibilityField.style.display = 'block';
                            // Facebook Pages via Bundle don't support Private/Unlisted, only Public or Schedule
                            visibilityField.querySelectorAll('button[data-visibility="private"], button[data-visibility="unlisted"]')
                                .forEach(btn => btn.style.display = 'none');
                        }
                    } else {
                        if (tagsField) tagsField.style.display = 'block';
                        if (visibilityField) {
                            visibilityField.style.display = 'block';
                            visibilityField.querySelectorAll('button').forEach(btn => btn.style.display = 'inline-block');
                        }
                    }

                    updateCreateButton();
                }

                channels.forEach(channel => {
                    const isDisconnected = channel.isConnected === false; // Defaults to true if undefined

                    // 1. Selector Option (Disabled if disconnected)
                    const option = document.createElement('option');
                    option.value = channel.channelId;
                    option.textContent = `${isDisconnected ? '[DISCONNECTED] ' : ''}${channel.platform === 'facebook' ? '[FB] ' : ''}${channel.channelTitle}`;
                    if (isDisconnected) option.disabled = true;
                    channelSelector.appendChild(option);

                    // 2. Dropdown List Item
                    const item = document.createElement('div');
                    item.className = 'channel-item';
                    item.dataset.id = channel.channelId;
                    item.dataset.platform = channel.platform || 'youtube';

                    if (isDisconnected) {
                        item.classList.add('disconnected');
                        // User requested "same as" connected - removing visual dimming/grayscale
                        // item.style.opacity = '0.7'; 
                    }

                    const platformIcon = channel.platform === 'facebook'
                        ? '<i class="fab fa-facebook" style="position: absolute; bottom: 0; right: 0; color: #1877f2; background: white; border-radius: 50%; font-size: 14px;"></i>'
                        : '<i class="fab fa-youtube" style="position: absolute; bottom: 0; right: 0; color: #ff0000; background: white; border-radius: 50%; font-size: 14px;"></i>';

                    // Removing OFFLINE badge as per user request
                    const discBadge = '';

                    item.innerHTML = `
                        <div class="avatar-wrapper">
                            <div class="delete-btn">×</div>
                            <div class="check-icon"><i class="fas fa-check"></i></div>
                            <img src="${channel.thumbnail}" class="channel-avatar">
                            ${platformIcon}
                        </div>

                        <div class="channel-title">
                            ${channel.channelTitle}
                            ${discBadge}
                        </div>
                    `;

                    item.addEventListener('click', (e) => {
                        // Allow clicking delete button even if disconnected
                        if (e.target.classList.contains('delete-btn')) return;

                        if (isDisconnected) {
                            showNotification('This channel is disconnected. Please re-add it.', 'error');
                            return;
                        }
                        selectChannel(channel.channelId, channel.platform || 'youtube');
                    });

                    const deleteBtn = item.querySelector('.delete-btn');
                    if (deleteBtn) {
                        deleteBtn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            showConfirmationToast(`Disconnect <strong>${channel.channelTitle}</strong>?`, () => deleteChannel(channel.channelId, channel.channelTitle));
                        });
                    }
                    channelList.appendChild(item);
                });

                const mBtn = document.getElementById('manage-channels-btn');
                if (mBtn) {
                    mBtn.style.display = channels.length > 0 ? 'flex' : 'none';
                }

                const urlParams = new URLSearchParams(window.location.search);
                const newChannelId = urlParams.get('new_channel_id');
                const savedId = localStorage.getItem('selectedChannelId');
                const savedPlatform = localStorage.getItem('selectedChannelPlatform') || 'youtube';

                if (newChannelId && channels.find(c => c.channelId === newChannelId)) {
                    // Prioritize newly connected channel
                    const newChan = channels.find(c => c.channelId === newChannelId);
                    selectChannel(newChannelId, newChan.platform || 'youtube');
                } else {
                    // Filter for CONNECTED channels only
                    const connectedChannels = channels.filter(c => c.isConnected !== false);

                    if (savedId && connectedChannels.find(c => c.channelId === savedId)) {
                        // Restore saved selection ONLY if it's still connected
                        selectChannel(savedId, savedPlatform);
                    } else if (connectedChannels.length > 0) {
                        // Otherwise pick the first CONNECTED channel
                        selectChannel(connectedChannels[0].channelId, connectedChannels[0].platform || 'youtube');
                    }
                }
            }
        } catch (e) {
            console.error('Error loading channels:', e);
        }
    }

    const manageChannelsBtn = document.getElementById('manage-channels-btn');
    const doneManagingHeader = document.getElementById('done-managing-header');

    if (manageChannelsBtn) {
        manageChannelsBtn.addEventListener('click', (e) => {
            const managementDropdown = document.getElementById('management-dropdown');
            if (managementDropdown) managementDropdown.classList.remove('show');

            const channelList = document.getElementById('channel-list');
            const isManaging = channelList.classList.toggle('manage-mode');

            // Show/Hide header button
            if (doneManagingHeader) {
                doneManagingHeader.style.display = isManaging ? 'inline-block' : 'none';
            }

            manageChannelsBtn.innerHTML = isManaging ?
                '<i class="fas fa-check" style="color: #22c55e;"></i> Done Managing' :
                '<i class="fas fa-list-ul" style="color: #4b5563;"></i> Manage Channels';
            manageChannelsBtn.style.color = isManaging ? '#22c55e' : '';
        });
    }

    if (doneManagingHeader) {
        doneManagingHeader.addEventListener('click', () => {
            const channelList = document.getElementById('channel-list');
            if (channelList) channelList.classList.remove('manage-mode');
            doneManagingHeader.style.display = 'none';

            // Reset management button text if it exists
            if (manageChannelsBtn) {
                manageChannelsBtn.innerHTML = '<i class="fas fa-list-ul" style="color: #4b5563;"></i> Manage Channels';
                manageChannelsBtn.style.color = '';
            }
        });
    }

    function showNotification(message, type = 'success') {
        const toast = document.createElement('div');
        toast.className = `toast-notification ${type}`;
        toast.innerHTML = `<i class="fas fa-${type === 'success' ? 'check-circle' : 'exclamation-circle'}"></i> <span>${message}</span>`;
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('show'));
        setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 3000);
    }
    window.showNotification = showNotification;

    function showConfirmationToast(message, onConfirm) {
        const toast = document.createElement('div'); toast.className = 'toast-notification error show';
        toast.innerHTML = `<span>${message}</span><div class="toast-actions"><button id="toast-cancel">Cancel</button><button id="toast-confirm">Confirm</button></div>`;
        document.body.appendChild(toast);
        document.getElementById('toast-confirm').onclick = () => { onConfirm(); toast.remove(); };
        document.getElementById('toast-cancel').onclick = () => { toast.remove(); };
    }

    async function deleteChannel(channelId, title) {
        const res = await fetch('/delete-channel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelId }) });
        const result = await res.json();
        if (result.success) { showNotification(`Disconnected ${title}`); loadChannels(); }
    }

    async function checkSessionStatus() {
        if (!sessionId) return;
        console.log('[CheckSession] Checking status for session:', sessionId);
        const res = await fetch(`/session-status?sessionId=${sessionId}`);
        const data = await res.json();
        console.log('[CheckSession] Received data:', data);
        if (data.success) {
            if (data.audio) {
                console.log('[CheckSession] Audio found, count:', data.audioCount);
                updateAudioStatus(data.audioCount || 1, data.totalDuration, true);
            }
            if (data.image) {
                console.log('[CheckSession] Image found:', data.imageUrl);
                state.imageReady = true;
                setStatus(imageStatus, 'success', 'Image restored', () => resetImage());
                updateImagePreview(`${data.imageUrl}?t=${Date.now()}`);
            }
            updateCreateButton();
        }
    }

    async function resetAudio(skipServer = false) {
        if (!skipServer) {
            await fetch('/remove-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, type: 'audio' }) });
        }
        state.audioReady = false; state.audioCount = 0;
        audioStatus.className = 'status-box';
        audioStatus.innerHTML = '<i class="fas fa-times-circle"></i> Audio not uploaded';
        audioStatus.style.backgroundColor = ''; audioStatus.style.color = '';
        updateCreateButton();
    }

    async function resetImage(skipServer = false) {
        if (!skipServer) {
            await fetch('/remove-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, type: 'image' }) });
        }
        state.imageReady = false;
        imageStatus.className = 'status-box';
        imageStatus.innerHTML = '<i class="fas fa-times-circle"></i> Image not uploaded';
        imageStatus.style.backgroundColor = ''; imageStatus.style.color = '';
        document.getElementById('image-preview-container').innerHTML = ''; updateCreateButton();
    }

    function isValidHttpUrl(string) {
        let url;
        try {
            url = new URL(string);
        } catch (_) {
            return false;
        }
        return url.protocol === "http:" || url.protocol === "https:";
    }

    async function handleAudioUrl(url) {
        if (!url) return;
        if (!isValidHttpUrl(url) || !(url.includes('youtube.com') || url.includes('youtu.be'))) {
            setStatus(audioStatus, 'error', 'Invalid YouTube URL');
            return;
        }
        jobProgress.style.display = 'none';
        progressStatus.textContent = '';
        if (progressBar) { progressBar.style.backgroundColor = ''; progressBar.style.width = '0%'; }

        const audioSeq = state.audioCount + 1;
        setStatus(audioStatus, 'loading', `Downloading Audio #${audioSeq}...`);
        const eventSource = new EventSource(`/download-audio?url=${encodeURIComponent(url)}&sessionId=${sessionId}`);
        eventSource.onmessage = (e) => {
            const data = JSON.parse(e.data);
            if (data.success) {
                updateAudioStatus(audioSeq, data.totalDuration);
                eventSource.close();
                updateCreateButton();
            } else if (data.message) {
                let msg = data.message;
                if (msg.includes('Downloading...')) {
                    const percent = msg.match(/(\d+)%/);
                    msg = `Downloading Audio #${audioSeq}${percent ? ' (' + percent[0] + ')' : ''}...`;
                }
                setStatus(audioStatus, 'loading', msg);
            } else if (data.error) {
                setStatus(audioStatus, 'error', data.error);
                eventSource.close();
            }
        };
    }

    async function handleFiles(files) {
        jobProgress.style.display = 'none';
        progressStatus.textContent = '';
        if (progressBar) { progressBar.style.backgroundColor = ''; progressBar.style.width = '0%'; }

        if (files.length === 0) return;

        for (const file of files) {
            const isAudio = file.type.startsWith('audio/');
            const isImage = file.type.startsWith('image/') ||
                file.name.toLowerCase().endsWith('.webp') ||
                file.name.toLowerCase().endsWith('.bmp') ||
                file.name.toLowerCase().endsWith('.gif');
            if (!isAudio && !isImage) {
                console.log('[Upload] Skipping unsupported file type:', file.type, file.name);
                continue;
            }

            const formData = new FormData();
            formData.append('sessionId', sessionId);
            formData.append('file', file);
            formData.append('fileType', isAudio ? 'audio' : 'image');

            if (isAudio) setStatus(audioStatus, 'loading', 'Uploading Audio...');
            else setStatus(imageStatus, 'loading', 'Uploading Image...');

            try {
                const res = await fetch('/upload-file', { method: 'POST', body: formData });
                if (!res.ok) {
                    const errorData = await res.json().catch(() => ({}));
                    throw new Error(errorData.message || `Server responded with ${res.status}`);
                }

                const result = await res.json();
                if (result.success) {
                    if (isAudio) {
                        updateAudioStatus(state.audioCount + 1, result.totalDuration);
                    } else {
                        state.imageReady = true;
                        setStatus(imageStatus, 'success', 'Image Uploaded', () => resetImage());
                        updateImagePreview(`${result.filePath}?t=${Date.now()}`);
                    }
                    updateCreateButton();
                } else {
                    throw new Error(result.message || 'Upload failed');
                }
            } catch (error) {
                console.error('Upload error:', error);
                if (isAudio) setStatus(audioStatus, 'error', `Upload failed: ${error.message}`);
                else setStatus(imageStatus, 'error', `Upload failed: ${error.message}`);
                showNotification(error.message, 'error');
            }
        }
    }

    fileUpload.addEventListener('change', (e) => handleFiles(e.target.files));
    uploadButton.addEventListener('click', () => fileUpload.click());

    async function handleImageUrl(url) {
        if (!url) return;
        if (!isValidHttpUrl(url)) {
            setStatus(imageStatus, 'error', 'Invalid Image URL');
            return;
        }
        jobProgress.style.display = 'none';
        progressStatus.textContent = '';
        if (progressBar) { progressBar.style.backgroundColor = ''; progressBar.style.width = '0%'; }

        setStatus(imageStatus, 'loading', 'Downloading...');
        const res = await fetch('/download-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, sessionId }) });
        const result = await res.json();
        if (result.success) { state.imageReady = true; setStatus(imageStatus, 'success', 'Image Downloaded', () => resetImage()); updateImagePreview(`${result.filePath}?t=${Date.now()}`); updateCreateButton(); }
    }

    imageUrlInput.addEventListener('change', (e) => handleImageUrl(e.target.value));
    audioUrlInput.addEventListener('change', (e) => handleAudioUrl(e.target.value));

    if (pasteAudioBtn) {
        pasteAudioBtn.addEventListener('click', async () => {
            try {
                const text = await navigator.clipboard.readText();
                if (text) { audioUrlInput.value = text; handleAudioUrl(text); }
            } catch (err) {
                console.error('Failed to read clipboard:', err);
                showNotification('Clipboard access denied or empty', 'error');
            }
        });
    }

    if (pasteImageBtn) {
        pasteImageBtn.addEventListener('click', async () => {
            try {
                const text = await navigator.clipboard.readText();
                if (text) { imageUrlInput.value = text; handleImageUrl(text); }
            } catch (err) {
                console.error('Failed to read clipboard:', err);
                showNotification('Clipboard access denied or empty', 'error');
            }
        });
    }

    // Automation Modal Paste Buttons
    const pasteAutoAudioBtn = document.getElementById('paste-auto-audio-btn');
    const pasteAutoImageBtn = document.getElementById('paste-auto-image-btn');
    const autoAudioLinksInput = document.getElementById('auto-audio-links');
    const autoImageLinkInput = document.getElementById('auto-image-link');

    if (pasteAutoAudioBtn) {
        pasteAutoAudioBtn.addEventListener('click', async () => {
            try {
                const text = await navigator.clipboard.readText();
                if (text && autoAudioLinksInput) {
                    // Split clipboard text and existing text into normalized arrays
                    const existingLinks = autoAudioLinksInput.value.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                    const newLinks = text.split(/[\n,]+/).map(l => l.trim()).filter(l => l.length > 0);

                    // Filter out duplicates
                    const uniqueNewLinks = newLinks.filter(l => !existingLinks.includes(l));

                    if (uniqueNewLinks.length > 0) {
                        const separator = autoAudioLinksInput.value.trim().length > 0 ? '\n' : '';
                        autoAudioLinksInput.value = autoAudioLinksInput.value.trim() + separator + uniqueNewLinks.join('\n');
                        showNotification(`Added ${uniqueNewLinks.length} new links.`);
                    } else if (newLinks.length > 0) {
                        showNotification('Specified links are already in the list.', 'info');
                    }
                }
            } catch (err) {
                console.error('Failed to read clipboard:', err);
                showNotification('Clipboard access denied or empty', 'error');
            }
        });
    }

    if (pasteAutoImageBtn) {
        pasteAutoImageBtn.addEventListener('click', async () => {
            try {
                const text = await navigator.clipboard.readText();
                if (text && autoImageLinkInput) {
                    autoImageLinkInput.value = text;
                }
            } catch (err) {
                console.error('Failed to read clipboard:', err);
                showNotification('Clipboard access denied or empty', 'error');
            }
        });
    }

    // --- Image Editor ---
    const editorModal = document.getElementById('imageEditorModal');
    const editorImage = document.getElementById('editorImage');
    const saveCropBtn = document.getElementById('save-crop-btn');
    const previewTrigger = document.getElementById('image-preview-container');
    let cropper = null;

    let isStretchedMode = false;
    let dotUpdateFrame = null;

    function updateDots() {
        if (!cropper) return;
        const canvas = cropper.getCanvasData();
        const dots = ['tl', 'tr', 'bl', 'br'].map(id => document.getElementById('dot-' + id));
        if (!dots[0]) return;
        dots.forEach(d => d.style.display = 'block');
        const l = Math.round(canvas.left), t = Math.round(canvas.top), w = Math.round(canvas.width), h = Math.round(canvas.height);
        dots[0].style.left = l + 'px'; dots[0].style.top = t + 'px';
        dots[1].style.left = (l + w) + 'px'; dots[1].style.top = t + 'px';
        dots[2].style.left = l + 'px'; dots[2].style.top = (t + h) + 'px';
        dots[3].style.left = (l + w) + 'px'; dots[3].style.top = (t + h) + 'px';
        dotUpdateFrame = null;
    }

    function setStretch(val) {
        if (isStretchedMode === val) return;
        isStretchedMode = val;
        const wrapper = document.getElementById('editor-wrapper');
        if (wrapper) wrapper.classList.toggle('is-stretching', val);
        const canvasImg = editorImage.parentElement.querySelector('.cropper-canvas img');
        const viewBoxImg = editorImage.parentElement.querySelector('.cropper-view-box img');
        if (val) {
            if (canvasImg) { canvasImg.style.objectFit = 'fill'; canvasImg.style.width = '100%'; canvasImg.style.height = '100%'; }
            if (viewBoxImg) { viewBoxImg.style.objectFit = 'fill'; viewBoxImg.style.width = '100%'; viewBoxImg.style.height = '100%'; }
        } else {
            if (canvasImg) { canvasImg.style.objectFit = ''; canvasImg.style.width = ''; canvasImg.style.height = ''; }
            if (viewBoxImg) { viewBoxImg.style.objectFit = ''; viewBoxImg.style.width = ''; viewBoxImg.style.height = ''; }
        }
    }

    if (previewTrigger) {
        previewTrigger.addEventListener('click', () => {
            const img = previewTrigger.querySelector('img');
            if (img && editorModal && editorImage) {
                editorImage.src = img.src;
                editorModal.style.display = 'flex';
                setStretch(false);
                if (cropper) cropper.destroy();
                cropper = new Cropper(editorImage, {
                    aspectRatio: 16 / 9, viewMode: 0, dragMode: 'move', autoCropArea: 1, highlight: false, background: false,
                    responsive: true, restore: false, guides: false, center: false,
                    ready() {
                        const container = cropper.getContainerData();
                        cropper.setCropBoxData({ left: 0, top: 0, width: container.width, height: container.height });
                        updateDots();
                    },
                    crop() { if (!dotUpdateFrame) dotUpdateFrame = requestAnimationFrame(updateDots); }
                });
                editorImage.addEventListener('zoom', () => setStretch(false));
                editorImage.addEventListener('cropstart', () => setStretch(false));

                let isDraggingDot = false, startDist, startScale;
                document.querySelectorAll('.sticky-dot').forEach(dot => {
                    dot.addEventListener('mousedown', e => {
                        isDraggingDot = true; setStretch(false);
                        const canvas = cropper.getCanvasData(), rect = editorImage.parentElement.getBoundingClientRect();
                        const centerX = canvas.left + canvas.width / 2, centerY = canvas.top + canvas.height / 2;
                        const mouseX = e.clientX - rect.left, mouseY = e.clientY - rect.top;
                        startDist = Math.sqrt(Math.pow(mouseX - centerX, 2) + Math.pow(mouseY - centerY, 2));
                        startScale = canvas.width / cropper.getImageData().naturalWidth;
                        e.stopPropagation(); e.preventDefault();
                    });
                });
                window.addEventListener('mousemove', e => {
                    if (!isDraggingDot || !cropper) return;
                    const canvas = cropper.getCanvasData(), rect = editorImage.parentElement.getBoundingClientRect();
                    const centerX = canvas.left + canvas.width / 2, centerY = canvas.top + canvas.height / 2;
                    const mouseX = e.clientX - rect.left, mouseY = e.clientY - rect.top;
                    const currentDist = Math.sqrt(Math.pow(mouseX - centerX, 2) + Math.pow(mouseY - centerY, 2));
                    cropper.zoomTo(startScale * (currentDist / (startDist || 1)));
                });
                window.addEventListener('mouseup', () => isDraggingDot = false);
            }
        });
    }

    // --- Overlay Management ---
    let overlayImg = null;
    let overlayEl = null;
    let overlayType = 'image'; // 'image' or 'video' (v188)
    let overlayPath = null; // Store for backend (v188)

    function setupOverlayInteractions(el) {
        let isDragging = false;
        let isResizing = false;
        let startX, startY, startWidth, startHeight, startLeft, startTop;

        el.addEventListener('mousedown', (e) => {
            document.querySelectorAll('.overlay-item').forEach(o => o.style.border = '1px dashed #fff');
            el.style.border = '2px solid #1677ff';
            el.dataset.selected = 'true';
            if (e.target.classList.contains('overlay-handle')) isResizing = true;
            else isDragging = true;
            const rect = el.getBoundingClientRect();
            startX = e.clientX; startY = e.clientY;
            startWidth = rect.width; startHeight = rect.height;
            startLeft = el.offsetLeft; startTop = el.offsetTop;
            e.preventDefault(); e.stopPropagation();
        });

        window.addEventListener('mousemove', (e) => {
            if (isDragging) {
                el.style.left = (startLeft + e.clientX - startX) + 'px';
                el.style.top = (startTop + e.clientY - startY) + 'px';
            } else if (isResizing) {
                const newWidth = Math.max(20, startWidth + e.clientX - startX);
                let ratio = 1;
                if (overlayType === 'video' && el.querySelector('video')) {
                    const v = el.querySelector('video');
                    ratio = v.videoHeight / v.videoWidth;
                } else if (overlayImg) {
                    ratio = overlayImg.height / overlayImg.width;
                }
                el.style.width = newWidth + 'px';
                el.style.height = (newWidth * ratio) + 'px';
            }
        });

        window.addEventListener('mouseup', () => { isDragging = false; isResizing = false; });
    }

    window.addEventListener('keydown', (e) => {
        if ((e.key === 'Delete' || e.key === 'Backspace') && overlayEl && overlayEl.dataset.selected === 'true') {
            overlayEl.remove(); overlayEl = null; overlayImg = null; overlayPath = null;
            window.currentOverlay = null; showNotification('Overlay removed');
        }
    });

    document.getElementById('image-viewport')?.addEventListener('mousedown', (e) => {
        if (e.target.id === 'image-viewport' || e.target.id === 'editorImage') {
            if (overlayEl) { overlayEl.style.border = '1px dashed #fff'; overlayEl.dataset.selected = 'false'; }
        }
    });

    const addOverlayBtn = document.getElementById('add-overlay-btn');
    const overlayFileInput = document.getElementById('overlay-file-input');

    if (addOverlayBtn && overlayFileInput) {
        addOverlayBtn.addEventListener('click', () => overlayFileInput.click());
        overlayFileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                const isVideo = file.type.startsWith('video/');
                overlayType = isVideo ? 'video' : 'image';
                const reader = new FileReader();
                reader.onload = async (event) => {
                    if (overlayEl) overlayEl.remove();
                    const viewport = document.getElementById('image-viewport');
                    overlayEl = document.createElement('div');
                    overlayEl.className = 'overlay-item';
                    overlayEl.dataset.type = overlayType;

                    if (isVideo) {
                        const video = document.createElement('video');
                        video.src = event.target.result;
                        video.autoplay = true; video.loop = true; video.muted = true;
                        video.style.width = '100%'; video.style.height = '100%'; video.style.objectFit = 'contain';
                        overlayEl.appendChild(video);
                        video.onloadedmetadata = () => {
                            Object.assign(overlayEl.style, {
                                position: 'absolute', width: '200px', height: (200 * video.videoHeight / video.videoWidth) + 'px',
                                top: '20px', left: '20px', border: '1px dashed #fff', cursor: 'move', zIndex: '1500',
                            });
                        };
                    } else {
                        overlayImg = new Image();
                        overlayImg.src = event.target.result;
                        overlayImg.onload = () => {
                            Object.assign(overlayEl.style, {
                                position: 'absolute', width: '150px', height: (150 * overlayImg.height / overlayImg.width) + 'px',
                                top: '20px', left: '20px', border: '1px dashed #fff', cursor: 'move', zIndex: '1500',
                                background: `url(${overlayImg.src}) center/contain no-repeat`, boxShadow: '0 0 5px rgba(0,0,0,0.5)'
                            });
                        };
                    }

                    const handle = document.createElement('div');
                    handle.className = 'overlay-handle';
                    Object.assign(handle.style, {
                        width: '14px', height: '14px', background: '#1677ff', position: 'absolute',
                        bottom: '-7px', right: '-7px', cursor: 'nwse-resize', borderRadius: '2px', border: '1px solid white'
                    });
                    overlayEl.appendChild(handle);
                    viewport.appendChild(overlayEl);
                    setupOverlayInteractions(overlayEl);

                    const formData = new FormData();
                    formData.append('sessionId', sessionId); formData.append('file', file); formData.append('fileType', 'overlay');
                    const uploadRes = await fetch('/upload-file', { method: 'POST', body: formData });
                    const result = await uploadRes.json();
                    if (result.success) { overlayPath = result.filePath; }
                };
                reader.readAsDataURL(file);
            }
        });
    }

    if (saveCropBtn) {
        saveCropBtn.addEventListener('click', () => {
            if (!cropper) return;
            saveCropBtn.textContent = 'Saving...';
            const handleBlob = async (blob) => {
                try {
                    const formData = new FormData();
                    formData.append('sessionId', sessionId); formData.append('file', blob, 'image.jpg'); formData.append('fileType', 'image');
                    const res = await fetch('/upload-file', { method: 'POST', body: formData });
                    const result = await res.json();
                    if (result.success) {
                        showNotification('Saved!');
                        updateImagePreview(`${result.filePath}?t=${Date.now()}`);
                        closeEditor();
                    } else showNotification(result.message || 'Error saving image', 'error');
                } catch (err) { console.error('Save failed:', err); showNotification('Save failed', 'error'); }
                finally { saveCropBtn.textContent = 'Save & Apply'; }
            };

            const finalCanvas = document.createElement('canvas');
            finalCanvas.width = 1280; finalCanvas.height = 720;
            const ctx = finalCanvas.getContext('2d');
            let baseCanvas;
            if (isStretchedMode) {
                baseCanvas = document.createElement('canvas'); baseCanvas.width = 1280; baseCanvas.height = 720;
                baseCanvas.getContext('2d').drawImage(editorImage, 0, 0, 1280, 720);
            } else baseCanvas = cropper.getCroppedCanvas({ width: 1280, height: 720, fillColor: '#000' });

            ctx.drawImage(baseCanvas, 0, 0);
            if (overlayEl && overlayImg && overlayType === 'image') {
                const viewport = document.getElementById('image-viewport'), vRect = viewport.getBoundingClientRect(), oRect = overlayEl.getBoundingClientRect();
                const scaleX = 1280 / vRect.width, scaleY = 720 / vRect.height;
                ctx.drawImage(overlayImg, (oRect.left - vRect.left) * scaleX, (oRect.top - vRect.top) * scaleY, oRect.width * scaleX, oRect.height * scaleY);
            }

            const viewport = document.getElementById('image-viewport');
            window.currentOverlay = (overlayEl && overlayPath) ? {
                type: overlayType, path: overlayPath,
                x: (overlayEl.offsetLeft) / viewport.offsetWidth, y: (overlayEl.offsetTop) / viewport.offsetHeight,
                w: overlayEl.offsetWidth / viewport.offsetWidth, h: overlayEl.offsetHeight / viewport.offsetHeight
            } : null;

            finalCanvas.toBlob(handleBlob, 'image/jpeg', 0.95);
        });
    }

    document.querySelectorAll('.tool-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!cropper) return;
            const action = btn.dataset.action;
            if (['zoom-in', 'zoom-out', 'rotate-left', 'rotate-right', 'flip-h', 'flip-v', 'reset'].includes(action)) setStretch(false);
            if (action === 'zoom-in') cropper.zoom(0.1);
            else if (action === 'zoom-out') cropper.zoom(-0.1);
            else if (action === 'fit') {
                setStretch(false);
                const c = cropper.getContainerData(), i = cropper.getImageData(), s = Math.min(c.width / i.naturalWidth, c.height / i.naturalHeight);
                cropper.zoomTo(s); cropper.setCanvasData({ left: (c.width - i.naturalWidth * s) / 2, top: (c.height - i.naturalHeight * s) / 2 });
            } else if (action === 'stretch') {
                setStretch(true); const c = cropper.getContainerData();
                cropper.setCanvasData({ left: 0, top: 0, width: c.width, height: c.height });
                cropper.setCropBoxData({ left: 0, top: 0, width: c.width, height: c.height });
                setTimeout(() => {
                    const canvasImg = editorImage.parentElement.querySelector('.cropper-canvas img');
                    if (canvasImg) { canvasImg.style.width = '100%'; canvasImg.style.height = '100%'; canvasImg.style.objectFit = 'fill'; }
                    updateDots();
                }, 10);
            } else if (action === 'rotate-left') cropper.rotate(-90);
            else if (action === 'rotate-right') cropper.rotate(90);
            else if (action === 'flip-h') cropper.scaleX(cropper.getData().scaleX === -1 ? 1 : -1);
            else if (action === 'flip-v') cropper.scaleY(cropper.getData().scaleY === -1 ? 1 : -1);
            else if (action === 'reset') cropper.reset();
        });
    });

    function closeEditor() { editorModal.style.display = 'none'; if (cropper) { cropper.destroy(); cropper = null; } }
    document.querySelector('.close-modal').onclick = closeEditor;
    document.getElementById('cancel-edit-btn').onclick = closeEditor;

    document.getElementById('upload-form').onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const visibility = document.querySelector('.visibility-options button.active').dataset.visibility;

        // Prepare data object
        const data = {
            sessionId,
            title: fd.get('title'),
            description: fd.get('description'),
            tags: fd.get('tags'),
            channelId: channelSelector.value,
            platform: channelSelector.dataset.platform || 'youtube',
            visibility: visibility,
            overlay: window.currentOverlay
        };

        // Handle Scheduling
        if (visibility === 'schedule') {
            const date = fd.get('scheduleDate');
            const time = fd.get('scheduleTime');
            if (!date || !time) {
                showNotification('Please provide both date and time for scheduling.', 'error');
                return;
            }
            const publishAt = new Date(`${date}T${time}:00`).toISOString();
            data.publishAt = publishAt;
            // YouTube requires scheduled videos to be private/public, but we send 'private' to the API
            // and the API handles the transition. The backend will map this correctly.
        }

        jobProgress.style.display = 'block';
        progressStatus.textContent = 'Queueing...';

        try {
            const res = await fetch('/create-video', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            const result = await res.json();
            if (result.success) {
                pollJobStatus(sessionId);
            } else {
                showNotification(result.error || 'Failed to start video creation', 'error');
                jobProgress.style.display = 'none';
            }
        } catch (err) {
            console.error('Create video fetch error:', err);
            showNotification('Server communication error', 'error');
            jobProgress.style.display = 'none';
        }
    };

    function pollJobStatus(sid) {
        const interval = setInterval(async () => {
            const res = await fetch(`/job-status/${sid}`);
            const status = await res.json();
            progressStatus.textContent = status.message;
            const match = status.message.match(/(\d+)%/);
            if (status.status === 'processing') progressBar.style.width = '20%';
            else if (status.status === 'uploading') {
                if (match && progressBar) progressBar.style.width = (40 + (parseInt(match[1]) * 0.6)) + '%';
                else if (progressBar) progressBar.style.width = '40%';
            }
            if (status.status === 'complete') {
                if (progressBar) progressBar.style.width = '100%';
                setTimeout(() => jobProgress.style.display = 'none', 1000);
                clearInterval(interval);

                let successHtml = `<strong>Complete!</strong> `;
                if (status.platform === 'facebook') {
                    // Check if it's a real schedule (more than 1 minute in the future)
                    const isRealSchedule = status.publishAt && (new Date(status.publishAt).getTime() > Date.now() + 60000);
                    if (isRealSchedule) {
                        const date = new Date(status.publishAt);
                        const formatted = date.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
                        successHtml += `Scheduled for: ${formatted}`;
                    } else {
                        successHtml += `Processing on Facebook...`;
                    }
                } else {
                    if (status.videoUrl && status.videoUrl.includes('bundle.social')) {
                        successHtml += `Processing on YouTube...`;
                    } else {
                        successHtml += `<a href="${status.videoUrl}" target="_blank">Watch on YouTube</a> `;
                    }
                }
                successHtml += `<br><small>Created in ${status.creationTime}s • Uploaded in ${status.uploadTime}s</small>`;

                setStatus(document.getElementById('final-status'), 'success', successHtml);
                showNotification('Video created and uploaded!');
            } else if (status.status === 'failed') {
                clearInterval(interval);
                if (progressBar) progressBar.style.backgroundColor = '#ef4444';
                setStatus(document.getElementById('final-status'), 'error', `<strong>Upload Failed</strong>`);
                showNotification('Upload Failed', 'error');
                resetAudio(true); resetImage(true);
                document.getElementById('create-video-btn').disabled = true;
            }
        }, 1000);
    }

    document.querySelectorAll('.visibility-options button').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.visibility-options button').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById('schedule-container').style.display = btn.dataset.visibility === 'schedule' ? 'block' : 'none';
        });
    });

    // --- YouTube Cookies Management ---
    const cookiesModal = document.getElementById('cookiesModal');
    const manageCookiesBtn = document.getElementById('manage-cookies-btn');
    const closeCookiesBtn = document.getElementById('close-cookies-modal');
    const cancelCookiesBtn = document.getElementById('cancel-cookies-btn');
    const saveCookiesBtn = document.getElementById('save-cookies-btn');
    const cookiesEditor = document.getElementById('cookies-editor');

    if (manageCookiesBtn) {
        manageCookiesBtn.addEventListener('click', async () => {
            try {
                const res = await fetch('/get-cookies', { method: 'POST' });
                const data = await res.json();
                if (data.success) {
                    cookiesEditor.value = data.cookies || '';
                    cookiesModal.style.display = 'flex';
                } else {
                    showNotification('Failed to load cookies', 'error');
                }
            } catch (err) {
                console.error('Error fetching cookies:', err);
                showNotification('Error loading cookies', 'error');
            }
        });
    }

    const closeCookies = () => { cookiesModal.style.display = 'none'; };
    if (closeCookiesBtn) closeCookiesBtn.addEventListener('click', closeCookies);
    if (cancelCookiesBtn) cancelCookiesBtn.addEventListener('click', closeCookies);

    if (saveCookiesBtn) {
        saveCookiesBtn.addEventListener('click', async () => {
            saveCookiesBtn.disabled = true;
            saveCookiesBtn.textContent = 'Saving...';
            try {
                const res = await fetch('/save-cookies', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cookies: cookiesEditor.value })
                });
                const data = await res.json();
                if (data.success) {
                    showNotification('Cookies saved successfully!');
                    closeCookies();
                } else {
                    showNotification('Failed to save cookies', 'error');
                }
            } catch (err) {
                console.error('Error saving cookies:', err);
                showNotification('Error saving cookies', 'error');
            } finally {
                saveCookiesBtn.disabled = false;
                saveCookiesBtn.textContent = 'Save Cookies';
            }
        });
    }

    // --- Management Dropdown ---
    const managementBtn = document.getElementById('management-btn');
    const managementDropdown = document.getElementById('management-dropdown');
    const addAccountBtn = document.getElementById('add-account-btn');
    const addAccountDropdown = document.getElementById('add-account-dropdown');

    if (managementBtn && managementDropdown) {
        managementBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            addAccountDropdown?.classList.remove('show');
            managementDropdown.classList.toggle('show');
        });
    }

    if (addAccountBtn && addAccountDropdown) {
        addAccountBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            managementDropdown?.classList.remove('show');
            addAccountDropdown.classList.toggle('show');
        });

        // Force auth links to open in popups (v188)
        addAccountDropdown.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const url = link.getAttribute('href');
                const width = 600, height = 700;
                const left = (window.innerWidth / 2) - (width / 2);
                const top = (window.innerHeight / 2) - (height / 2);
                window.open(url, 'ConnectAccount', `width=${width},height=${height},left=${left},top=${top},scrollbars=yes,status=no,menubar=no,toolbar=no`);
                addAccountDropdown.classList.remove('show');
            });
        });
    }

    window.addEventListener('click', (e) => {
        if (e.target === cookiesModal) closeCookies();
        if (e.target === tokensModal) closeTokens();
        if (e.target === channelsJSONModal) closeChannelsJSON();

        // Close dropdowns when clicking outside
        if (managementDropdown && !managementDropdown.contains(e.target) && e.target !== managementBtn) {
            managementDropdown.classList.remove('show');
        }
        if (addAccountDropdown && !addAccountDropdown.contains(e.target) && e.target !== addAccountBtn) {
            addAccountDropdown.classList.remove('show');
        }
    });

    // --- YouTube Tokens Management ---
    const tokensModal = document.getElementById('tokensModal');
    const manageTokensBtn = document.getElementById('manage-tokens-btn');
    const closeTokensBtn = document.getElementById('close-tokens-modal');
    const cancelTokensBtn = document.getElementById('cancel-tokens-btn');
    const saveTokensBtn = document.getElementById('save-tokens-btn');
    const tokensEditor = document.getElementById('tokens-editor');

    if (manageTokensBtn) {
        manageTokensBtn.addEventListener('click', async () => {
            try {
                const res = await fetch('/get-tokens', { method: 'POST' });
                const data = await res.json();
                if (data.success) {
                    tokensEditor.value = data.tokens || '[]';
                    tokensModal.style.display = 'flex';
                } else {
                    showNotification('Failed to load tokens', 'error');
                }
            } catch (err) {
                console.error('Error fetching tokens:', err);
                showNotification('Error loading tokens', 'error');
            }
        });
    }

    const closeTokens = () => { tokensModal.style.display = 'none'; };
    if (closeTokensBtn) closeTokensBtn.addEventListener('click', closeTokens);
    if (cancelTokensBtn) cancelTokensBtn.addEventListener('click', closeTokens);

    if (saveTokensBtn) {
        saveTokensBtn.addEventListener('click', async () => {
            saveTokensBtn.disabled = true;
            saveTokensBtn.textContent = 'Saving...';
            try {
                const res = await fetch('/save-tokens', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tokens: tokensEditor.value })
                });
                const data = await res.json();
                if (data.success) {
                    showNotification('Tokens saved successfully!');
                    closeTokens();
                } else {
                    showNotification(data.message || 'Failed to save tokens', 'error');
                }
            } catch (err) {
                console.error('Error saving tokens:', err);
                showNotification('Error saving tokens', 'error');
            } finally {
                saveTokensBtn.disabled = false;
                saveTokensBtn.textContent = 'Save Tokens';
            }
        });
    }

    // --- Channels JSON Management ---
    const channelsJSONModal = document.getElementById('channelsJSONModal');
    const manageChannelsJSONBtn = document.getElementById('manage-channels-json-btn');
    const closeChannelsJSONBtn = document.getElementById('close-channels-json-modal');
    const cancelChannelsJSONBtn = document.getElementById('cancel-channels-json-btn');
    const saveChannelsJSONBtn = document.getElementById('save-channels-json-btn');
    const channelsJSONEditor = document.getElementById('channels-json-editor');

    if (manageChannelsJSONBtn) {
        manageChannelsJSONBtn.addEventListener('click', async () => {
            try {
                const res = await fetch('/get-channels-json', { method: 'POST' });
                const data = await res.json();
                if (data.success) {
                    channelsJSONEditor.value = data.channels || '{"channels":[]}';
                    channelsJSONModal.style.display = 'flex';
                } else {
                    showNotification('Failed to load channels data', 'error');
                }
            } catch (err) {
                console.error('Error fetching channels data:', err);
                showNotification('Error loading channels data', 'error');
            }
        });
    }

    const closeChannelsJSON = () => { channelsJSONModal.style.display = 'none'; };
    if (closeChannelsJSONBtn) closeChannelsJSONBtn.addEventListener('click', closeChannelsJSON);
    if (cancelChannelsJSONBtn) cancelChannelsJSONBtn.addEventListener('click', closeChannelsJSON);

    // --- User Plan Management ---
    const userPlanModal = document.getElementById('userPlanModal');
    const manageUserPlansBtn = document.getElementById('manage-user-plans-btn');
    const closeUserPlanBtn = document.getElementById('close-user-plan-modal');
    const cancelUserPlanBtn = document.getElementById('cancel-user-plan-btn');
    const saveUserPlanBtn = document.getElementById('save-user-plan-btn');
    const updatePlanUsernameInput = document.getElementById('update-plan-username');
    const updatePlanSelect = document.getElementById('update-plan-select');

    // --- Analytics ---
    const analyticsModal = document.getElementById('analyticsModal');
    const analyticsBtn = document.getElementById('analytics-btn');
    const closeAnalyticsBtn = document.getElementById('close-analytics-modal');
    const statsTotalVisitors = document.getElementById('stats-total-visitors');
    const statsUniqueVisitors = document.getElementById('stats-unique-visitors');
    const statsCountriesBody = document.getElementById('stats-countries-body');
    const statsIpsBody = document.getElementById('stats-ips-body');

    const openAnalyticsModal = async () => {
        try {
            const res = await fetch('/api/visitor-stats', { method: 'GET' });
            if (!res.ok) throw new Error('Failed to fetch stats');
            const data = await res.json();

            if (data.success && data.stats) {
                const s = data.stats;
                statsTotalVisitors.textContent = s.totalVisitors || 0;
                statsUniqueVisitors.textContent = s.uniqueVisitors || 0;

                // Render Countries
                statsCountriesBody.innerHTML = Object.entries(s.visitorsPerCountry || {})
                    .sort((a, b) => b[1] - a[1])
                    .map(([country, count]) => `
                        <tr>
                            <td style="padding: 10px; border-bottom: 1px solid #f1f5f9; color: black;">${country}</td>
                            <td style="padding: 10px; border-bottom: 1px solid #f1f5f9; text-align: right; font-weight: 600; color: black;">${count}</td>
                        </tr>
                    `).join('') || '<tr><td colspan="2" style="padding: 20px; text-align: center; color: black; font-weight: 500;">No data yet</td></tr>';

                // Render IPs (Simplified list)
                statsIpsBody.innerHTML = Object.entries(s.ipAddresses || {})
                    .sort((a, b) => b[1].hits - a[1].hits)
                    .slice(0, 50) // Show top 50
                    .map(([ip, details]) => `
                        <tr>
                            <td style="padding: 10px; border-bottom: 1px solid #f1f5f9; font-family: monospace; color: black;">${ip}</td>
                            <td style="padding: 10px; border-bottom: 1px solid #f1f5f9; color: black;">${details.country}</td>
                            <td style="padding: 10px; border-bottom: 1px solid #f1f5f9; text-align: right; color: black;">${details.hits}</td>
                        </tr>
                    `).join('') || '<tr><td colspan="3" style="padding: 20px; text-align: center; color: black; font-weight: 500;">No data yet</td></tr>';

                // Populate Detailed Logs Table
                const detailedBody = document.getElementById('stats-detailed-body');
                const detailedLogs = data.detailedLogs || {}; // { 'ip': { first_seen, last_seen, paths: [] } }

                // Convert object to array and sort by last_seen desc
                const logsArray = Object.keys(detailedLogs).map(ip => ({
                    ip,
                    ...detailedLogs[ip]
                })).sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen)).slice(0, 100);

                detailedBody.innerHTML = logsArray.map(log => {
                    const firstSeen = new Date(log.first_seen).toLocaleString();
                    const lastSeen = new Date(log.last_seen).toLocaleString();

                    // Format Paths nicely (Limit to last 10 for performance)
                    let pathsHtml = '';
                    if (Array.isArray(log.paths) && log.paths.length > 0) {
                        const displayedPaths = log.paths.slice(-10);
                        pathsHtml = displayedPaths.map(p => `
                            <span style="display:inline-block; background:#e0e7ff; color:#3730a3; padding:2px 6px; border-radius:4px; margin:2px; font-size:0.8em; font-family:monospace;">
                                ${p}
                            </span>
                        `).join('');
                        if (log.paths.length > 10) {
                            pathsHtml += `<span style="color:#94a3b8; font-size:0.8em; margin-left:5px;">+${log.paths.length - 10} more</span>`;
                        }
                    } else {
                        pathsHtml = '<span style="color:#94a3b8;">No paths recorded</span>';
                    }

                    return `
                        <tr>
                            <td style="padding: 10px; border-bottom: 1px solid #f1f5f9; color: #334155; font-weight:600;">${log.ip}</td>
                            <td style="padding: 10px; border-bottom: 1px solid #f1f5f9; color: #64748b; font-size: 0.8em;">
                                <div><i class="fas fa-play" style="font-size:0.7em; color:#10b981;"></i> ${firstSeen}</div>
                                <div style="margin-top:2px;"><i class="fas fa-stop" style="font-size:0.7em; color:#ef4444;"></i> ${lastSeen}</div>
                            </td>
                            <td style="padding: 10px; border-bottom: 1px solid #f1f5f9;">
                                ${pathsHtml}
                            </td>
                        </tr>
                    `;
                }).join('') || '<tr><td colspan="3" style="padding: 20px; text-align: center; color: #94a3b8;">No detailed logs found</td></tr>';

                analyticsModal.style.display = 'block';
            }
        } catch (err) {
            console.error('Analytics Error:', err);
            showNotification('Failed to load analytics', 'error');
        }
    };

    if (analyticsBtn) analyticsBtn.addEventListener('click', openAnalyticsModal);
    if (closeAnalyticsBtn) closeAnalyticsBtn.addEventListener('click', () => { analyticsModal.style.display = 'none'; });


    if (manageUserPlansBtn) {
        manageUserPlansBtn.addEventListener('click', () => {
            managementDropdown.classList.remove('show');
            userPlanModal.style.display = 'flex';
        });
    }

    const closeUserPlan = () => { userPlanModal.style.display = 'none'; };
    if (closeUserPlanBtn) closeUserPlanBtn.addEventListener('click', closeUserPlan);
    if (cancelUserPlanBtn) cancelUserPlanBtn.addEventListener('click', closeUserPlan);

    if (saveUserPlanBtn) {
        saveUserPlanBtn.addEventListener('click', async () => {
            const username = updatePlanUsernameInput.value.trim();
            const plan = updatePlanSelect.value;

            if (!username) {
                showNotification('Please enter a username', 'error');
                return;
            }

            saveUserPlanBtn.disabled = true;
            saveUserPlanBtn.textContent = 'Saving...';

            try {
                // 1. Get user ID by username
                const usersRes = await fetch('/api/users', { method: 'POST' });
                const users = await usersRes.json();

                if (!usersRes.ok || !Array.isArray(users)) {
                    showNotification(users.message || 'Failed to fetch user list', 'error');
                    return;
                }

                const user = users.find(u => u.username === username);

                if (!user) {
                    showNotification('User not found', 'error');
                    return;
                }

                // 2. Update plan
                const updateRes = await fetch(`/api/users/${user.id}/plan`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ plan })
                });

                const data = await updateRes.json();
                if (data.success) {
                    showNotification(`Plan updated to ${plan} for ${username}`);
                    closeUserPlan();
                } else {
                    showNotification(data.message || 'Failed to update plan', 'error');
                }
            } catch (err) {
                console.error('Error updating user plan:', err);
                showNotification('Error updating user plan', 'error');
            } finally {
                saveUserPlanBtn.disabled = false;
                saveUserPlanBtn.textContent = 'Save Changes';
            }
        });
    }

    if (saveChannelsJSONBtn) {
        saveChannelsJSONBtn.addEventListener('click', async () => {
            saveChannelsJSONBtn.disabled = true;
            saveChannelsJSONBtn.textContent = 'Saving...';
            try {
                const res = await fetch('/save-channels-json', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ channels: channelsJSONEditor.value })
                });
                const data = await res.json();
                if (data.success) {
                    showNotification('Channels data saved successfully!');
                    closeChannelsJSON();
                    loadChannels(); // Refresh channel list UI
                } else {
                    showNotification(data.message || 'Failed to save channels data', 'error');
                }
            } catch (err) {
                console.error('Error saving channels data:', err);
                showNotification('Error saving channels data', 'error');
            } finally {
                saveChannelsJSONBtn.disabled = false;
                saveChannelsJSONBtn.textContent = 'Save Channels';
            }
        });
    }

    loadChannels();
    checkSessionStatus();
    // --- Facebook Credentials Management ---
    const fbCredsModal = document.getElementById('fbCredsModal');
    const manageFbCredsBtn = document.getElementById('manage-fb-creds-btn');
    const closeFbCredsModal = document.getElementById('close-fb-creds-modal');
    const cancelFbCredsBtn = document.getElementById('cancel-fb-creds-btn');
    const saveFbCredsBtn = document.getElementById('save-fb-creds-btn');
    const fbCredsEditor = document.getElementById('fb-creds-editor');

    const openFacebookCredentials = async () => {
        try {
            const res = await fetch('/get-facebook-credentials', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                fbCredsEditor.value = data.credentials;
                fbCredsModal.style.display = 'flex';
            }
        } catch (err) {
            console.error('Error fetching FB creds:', err);
            showNotification('Error loading Facebook credentials', 'error');
        }
    };

    window.openFacebookCredentials = openFacebookCredentials; // Expose globally

    if (manageFbCredsBtn) {
        manageFbCredsBtn.addEventListener('click', openFacebookCredentials);
    }

    const closeFbCreds = () => { fbCredsModal.style.display = 'none'; };
    if (closeFbCredsModal) closeFbCredsModal.onclick = closeFbCreds;
    if (cancelFbCredsBtn) cancelFbCredsBtn.onclick = closeFbCreds;

    if (saveFbCredsBtn) {
        saveFbCredsBtn.addEventListener('click', async () => {
            try {
                JSON.parse(fbCredsEditor.value); // Validate JSON
            } catch (e) {
                showNotification('Invalid JSON format.', 'error');
                return;
            }

            saveFbCredsBtn.disabled = true;
            saveFbCredsBtn.textContent = 'Saving...';
            try {
                const res = await fetch('/save-facebook-credentials', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ credentials: fbCredsEditor.value })
                });
                const result = await res.json();
                if (result.success) {
                    showNotification('Facebook credentials saved!', 'success');
                    closeFbCreds();
                } else {
                    showNotification(result.message || 'Failed to save', 'error');
                }
            } catch (err) {
                console.error('Save FB creds error:', err);
                showNotification('Error saving credentials', 'error');
            } finally {
                saveFbCredsBtn.disabled = false;
                saveFbCredsBtn.textContent = 'Save Credentials';
            }
        });
    }

    // --- YouTube Credentials Management ---
    const credentialsModal = document.getElementById('credentialsModal');
    const manageCredentialsBtn = document.getElementById('manage-credentials-btn');
    const closeCredentialsModal = document.getElementById('close-credentials-modal');
    const cancelCredentialsBtn = document.getElementById('cancel-credentials-btn');
    const saveCredentialsBtn = document.getElementById('save-credentials-btn');
    const credentialsEditor = document.getElementById('credentials-editor');

    const openYouTubeCredentials = async () => {
        try {
            const res = await fetch('/get-credentials', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                credentialsEditor.value = data.credentials;
                credentialsModal.style.display = 'flex';
            }
        } catch (err) {
            console.error('Error fetching YouTube creds:', err);
            showNotification('Error loading YouTube credentials', 'error');
        }
    };

    if (manageCredentialsBtn) {
        manageCredentialsBtn.addEventListener('click', openYouTubeCredentials);
    }

    const closeCredentials = () => { credentialsModal.style.display = 'none'; };
    if (closeCredentialsModal) closeCredentialsModal.onclick = closeCredentials;
    if (cancelCredentialsBtn) cancelCredentialsBtn.onclick = closeCredentials;

    if (saveCredentialsBtn) {
        saveCredentialsBtn.addEventListener('click', async () => {
            try {
                JSON.parse(credentialsEditor.value); // Validate JSON
            } catch (e) {
                showNotification('Invalid JSON format.', 'error');
                return;
            }

            saveCredentialsBtn.disabled = true;
            saveCredentialsBtn.textContent = 'Saving...';
            try {
                const res = await fetch('/save-credentials', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ credentials: credentialsEditor.value })
                });
                const data = await res.json();
                if (data.success) {
                    showNotification('YouTube credentials saved successfully!');
                    setTimeout(closeCredentials, 500); // Close after successful save
                } else {
                    showNotification('Failed to save credentials', 'error');
                }
            } catch (err) {
                console.error('Error saving YouTube credentials:', err);
                showNotification('Error saving credentials', 'error');
            } finally {
                saveCredentialsBtn.disabled = false;
                saveCredentialsBtn.textContent = 'Save Credentials';
            }
        });
    }

    // --- Pricing Modal ---
    const pricingModal = document.getElementById('pricingModal');
    const upgradeBtn = document.getElementById('upgrade-btn');
    const closePricingBtn = document.getElementById('close-pricing-modal');
    const billingToggle = document.getElementById('billing-toggle');
    const toggleMonthly = document.getElementById('toggle-monthly');
    const toggleYearly = document.getElementById('toggle-yearly');
    const discountCallout = document.getElementById('discount-callout');

    const proPrice = document.getElementById('pro-price');
    const proSubtitle = document.getElementById('pro-subtitle');

    if (upgradeBtn) {
        upgradeBtn.onclick = () => { pricingModal.style.display = 'flex'; };
    }

    const upgradeTextLink = document.getElementById('upgrade-text-link');
    if (upgradeTextLink) {
        upgradeTextLink.onclick = (e) => {
            e.preventDefault();
            pricingModal.style.display = 'flex';
        };
    }

    if (closePricingBtn) {
        closePricingBtn.onclick = () => { pricingModal.style.display = 'none'; };
    }

    if (billingToggle) {
        billingToggle.onclick = () => {
            const isYearly = toggleYearly.classList.toggle('active');
            toggleMonthly.classList.toggle('active', !isYearly);

            if (isYearly) {
                proPrice.innerHTML = '$8<span>/mo</span>';
                proSubtitle.textContent = '$96 paid yearly. Cancel anytime.';
                if (discountCallout) discountCallout.style.opacity = '1';
            } else {
                proPrice.innerHTML = '$12<span>/mo</span>';
                proSubtitle.textContent = '$12 paid monthly. Cancel anytime.';
                if (discountCallout) discountCallout.style.opacity = '0.5'; // Dim it when monthly selected
            }
        };
    }

    // Modal behavior for Facebook credentials and Pricing
    window.addEventListener('click', (e) => {
        if (e.target === fbCredsModal) closeFbCreds();
        if (e.target === fbCookiesModal) closeFbCookies();
        if (e.target === pricingModal) pricingModal.style.display = 'none';
    });

    // Auto-open from URL param (for redirects from error pages)
    if (urlParams.get('action') === 'manage-fb-creds') {
        openFacebookCredentials();
    }

    // --- Auth State Check ---
    // --- Automation Modal Logic ---
    const automationModal = document.getElementById('automationModal');
    const automationBtn = document.getElementById('automation-btn');
    const closeAutoModal = document.getElementById('close-automation-modal');
    const cancelAutoBtn = document.getElementById('cancel-auto-btn');
    const startAutoBtn = document.getElementById('start-auto-btn');
    const autoAudioLinks = document.getElementById('auto-audio-links');
    const autoImageLink = document.getElementById('auto-image-link');
    const autoApplyDelayToggle = document.getElementById('auto-apply-delay');

    // Persistence: Load saved delay preference
    if (autoApplyDelayToggle) {
        const savedDelayPref = localStorage.getItem('mp3toyt_apply_delay');
        console.log(`[Automation UI] Loading saved delay preference: ${savedDelayPref}`);
        if (savedDelayPref !== null) {
            autoApplyDelayToggle.checked = savedDelayPref === 'true';
        }

        // Persistence: Save delay preference on change
        autoApplyDelayToggle.addEventListener('change', () => {
            console.log(`[Automation UI] Delay toggle changed to: ${autoApplyDelayToggle.checked}`);
            localStorage.setItem('mp3toyt_apply_delay', autoApplyDelayToggle.checked);
        });
    }

    if (automationBtn) {
        automationBtn.addEventListener('click', () => {
            console.log('[Automation UI] Opening automation modal');
            automationModal.style.display = 'flex';
        });
    }

    const closeAuto = () => { automationModal.style.display = 'none'; };
    if (closeAutoModal) closeAutoModal.addEventListener('click', closeAuto);
    if (cancelAutoBtn) cancelAutoBtn.addEventListener('click', closeAuto);

    if (startAutoBtn) {
        startAutoBtn.onclick = async () => {
            console.log('[Automation UI] "Process Links" button CLICKED.');

            try {
                const links = autoAudioLinks?.value?.split('\n').map(l => l.trim()).filter(l => l) || [];
                const thumbUrl = autoImageLink?.value?.trim() || "";
                const applyDelay = document.getElementById('auto-apply-delay')?.checked ?? true;

                console.log(`[Automation UI] Preparing to send request.`, { linksCount: links.length, applyDelay });

                if (links.length === 0) {
                    console.warn('[Automation UI] Validation failed: No links provided.');
                    showNotification('Please enter at least one audio link.', 'error');
                    return;
                }

                startAutoBtn.disabled = true;
                startAutoBtn.textContent = 'Queueing...';

                console.log('[Automation UI] Fetching /start-automation...');
                const res = await fetch('/start-automation', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ links, thumbUrl, applyDelay })
                });

                const result = await res.json();
                console.log('[Automation UI] API Response:', result);

                if (result.success) {
                    showNotification(`Success! Video queued for ${links.length} song(s).`, 'success');
                    if (autoAudioLinks) autoAudioLinks.value = '';
                    if (autoImageLink) autoImageLink.value = '';

                    const successIcon = document.getElementById('auto-success-icon');
                    if (successIcon) {
                        successIcon.style.display = 'inline-block';
                        setTimeout(() => { if (successIcon) successIcon.style.display = 'none'; }, 4000);
                    }
                } else {
                    console.error('[Automation UI] Server reported error:', result.error);
                    showNotification(result.error || 'Failed to start automation', 'error');
                }
            } catch (err) {
                console.error('[Automation UI] CRITICAL FETCH ERROR:', err);
                showNotification('Network error starting automation', 'error');
            } finally {
                startAutoBtn.disabled = false;
                startAutoBtn.textContent = 'Process Links';
                console.log('[Automation UI] Request lifecycle complete.');
            }
        };
    }

    // --- Facebook Cookies Management (Puppeteer) ---
    const fbCookiesModal = document.getElementById('fbCookiesModal');
    const manageFbCookiesBtn = document.getElementById('manage-fb-cookies-btn');
    const closeFbCookiesModal = document.getElementById('close-fb-cookies-modal');
    const cancelFbCookiesBtn = document.getElementById('cancel-fb-cookies-btn');
    const saveFbCookiesBtn = document.getElementById('save-fb-cookies-btn');
    const fbCookiesEditor = document.getElementById('fb-cookies-editor');

    const openFacebookCookies = async () => {
        try {
            const res = await fetch('/get-facebook-cookies');
            const data = await res.json();
            if (data.success) {
                fbCookiesEditor.value = data.cookies;
                fbCookiesModal.style.display = 'flex';
            } else {
                showNotification(data.message || 'Error loading cookies', 'error');
            }
        } catch (err) {
            console.error('Error fetching Facebook cookies:', err);
            showNotification('Error loading Facebook cookies', 'error');
        }
    };

    if (manageFbCookiesBtn) {
        manageFbCookiesBtn.addEventListener('click', openFacebookCookies);
    }

    const closeFbCookies = () => { if (fbCookiesModal) fbCookiesModal.style.display = 'none'; };
    if (closeFbCookiesModal) closeFbCookiesModal.onclick = closeFbCookies;
    if (cancelFbCookiesBtn) cancelFbCookiesBtn.onclick = closeFbCookies;

    if (saveFbCookiesBtn) {
        saveFbCookiesBtn.addEventListener('click', async () => {
            try {
                JSON.parse(fbCookiesEditor.value); // Validate JSON
            } catch (e) {
                showNotification('Invalid JSON format for cookies.', 'error');
                return;
            }

            saveFbCookiesBtn.disabled = true;
            saveFbCookiesBtn.textContent = 'Saving...';
            try {
                const res = await fetch('/save-facebook-cookies', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cookies: fbCookiesEditor.value })
                });
                const result = await res.json();
                if (result.success) {
                    showNotification('Facebook cookies saved!', 'success');
                    closeFbCookies();
                } else {
                    showNotification(result.message || 'Failed to save', 'error');
                }
            } catch (err) {
                console.error('Save FB cookies error:', err);
                showNotification('Error saving cookies', 'error');
            } finally {
                saveFbCookiesBtn.disabled = false;
                saveFbCookiesBtn.textContent = 'Save Cookies';
            }
        });
    }

    async function checkAuth() {
        try {
            const res = await fetch('/api/auth/me');
            const data = await res.json();
            const loginBtn = document.getElementById('login-btn-header');
            const logoutBtn = document.getElementById('logout-btn-header');
            const manageUsersLink = document.getElementById('manage-users-link');

            if (data.success && data.user) {
                // User is logged in
                if (loginBtn) loginBtn.style.display = 'none';
                if (logoutBtn) {
                    logoutBtn.style.display = 'inline-block';
                    logoutBtn.onclick = async () => {
                        await fetch('/api/auth/logout', { method: 'POST' });
                        window.location.reload();
                    };
                }

                const managementBtn = document.getElementById('management-btn');
                const upgradeBtn = document.getElementById('upgrade-btn');
                const automationBtn = document.getElementById('automation-btn');

                const analyticsBtnHeader = document.getElementById('analytics-btn');
                const isAdmin = data.user.username === 'erraja';
                localStorage.setItem('mp3toyt_isAdmin', isAdmin); // Sync for next refresh

                // Show Cog menu for all logged-in users, but hide admin-only items
                if (managementBtn) {
                    managementBtn.style.display = 'flex';
                    const adminOnlyItems = ['manage-cookies-btn', 'manage-tokens-btn', 'manage-channels-json-btn', 'manage-user-plans-btn', 'manage-fb-creds-btn', 'manage-credentials-btn', 'manage-fb-cookies-btn'];
                    adminOnlyItems.forEach(id => {
                        const el = document.getElementById(id);
                        if (el) el.style.display = isAdmin ? 'flex' : 'none';
                    });
                }

                if (automationBtn) automationBtn.style.display = isAdmin ? 'flex' : 'none';
                if (analyticsBtnHeader) analyticsBtnHeader.style.display = isAdmin ? 'flex' : 'none';

                if (upgradeBtn) {
                    upgradeBtn.style.display = 'flex';
                    if (data.user.plan === 'pro') {
                        upgradeBtn.innerHTML = '<i class="fas fa-crown" style="color: #f59e0b;"></i> Pro Plan';
                    } else if (data.user.plan === 'basic') {
                        upgradeBtn.innerHTML = '<i class="fas fa-crown" style="color: #f59e0b;"></i> Basic Plan';
                    } else {
                        upgradeBtn.innerHTML = '<i class="fas fa-crown" style="color: #f59e0b;"></i> Upgrade';
                    }
                }

                // Show Manage Users if Admin
                if (data.user.role === 'admin' && manageUsersLink) {
                    manageUsersLink.style.display = 'block';
                }

            } else {
                // Not logged in
                if (loginBtn) loginBtn.style.display = 'inline-block';
                if (logoutBtn) logoutBtn.style.display = 'none';
            }
        } catch (err) {
            console.error('Auth check error:', err);
        } finally {
            // Wait at least 3 seconds so the user can see the beautiful loader
            setTimeout(() => {
                const loader = document.getElementById('page-loader');
                if (loader) {
                    loader.style.opacity = '0';
                    loader.style.visibility = 'hidden';
                    setTimeout(() => loader.remove(), 500); // Remove from DOM after transition
                }
            }, 800);
        }
    }
    checkAuth();
});
