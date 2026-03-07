import subprocess
import os
import sys
import json
import time
import re
import argparse
import random 

# Force Python to handle Unicode/Emojis without crashing
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

try:
    import psutil
except ImportError:
    print('{"error": "psutil not found"}', file=sys.stdout)
    sys.exit(1)

def log(msg):
    print(msg, file=sys.stderr, flush=True)

def set_process_priority(impact_level):
    try:
        p = psutil.Process(os.getpid())
        if hasattr(psutil, "BELOW_NORMAL_PRIORITY_CLASS"):
            if impact_level == "stealth": p.nice(psutil.IDLE_PRIORITY_CLASS)
            elif impact_level == "balanced": p.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
            elif impact_level == "beast": p.nice(psutil.HIGH_PRIORITY_CLASS)
            else: p.nice(psutil.NORMAL_PRIORITY_CLASS)
        else:
            if impact_level == "stealth": p.nice(19)
            elif impact_level == "balanced": p.nice(10)
            elif impact_level == "beast": p.nice(-10) 
            else: p.nice(0)
    except Exception:
        pass

def format_bytes(size):
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if size < 1024.0: return f"{size:.2f} {unit}"
        size /= 1024.0
    return f"{size:.2f} PB"

def analyze_sensor_and_motion(file_path, duration):
    mid = str(max(0, duration * 0.3))
    cmd = ["ffmpeg", "-hide_banner", "-ss", mid, "-i", file_path, "-t", "1", "-vf", "signalstats", "-f", "null", "-"]
    try:
        res = subprocess.run(cmd, stderr=subprocess.PIPE, text=True, encoding='utf-8', errors='ignore')
        yvar_matches = re.findall(r'YVAR: ([\d.]+)', res.stderr)
        if yvar_matches:
            avg_yvar = sum(float(x) for x in yvar_matches) / len(yvar_matches)
            if avg_yvar > 1500: return 15, "High (Gritty Film)"
            elif avg_yvar > 600: return 10, "Medium (Standard Noise)"
            elif avg_yvar > 200: return 6, "Low (Modern Digital)"
            else: return 2, "Ultra-Clean (Animation/Screen)"
    except Exception:
        pass
    return 8, "Fallback (Standard)"

def smart_auto_crop(file_path, duration, width, height):
    timestamps = [duration * 0.2, duration * 0.5, duration * 0.8]
    crops_found = []
    for ts in timestamps:
        cmd = ["ffmpeg", "-hide_banner", "-ss", str(ts), "-i", file_path, "-t", "2", "-vf", "cropdetect=24:16:0", "-f", "null", "-"]
        res = subprocess.run(cmd, stderr=subprocess.PIPE, text=True, encoding='utf-8', errors='ignore')
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
        log(f"[CRITICAL] File not found on disk: {file_path}")
        sys.exit(1)
    cmd = ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", file_path]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='ignore')
        data = json.loads(res.stdout)
        v = next((s for s in data.get('streams', []) if s.get('codec_type') == 'video'), {})
        
        width = int(v.get('width', 0))
        height = int(v.get('height', 0))
        fps_raw = v.get('r_frame_rate', '30/1')
        fps = eval(fps_raw) if '/' in fps_raw else float(fps_raw)
        
        color_space = v.get('pix_fmt', 'unknown')
        color_transfer = v.get('color_transfer', 'unknown')
        bit_depth = 10 if '10' in color_space or 'p10' in color_space else 8
        is_hdr = color_transfer in ['smpte2084', 'arib-std-b67']
        
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
            "size": size, "duration": duration, "bitrate": bitrate, "bpp": bpp,
            "crop": actual_crop, "total_frames": int(duration * fps),
            "grain_level": grain_level, "noise_profile": noise_profile
        }
    except Exception as e:
        log(f"[CRITICAL] DNA Extraction failed: {e}")
        sys.exit(1)


