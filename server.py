import os
import json
import shutil
import uuid
import threading
import logging
from datetime import datetime
from flask import Flask, render_template, request, jsonify, send_file, Response, g, has_request_context
from concurrent.futures import ThreadPoolExecutor
import downloader
import converter


app = Flask(__name__)
config = {}
state = {'jobs': {}, 'recent_downloads': []}
jobs_lock = threading.Lock()
executor = ThreadPoolExecutor(max_workers=10)
logger = logging.getLogger("vdnldr.server")
job_controls = {}
job_futures = {}


class LevelLowerFilter(logging.Filter):
    def filter(self, record):
        record.level_lower = record.levelname.lower()
        return True


class CorrelationFilter(logging.Filter):
    def filter(self, record):
        if not hasattr(record, "request_id"):
            if has_request_context() and hasattr(g, "request_id"):
                record.request_id = g.request_id
            else:
                record.request_id = "-"
        if not hasattr(record, "job_id"):
            record.job_id = "-"
        return True


def setup_logging():
    logs_dir = "logs"
    os.makedirs(logs_dir, exist_ok=True)

    log_file = os.path.join(logs_dir, f"vdnldr_{datetime.now().strftime('%Y-%m-%d')}.log")

    root_logger = logging.getLogger()
    root_logger.handlers = []
    root_logger.setLevel(logging.INFO)

    formatter = logging.Formatter(
        fmt="%(asctime)s | %(level_lower)s | req=%(request_id)s | job=%(job_id)s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S"
    )

    file_handler = logging.FileHandler(log_file, encoding="utf-8")
    file_handler.setLevel(logging.INFO)
    file_handler.setFormatter(formatter)
    file_handler.addFilter(LevelLowerFilter())
    file_handler.addFilter(CorrelationFilter())

    root_logger.addHandler(file_handler)

    werkzeug_logger = logging.getLogger("werkzeug")
    werkzeug_logger.handlers = []
    werkzeug_logger.propagate = False
    werkzeug_logger.disabled = True

    logger.info("Logging initialized. file=%s", os.path.abspath(log_file))


def load_config():
    global config
    with open('app_config.json', 'r') as f:
        config = json.load(f)
    logger.info("Configuration loaded from app_config.json")


def load_state():
    global state
    if not os.path.exists('state.json'):
        return

    try:
        with open('state.json', 'r') as f:
            loaded = json.load(f)

        # Migration support: old schema with current_job
        if 'jobs' not in loaded:
            jobs = {}
            current_job = loaded.get('current_job')
            if current_job and isinstance(current_job, dict) and current_job.get('id'):
                jobs[current_job['id']] = current_job
            loaded = {
                'jobs': jobs,
                'recent_downloads': loaded.get('recent_downloads', [])
            }

        state = {
            'jobs': loaded.get('jobs', {}),
            'recent_downloads': loaded.get('recent_downloads', [])
        }
        logger.info("State loaded from state.json")
    except Exception:
        logger.exception("Failed to load state.json. Using default state")
        state = {'jobs': {}, 'recent_downloads': []}


def save_state():
    with open('state.json', 'w') as f:
        json.dump(state, f, indent=2)
    logger.info("State saved to state.json")


def check_ffmpeg():
    ffmpeg_path = config.get('ffmpeg_path')
    if ffmpeg_path and os.path.exists(ffmpeg_path):
        return True
    return shutil.which('ffmpeg') is not None


def init_downloads_dir():
    temp_dir = config['temp_dir']
    os.makedirs(temp_dir, exist_ok=True)
    logger.info("Downloads directory initialized: %s", os.path.abspath(temp_dir))


