import subprocess
import os
import json
import logging
import re
from pathlib import Path


logger = logging.getLogger("vdnldr.converter")


def _resolve_ffprobe_path(ffmpeg_path):
    """Resolve ffprobe executable from configured ffmpeg path, if possible."""
    if not ffmpeg_path:
        return 'ffprobe'

    ffmpeg_file = Path(ffmpeg_path)
    sibling = ffmpeg_file.with_name('ffprobe.exe' if os.name == 'nt' else 'ffprobe')
    if sibling.exists():
        return str(sibling)
    return 'ffprobe'


def _probe_video_codec(output_file, ffmpeg_path, job_id):
    """Return first video codec in output file, or None when probe is unavailable."""
    ffprobe_path = _resolve_ffprobe_path(ffmpeg_path)
    probe_cmd = [
        ffprobe_path,
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name',
        '-of', 'json',
        output_file
    ]

    try:
        probe = subprocess.run(probe_cmd, capture_output=True, text=True, timeout=30)
        if probe.returncode != 0:
            logger.warning(
                "ffprobe unavailable/failed: job_id=%s stderr=%s",
                job_id,
                (probe.stderr or '').strip(),
                extra={"job_id": job_id}
            )
            return None

        payload = json.loads(probe.stdout or '{}')
        streams = payload.get('streams') or []
        if not streams:
            return None
        return streams[0].get('codec_name')
    except Exception:
        logger.exception("ffprobe codec probe failed: job_id=%s", job_id, extra={"job_id": job_id})
        return None


def sanitize_output_basename(name):
    """Normalize a user-provided filename to a safe Windows-compatible basename."""
    if not name:
        return None

    base = name.strip()
    if not base:
        return None

    if base.lower().endswith('.mp4'):
        base = base[:-4]

    base = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', '_', base)
    base = re.sub(r'\s+', ' ', base).strip(' .')

    if not base:
        return None

    return base[:120]


def build_concat_list(job, status_dict):
    """
    Create FFmpeg concat file with only 'done' segments.
    
    Args:
        job: Job dict with 'dest_dir'
        status_dict: Status dict with segment states
    
    Returns:
        tuple[str, dict]: concat file path and coverage metadata
    """
    concat_file = os.path.join(job['dest_dir'], 'concat.txt')
    included = 0
    normalized_status = {}
    for raw_index, value in status_dict.items():
        try:
            normalized_status[int(raw_index)] = value
        except (TypeError, ValueError):
            continue

    total = len(normalized_status)

    # Only include a contiguous prefix (0..N) of finished segments.
    # Sparse/holed lists can produce structurally valid but unplayable MP4 output.
    contiguous_indexes = []
    for index in sorted(normalized_status.keys()):
        if normalized_status.get(index) == 'done':
            contiguous_indexes.append(index)
            continue
        break
    
    with open(concat_file, 'w') as f:
        for index in contiguous_indexes:
            segment_path = os.path.join(job['dest_dir'], f"segment_{index:04d}.ts")
            if not os.path.exists(segment_path):
                break
            f.write(f"file '{os.path.abspath(segment_path)}'\n")
            included += 1

    coverage = {
        'included_segments': included,
        'total_segments': total,
        'contiguous_until': included - 1,
        'is_partial': included < total
    }

    logger.info(
        "concat list built: job_id=%s included_segments=%s total_segments=%s contiguous_until=%s concat_file=%s",
        job.get('id'),
        included,
        total,
        coverage['contiguous_until'],
        concat_file,
        extra={"job_id": job.get('id', '-')}
    )

    return concat_file, coverage


