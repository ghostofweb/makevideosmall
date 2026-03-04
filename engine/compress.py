import subprocess
import os
import sys
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

def log(msg):
    print(msg, file=sys.stderr, flush=True)

# ----------------------------------------------------------------------
# THE OS PRIORITY MANAGER
# ----------------------------------------------------------------------
def set_process_priority(impact_level):
    try:
        p = psutil.Process(os.getpid())
        if hasattr(psutil, "BELOW_NORMAL_PRIORITY_CLASS"):
            if impact_level == "stealth":
                p.nice(psutil.IDLE_PRIORITY_CLASS)
                log("[PYTHON] Mode: STEALTH.")
            elif impact_level == "balanced":
                p.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
                log("[PYTHON] Mode: BALANCED.")
            elif impact_level == "beast":
                p.nice(psutil.HIGH_PRIORITY_CLASS)
                log("[PYTHON] Mode: BEAST.")
            else:
                p.nice(psutil.NORMAL_PRIORITY_CLASS)
        else:
            if impact_level == "stealth":
                p.nice(19)
            elif impact_level == "balanced":
                p.nice(10)
            elif impact_level == "beast":
                p.nice(-10) 
            else:
                p.nice(0)
    except Exception as e:
        log(f"[PYTHON WARN] Failed to set process priority: {e}")

def format_bytes(size):
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if size < 1024.0: return f"{size:.2f} {unit}"
        size /= 1024.0
    return f"{size:.2f} PB"

def analyze_sensor_and_motion(file_path, duration):
    log("[PYTHON] Running Deep Sensor Analysis...")
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
        pass
    return 8, "Fallback (Standard)"

def smart_auto_crop(file_path, duration, width, height):
    log("[PYTHON] Running Cinematic Crop Detection...")
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
        
        # 🔴 Ensure we have a valid original bitrate
        bitrate = int(data.get('format', {}).get('bitrate', 0))
        if bitrate == 0 and duration > 0: 
            bitrate = int((size * 8) / duration)
            
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