def get_engine_settings(dna, engine_type, preset_id):
    is_60fps = dna['fps'] > 45
    is_4k = dna['width'] >= 3840
    orig_bitrate = dna.get('bitrate', 1)

    settings = {"cmd_args": []}

    hard_cap = int(orig_bitrate * 0.98) 

    if engine_type == 'gpu':
        settings["codec"] = "hevc_nvenc"
        
        if is_4k:
            cq = 32 if preset_id == 'max' else 40 if preset_id == 'balanced' else 48
        else:
            cq = 26 if preset_id == 'max' else 34 if preset_id == 'balanced' else 42
            
        settings["cmd_args"] = [
            "-c:v", settings["codec"], 
            "-preset", "p6" if preset_id == 'max' else "p4", 
            "-rc", "vbr", "-cq", str(cq),
            "-rc-lookahead", "20", 
            "-maxrate", str(hard_cap), "-bufsize", str(hard_cap * 2)
        ]
        settings["crf_label"] = cq
 
    else:
        settings["codec"] = "libsvtav1"
        grain = dna.get('grain_level', 10)
        
        if is_4k:
            crf = 36 if preset_id == 'max' else 46 if preset_id == 'balanced' else 55
            preset = 8 if preset_id == 'max' else 10 if preset_id == 'balanced' else 12
            if not is_60fps: preset = max(4, preset - 2)
        else:
            crf = 30 if preset_id == 'max' else 40 if preset_id == 'balanced' else 50
            preset = 4 if preset_id == 'max' else 6 if preset_id == 'balanced' else 8

        settings["cmd_args"] = [
            "-c:v", "libsvtav1", "-preset", str(preset), "-crf", str(crf),
            "-pix_fmt", "yuv420p10le", 
            "-maxrate", str(hard_cap), "-bufsize", str(hard_cap * 2), 
            "-svtav1-params", f"tune=0:film-grain={grain}"
        ]
        settings["crf_label"] = crf
        
    return settings

