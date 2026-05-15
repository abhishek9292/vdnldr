import subprocess
import os
import json
import logging


logger = logging.getLogger("vdnldr.converter")


def build_concat_list(job, status_dict):
    """
    Create FFmpeg concat file with only 'done' segments.
    
    Args:
        job: Job dict with 'dest_dir'
        status_dict: Status dict with segment states
    
    Returns:
        str: Path to concat file
    """
    concat_file = os.path.join(job['dest_dir'], 'concat.txt')
    included = 0
    
    with open(concat_file, 'w') as f:
        for index in sorted(status_dict.keys()):
            if status_dict[index] == 'done':
                segment_path = os.path.join(job['dest_dir'], f"segment_{index:04d}.ts")
                f.write(f"file '{os.path.abspath(segment_path)}'\n")
                included += 1

    logger.info(
        "concat list built: job_id=%s included_segments=%s concat_file=%s",
        job.get('id'),
        included,
        concat_file,
        extra={"job_id": job.get('id', '-')}
    )
    
    return concat_file


def convert_to_mp4(job_id, concat_file, output_path, ffmpeg_path=None):
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
        
        output_filename = f"{job_id}.mp4"
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
