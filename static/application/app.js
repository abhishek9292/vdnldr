let currentJob = null;
let segmentStatus = {};
let eventSource = null;
let lastConvertedFilename = null;
let isPaused = false;

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

function updateAnalyseButtonState() {
    const urlValue = $('#urlInput').val().trim();
    const isValid = isValidM3u8Url(urlValue);
    $('#analyseBtn').prop('disabled', !isValid);
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

        $('#urlInput').val(clipText);
        updateAnalyseButtonState();
        showToast('M3U8 URL pasted from clipboard', 'success');
    } catch (e) {
        showToast('Unable to read clipboard. Please allow clipboard permission.', 'danger');
    }
}

function updateSegmentDisplay() {
    const container = $('#segmentContainer');
    container.empty();
    
    let doneCount = 0;
    const totalSegments = Object.keys(segmentStatus).length;
    
    for (let i = 0; i < totalSegments; i++) {
        const status = segmentStatus[i] || 'pending';
        if (status === 'done') doneCount++;
        
        const segment = $(`<div class="segment ${status}" data-index="${i}" title="Segment ${i}"></div>`);
        if (status === 'failed') {
            segment.click(() => retrySegment(i));
        }
        container.append(segment);
    }
    
    $('#statusCounter').text(doneCount);
    $('#totalCounter').text(totalSegments);
    
    const hasNonDone = Object.values(segmentStatus).some((s) => s !== 'done');
    if (!hasNonDone && totalSegments > 0) {
        $('#downloadFullBtn').show();
    } else {
        $('#downloadFullBtn').hide();
    }
}

function updatePauseResumeButtons(paused) {
    isPaused = !!paused;
    if (isPaused) {
        $('#pauseBtn').hide();
        $('#resumeBtn').show();
    } else {
        $('#pauseBtn').show();
        $('#resumeBtn').hide();
    }
}

function resetDownloadUIForNewAnalysis() {
    currentJob = null;
    lastConvertedFilename = null;
    segmentStatus = {};
    updatePauseResumeButtons(false);

    if (eventSource) {
        eventSource.close();
        eventSource = null;
    }

    $('#segmentContainer').empty();
    $('#statusCounter').text('0');
    $('#totalCounter').text('0');
    $('#segmentDiv').hide();
    $('#actionDiv').hide();
    $('#downloadFullBtn').hide();
}

function retrySegment(index) {
    $.ajax({
        url: '/retry',
        method: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({ index: index }),
        success: () => {
            segmentStatus[index] = 'downloading';
            updateSegmentDisplay();
        },
        error: (xhr) => {
            showToast(buildErrorMessage('Retry failed', xhr), 'danger');
        }
    });
}