def recover_incomplete_jobs():
    """Recreate controls and resume non-paused unfinished jobs after process restart."""
    with jobs_lock:
        jobs = dict(state.get('jobs', {}))

    recovered = 0
    for job_id, job in jobs.items():
        status = job.get('status', {})
        workers = int(job.get('workers', config.get('default_workers', 5)))
        workers = max(config['min_workers'], min(workers, config['max_workers']))

        # Ensure job directory exists before trying to continue.
        os.makedirs(job.get('dest_dir', os.path.join(config['temp_dir'], job_id)), exist_ok=True)

        pause_event = threading.Event()
        if job.get('paused'):
            pause_event.clear()
        else:
            pause_event.set()

        with jobs_lock:
            job_controls[job_id] = {'pause_event': pause_event}

        pending_count = sum(1 for s in status.values() if s != 'done')
        if pending_count == 0:
            continue

        # Paused jobs are restored but not auto-submitted until resume is requested.
        if job.get('paused'):
            logger.info(
                "Recovered paused job: job_id=%s remaining=%s",
                job_id,
                pending_count,
                extra={"job_id": job_id}
            )
            continue

        with jobs_lock:
            existing_future = job_futures.get(job_id)
            if existing_future and not existing_future.done():
                continue
            job_futures[job_id] = executor.submit(downloader.start_download_job, job, workers, pause_event)

        recovered += 1
        logger.info(
            "Recovered running job: job_id=%s remaining=%s workers=%s",
            job_id,
            pending_count,
            workers,
            extra={"job_id": job_id}
        )

    logger.info("Job recovery completed: resumed_jobs=%s", recovered)


def get_job_or_error(job_id):
    if not job_id:
        return None, jsonify({'error': 'job_id is required'}), 400

    with jobs_lock:
        job = state.get('jobs', {}).get(job_id)

    if not job:
        return None, jsonify({'error': 'Job not found'}), 404

    return job, None, None


@app.before_request
def assign_request_id():
    incoming_request_id = (request.headers.get("X-Request-ID") or "").strip()
    g.request_id = incoming_request_id or str(uuid.uuid4())[:12]


@app.after_request
def add_request_id_header(response):
    response.headers["X-Request-ID"] = getattr(g, "request_id", "-")
    return response


@app.route('/')
def index():
    logger.info("Route / requested")
    return render_template('frontend.html')


@app.route('/analyze', methods=['POST'])
def analyze():
    try:
        data = request.get_json() or {}
        url = data.get('url', '').strip()

        if not url:
            logger.error("Analyze failed: URL required")
            return jsonify({'error': 'URL required'}), 400

        logger.info("Analyze requested for url=%s", url)

        variants = downloader.parse_master(url)

        if not variants:
            try:
                segments = downloader.parse_media(url)
                if segments:
                    variants = [{
                        "resolution": "Direct Stream",
                        "quality": "Direct",
                        "bandwidth": 0,
                        "uri": url
                    }]
                    logger.info("Analyze result: direct media playlist detected, segments=%s", len(segments))
                else:
                    logger.error("Analyze failed: no video segments found for url=%s", url)
                    return jsonify({'error': 'No video segments found in URL'}), 400
            except Exception as e:
                logger.exception("Analyze failed while parsing media playlist for url=%s", url)
                return jsonify({'error': f'Failed to parse M3U8: {str(e)}'}), 400

        logger.info("Analyze success: variants=%s for url=%s", len(variants), url)
        return jsonify({'variants': variants})
    except Exception as e:
        logger.exception("Analyze route exception")
        return jsonify({'error': str(e)}), 400


@app.route('/start', methods=['POST'])
def start_download():
    try:
        data = request.get_json() or {}
        url = data.get('url', '').strip()
        quality_uri = data.get('quality_uri', '').strip()
        workers = int(data.get('workers', config['default_workers']))

        if not url or not quality_uri:
            logger.error("Start failed: URL and quality required")
            return jsonify({'error': 'URL and quality required'}), 400

        workers = max(config['min_workers'], min(workers, config['max_workers']))

        segments = downloader.parse_media(quality_uri)
        if not segments:
            logger.error("Start failed: no segments found for quality_uri=%s", quality_uri)
            return jsonify({'error': 'No segments found'}), 400

        job_id = str(uuid.uuid4())[:8]
        job_dir = os.path.join(config['temp_dir'], job_id)
        os.makedirs(job_dir, exist_ok=True)

        job = {
            'id': job_id,
            'url': url,
            'quality_uri': quality_uri,
            'dest_dir': job_dir,
            'segments': segments,
            'status': {i: 'pending' for i in range(len(segments))},
            'created': datetime.now().isoformat(),
            'workers': workers,
            'paused': False
        }

        pause_event = threading.Event()
        pause_event.set()

        with jobs_lock:
            state.setdefault('jobs', {})[job_id] = job
            job_controls[job_id] = {'pause_event': pause_event}
        save_state()

        logger.info(
            "Download job created: job_id=%s workers=%s segments=%s quality_uri=%s",
            job_id,
            workers,
            len(segments),
            quality_uri,
            extra={"job_id": job_id}
        )

        with jobs_lock:
            job_futures[job_id] = executor.submit(downloader.start_download_job, job, workers, pause_event)
        logger.info("Download job submitted: job_id=%s", job_id, extra={"job_id": job_id})

        return jsonify({'job_id': job_id, 'total_segments': len(segments)})
    except Exception as e:
        logger.exception("Start route exception")
        return jsonify({'error': str(e)}), 400