def api_analyze(file_path, temp_dir, engine_type):
    log(f"\n[PYTHON] STARTING ANALYSIS PIPELINE ({engine_type.upper()})")
    start_total_analysis = time.time()
    
    dna = extract_dna(file_path)
    mid_point = int(dna['duration'] / 2)
    uid = random.randint(10000, 99999)
    PREVIEW_DURATION = "3" 
    vid_orig = os.path.join(temp_dir, f"vb_temp_orig_{uid}.mp4").replace("\\", "/")

    print(json.dumps({"type": "analysis_progress", "progress": 10, "eta": "Extracting Reference..."}), flush=True)
    subprocess.run(["ffmpeg", "-y", "-ss", str(mid_point), "-i", file_path, "-t", PREVIEW_DURATION, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16", "-an", vid_orig], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    estimates = {}
    current_progress = 10
    presets_to_run = ['max', 'balanced', 'fast']
    
    for preset_id in presets_to_run:
        elapsed = time.time() - start_total_analysis
        total_est = elapsed / (current_progress / 100) if current_progress > 0 else 0
        eta_secs = max(0, total_est - elapsed)
        eta_str = f"{int(eta_secs // 60)}m {int(eta_secs % 60)}s" if eta_secs > 0 else "Calculating..."
        print(json.dumps({"type": "analysis_progress", "progress": current_progress, "eta": f"Benchmarking {preset_id} ({eta_str})"}), flush=True)

        engine_cfg = get_engine_settings(dna, engine_type, preset_id)
        
        master_out_path = os.path.join(temp_dir, f"vb_master_temp_{preset_id}_{uid}.mkv").replace("\\", "/")
        vf_arg = ["-vf", dna['crop']] if dna['crop'] else []
        
        cmd_encode = ["ffmpeg", "-y", "-ss", str(mid_point), "-i", file_path, "-t", PREVIEW_DURATION] + vf_arg + engine_cfg["cmd_args"] + ["-an", master_out_path]
        
        start_enc = time.time()
        res_encode = subprocess.run(cmd_encode, stderr=subprocess.PIPE, text=True, encoding='utf-8', errors='ignore')
        enc_time = max(0.5, (time.time() - start_enc) - 1.5)
        web_out_path = master_out_path
        final_est_bytes = dna['size'] 
        
        if os.path.exists(master_out_path):
            chunk_weight_bytes = os.path.getsize(master_out_path)
            
            multiplier = 1.25 if engine_type == 'gpu' else 1.10
            
            estimated_video_bytes = (chunk_weight_bytes / float(PREVIEW_DURATION)) * dna['duration'] * multiplier
            estimated_audio_bytes = (128000 / 8) * dna['duration']
            final_est_bytes = estimated_video_bytes + estimated_audio_bytes

            ceiling = dna['size'] * 0.95
            if final_est_bytes > ceiling:
                final_est_bytes = ceiling

            if engine_type == 'gpu':
                web_out_path = os.path.join(temp_dir, f"vb_web_temp_{preset_id}_{uid}.mp4").replace("\\", "/")
                cmd_convert = ["ffmpeg", "-y", "-i", master_out_path, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", "-an", web_out_path]
                subprocess.run(cmd_convert, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                web_out_path = os.path.join(temp_dir, f"vb_web_temp_{preset_id}_{uid}.webm").replace("\\", "/")
                os.rename(master_out_path, web_out_path)
        else:
            log(f"[FFMPEG CRASH on {preset_id}] {res_encode.stderr}")

        current_progress += 30
        
        if os.path.exists(web_out_path):
            est_mins = ((enc_time / float(PREVIEW_DURATION)) * dna['duration']) / 60
            savings_pct = int((1 - (final_est_bytes / dna['size'])) * 100)
            
            estimates[preset_id] = {
                "video_path": web_out_path,
                "size_bytes": final_est_bytes, 
                "size_formatted": format_bytes(final_est_bytes),
                "savings": max(0, savings_pct), 
                "time_mins": round(est_mins, 1),
                "time_formatted": f"~{round(est_mins, 1)} mins",
                "crf_used": engine_cfg["crf_label"]
            }

    # Time Sanity Smoothing
    if "balanced" in estimates and "max" in estimates:
        if estimates["balanced"]["time_mins"] >= estimates["max"]["time_mins"]:
            estimates["balanced"]["time_mins"] = max(1.0, estimates["max"]["time_mins"] * 0.7)
            estimates["balanced"]["time_formatted"] = f"~{round(estimates['balanced']['time_mins'], 1)} mins"

    if "fast" in estimates and "balanced" in estimates:
        if estimates["fast"]["time_mins"] >= estimates["balanced"]["time_mins"]:
            estimates["fast"]["time_mins"] = max(0.5, estimates["balanced"]["time_mins"] * 0.6)
            estimates["fast"]["time_formatted"] = f"~{round(estimates['fast']['time_mins'], 1)} mins"

    print(json.dumps({"type": "analysis_progress", "progress": 100, "eta": "Finalizing..."}), flush=True)

    payload = {
        "status": "success",
        "dna": dna,
        "active_engine": engine_type,
        "videos": {
            "original": vid_orig,
            "previews": estimates
        }
    }
    print(f"\n{json.dumps(payload)}")


def api_encode(file_path, preset_id, output_path, engine_type):
    log(f"\n[PYTHON] STARTING MASTER ENCODE ({engine_type.upper()})")
    
    dna = extract_dna(file_path)
    total_frames = dna.get('total_frames', 1)
    
    engine_cfg = get_engine_settings(dna, engine_type, preset_id)
    vf_arg = ["-vf", dna['crop']] if dna['crop'] else []
    
    cmd = ["ffmpeg", "-y", "-i", file_path] + vf_arg + engine_cfg["cmd_args"] + ["-c:a", "aac", "-b:a", "128k", output_path]

    process = subprocess.Popen(cmd, stderr=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding='utf-8', errors='ignore')
    start_time = time.time()
    
    for line in process.stderr:
        line = line.strip()
        if not line: continue
        if "frame=" in line and "time=" in line:
            try:
                frame_match = re.search(r'frame=\s*(\d+)', line)
                if frame_match:
                    frame = int(frame_match.group(1))
                    progress = min(99.9, (frame / total_frames) * 100)
                    
                    elapsed = time.time() - start_time
                    if progress > 0:
                        total_est = elapsed / (progress / 100)
                        eta_secs = total_est - elapsed
                        eta = f"{int(eta_secs // 60)}m {int(eta_secs % 60)}s"
                    else:
                        eta = "Calculating..."
                        
                    telemetry = {
                        "type": "telemetry",
                        "progress": progress,
                        "cpu": psutil.cpu_percent(),
                        "ram": psutil.virtual_memory().used / (1024**3),
                        "eta": eta
                    }
                    print(json.dumps(telemetry), flush=True)
            except Exception: pass 
        else:
            log(f"[FFMPEG] {line}")

    process.wait()
    if process.returncode == 0:
        print(json.dumps({"type": "complete", "progress": 100, "eta": "Done"}))
    else:
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
    parser.add_argument("--engine", type=str, choices=["cpu", "gpu"], default="cpu") 
    
    args = parser.parse_args()
    set_process_priority(args.impact)

    if args.action == "analyze":
        api_analyze(args.input, args.tempdir, args.engine) 
    elif args.action == "encode":
        api_encode(args.input, args.preset, args.output, args.engine)