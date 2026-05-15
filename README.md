# VDNLDR – Online Video Downloader

A Flask-based web application for downloading M3U8 HLS video streams and converting them to MP4 files.

## Features

✅ **M3U8 Stream Analysis** – Parse M3U8 playlists and list available quality variants  
✅ **Concurrent Segment Downloads** – Configurable worker threads (1–20) for fast downloading  
✅ **Real-time Progress Tracking** – Server-Sent Events (SSE) stream segment status updates  
✅ **Visual Segment Status** – Color-coded boxes show download progress:
  - 🟩 Green = Downloaded  
  - 🟨 Yellow = Downloading  
  - 🔴 Red = Failed (click to retry)  
  - ⬜ Gray = Pending  

✅ **Manual Retry** – Click failed segments to retry unlimited times  
✅ **Partial MP4 Conversion** – Convert green segments to MP4 even if download is incomplete  
✅ **Automatic FFmpeg Detection** – Toast notification if FFmpeg is not installed  
✅ **Recent Downloads Tracking** – Last 2 converted MP4s with download links  
✅ **Cleanup & Reset** – Delete all downloads and reset state with one button  
✅ **Compact Bootstrap 5 UI** – Responsive, clean design with toast notifications  

---

## Project Structure

```
vdnldr/
├── server.py                    # Flask backend (all API routes)
├── downloader.py                # M3U8 parsing + concurrent segment downloader
├── converter.py                 # FFmpeg MP4 conversion
├── app_config.json              # Configuration (port, workers, defaults)
├── templates/
│   └── frontend.html            # Bootstrap 5 SPA
├── static/
│   └── application/
│       └── app.js               # jQuery frontend logic
├── .venv/                       # Python virtual environment
├── downloads/                   # MP4 output + temp segments (auto-created)
└── state.json                   # Runtime job state (auto-created)
```

---

## Installation

### Prerequisites

- **Python 3.7+**
- **FFmpeg** (for MP4 conversion; install separately if not found)

### Step 1: Create Virtual Environment

```bash
python -m venv .venv
.venv\Scripts\activate  # Windows
source .venv/bin/activate  # macOS/Linux
```

### Step 2: Install Dependencies

```bash
pip install flask flask-cors m3u8 requests
```

### Step 3: Install FFmpeg (Optional but Recommended)

#### Windows
```bash
# Using Chocolatey
choco install ffmpeg

# Or download from: https://ffmpeg.org/download.html
```

#### macOS
```bash
brew install ffmpeg
```

#### Linux (Ubuntu/Debian)
```bash
sudo apt-get install ffmpeg
```

---

## Running the Application

```bash
python server.py
```

Then open your browser to: **http://localhost:8020**

The server will warn if FFmpeg is not found – conversion will fail until FFmpeg is installed.

---

## Usage

### 1. **Analyse** a Stream
   - Paste an M3U8 URL in the input field
   - Click **Analyse** button
   - Dropdown populates with available quality variants

### 2. **Configure Download**
   - Select quality from dropdown
   - Set **Workers** (number of parallel downloads, 1–20)
   - Click **Start Download**

### 3. **Monitor Progress**
   - Segment boxes display real-time download status
   - Counter shows `X / Y segments downloaded`
   - Click red boxes to retry failed segments

### 4. **Convert to MP4**
   - Click **Convert & Download** button
   - Only green (downloaded) segments are joined
   - Download link appears; click to save MP4

### 5. **Download Full Video** (Optional)
   - If all segments are green, **Download Full Video** button appears
   - Click to download the complete MP4

### 6. **Cleanup**
   - Click **Delete All Downloads** to remove all MP4s and temp files
   - Resets the app state

---

## Configuration (`app_config.json`)

```json
{
  "port": 8020,
  "default_workers": 5,
  "max_workers": 20,
  "min_workers": 1,
  "temp_dir": "downloads",
  "max_recent_downloads": 2,
  "segment_timeout": 30,
  "ffmpeg_check_on_startup": true
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `port` | 8020 | HTTP server port |
| `default_workers` | 5 | Default parallel download threads |
| `max_workers` | 20 | Maximum allowed workers |
| `min_workers` | 1 | Minimum allowed workers |
| `temp_dir` | `downloads` | Folder for MP4s and temp segments |
| `max_recent_downloads` | 2 | Number of recent downloads to track |
| `segment_timeout` | 30 | Segment download timeout (seconds) |
| `ffmpeg_check_on_startup` | true | Check for FFmpeg at startup |

---

## API Routes

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Serve frontend |
| `POST` | `/analyze` | Parse M3U8, return quality variants |
| `POST` | `/start` | Start download job |
| `GET` | `/progress` | SSE stream for segment status |
| `POST` | `/retry` | Retry a failed segment |
| `POST` | `/convert` | Convert segments to MP4 |
| `GET` | `/downloads/<filename>` | Download converted MP4 |
| `GET` | `/jobs` | Get current job + recent downloads |
| `POST` | `/cleanup` | Delete all downloads & reset state |

---

## Troubleshooting

### FFmpeg Not Found
**Problem:** "FFmpeg not found" toast on page load or convert attempt  
**Solution:**  
- Install FFmpeg from https://ffmpeg.org/download.html  
- Ensure `ffmpeg` is in system PATH  
- Restart server after installation  

### Download Fails for All Segments
**Problem:** All segments show red after starting download  
**Solution:**  
- Verify M3U8 URL is publicly accessible  
- Check internet connection  
- Try a different M3U8 URL (some streams may have geo-restrictions)  
- Increase `segment_timeout` in `app_config.json`  

### Server Won't Start
**Problem:** Port 8020 already in use  
**Solution:** Change `"port"` in `app_config.json` to an available port (e.g., 8021, 8080)

### No Recent Downloads Show Up
**Problem:** "Recent Downloads" section is empty  
**Solution:**  
- Complete at least one conversion to MP4  
- Check `state.json` to ensure recent_downloads array is populated  

---

## Notes

- **One Active Job:** Only one download job can run at a time  
- **No Resume:** Downloads cannot resume across server restarts  
- **Temp Files:** Segment files are kept in `downloads/<job_id>/` folder  
- **State Persistence:** Job state is saved to `state.json` but lost on server restart  
- **No Authentication:** This is a local/private tool with no auth/sessions  

---

## Example M3U8 URLs for Testing

- Apple HLS test streams: https://devstreaming-cdn.apple.com/videos/streaming/examples/img-click-to-unmute/master.m3u8
- Big Buck Bunny: https://test-streams.mux.dev/x36xhzz/x3ksqt.m3u8

---

## License

MIT

---

## Support

For issues, feature requests, or contributions, please check the code comments in:
- `server.py` – Flask backend logic
- `downloader.py` – M3U8 parsing and segment downloading
- `converter.py` – FFmpeg MP4 conversion
- `static/application/app.js` – Frontend UI and SSE handling