@app.route('/progress')
def progress():
    job_id = request.args.get('job_id', '').strip()
    job, err_resp, err_code = get_job_or_error(job_id)
    if err_resp:
        return err_resp, err_code

    logger.info("Progress stream opened", extra={"job_id": job_id})

    def event_generator():
        import time
        last_update = None
        while True:
            with jobs_lock:
                current_job = state.get('jobs', {}).get(job_id)

            if current_job:
                current_status = current_job.get('status', {})
                serialized = json.dumps(current_status, sort_keys=True)
                if serialized != last_update:
                    done_count = sum(1 for s in current_status.values() if s == 'done')
                    total_count = len(current_status)
                    paused = bool(current_job.get('paused', False))
                    payload = {
                        'status': current_status,
                        'done': done_count,
                        'total': total_count,
                        'paused': paused
                    }
                    yield f"data: {json.dumps(payload)}\n\n"
                    last_update = serialized

            time.sleep(0.5)

    return Response(event_generator(), mimetype='text/event-stream')


@app.route('/retry', methods=['POST'])
def retry():
    try:
        data = request.get_json() or {}
        job_id = data.get('job_id', '').strip()
        index = int(data.get('index'))

        job, err_resp, err_code = get_job_or_error(job_id)
        if err_resp:
            logger.error("Retry failed: job not found job_id=%s", job_id)
            return err_resp, err_code

        logger.info("Retry requested: job_id=%s segment_index=%s", job_id, index, extra={"job_id": job_id})
        downloader.retry_segment(index, job, job['status'])
        logger.info("Retry dispatched: job_id=%s segment_index=%s", job_id, index, extra={"job_id": job_id})

        return jsonify({'success': True})
    except Exception as e:
        logger.exception("Retry route exception")
        return jsonify({'error': str(e)}), 400


@app.route('/pause', methods=['POST'])
def pause_download():
    try:
        data = request.get_json() or {}
        job_id = data.get('job_id', '').strip()

        job, err_resp, err_code = get_job_or_error(job_id)
        if err_resp:
            logger.error("Pause failed: job not found job_id=%s", job_id)
            return err_resp, err_code

        with jobs_lock:
            controls = job_controls.get(job_id)
            if not controls:
                logger.error("Pause failed: controls missing for job_id=%s", job_id)
                return jsonify({'error': 'Job controls not found'}), 400
            controls['pause_event'].clear()
            job['paused'] = True
        save_state()

        logger.info("Pause requested: job_id=%s", job_id, extra={"job_id": job_id})
        return jsonify({'success': True, 'paused': True})
    except Exception as e:
        logger.exception("Pause route exception")
        return jsonify({'error': str(e)}), 400


@app.route('/resume', methods=['POST'])
def resume_download():
    try:
        data = request.get_json() or {}
        job_id = data.get('job_id', '').strip()

        job, err_resp, err_code = get_job_or_error(job_id)
        if err_resp:
            logger.error("Resume failed: job not found job_id=%s", job_id)
            return err_resp, err_code

        with jobs_lock:
            controls = job_controls.get(job_id)
            if not controls:
                logger.error("Resume failed: controls missing for job_id=%s", job_id)
                return jsonify({'error': 'Job controls not found'}), 400
            controls['pause_event'].set()
            job['paused'] = False

            # If this job was restored as paused on startup, ensure worker is submitted on first resume.
            running_future = job_futures.get(job_id)
            if not running_future or running_future.done():
                workers = int(job.get('workers', config.get('default_workers', 5)))
                workers = max(config['min_workers'], min(workers, config['max_workers']))
                job_futures[job_id] = executor.submit(
                    downloader.start_download_job,
                    job,
                    workers,
                    controls['pause_event']
                )
                logger.info(
                    "Resume submitted job worker: job_id=%s workers=%s",
                    job_id,
                    workers,
                    extra={"job_id": job_id}
                )
        save_state()

        logger.info("Resume requested: job_id=%s", job_id, extra={"job_id": job_id})
        return jsonify({'success': True, 'paused': False})
    except Exception as e:
        logger.exception("Resume route exception")
        return jsonify({'error': str(e)}), 400


