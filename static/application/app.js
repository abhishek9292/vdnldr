let tabs = [];
let activeTabId = null;
let eventSources = {};

const STORAGE_KEY_TABS = 'vdnldr_tabs';
const STORAGE_KEY_ACTIVE = 'vdnldr_active_tab';

function showToast(message, type = 'danger') {
    const alertClass = type === 'success' ? 'alert-success' : (type === 'info' ? 'alert-info' : 'alert-danger');
    const toastHtml = `
        <div class="alert ${alertClass} alert-dismissible fade show" role="alert" style="min-width: 300px;">
            ${message}
            <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
        </div>
    `;
    $('#toastContainer').append(toastHtml);
    setTimeout(() => {
        $('.alert').fadeOut(() => $('.alert').remove());
    }, 5000);
}

function buildErrorMessage(prefix, xhr) {
    const errorMsg = xhr?.responseJSON?.error || 'Unknown error';
    const requestId = xhr?.getResponseHeader ? xhr.getResponseHeader('X-Request-ID') : null;
    if (requestId) {
        return `${prefix}: ${errorMsg} (Request ID: ${requestId})`;
    }
    return `${prefix}: ${errorMsg}`;
}

function isValidM3u8Url(urlText) {
    if (!urlText) {
        return false;
    }

    try {
        const parsed = new URL(urlText.trim());
        const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:';
        const hasM3u8 = /\.m3u8($|\?)/i.test(parsed.href);
        return isHttp && hasM3u8;
    } catch (e) {
        return false;
    }
}