def api_analyze(file_path, temp_dir):
    log(f"\n[PYTHON] STARTING ANALYSIS PIPELINE")
    start_total_analysis = time.time()
    
    dna = extract_dna(file_path)
    
    mid_point = int(dna['duration'] / 2)
    uid = random.randint(10000, 99999)
    
    # Shortened to 3 seconds for faster UX
    PREVIEW_DURATION = "3" 
    vid_orig = os.path.join(temp_dir, f"vb_temp_orig_{uid}.mp4").replace("\\", "/")
    
    orig_size = dna.get('size', 1)
    orig_bitrate = dna.get('bitrate', 1)
    grain_value = dna.get('grain_level', 10)

    # 🔴 THE HYBRID SAFETY NET
    cap_max = int(orig_bitrate * 0.90)
    cap_bal = int(orig_bitrate * 0.60)
    cap_fast = int(orig_bitrate * 0.40)

    if dna['width'] >= 3840:
        crf_max, crf_bal, crf_fast = 30, 36, 42 
        preset_max = 5 
    elif dna['width'] >= 1920:
        crf_max, crf_bal, crf_fast = 24, 30, 36
        preset_max = 5
    else:
        crf_max, crf_bal, crf_fast = 20, 26, 32
        preset_max = 4

    presets = {
        "max": {"id": "max", "preset": preset_max, "crf": crf_max, "cap": cap_max, "est_size": orig_size * 0.70, "out": os.path.join(temp_dir, f"vb_temp_max_{uid}.webm").replace("\\", "/")},
        "balanced": {"id": "balanced", "preset": 6, "crf": crf_bal, "cap": cap_bal, "est_size": orig_size * 0.50, "out": os.path.join(temp_dir, f"vb_temp_bal_{uid}.webm").replace("\\", "/")},
        "fast": {"id": "fast", "preset": 8, "crf": crf_fast, "cap": cap_fast, "est_size": orig_size * 0.35, "out": os.path.join(temp_dir, f"vb_temp_fast_{uid}.webm").replace("\\", "/")}
    }

    log(f"[PYTHON] Extracting Reference Video...")
    print(json.dumps({"type": "analysis_progress", "progress": 10, "eta": "Extracting Reference..."}), flush=True)
    
    subprocess.run([
        "ffmpeg", "-y", "-ss", str(mid_point), "-i", file_path, "-t", PREVIEW_DURATION, 
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16", "-an", vid_orig
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    estimates = {}
    current_progress = 10
    
    for key, p in presets.items():
        elapsed = time.time() - start_total_analysis
        total_est = elapsed / (current_progress / 100) if current_progress > 0 else 0
        eta_secs = max(0, total_est - elapsed)
        eta_str = f"{int(eta_secs // 60)}m {int(eta_secs % 60)}s" if eta_secs > 0 else "Calculating..."
        
        print(json.dumps({"type": "analysis_progress", "progress": current_progress, "eta": f"Benchmarking {key} ({eta_str})"}), flush=True)

        vf_arg = ["-vf", dna['crop']] if dna['crop'] else []
        
        # 🔴 Constrained Encode
        cmd = [
            "ffmpeg", "-y", "-ss", str(mid_point), "-i", file_path, "-t", PREVIEW_DURATION
        ] + vf_arg + [
            "-c:v", "libsvtav1", "-preset", str(p['preset']), 
            "-crf", str(p['crf']),
            "-maxrate", str(p['cap']), "-bufsize", str(p['cap'] * 2),
            "-svtav1-params", f"tune=0:film-grain={grain_value}", 
            "-an", p['out']
        ]
        
        start_enc = time.time()
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        enc_time = time.time() - start_enc
        
        current_progress += 30
        
        if os.path.exists(p['out']):
            est_mins = ((enc_time / float(PREVIEW_DURATION)) * dna['duration']) / 60
            savings_pct = int((1 - (p['est_size'] / orig_size)) * 100)
            
            estimates[key] = {
                "video_path": p['out'],
                "size_bytes": p['est_size'], 
                "size_formatted": format_bytes(p['est_size']),
                "savings": savings_pct,
                "time_mins": round(est_mins, 1),
                "time_formatted": f"~{round(est_mins, 1)} mins",
                "crf_used": p['crf']
            }

    print(json.dumps({"type": "analysis_progress", "progress": 100, "eta": "Finalizing..."}), flush=True)

    payload = {
        "status": "success",
        "dna": dna,
        "videos": {
            "original": vid_orig,
            "previews": estimates
        }
    }
    
    log(f"[PYTHON] Analysis Complete. Payload dispatched.")
    print(f"\n{json.dumps(payload)}")

    
def api_encode(file_path, preset_id, output_path):
    log(f"\n[PYTHON] STARTING MASTER ENCODE")
    log(f"[PYTHON] Target Output: {output_path}")
    
    dna = extract_dna(file_path)
    total_frames = dna.get('total_frames', 1)
    
    orig_bitrate = dna.get('bitrate', 1)
    grain_value = dna.get('grain_level', 10)
    
    if preset_id == 'max':
        cap_br = int(orig_bitrate * 0.90)
        preset_num = "5" if dna['width'] >= 1920 else "4"
    elif preset_id == 'balanced':
        cap_br = int(orig_bitrate * 0.60)
        preset_num = "6"
    else:
        cap_br = int(orig_bitrate * 0.40)
        preset_num = "8"

    if dna['width'] >= 3840:
        crf = 30 if preset_id == 'max' else 36 if preset_id == 'balanced' else 42
    elif dna['width'] >= 1920:
        crf = 24 if preset_id == 'max' else 30 if preset_id == 'balanced' else 36
    else:
        crf = 20 if preset_id == 'max' else 26 if preset_id == 'balanced' else 32

    # 🔴 Master Encode with Constrained CRF
    cmd = [
        "ffmpeg", "-y", "-i", file_path,
        "-c:v", "libsvtav1", "-preset", preset_num, 
        "-crf", str(crf),
        "-maxrate", str(cap_br), "-bufsize", str(cap_br * 2),
        "-svtav1-params", f"tune=0:film-grain={grain_value}", 
        "-c:a", "copy",
        output_path
    ]
    
    log(f"[PYTHON] Command Built. Firing Uncapped FFMPEG...")
    process = subprocess.Popen(cmd, stderr=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding='utf-8')
    start_time = time.time()
    
    for line in process.stderr:
        line = line.strip()
        if not line: continue
        
        if "frame=" in line and "time=" in line:
            try:
                frame_match = re.search(r'frame=\s*(\d+)', line)
                fps_match = re.search(r'fps=\s*([\d.]+)', line)
                
                if frame_match:
                    frame = int(frame_match.group(1))
                    fps = float(fps_match.group(1)) if fps_match else 0.0
                    progress = min(99.9, (frame / total_frames) * 100)
                    
                    elapsed = time.time() - start_time
                    if progress > 0:
                        total_est = elapsed / (progress / 100)
                        eta_secs = total_est - elapsed
                        eta = f"{int(eta_secs // 60)}m {int(eta_secs % 60)}s"
                    else:
                        eta = "Calculating..."
                        
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
                pass 
        else:
            log(f"[FFMPEG] {line}")

    process.wait()
    
    if process.returncode == 0:
        log("[PYTHON] MASTER ENCODE COMPLETED SUCCESSFULLY!")
        print(json.dumps({"type": "complete", "progress": 100, "eta": "Done"}))
    else:
        log(f"[PYTHON ERROR] FFMPEG failed with code {process.returncode}")
        sys.exit(1)

if __name__ == "__main__":
    os.environ["PATH"] = os.path.dirname(os.path.abspath(__file__)) + os.pathsep + os.environ["PATH"]
    parser = argparse.ArgumentParser()
    parser.add_argument("--action", type=str, choices=["analyze", "encode"], required=True)
    parser.add_argument("--input", type=str, required=True)
    parser.add_argument("--preset", type=str, choices=["max", "balanced", "fast"], default="balanced")
    parser.add_argument("--output", type=str)
    parser.add_argument("--tempdir", type=str) 
    parser.add_argument("--impact", type=str, choices=["stealth", "balanced", "beast"], default="balanced") 
    
    args = parser.parse_args()

    set_process_priority(args.impact)

    if args.action == "analyze":
        if not args.tempdir:
            sys.exit(1)
        api_analyze(args.input, args.tempdir) 
        
    elif args.action == "encode":
        if not args.output:
            sys.exit(1)
        api_encode(args.input, args.preset, args.output)