@app.route('/convert', methods=['POST'])
def convert():
    try:
        data = request.get_json() or {}
        job_id = data.get('job_id', '').strip()
        output_name = data.get('output_name', '').strip()

        if not check_ffmpeg():
            logger.error("Convert failed: FFmpeg not found")
            return jsonify({'error': 'FFmpeg not found. Please install FFmpeg.'}), 400

        job, err_resp, err_code = get_job_or_error(job_id)
        if err_resp:
            logger.error("Convert failed: job not found job_id=%s", job_id)
            return err_resp, err_code

        done_count = sum(1 for s in job.get('status', {}).values() if s == 'done')
        if done_count == 0:
            logger.error("Convert failed: no downloaded segments for job_id=%s", job_id, extra={"job_id": job_id})
            return jsonify({'error': 'No downloaded segments available to convert yet.'}), 400

        logger.info("Convert requested: job_id=%s", job_id, extra={"job_id": job_id})

        concat_file = converter.build_concat_list(job, job['status'])
        ffmpeg_path = config.get('ffmpeg_path')
        result = converter.convert_to_mp4(job_id, concat_file, config['temp_dir'], ffmpeg_path, output_name)

        if result['success']:
            with jobs_lock:
                recent = state.get('recent_downloads', [])
                recent.insert(0, {
                    'filename': result['filename'],
                    'job_id': job_id,
                    'timestamp': datetime.now().isoformat()
                })
                state['recent_downloads'] = recent[:config['max_recent_downloads']]
            save_state()
            logger.info("Convert success: job_id=%s filename=%s", job_id, result.get('filename'), extra={"job_id": job_id})
            return jsonify(result)

        logger.error("Convert failed: job_id=%s error=%s", job_id, result.get('error'), extra={"job_id": job_id})
        return jsonify(result), 400
    except Exception as e:
        logger.exception("Convert route exception")
        return jsonify({'error': str(e)}), 400


@app.route('/downloads/<filename>', methods=['GET', 'DELETE'])
def download_file(filename):
    try:
        file_path = os.path.join(config['temp_dir'], filename)

        if request.method == 'DELETE':
            if not os.path.exists(file_path):
                logger.error("Delete download failed: file not found filename=%s", filename)
                return jsonify({'error': 'File not found'}), 404

            os.remove(file_path)
            with jobs_lock:
                recent = state.get('recent_downloads', [])
                state['recent_downloads'] = [item for item in recent if item.get('filename') != filename]
            save_state()
            logger.info("Download file deleted: filename=%s", filename)
            return jsonify({'success': True, 'filename': filename})

        if os.path.exists(file_path):
            logger.info("Download file served: filename=%s", filename)
            return send_file(file_path, as_attachment=True)

        logger.error("Download failed: file not found filename=%s", filename)
        return jsonify({'error': 'File not found'}), 404
    except Exception as e:
        logger.exception("Download route exception for filename=%s", filename)
        return jsonify({'error': str(e)}), 400


@app.route('/jobs')
def get_jobs():
    logger.info("Jobs requested")
    with jobs_lock:
        return jsonify({
            'jobs': state.get('jobs', {}),
            'recent_downloads': state.get('recent_downloads', [])
        })


@app.route('/cleanup', methods=['POST'])
def cleanup():
    try:
        temp_dir = config['temp_dir']
        if os.path.exists(temp_dir):
            shutil.rmtree(temp_dir)
            os.makedirs(temp_dir, exist_ok=True)

        with jobs_lock:
            state['jobs'] = {}
            state['recent_downloads'] = []
            job_controls.clear()
        save_state()

        logger.info("Cleanup completed: downloads cleared and state reset")
        return jsonify({'success': True})
    except Exception as e:
        logger.exception("Cleanup route exception")
        return jsonify({'error': str(e)}), 400


if __name__ == '__main__':
    setup_logging()
    load_config()
    load_state()
    init_downloads_dir()
    recover_incomplete_jobs()

    if config['ffmpeg_check_on_startup'] and not check_ffmpeg():
        logger.error("FFmpeg not found. Conversion will not work.")
    else:
        logger.info("FFmpeg availability check passed")

    logger.info("VDNLDR server starting on port %s", config['port'])
    app.run(host='0.0.0.0', port=config['port'], debug=False)