function newTabObject(title = null) {
    const id = `tab_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    return {
        id,
        title: title || `Tab ${tabs.length + 1}`,
        url: '',
        qualityUri: '',
        workers: 5,
        outputName: '',
        variants: [],
        jobId: null,
        segmentStatus: {},
        totalSegments: 0,
        isPaused: false,
        lastConvertedFilename: null
    };
}

function sanitizeOutputNameInput(raw) {
    if (!raw) return '';
    let text = String(raw).trim();
    if (text.toLowerCase().endsWith('.mp4')) {
        text = text.slice(0, -4);
    }
    text = text.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').replace(/\s+/g, ' ').trim();
    return text.slice(0, 120);
}

function suggestNameFromUrl(urlText) {
    if (!urlText) return '';
    try {
        const url = new URL(urlText);
        const parts = url.pathname.split('/').filter(Boolean);
        for (let i = parts.length - 1; i >= 0; i--) {
            const p = parts[i];
            const cleaned = sanitizeOutputNameInput(decodeURIComponent(p));
            if (!cleaned) continue;
            if (/\.m3u8$/i.test(cleaned) || /^index[-_.]/i.test(cleaned)) continue;
            if (/^\d+$/.test(cleaned)) continue;
            return cleaned;
        }
    } catch (e) {
        return '';
    }
    return '';
}

function saveTabsToStorage() {
    try {
        localStorage.setItem(STORAGE_KEY_TABS, JSON.stringify(tabs));
        localStorage.setItem(STORAGE_KEY_ACTIVE, activeTabId || '');
    } catch (e) {
        // Ignore storage quota/private mode errors; app can still run in-memory.
    }
}

function loadTabsFromStorage() {
    try {
        const rawTabs = localStorage.getItem(STORAGE_KEY_TABS);
        const rawActive = localStorage.getItem(STORAGE_KEY_ACTIVE);
        if (rawTabs) {
            tabs = JSON.parse(rawTabs);
        }
        // Backward-compatible migration for tabs saved by older app versions.
        if (Array.isArray(tabs)) {
            tabs = tabs.map((t, idx) => ({
                id: t.id || `tab_${Date.now()}_${idx}`,
                title: t.title || `Tab ${idx + 1}`,
                url: t.url || '',
                qualityUri: t.qualityUri || '',
                workers: Number.isInteger(t.workers) ? t.workers : 5,
                outputName: t.outputName || '',
                variants: Array.isArray(t.variants) ? t.variants : [],
                jobId: t.jobId || null,
                segmentStatus: t.segmentStatus || {},
                totalSegments: Number.isInteger(t.totalSegments) ? t.totalSegments : 0,
                isPaused: !!t.isPaused,
                lastConvertedFilename: t.lastConvertedFilename || null
            }));
        }
        if (!Array.isArray(tabs) || tabs.length === 0) {
            tabs = [newTabObject('Tab 1')];
        }
        activeTabId = rawActive && tabs.find(t => t.id === rawActive) ? rawActive : tabs[0].id;
    } catch (e) {
        tabs = [newTabObject('Tab 1')];
        activeTabId = tabs[0].id;
    }
}

function getActiveTab() {
    return tabs.find(t => t.id === activeTabId) || null;
}

function closeEventSource(jobId) {
    if (jobId && eventSources[jobId]) {
        eventSources[jobId].close();
        delete eventSources[jobId];
    }
}

function renderTabs() {
    const tabsContainer = $('#jobTabs');
    tabsContainer.empty();

    tabs.forEach((tab) => {
        const activeClass = tab.id === activeTabId ? 'active' : '';
        const li = $(`
            <li class="nav-item" data-tab-id="${tab.id}">
                <a class="nav-link ${activeClass}" href="#" data-switch-tab="${tab.id}">
                    ${tab.title}
                    <span class="ms-2 text-danger" data-close-tab="${tab.id}" style="cursor:pointer;">×</span>
                </a>
            </li>
        `);
        tabsContainer.append(li);
    });

    $('[data-switch-tab]').off('click').on('click', function (e) {
        e.preventDefault();
        const tabId = $(this).attr('data-switch-tab');
        activeTabId = tabId;
        saveTabsToStorage();
        renderTabs();
        renderActiveTab();
    });

    $('[data-close-tab]').off('click').on('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        const tabId = $(this).attr('data-close-tab');
        closeTab(tabId);
    });
}

function closeTab(tabId) {
    if (tabs.length === 1) {
        showToast('At least one tab is required', 'info');
        return;
    }

    const tab = tabs.find(t => t.id === tabId);
    if (tab && tab.jobId) {
        closeEventSource(tab.jobId);
    }

    tabs = tabs.filter(t => t.id !== tabId);
    if (activeTabId === tabId) {
        activeTabId = tabs[0].id;
    }

    saveTabsToStorage();
    renderTabs();
    renderActiveTab();
}

function addNewTab() {
    const tab = newTabObject();
    tabs.push(tab);
    activeTabId = tab.id;
    saveTabsToStorage();
    renderTabs();
    renderActiveTab();
}

function updateAnalyseButtonState() {
    const urlValue = $('#urlInput').val().trim();
    const isValid = isValidM3u8Url(urlValue);
    $('#analyseBtn').prop('disabled', !isValid);
}

function updatePauseResumeButtons(tab) {
    if (!tab || !tab.jobId) {
        $('#pauseBtn').hide();
        $('#resumeBtn').hide();
        return;
    }

    if (tab.isPaused) {
        $('#pauseBtn').hide();
        $('#resumeBtn').show();
    } else {
        $('#pauseBtn').show();
        $('#resumeBtn').hide();
    }
}

function renderVariants(tab) {
    const dropdown = $('#resolutionDropdown');
    dropdown.empty();
    dropdown.append('<option value="">Select a resolution</option>');

    (tab.variants || []).forEach(v => {
        const mbps = v.bandwidth && v.bandwidth > 0 ? `${(v.bandwidth / 1000000).toFixed(1)}Mbps` : null;
        const quality = v.quality && v.quality !== 'Unknown' ? v.quality : null;
        const parts = [v.resolution];
        if (quality) parts.push(quality);
        if (mbps) parts.push(mbps);
        const label = parts.join(' | ');
        const selected = tab.qualityUri === v.uri ? 'selected' : '';
        dropdown.append(`<option value="${v.uri}" ${selected}>${label}</option>`);
    });

    if ((tab.variants || []).length > 0) {
        $('#resolutionDiv').show();
        $('#workersDiv').show();
    } else {
        $('#resolutionDiv').hide();
        $('#workersDiv').hide();
    }
}

function updateSegmentDisplay(tab) {
    const container = $('#segmentContainer');
    container.empty();

    if (!tab) {
        $('#segmentDiv').hide();
        $('#actionDiv').hide();
        $('#downloadFullBtn').hide();
        return;
    }

    const statusObj = tab.segmentStatus || {};
    const keys = Object.keys(statusObj);
    const totalSegments = tab.totalSegments || keys.length;

    let doneCount = 0;
    for (let i = 0; i < totalSegments; i++) {
        const status = statusObj[i] || statusObj[String(i)] || 'pending';
        if (status === 'done') doneCount++;

        const segment = $(`<div class="segment ${status}" data-index="${i}" title="Segment ${i}"></div>`);
        if (status === 'failed') {
            segment.click(() => retrySegment(tab, i));
        }
        container.append(segment);
    }

    $('#statusCounter').text(doneCount);
    $('#totalCounter').text(totalSegments);

    const hasNonDone = totalSegments > 0 && doneCount !== totalSegments;
    if (!hasNonDone && totalSegments > 0) {
        $('#downloadFullBtn').show();
    } else {
        $('#downloadFullBtn').hide();
    }

    if (tab.jobId) {
        $('#segmentDiv').show();
        $('#actionDiv').show();
    } else {
        $('#segmentDiv').hide();
        $('#actionDiv').hide();
    }

    updatePauseResumeButtons(tab);
}

function renderActiveTab() {
    const tab = getActiveTab();
    if (!tab) return;

    $('#urlInput').val(tab.url || '');
    $('#workersInput').val(tab.workers || 5);
    $('#filenameInput').val(tab.outputName || '');
    renderVariants(tab);
    updateSegmentDisplay(tab);
    renderDetectedNameBadge(tab);
    updateAnalyseButtonState();
}

function renderDetectedNameBadge(tab) {
    const urlBased = suggestNameFromUrl((tab && tab.url) || '');
    if (urlBased) {
        $('#detectedNameBadge').text(urlBased);
        $('#detectedNameWrap').show();
    } else {
        $('#detectedNameBadge').text('');
        $('#detectedNameWrap').hide();
    }
}

function loadJobs() {
    $.get('/jobs', (response) => {
        const recentDownloads = response.recent_downloads || [];
        const list = $('#downloadsList');
        list.empty();

        if (recentDownloads.length === 0) {
            $('#downloadsDiv').hide();
        } else {
            $('#downloadsDiv').show();
            recentDownloads.forEach(dl => {
                const timestamp = new Date(dl.timestamp);
                const dateStr = timestamp.toLocaleString();
                const item = $(`
                    <div class="download-item">
                        <div>
                            <strong>${dl.filename}</strong><br>
                            <small>${dateStr}</small>
                        </div>
                        <div class="d-flex gap-1">
                            <a href="/downloads/${dl.filename}" class="btn btn-sm btn-primary">Download</a>
                            <button class="btn btn-sm btn-outline-danger" title="Delete" data-delete-filename="${dl.filename}">🗑</button>
                        </div>
                    </div>
                `);
                list.append(item);
            });

            $('[data-delete-filename]').off('click').on('click', function () {
                const filename = $(this).attr('data-delete-filename');
                deleteRecentDownload(filename);
            });
        }
    });
}

function deleteRecentDownload(filename) {
    if (!filename) return;
    if (!confirm(`Delete ${filename}?`)) return;

    $.ajax({
        url: '/downloads/' + encodeURIComponent(filename),
        method: 'DELETE',
        success: () => {
            showToast(`Deleted: ${filename}`, 'success');
            tabs.forEach(t => {
                if (t.lastConvertedFilename === filename) {
                    t.lastConvertedFilename = null;
                }
            });
            saveTabsToStorage();
            loadJobs();
        },
        error: (xhr) => {
            showToast(buildErrorMessage('Delete failed', xhr), 'danger');
        }
    });
}

function startEventListener(tab) {
    if (!tab || !tab.jobId) return;

    closeEventSource(tab.jobId);
    const es = new EventSource('/progress?job_id=' + encodeURIComponent(tab.jobId));
    eventSources[tab.jobId] = es;

    es.onmessage = (event) => {
        const data = JSON.parse(event.data);
        const targetTab = tabs.find(t => t.id === tab.id);
        if (!targetTab) return;

        targetTab.segmentStatus = data.status || {};
        targetTab.totalSegments = data.total || targetTab.totalSegments || Object.keys(targetTab.segmentStatus).length;
        targetTab.isPaused = !!data.paused;

        saveTabsToStorage();

        if (targetTab.id === activeTabId) {
            updateSegmentDisplay(targetTab);
        }
    };

    es.onerror = () => {
        closeEventSource(tab.jobId);
    };
}

function retrySegment(tab, index) {
    if (!tab || !tab.jobId) {
        showToast('No active job found for this tab', 'danger');
        return;
    }

    $.ajax({
        url: '/retry',
        method: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({ job_id: tab.jobId, index: index }),
        success: () => {
            tab.segmentStatus[index] = 'downloading';
            saveTabsToStorage();
            if (tab.id === activeTabId) {
                updateSegmentDisplay(tab);
            }
        },
        error: (xhr) => {
            showToast(buildErrorMessage('Retry failed', xhr), 'danger');
        }
    });
}

function convertCurrentTab(tab, onSuccess, onError, onComplete) {
    if (!tab || !tab.jobId) {
        showToast('No active job for this tab', 'danger');
        if (onComplete) onComplete();
        return;
    }

    $.ajax({
        url: '/convert',
        method: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({ job_id: tab.jobId, output_name: tab.outputName || '' }),
        success: (response) => {
            tab.lastConvertedFilename = response.filename;
            saveTabsToStorage();
            if (onSuccess) onSuccess(response);
        },
        error: (xhr) => {
            if (onError) onError(xhr);
        },
        complete: () => {
            if (onComplete) onComplete();
        }
    });
}

async function pasteUrlFromClipboard() {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
        showToast('Clipboard API not supported in this browser', 'danger');
        return;
    }

    try {
        const clipText = (await navigator.clipboard.readText()).trim();
        if (!clipText) {
            showToast('Clipboard is empty', 'danger');
            return;
        }

        if (!isValidM3u8Url(clipText)) {
            showToast('Clipboard text is not a valid M3U8 URL', 'danger');
            return;
        }

        const tab = getActiveTab();
        if (!tab) return;

        tab.url = clipText;
        $('#urlInput').val(clipText);
        updateAnalyseButtonState();
        saveTabsToStorage();
        showToast('M3U8 URL pasted from clipboard', 'success');
    } catch (e) {
        showToast('Unable to read clipboard. Please allow clipboard permission.', 'danger');
    }
}

function resetTabForNewAnalysis(tab) {
    if (!tab) return;

    if (tab.jobId) {
        closeEventSource(tab.jobId);
    }

    tab.qualityUri = '';
    tab.variants = [];
    tab.jobId = null;
    tab.segmentStatus = {};
    tab.totalSegments = 0;
    tab.isPaused = false;
    tab.lastConvertedFilename = null;

    if (!tab.outputName) {
        tab.outputName = suggestNameFromUrl(tab.url || '');
    }

    saveTabsToStorage();
}

function pauseCurrentDownload(tab) {
    if (!tab || !tab.jobId) {
        showToast('No active job for this tab', 'danger');
        return;
    }

    $.ajax({
        url: '/pause',
        method: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({ job_id: tab.jobId }),
        success: (response) => {
            tab.isPaused = !!response.paused;
            saveTabsToStorage();
            if (tab.id === activeTabId) updatePauseResumeButtons(tab);
            showToast('Download paused', 'info');
        },
        error: (xhr) => {
            showToast(buildErrorMessage('Pause failed', xhr), 'danger');
        }
    });
}

function resumeCurrentDownload(tab) {
    if (!tab || !tab.jobId) {
        showToast('No active job for this tab', 'danger');
        return;
    }

    $.ajax({
        url: '/resume',
        method: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({ job_id: tab.jobId }),
        success: (response) => {
            tab.isPaused = !!response.paused;
            saveTabsToStorage();
            if (tab.id === activeTabId) updatePauseResumeButtons(tab);
            showToast('Download resumed', 'success');
        },
        error: (xhr) => {
            showToast(buildErrorMessage('Resume failed', xhr), 'danger');
        }
    });
}

function doMainResetDelete() {
    if (!confirm('Reset everything and delete all downloads for all tabs?')) {
        return;
    }

    $.ajax({
        url: '/cleanup',
        method: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({}),
        success: () => {
            Object.keys(eventSources).forEach(jobId => closeEventSource(jobId));
            tabs = [newTabObject('Tab 1')];
            activeTabId = tabs[0].id;
            saveTabsToStorage();
            renderTabs();
            renderActiveTab();
            loadJobs();
            showToast('Main reset completed', 'success');
        },
        error: (xhr) => {
            showToast(buildErrorMessage('Main reset failed', xhr), 'danger');
        }
    });
}

$(document).ready(() => {
    loadTabsFromStorage();
    renderTabs();
    renderActiveTab();
    loadJobs();

    tabs.forEach(tab => {
        if (tab.jobId) {
            startEventListener(tab);
        }
    });

    $('#addTabBtn').click(() => {
        addNewTab();
    });

    $('#mainResetBtn').click(() => {
        doMainResetDelete();
    });

    $('#urlInput').on('input', () => {
        const tab = getActiveTab();
        if (!tab) return;
        tab.url = $('#urlInput').val().trim();
        if (!tab.outputName) {
            tab.outputName = suggestNameFromUrl(tab.url);
            $('#filenameInput').val(tab.outputName || '');
        }
        saveTabsToStorage();
        renderDetectedNameBadge(tab);
        updateAnalyseButtonState();
    });

    $('#filenameInput').on('input', () => {
        const tab = getActiveTab();
        if (!tab) return;
        tab.outputName = sanitizeOutputNameInput($('#filenameInput').val());
        $('#filenameInput').val(tab.outputName);
        saveTabsToStorage();
    });

    $('#workersInput').on('input', () => {
        const tab = getActiveTab();
        if (!tab) return;
        tab.workers = parseInt($('#workersInput').val(), 10) || 5;
        saveTabsToStorage();
    });

    $('#resolutionDropdown').on('change', () => {
        const tab = getActiveTab();
        if (!tab) return;
        tab.qualityUri = $('#resolutionDropdown').val();
        saveTabsToStorage();
    });

    $('#pasteUrlBtn').click(async () => {
        await pasteUrlFromClipboard();
    });

    $('#analyseBtn').click(() => {
        const tab = getActiveTab();
        if (!tab) return;

        const url = $('#urlInput').val().trim();
        if (!isValidM3u8Url(url)) {
            showToast('Please enter a valid M3U8 URL', 'danger');
            return;
        }

        tab.url = url;
        resetTabForNewAnalysis(tab);
        saveTabsToStorage();
        renderActiveTab();

        $('#analyseBtn').prop('disabled', true).text('Analysing...');

        $.ajax({
            url: '/analyze',
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ url }),
            success: (response) => {
                tab.variants = response.variants || [];
                tab.qualityUri = '';
                if (!tab.outputName) {
                    tab.outputName = suggestNameFromUrl(tab.url || '');
                }
                saveTabsToStorage();
                renderActiveTab();
                showToast(`Found ${tab.variants.length} quality variants`, 'success');
            },
            error: (xhr) => {
                showToast(buildErrorMessage('Analysis failed', xhr), 'danger');
            },
            complete: () => {
                $('#analyseBtn').prop('disabled', false).text('Analyse');
                updateAnalyseButtonState();
            }
        });
    });

    $('#startBtn').click(() => {
        const tab = getActiveTab();
        if (!tab) return;

        const url = (tab.url || '').trim();
        const qualityUri = $('#resolutionDropdown').val();
        const workers = parseInt($('#workersInput').val(), 10) || 5;

        if (!url || !qualityUri) {
            showToast('Please select a resolution', 'danger');
            return;
        }

        tab.qualityUri = qualityUri;
        tab.workers = workers;
        saveTabsToStorage();

        $('#startBtn').prop('disabled', true).text('Starting...');

        $.ajax({
            url: '/start',
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ url, quality_uri: qualityUri, workers }),
            success: (response) => {
                tab.jobId = response.job_id;
                tab.segmentStatus = {};
                tab.totalSegments = response.total_segments;
                tab.isPaused = false;
                tab.lastConvertedFilename = null;
                for (let i = 0; i < response.total_segments; i++) {
                    tab.segmentStatus[i] = 'pending';
                }
                saveTabsToStorage();
                renderActiveTab();
                startEventListener(tab);
                showToast(`Download started (${response.total_segments} segments)`, 'success');
            },
            error: (xhr) => {
                showToast(buildErrorMessage('Download failed', xhr), 'danger');
            },
            complete: () => {
                $('#startBtn').prop('disabled', false).text('Start Download');
            }
        });
    });

    $('#pauseBtn').click(() => {
        const tab = getActiveTab();
        pauseCurrentDownload(tab);
    });

    $('#resumeBtn').click(() => {
        const tab = getActiveTab();
        resumeCurrentDownload(tab);
    });

    $('#convertBtn').click(() => {
        const tab = getActiveTab();
        if (!tab) return;

        $('#convertBtn').prop('disabled', true).text('Converting...');

        convertCurrentTab(
            tab,
            (response) => {
                showToast('Conversion successful: ' + response.filename, 'success');
                loadJobs();
                window.location.href = '/downloads/' + response.filename;
            },
            (xhr) => {
                showToast(buildErrorMessage('Conversion failed', xhr), 'danger');
            },
            () => {
                $('#convertBtn').prop('disabled', false).text('Convert & Download');
            }
        );
    });

    $('#downloadFullBtn').click(() => {
        const tab = getActiveTab();
        if (!tab || !tab.jobId) {
            showToast('No active job found', 'danger');
            return;
        }

        const statuses = Object.values(tab.segmentStatus || {});
        const total = tab.totalSegments || statuses.length;
        const doneCount = statuses.filter(s => s === 'done').length;
        if (total === 0 || doneCount !== total) {
            showToast('Full video is available only after all segments are downloaded', 'info');
            return;
        }

        $('#downloadFullBtn').prop('disabled', true).text('Preparing Full Video...');

        if (tab.lastConvertedFilename) {
            window.location.href = '/downloads/' + tab.lastConvertedFilename;
            $('#downloadFullBtn').prop('disabled', false).text('⬇ Download Full Video');
            return;
        }

        convertCurrentTab(
            tab,
            (response) => {
                showToast('Full video is ready. Starting download...', 'success');
                loadJobs();
                window.location.href = '/downloads/' + response.filename;
            },
            (xhr) => {
                showToast(buildErrorMessage('Full video preparation failed', xhr), 'danger');
            },
            () => {
                $('#downloadFullBtn').prop('disabled', false).text('⬇ Download Full Video');
            }
        );
    });

    $('#deleteAllBtn').click(() => {
        doMainResetDelete();
    });

    // Force a final persistence snapshot when tab/window is hidden or closed.
    window.addEventListener('beforeunload', saveTabsToStorage);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            saveTabsToStorage();
        }
    });
});
