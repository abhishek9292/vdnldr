# VDNLDR Quick Start Guide

## 🚀 Start the Application

```bash
cd c:\Users\abhis\Desktop\img\vdnldr
.venv\Scripts\activate
python server.py
```

Then open: **http://localhost:8020**

---

## ✅ Current Status

✓ All files created and organized  
✓ Flask backend running on port 8020  
✓ Frontend UI loaded with Bootstrap 5 + jQuery  
✓ Virtual environment set up with all dependencies  
✓ Directory structure: `templates/`, `static/application/`, `downloads/`  

---

## ⚠️ Important: FFmpeg Installation

**FFmpeg is required for MP4 conversion but is NOT yet installed.**

### Install FFmpeg:

**Windows (Chocolatey):**
```bash
choco install ffmpeg
```

**Windows (Manual):**
- Download from: https://ffmpeg.org/download.html
- Extract to a folder  
- Add to PATH or place in project folder

**macOS:**
```bash
brew install ffmpeg
```

**Linux:**
```bash
sudo apt-get install ffmpeg
```

After installation, restart the Flask server. The warning will disappear.

---

## 📋 Project Files

| File | Purpose |
|------|---------|
| `server.py` | Flask backend – all routes & job management |
| `downloader.py` | M3U8 parsing + concurrent segment downloader |
| `converter.py` | FFmpeg MP4 conversion logic |
| `app_config.json` | Configuration (workers, port, timeouts) |
| `templates/frontend.html` | Bootstrap 5 web UI (Jinja2 template) |
| `static/application/app.js` | jQuery frontend logic (SSE, AJAX) |
| `README.md` | Full documentation |

---

## 🧪 Test the Application

### Using Test M3U8 URLs:

1. **Apple Test Stream:**
   ```
   https://devstreaming-cdn.apple.com/videos/streaming/examples/img-click-to-unmute/master.m3u8
   ```

2. **Big Buck Bunny:**
   ```
   https://test-streams.mux.dev/x36xhzz/x3ksqt.m3u8
   ```

### Steps:

1. Paste URL in "M3U8 URL" field
2. Click **Analyse**
3. Select a quality variant
4. Set workers (e.g., 5)
5. Click **Start Download**
6. Watch segments download (green boxes)
7. Click **Convert & Download**
8. Download the MP4 file

---

## 🔧 Configuration

Edit `app_config.json` to change:
- **port** – Server port (default: 8020)
- **default_workers** – Default parallel downloads (default: 5)
- **max_workers** – Maximum allowed (default: 20)
- **segment_timeout** – Timeout per segment (default: 30s)

---

## 📝 Next Steps

1. ✅ Install FFmpeg
2. ✅ Test with a public M3U8 URL
3. ✅ Adjust workers for optimal speed
4. ✅ Monitor segment downloads in real-time

---

## 💡 Features Overview

| Feature | Details |
|---------|---------|
| **M3U8 Analysis** | Detects quality variants and bandwidth |
| **Concurrent Downloads** | 1–20 parallel workers for speed |
| **Live Progress** | SSE stream updates segment status |
| **Visual Feedback** | Color-coded boxes (Green/Yellow/Red/Gray) |
| **Failed Retry** | Click red boxes to retry unlimited times |
| **Partial Conversion** | Convert only downloaded segments |
| **Download Tracking** | Last 2 MP4s with timestamps |
| **One-Click Cleanup** | Delete all downloads & reset state |

---

## 🛠️ Troubleshooting

**"FFmpeg not found" warning:**
- Install FFmpeg (see above)
- Restart server

**Download fails for all segments:**
- Check internet connection
- Verify M3U8 URL is accessible
- Try a different stream

**Port already in use:**
- Edit `app_config.json`, change `"port"` to 8021 or similar

---

## 📂 Directory Structure Created

```
vdnldr/
├── .venv/                   # Virtual environment
├── templates/
│   └── frontend.html        # Flask Jinja2 template
├── static/
│   └── application/
│       └── app.js           # Frontend JavaScript
├── downloads/               # Auto-created (MP4s + temp segments)
├── server.py
├── downloader.py
├── converter.py
├── app_config.json
├── state.json               # Auto-created (runtime state)
└── README.md
```

---

**Ready to go! 🎬**