function startEventListener() {
    if (!!window.EventSource) {
        if (eventSource) {
            eventSource.close();
        }
        
        eventSource = new EventSource('/progress');
        eventSource.onmessage = (event) => {
            const data = JSON.parse(event.data);
            segmentStatus = data.status;
            updatePauseResumeButtons(data.paused);
            updateSegmentDisplay();
        };
        
        eventSource.onerror = () => {
            eventSource.close();
        };
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
    if (!filename) {
        return;
    }

    if (!confirm(`Delete ${filename}?`)) {
        return;
    }

    $.ajax({
        url: '/downloads/' + encodeURIComponent(filename),
        method: 'DELETE',
        success: () => {
            showToast(`Deleted: ${filename}`, 'success');
            if (lastConvertedFilename === filename) {
                lastConvertedFilename = null;
            }
            loadJobs();
        },
        error: (xhr) => {
            showToast(buildErrorMessage('Delete failed', xhr), 'danger');
        }
    });
}

function convertCurrentJob(onSuccess, onError, onComplete) {
    $.ajax({
        url: '/convert',
        method: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({}),
        success: (response) => {
            lastConvertedFilename = response.filename;
            if (onSuccess) {
                onSuccess(response);
            }
        },
        error: (xhr) => {
            if (onError) {
                onError(xhr);
            }
        },
        complete: () => {
            if (onComplete) {
                onComplete();
            }
        }
    });
}

function pauseCurrentDownload() {
    $.ajax({
        url: '/pause',
        method: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({}),
        success: (response) => {
            updatePauseResumeButtons(response.paused);
            showToast('Download paused', 'info');
        },
        error: (xhr) => {
            showToast(buildErrorMessage('Pause failed', xhr), 'danger');
        }
    });
}

function resumeCurrentDownload() {
    $.ajax({
        url: '/resume',
        method: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({}),
        success: (response) => {
            updatePauseResumeButtons(response.paused);
            showToast('Download resumed', 'success');
        },
        error: (xhr) => {
            showToast(buildErrorMessage('Resume failed', xhr), 'danger');
        }
    });
}

$(document).ready(() => {
    loadJobs();

    // Analyse is only enabled for valid M3U8 URLs.
    updateAnalyseButtonState();

    $('#urlInput').on('input', () => {
        updateAnalyseButtonState();
    });

    $('#pasteUrlBtn').click(async () => {
        await pasteUrlFromClipboard();
    });
    
    $('#analyseBtn').click(() => {
        const url = $('#urlInput').val().trim();
        if (!isValidM3u8Url(url)) {
            showToast('Please enter a valid M3U8 URL', 'danger');
            return;
        }

        // Start a fresh analysis flow and reset current download UI state.
        resetDownloadUIForNewAnalysis();
        
        $('#analyseBtn').prop('disabled', true).text('Analysing...');
        
        $.ajax({
            url: '/analyze',
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ url: url }),
            success: (response) => {
                const dropdown = $('#resolutionDropdown');
                dropdown.empty();
                dropdown.append('<option value="">Select a resolution</option>');
                
                response.variants.forEach(v => {
                    const mbps = v.bandwidth && v.bandwidth > 0 ? `${(v.bandwidth / 1000000).toFixed(1)}Mbps` : null;
                    const quality = v.quality && v.quality !== 'Unknown' ? v.quality : null;
                    const parts = [v.resolution];
                    if (quality) {
                        parts.push(quality);
                    }
                    if (mbps) {
                        parts.push(mbps);
                    }
                    const label = parts.join(' | ');
                    dropdown.append(`<option value="${v.uri}">${label}</option>`);
                });
                
                $('#resolutionDiv').show();
                $('#workersDiv').show();
                showToast(`Found ${response.variants.length} quality variants`, 'success');
            },
            error: (xhr) => {
                showToast(buildErrorMessage('Analysis failed', xhr), 'danger');
            },
            complete: () => {
                $('#analyseBtn').prop('disabled', false).text('Analyse');
            }
        });
    });
    
    $('#startBtn').click(() => {
        const url = $('#urlInput').val().trim();
        const qualityUri = $('#resolutionDropdown').val();
        const workers = parseInt($('#workersInput').val());
        
        if (!url || !qualityUri) {
            showToast('Please select a resolution', 'danger');
            return;
        }
        
        $('#startBtn').prop('disabled', true).text('Starting...');
        
        $.ajax({
            url: '/start',
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ url: url, quality_uri: qualityUri, workers: workers }),
            success: (response) => {
                currentJob = response;
                lastConvertedFilename = null;
                segmentStatus = {};
                for (let i = 0; i < response.total_segments; i++) {
                    segmentStatus[i] = 'pending';
                }
                
                $('#segmentDiv').show();
                $('#actionDiv').show();
                updatePauseResumeButtons(false);
                $('#downloadFullBtn').hide();
                updateSegmentDisplay();
                startEventListener();
                showToast(`Download started with ${workers} workers (${response.total_segments} segments)`, 'success');
            },
            error: (xhr) => {
                showToast(buildErrorMessage('Download failed', xhr), 'danger');
            },
            complete: () => {
                $('#startBtn').prop('disabled', false).text('Start Download');
            }
        });
    });
    
    $('#convertBtn').click(() => {
        $('#convertBtn').prop('disabled', true).text('Converting...');

        convertCurrentJob(
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
        if (!currentJob || !currentJob.job_id) {
            showToast('No active job found', 'danger');
            return;
        }

        $('#downloadFullBtn').prop('disabled', true).text('Preparing Full Video...');

        if (lastConvertedFilename) {
            window.location.href = '/downloads/' + lastConvertedFilename;
            $('#downloadFullBtn').prop('disabled', false).text('⬇ Download Full Video');
            return;
        }

        // Convert first, then download the actual generated file.
        convertCurrentJob(
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
        if (confirm('Delete all downloads and reset state? This cannot be undone.')) {
            $('#deleteAllBtn').prop('disabled', true);
            
            $.ajax({
                url: '/cleanup',
                method: 'POST',
                contentType: 'application/json',
                data: JSON.stringify({}),
                success: () => {
                    resetDownloadUIForNewAnalysis();
                    $('#resolutionDiv').hide();
                    $('#workersDiv').hide();
                    loadJobs();
                    showToast('All downloads deleted', 'success');
                },
                error: (xhr) => {
                    showToast(buildErrorMessage('Cleanup failed', xhr), 'danger');
                },
                complete: () => {
                    $('#deleteAllBtn').prop('disabled', false);
                }
            });
        }
    });

    $('#pauseBtn').click(() => {
        pauseCurrentDownload();
    });

    $('#resumeBtn').click(() => {
        resumeCurrentDownload();
    });
});
