import requests
import m3u8
import os
import logging
import time
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from urllib.parse import urljoin


logger = logging.getLogger("vdnldr.downloader")


def infer_resolution_from_variant(variant_uri, bandwidth):
    """Infer likely resolution from variant URI/profile name and bandwidth."""
    uri_lower = (variant_uri or "").lower()

    # Profile hints commonly used in CDN paths.
    if "/hd/" in uri_lower:
        return "1920x1080", "HD"
    if "/md/" in uri_lower:
        return "1280x720", "MD"
    if "/sd/" in uri_lower:
        return "854x480", "SD"
    if "/ld/" in uri_lower and "/lld/" not in uri_lower:
        return "640x360", "LD"
    if "/lld/" in uri_lower:
        return "426x240", "LLD"

    # Bandwidth fallback when profile is not present.
    if bandwidth >= 4500000:
        return "1920x1080", "HD"
    if bandwidth >= 2500000:
        return "1280x720", "MD"
    if bandwidth >= 1100000:
        return "854x480", "SD"
    if bandwidth >= 700000:
        return "640x360", "LD"
    if bandwidth > 0:
        return "426x240", "LLD"

    return "Unknown", "Unknown"


def parse_master(url):
    """
    Parse master M3U8 file and return list of variants with resolution and bandwidth.
    Handles both master playlists and direct media playlists.
    
    Returns:
        list: List of dicts with 'resolution', 'bandwidth', 'uri'
              Empty list if it's a direct media playlist (will be handled by parse_media)
    """
    try:
        logger.info("parse_master called: url=%s", url)
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        playlist = m3u8.loads(response.text, uri=url)
        
        # If it's a direct media playlist (not a master), return empty list
        # The caller will treat the original URL as the media playlist
        if not playlist.is_variant and playlist.segments:
            logger.info("parse_master detected direct media playlist: url=%s", url)
            return []
        
        # Parse variant playlists (master playlist)
        variants = []
        if hasattr(playlist, 'playlists') and playlist.playlists:
            for playlist_item in playlist.playlists:
                bandwidth = playlist_item.stream_info.bandwidth or 0
                playlist_uri = urljoin(url, playlist_item.uri)

                # Extract resolution if available in manifest.
                if playlist_item.stream_info.resolution:
                    res = playlist_item.stream_info.resolution
                    resolution = f"{res[0]}x{res[1]}"
                    quality = "Original"
                else:
                    resolution, quality = infer_resolution_from_variant(playlist_uri, bandwidth)
                
                variants.append({
                    "resolution": resolution,
                    "quality": quality,
                    "bandwidth": bandwidth,
                    "uri": playlist_uri
                })
            
            return sorted(variants, key=lambda x: x['bandwidth'], reverse=True)
        
        # No variants found
        return []
    except Exception as e:
        logger.exception("parse_master failed: url=%s", url)
        raise Exception(f"Error parsing master M3U8: {str(e)}")


def parse_media(url):
    """
    Parse media M3U8 file and return list of absolute segment URIs.
    
    Returns:
        list: List of absolute segment URIs
    """
    try:
        logger.info("parse_media called: url=%s", url)
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        playlist = m3u8.loads(response.text, uri=url)
        
        segments = []
        for segment in playlist.segments:
            segment_uri = urljoin(url, segment.uri)
            segments.append(segment_uri)

        logger.info("parse_media success: url=%s segments=%s", url, len(segments))
        
        return segments
    except Exception as e:
        logger.exception("parse_media failed: url=%s", url)
        raise Exception(f"Error parsing media M3U8: {str(e)}")


def download_segment(index, uri, dest_dir, status_dict, job_id="-"):
    """
    Download a single .ts segment file.
    
    Args:
        index: Segment index
        uri: Segment URI
        dest_dir: Destination directory
        status_dict: Shared dict to update status {index: 'done'|'failed'}
    """
    try:
        status_dict[index] = 'downloading'
        response = requests.get(uri, timeout=30)
        response.raise_for_status()
        
        filename = os.path.join(dest_dir, f"segment_{index:04d}.ts")
        with open(filename, 'wb') as f:
            f.write(response.content)
        
        status_dict[index] = 'done'
        logger.info("segment downloaded: index=%s uri=%s", index, uri, extra={"job_id": job_id})
    except Exception as e:
        status_dict[index] = 'failed'
        logger.exception("segment download failed: index=%s uri=%s", index, uri, extra={"job_id": job_id})


def start_download_job(job, workers, pause_event=None):
    """
    Orchestrate download job using ThreadPoolExecutor.
    
    Args:
        job: Job dict with 'segments', 'dest_dir', 'status'
        workers: Number of worker threads
    """
    segments = job['segments']
    dest_dir = job['dest_dir']
    status_dict = job['status']
    job_id = job.get('id')

    logger.info(
        "download job started: job_id=%s workers=%s segments=%s",
        job_id,
        workers,
        len(segments),
        extra={"job_id": job_id}
    )
    
    os.makedirs(dest_dir, exist_ok=True)
    
    with ThreadPoolExecutor(max_workers=workers) as executor:
        in_flight = {}
        next_index = 0

        while next_index < len(segments) or in_flight:
            # Dispatch new downloads only while not paused.
            while next_index < len(segments) and len(in_flight) < workers:
                if pause_event is not None and not pause_event.is_set():
                    break

                # Respect terminal states from retries/manual updates.
                if status_dict.get(next_index) == 'done':
                    next_index += 1
                    continue

                if status_dict.get(next_index) != 'failed':
                    status_dict[next_index] = 'pending'

                uri = segments[next_index]
                future = executor.submit(download_segment, next_index, uri, dest_dir, status_dict, job_id)
                in_flight[future] = next_index
                next_index += 1

            if in_flight:
                done_futures, _ = wait(in_flight.keys(), timeout=0.2, return_when=FIRST_COMPLETED)
                for future in done_futures:
                    in_flight.pop(future, None)
                    try:
                        future.result()
                    except Exception:
                        pass
            else:
                time.sleep(0.2)

    done_count = sum(1 for state in status_dict.values() if state == 'done')
    failed_count = sum(1 for state in status_dict.values() if state == 'failed')
    logger.info(
        "download job finished: job_id=%s done=%s failed=%s total=%s",
        job_id,
        done_count,
        failed_count,
        len(segments),
        extra={"job_id": job_id}
    )


def retry_segment(index, job, status_dict):
    """
    Re-download a single segment.
    
    Args:
        index: Segment index
        job: Job dict with segments and dest_dir
        status_dict: Shared status dict
    """
    try:
        uri = job['segments'][index]
        dest_dir = job['dest_dir']
        job_id = job.get('id', '-')
        status_dict[index] = 'downloading'
        logger.info("retry started: job_id=%s index=%s uri=%s", job_id, index, uri, extra={"job_id": job_id})
        download_segment(index, uri, dest_dir, status_dict, job_id)
        logger.info("retry finished: job_id=%s index=%s status=%s", job_id, index, status_dict.get(index), extra={"job_id": job_id})
    except Exception as e:
        status_dict[index] = 'failed'
        logger.exception("retry failed: job_id=%s index=%s", job.get('id'), index, extra={"job_id": job.get('id', '-')})
