import subprocess
import os
import sys
import multiprocessing
import json
import time
import re
import argparse
import random 

try:
    import psutil
except ImportError:
    print('{"error": "psutil not found"}', file=sys.stdout)
    sys.exit(1)

# ================= CONFIGURATION =================
CORES_TO_SAVE = 2 

# PRO-TIP: Print all logs to STDERR so STDOUT stays pure JSON for React
def log(msg):
    print(msg, file=sys.stderr, flush=True)
# =================================================

def format_bytes(size):
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if size < 1024.0: return f"{size:.2f} {unit}"
        size /= 1024.0
    return f"{size:.2f} PB"

def analyze_sensor_and_motion(file_path, duration):
    log("[PYTHON] Running Deep Sensor & Spatial Analysis...")
    mid = str(max(0, duration * 0.3))
    cmd = ["ffmpeg", "-hide_banner", "-ss", mid, "-i", file_path, "-t", "1", "-vf", "signalstats", "-f", "null", "-"]
    try:
        res = subprocess.run(cmd, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        yvar_matches = re.findall(r'YVAR: ([\d.]+)', res.stderr)
        if yvar_matches:
            avg_yvar = sum(float(x) for x in yvar_matches) / len(yvar_matches)
            if avg_yvar > 1500: return 15, "High (Gritty Film)"
            elif avg_yvar > 600: return 10, "Medium (Standard Noise)"
            elif avg_yvar > 200: return 6, "Low (Modern Digital)"
            else: return 2, "Ultra-Clean (Animation/Screen)"
    except Exception as e:
        log(f"[PYTHON WARN] Sensor analysis failed: {e}")
    return 8, "Fallback (Standard)"

def smart_auto_crop(file_path, duration, width, height):
    log("[PYTHON] Running Multi-Point Cinematic Crop Detection...")
    timestamps = [duration * 0.2, duration * 0.5, duration * 0.8]
    crops_found = []
    for ts in timestamps:
        cmd = ["ffmpeg", "-hide_banner", "-ss", str(ts), "-i", file_path, "-t", "2", "-vf", "cropdetect=24:16:0", "-f", "null", "-"]
        res = subprocess.run(cmd, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        matches = re.findall(r'crop=\d+:\d+:\d+:\d+', res.stderr)
        if matches:
            c_w, c_h, c_x, c_y = map(int, matches[-1].replace('crop=', '').split(':'))
            if c_w < width - 16 or c_h < height - 16:
                crops_found.append(matches[-1])
    if crops_found:
        return max(set(crops_found), key=crops_found.count)
    return None

def extract_dna(file_path):
    if not os.path.exists(file_path):
        log(f"[CRITICAL] '{file_path}' not found.")
        sys.exit(1)

    log(f"[PYTHON] Extracting DNA from: {file_path}")
    cmd = ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", file_path]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='ignore')
        data = json.loads(res.stdout)
        
        v = next((s for s in data.get('streams', []) if s.get('codec_type') == 'video'), {})
        a = next((s for s in data.get('streams', []) if s.get('codec_type') == 'audio'), {})
        
        width = int(v.get('width', 0))
        height = int(v.get('height', 0))
        fps_raw = v.get('r_frame_rate', '30/1')
        fps = eval(fps_raw) if '/' in fps_raw else float(fps_raw)
        
        color_space = v.get('pix_fmt', 'unknown')
        color_transfer = v.get('color_transfer', 'unknown')
        bit_depth = 10 if '10' in color_space or 'p10' in color_space else 8
        is_hdr = color_transfer in ['smpte2084', 'arib-std-b67']
        
        a_codec = a.get('codec_name', 'none').lower()
        a_channels = a.get('channels', 0)
        
        size = int(data.get('format', {}).get('size', 0))
        duration = float(data.get('format', {}).get('duration', 0))
        bitrate = int(data.get('format', {}).get('bitrate', 0))
        if bitrate == 0 and duration > 0: bitrate = int((size * 8) / duration)
        bpp = bitrate / (width * height * fps) if (width * height * fps) > 0 else 0

        actual_crop = smart_auto_crop(file_path, duration, width, height)
        grain_level, noise_profile = analyze_sensor_and_motion(file_path, duration)

        return {
            "v_codec": v.get('codec_name', 'unknown').upper(), 
            "width": width, "height": height, "fps": fps, 
            "color_space": color_space, "bit_depth": bit_depth, "is_hdr": is_hdr,
            "a_codec": a_codec, "a_channels": a_channels,
            "size": size, "duration": duration, "bitrate": bitrate, "bpp": bpp,
            "crop": actual_crop, "total_frames": int(duration * fps),
            "grain_level": grain_level, "noise_profile": noise_profile
        }
    except Exception as e:
        log(f"[CRITICAL] DNA Extraction failed: {e}")
        sys.exit(1)


# ================= GUI API ENDPOINTS =================

def api_analyze(file_path, temp_dir):
    """
    Called by Electron when the user clicks 'Analyze'.
    Generates 4 Video Clips (1 Original, 3 Previews) in a safe temp dir and returns a JSON config.
    """
    dna = extract_dna(file_path)
    
    mid_point = int(dna['duration'] / 2)
    
    # Generate a unique ID so multiple simultaneous encodings never collide
    uid = random.randint(10000, 99999)
    
    PREVIEW_DURATION = "5" # 5 seconds of video for the loop
    
    vid_orig = os.path.join(temp_dir, f"vb_temp_orig_{uid}.mp4").replace("\\", "/")
    
    # 🔴 UPGRADED QUALITY TIERS
    if dna['width'] >= 3840: # 4K Footage
        crf_max, crf_bal, crf_fast = 28, 36, 44
    elif dna['width'] >= 1920: # 1080p Footage
        crf_max, crf_bal, crf_fast = 24, 32, 40
    else: # 720p or lower
        crf_max, crf_bal, crf_fast = 22, 28, 36

    presets = {
        "max": {
            "id": "max", 
            "title": "Max Quality (Slow)", 
            "preset": 4, 
            "crf": crf_max,
            "out": os.path.join(temp_dir, f"vb_temp_max_{uid}.webm").replace("\\", "/")
        },
        "balanced": {
            "id": "balanced", 
            "title": "Balanced (Medium)", 
            "preset": 6, 
            "crf": crf_bal,
            "out": os.path.join(temp_dir, f"vb_temp_bal_{uid}.webm").replace("\\", "/")
        },
        "fast": {
            "id": "fast", 
            "title": "Max Compression (Fast)", 
            "preset": 8,
            "crf": crf_fast,
            "out": os.path.join(temp_dir, f"vb_temp_fast_{uid}.webm").replace("\\", "/")
        }
    }

    # 1. Extract the Original Reference Video (Using ultrafast x264)
    log(f"[PYTHON] Extracting Original {PREVIEW_DURATION}s Video to {vid_orig}...")
    subprocess.run([
        "ffmpeg", "-y", "-ss", str(mid_point), "-i", file_path, "-t", PREVIEW_DURATION, 
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16", "-an", vid_orig
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # 🔴 AUDIO WEIGHT MATH
    # We estimate the audio track to be ~128kbps (16 KB/sec) to add back to our video estimates.
    audio_bytes_per_sec = 128000 / 8 
    total_audio_bytes = audio_bytes_per_sec * dna['duration']

    # 2. Benchmark the 3 Presets
    estimates = {}
    for key, p in presets.items():
        log(f"[PYTHON] Benchmarking Preset: {p['title']} (CRF {p['crf']})...")
        
        vf_arg = ["-vf", dna['crop']] if dna['crop'] else []
        
        # Encode 5 seconds of AV1 video directly to WebM
        cmd = [
            "ffmpeg", "-y", "-ss", str(mid_point), "-i", file_path, "-t", PREVIEW_DURATION
        ] + vf_arg + [
            "-c:v", "libsvtav1", "-preset", str(p['preset']), "-crf", str(p['crf']),
            "-svtav1-params", f"tune=0:film-grain={dna['grain_level']}", "-an", p['out']
        ]
        
        start_enc = time.time()
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        enc_time = time.time() - start_enc
        
        # 🔴 FIXED FILE SIZE MATH
        if os.path.exists(p['out']):
            test_size = os.path.getsize(p['out'])
            
            # Predict total video weight, then add predicted audio weight
            est_video_bytes = (test_size / float(PREVIEW_DURATION)) * dna['duration']
            est_total_size = est_video_bytes + total_audio_bytes
            
            est_mins = ((enc_time / float(PREVIEW_DURATION)) * dna['duration']) / 60
            
            estimates[key] = {
                "video_path": p['out'],
                "size_bytes": est_total_size,
                "size_formatted": format_bytes(est_total_size),
                "time_mins": round(est_mins, 1),
                "time_formatted": f"~{round(est_mins, 1)} mins",
                "crf_used": p['crf']
            }

    # 3. Print the Final JSON for Electron to Read
    payload = {
        "status": "success",
        "dna": dna,
        "videos": {
            "original": vid_orig,
            "previews": estimates
        }
    }
    
    print(json.dumps(payload))

    
def api_encode(file_path, preset_id, output_path, threads="0"):
    """
    Called by Electron when the user clicks 'Compress'.
    Runs the actual SVT-AV1 encode and streams real-time data back.
    """
    log(f"[PYTHON] ENGAGING MASTER ENCODE for {file_path}")
    log(f"[PYTHON] Mode: {preset_id.upper()} | Target Output: {output_path}")
    
    dna = extract_dna(file_path)
    total_frames = dna.get('total_frames', 1) # Prevent division by zero
    
    # 🔴 UPGRADED QUALITY TIERS (Must match analysis!)
    if dna['width'] >= 3840:
        crf = 28 if preset_id == 'max' else 36 if preset_id == 'balanced' else 44
    elif dna['width'] >= 1920:
        crf = 24 if preset_id == 'max' else 32 if preset_id == 'balanced' else 40
    else:
        crf = 22 if preset_id == 'max' else 28 if preset_id == 'balanced' else 36

    preset_num = "4" if preset_id == 'max' else "6" if preset_id == 'balanced' else "8"

    # Build FFMPEG Command
    cmd = [
        "ffmpeg", "-y", "-i", file_path,
        "-c:v", "libsvtav1", "-preset", preset_num, "-crf", str(crf),
        "-svtav1-params", f"tune=0:film-grain={dna['grain_level']}:lp={threads}",
        "-c:a", "copy",
        output_path
    ]
    
    log(f"[PYTHON] Executing: {' '.join(cmd)}")
    
    # Launch Process & Stream Output
    process = subprocess.Popen(cmd, stderr=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding='utf-8')
    start_time = time.time()
    
    for line in process.stderr:
        line = line.strip()
        if not line: continue
        
        log(f"[FFMPEG] {line}")
        
        if "frame=" in line and "time=" in line:
            try:
                frame_match = re.search(r'frame=\s*(\d+)', line)
                fps_match = re.search(r'fps=\s*([\d.]+)', line)
                
                if frame_match:
                    frame = int(frame_match.group(1))
                    fps = float(fps_match.group(1)) if fps_match else 0.0
                    
                    progress = min(99.9, (frame / total_frames) * 100)
                    
                    # Calculate ETA
                    elapsed = time.time() - start_time
                    if progress > 0:
                        total_est = elapsed / (progress / 100)
                        eta_secs = total_est - elapsed
                        eta = f"{int(eta_secs // 60)}m {int(eta_secs % 60)}s"
                    else:
                        eta = "Calculating..."
                        
                    # Hardware Telemetry
                    cpu_usage = psutil.cpu_percent()
                    ram_usage = psutil.virtual_memory().used / (1024**3)
                    
                    telemetry = {
                        "type": "telemetry",
                        "progress": progress,
                        "fps": fps,
                        "cpu": cpu_usage,
                        "ram": ram_usage,
                        "eta": eta
                    }
                    print(json.dumps(telemetry), flush=True)
            except Exception as e:
                pass # Ignore parsing errors for weirdly formatted lines

    process.wait()
    
    if process.returncode == 0:
        log("[PYTHON] MASTER ENCODE COMPLETED SUCCESSFULLY!")
        print(json.dumps({"type": "complete", "progress": 100, "eta": "Done"}))
    else:
        log(f"[PYTHON ERROR] FFMPEG failed with code {process.returncode}")
        sys.exit(1)

if __name__ == "__main__":
    # Ensure Python can find ffmpeg and av1an in the current 'engine' folder
    os.environ["PATH"] = os.path.dirname(os.path.abspath(__file__)) + os.pathsep + os.environ["PATH"]

    parser = argparse.ArgumentParser(description="VideoBake AI Engine")
    parser.add_argument("--action", type=str, choices=["analyze", "encode"], required=True, help="What Electron wants Python to do.")
    parser.add_argument("--input", type=str, required=True, help="Path to input video.")
    parser.add_argument("--preset", type=str, choices=["max", "balanced", "fast"], default="balanced", help="Encoding preset ID.")
    parser.add_argument("--output", type=str, help="Path to output video.")
    parser.add_argument("--tempdir", type=str, help="Safe temporary directory for preview files.") 
    
    parser.add_argument("--threads", type=str, default="0", help="Max logical processors to use.") 
    
    args = parser.parse_args()

    if args.action == "analyze":
        if not args.tempdir:
            log("[CRITICAL] Temp directory path is required for analysis.")
            sys.exit(1)
        api_analyze(args.input, args.tempdir) 
        
    elif args.action == "encode":
        if not args.output:
            log("[CRITICAL] Output path is required for encoding.")
            sys.exit(1)
            
        api_encode(args.input, args.preset, args.output, args.threads)