def convert_to_mp4(job_id, concat_file, output_path, ffmpeg_path=None, output_name=None):
    """
    Convert concatenated .ts segments to MP4 using FFmpeg.
    
    Args:
        job_id: Job ID (for filename)
        concat_file: Path to concat file
        output_path: Directory for output MP4
        ffmpeg_path: Explicit path to ffmpeg binary (optional)
    
    Returns:
        dict: {'success': bool, 'filename': str, 'error': str}
    """
    try:
        logger.info("convert_to_mp4 started: job_id=%s concat_file=%s", job_id, concat_file, extra={"job_id": job_id})
        # Determine which ffmpeg to use
        if not ffmpeg_path:
            # Try to load from config
            try:
                with open('app_config.json', 'r') as f:
                    config = json.load(f)
                    ffmpeg_path = config.get('ffmpeg_path')
            except:
                pass
        
        # Fallback to system ffmpeg if explicit path not found
        if not ffmpeg_path or not os.path.exists(ffmpeg_path):
            ffmpeg_path = 'ffmpeg'

        logger.info("ffmpeg selected: job_id=%s ffmpeg_path=%s", job_id, ffmpeg_path, extra={"job_id": job_id})
        
        preferred_name = sanitize_output_basename(output_name)
        output_filename = f"{preferred_name}.mp4" if preferred_name else f"{job_id}.mp4"
        output_file = os.path.join(output_path, output_filename)

        # Avoid clobbering an existing file from another tab/job with same custom name.
        if os.path.exists(output_file):
            output_filename = f"{preferred_name or job_id}_{job_id}.mp4"
            output_file = os.path.join(output_path, output_filename)
        
        cmd = [
            ffmpeg_path,
            '-f', 'concat',
            '-safe', '0',
            '-i', concat_file,
            '-c', 'copy',
            '-y',
            output_file
        ]
        
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=600
        )
        
        if result.returncode == 0 and os.path.exists(output_file):
            codec_name = _probe_video_codec(output_file, ffmpeg_path, job_id)
            supported_for_mp4 = {'h264', 'hevc', 'av1', 'mpeg4'}

            # Fallback for uncommon codecs (e.g., png) that many players reject in MP4.
            if codec_name and codec_name.lower() not in supported_for_mp4:
                logger.warning(
                    "copy output codec not player-friendly: job_id=%s codec=%s; retrying with transcode",
                    job_id,
                    codec_name,
                    extra={"job_id": job_id}
                )
                transcode_cmd = [
                    ffmpeg_path,
                    '-f', 'concat',
                    '-safe', '0',
                    '-i', concat_file,
                    '-map', '0:v:0?',
                    '-map', '0:a:0?',
                    '-c:v', 'libx264',
                    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
                    '-pix_fmt', 'yuv420p',
                    '-c:a', 'aac',
                    '-b:a', '128k',
                    '-movflags', '+faststart',
                    '-y',
                    output_file
                ]
                transcode_result = subprocess.run(
                    transcode_cmd,
                    capture_output=True,
                    text=True,
                    timeout=1800
                )
                if transcode_result.returncode != 0:
                    if os.path.exists(output_file):
                        try:
                            os.remove(output_file)
                        except OSError:
                            pass

                    stderr_text = (transcode_result.stderr or '').strip()
                    user_hint = (
                        'The selected stream appears to be unsupported, protected, or not standard HLS video segments. '
                        'Try another source/quality, or resume further before converting.'
                    )

                    logger.error(
                        "fallback transcode failed: job_id=%s returncode=%s stderr=%s",
                        job_id,
                        transcode_result.returncode,
                        stderr_text,
                        extra={"job_id": job_id}
                    )
                    return {
                        'success': False,
                        'filename': None,
                        'error': f"{user_hint}\n\n{stderr_text}" if stderr_text else user_hint
                    }

            logger.info("convert_to_mp4 success: job_id=%s output_file=%s", job_id, output_file, extra={"job_id": job_id})
            return {
                'success': True,
                'filename': output_filename,
                'error': None
            }
        else:
            logger.error(
                "convert_to_mp4 failed: job_id=%s returncode=%s stderr=%s",
                job_id,
                result.returncode,
                (result.stderr or '').strip(),
                extra={"job_id": job_id}
            )
            return {
                'success': False,
                'filename': None,
                'error': result.stderr or 'Unknown FFmpeg error'
            }
    except subprocess.TimeoutExpired:
        logger.exception("convert_to_mp4 timeout: job_id=%s", job_id, extra={"job_id": job_id})
        return {
            'success': False,
            'filename': None,
            'error': 'FFmpeg conversion timeout'
        }
    except Exception as e:
        logger.exception("convert_to_mp4 exception: job_id=%s", job_id, extra={"job_id": job_id})
        return {
            'success': False,
            'filename': None,
            'error': str(e)
        }
