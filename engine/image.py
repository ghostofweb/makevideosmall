import subprocess
import os
import sys
import json
import time
import argparse
import random
from typing import Dict, Any, Optional

# Ensure standard streams handle UTF-8 properly for IPC
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

def log(msg: str) -> None:
    """Log messages to stderr so they don't corrupt the JSON stdout stream."""
    print(msg, file=sys.stderr, flush=True)

def emit(obj: Dict[str, Any]) -> None:
    """Emit a JSON telemetry line to stdout for the Node/React frontend."""
    print(json.dumps(obj), flush=True)

def get_engine_dir() -> str:
    """
    Returns the true directory of the script or the compiled executable.
    Fixes the PyInstaller --onefile issue where __file__ points to a temp _MEI dir.
    """
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))

# ──────────────────────────────────────────────
# DNA Extraction
# ──────────────────────────────────────────────
def extract_image_dna(file_path: str) -> Dict[str, Any]:
    if not os.path.exists(file_path):
        log(f"[CRITICAL] Image not found: {file_path}")
        emit({"type": "error", "message": "File not found on disk."})
        sys.exit(1)

    cmd = [
        "ffprobe", "-v", "quiet", "-print_format", "json",
        "-show_format", "-show_streams", file_path
    ]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='ignore')
        data = json.loads(res.stdout)

        video_stream = next((s for s in data.get('streams', []) if s.get('codec_type') == 'video'), {})
        tags = data.get('format', {}).get('tags', {})

        width = int(video_stream.get('width', 0))
        height = int(video_stream.get('height', 0))
        size_bytes = int(data.get('format', {}).get('size', 0))

        return {
            "width": width, 
            "height": height,
            "size_bytes": size_bytes,
            "total_pixels": width * height,
            "metadata": tags
        }
    except Exception as e:
        log(f"[CRITICAL] DNA extraction failed: {e}")
        sys.exit(1)

# ──────────────────────────────────────────────
# FFmpeg Arg Builder
# ──────────────────────────────────────────────
def build_ffmpeg_args(input_path: str, output_path: str, fmt: str, quality: int, 
                      strip_exif: bool, metadata_dict: Optional[Dict[str, str]] = None) -> list:
    """
    Build FFmpeg args. Metadata write order:
      -map_metadata -1   (strip everything)
      -metadata k=v      (then write only our custom fields)
    """
    cmd = ["ffmpeg", "-y", "-i", input_path]

    if strip_exif:
        cmd.extend(["-map_metadata", "-1"])
    elif metadata_dict:
        # Keep original, but overwrite specific fields
        cmd.extend(["-map_metadata", "0"])

    if metadata_dict:
        for k, v in metadata_dict.items():
            if k and v:
                cmd.extend(["-metadata", f"{k}={v}"])
                log(f"[META] Writing: {k}={v}")

    # Format-specific encoding settings
    if fmt == "webp":
        cmd.extend(["-c:v", "libwebp", "-quality", str(quality)])
    elif fmt == "avif":
        # CRF 0=lossless, 63=terrible. Map 100→0, 0→63
        crf = int(63 - (quality * 0.63))
        cmd.extend(["-c:v", "libsvtav1", "-crf", str(crf), "-preset", "6"])
    else:  # jpg
        # q:v 2=best, 31=worst. Map 100→2, 0→31
        q_scale = max(2, int(31 - (quality * 0.29)))
        cmd.extend(["-q:v", str(q_scale)])

    cmd.append(output_path)
    return cmd

# ──────────────────────────────────────────────
# Target Size — 14-iteration binary search
# ──────────────────────────────────────────────
def process_target_size(input_path: str, output_path: str, fmt: str, target_kb: int, 
                        strip_exif: bool, temp_dir: str, metadata_dict: Optional[Dict[str, str]] = None) -> bool:
    target_bytes = target_kb * 1024
    log(f"[TARGET] Goal: {target_kb} KB ({target_bytes} bytes)")

    uid = random.randint(10000, 99999)
    temp_files = []

    min_q, max_q = 1, 100
    best_q = 50
    
    # Track overall closest
    best_diff = float('inf')
    best_temp = ""
    
    # Track strictly UNDER target
    best_under_diff = float('inf')
    best_under_temp = ""
    
    last_q = -1

    for i in range(14):
        current_q = (min_q + max_q) // 2

        if current_q == last_q:
            log(f"[TARGET] Converged at step {i}, q={current_q}")
            break
        last_q = current_q

        temp_out = os.path.join(temp_dir, f"vb_img_{uid}_s{i}.{fmt}").replace("\\", "/")
        temp_files.append(temp_out)

        cmd = build_ffmpeg_args(input_path, temp_out, fmt, current_q, strip_exif, metadata_dict)
        result = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                text=True, encoding='utf-8', errors='ignore')

        if not os.path.exists(temp_out):
            log(f"[TARGET] Step {i}: FFmpeg failed (q={current_q}). stderr: {result.stderr[:200]}")
            max_q = current_q - 1
            continue

        result_bytes = os.path.getsize(temp_out)
        diff = abs(target_bytes - result_bytes)
        pct_of_target = (result_bytes / target_bytes) * 100

        log(f"[TARGET] Step {i+1}/14: q={current_q:3d} → {result_bytes//1024:6d} KB "
            f"({pct_of_target:6.1f}% of {target_kb} KB) | diff={diff//1024} KB")

        emit({"type": "telemetry", "progress": 10 + int((i / 14) * 80),
              "eta": f"Hunting... (step {i+1}/14, q={current_q})"})

        # Update overall closest
        if diff < best_diff:
            best_diff = diff
            best_q = current_q
            best_temp = temp_out
            
        # Update closest UNDER target
        if result_bytes <= target_bytes and diff < best_under_diff:
            best_under_diff = diff
            best_under_temp = temp_out

        if result_bytes > target_bytes:
            max_q = current_q - 1  # Too big → lower quality
        else:
            min_q = current_q + 1  # Too small → raise quality

        if min_q > max_q:
            log(f"[TARGET] Search space exhausted at step {i+1}.")
            break
            
        if diff <= (target_bytes * 0.01):
            log(f"[TARGET] Target hit within 1% margin at step {i+1}.")
            break

    # Prioritize the file that is strictly under the KB limit, fallback to overall closest
    final_winner = best_under_temp if best_under_temp else best_temp

    # Cleanup temp files except winner
    for f in temp_files:
        if f != final_winner and os.path.exists(f):
            try: 
                os.remove(f)
            except OSError: 
                pass

    if not final_winner or not os.path.exists(final_winner):
        log("[TARGET] All iterations failed — no output produced.")
        return False

    achieved_bytes = os.path.getsize(final_winner)
    achieved_kb = achieved_bytes // 1024
    over_pct = ((achieved_bytes - target_bytes) / target_bytes) * 100

    log(f"[TARGET] Best result: {achieved_kb} KB at q={best_q} "
        f"(diff={abs(achieved_bytes - target_bytes)//1024} KB, {over_pct:+.1f}% vs target)")

    if achieved_bytes > target_bytes * 1.10:
        msg = (f"Could not compress below {achieved_kb} KB without corrupting the file. "
               f"Try a larger target or switch format to AVIF.")
        log(f"[TARGET] WARNING: {msg}")
        emit({"type": "error", "message": msg})  # Display error toast in React
    elif achieved_bytes < target_bytes * 0.5:
        msg = (f"Result ({achieved_kb} KB) is well under target. "
               f"You can increase the target for better quality.")
        log(f"[TARGET] INFO: {msg}")

    os.replace(final_winner, output_path)
    return True

# ──────────────────────────────────────────────
# AI Upscale (With CPU Fallback)
# ──────────────────────────────────────────────
def api_upscale(input_path: str, output_path: str) -> bool:
    log("\n[UPSCALE] Starting AI upscale pipeline")
    dna = extract_image_dna(input_path)

    # 4K safety cap: 3840×2160 = 8,294,400 pixels
    if dna['total_pixels'] > 8_500_000:
        width, height = dna['width'], dna['height']
        msg = (f"Image is already {width}×{height} ({dna['total_pixels']//1_000_000:.1f} MP) — "
               f"4K or larger. Upscaling rejected to prevent crash.")
        log(f"[UPSCALE] REJECTED: {msg}")
        emit({"type": "error", "message": msg})
        sys.exit(1)

    upscaler = os.path.join(get_engine_dir(), "realesrgan-ncnn-vulkan.exe")

    if not os.path.exists(upscaler):
        msg = f"Real-ESRGAN binary not found at {upscaler}. Cannot upscale."
        log(f"[UPSCALE] {msg}")
        emit({"type": "error", "message": msg})
        sys.exit(1)

    # --- ATTEMPT 1: GPU (-g 0) ---
    cmd_gpu = [upscaler, "-i", input_path, "-o", output_path, "-n", "realesrgan-x4plus", "-s", "4", "-g", "0"]
    log(f"[UPSCALE] Launching GPU Engine: {' '.join(cmd_gpu)}")
    emit({"type": "telemetry", "progress": 30, "eta": "AI upscaling via GPU..."})

    start = time.time()
    process_gpu = subprocess.run(cmd_gpu, capture_output=True, text=True, encoding='utf-8', errors='ignore')

    if process_gpu.returncode == 0 and os.path.exists(output_path):
        log(f"[UPSCALE] GPU Upscale Done in {round(time.time() - start, 1)}s")
        return True

    # --- ATTEMPT 2: CPU Fallback (-g -1) ---
    log(f"[UPSCALE] GPU failed. Attempting CPU fallback... Error: {process_gpu.stderr[:200]}")
    emit({"type": "telemetry", "progress": 35, "eta": "GPU failed. Falling back to CPU (this takes longer)..."})
    
    cmd_cpu = [upscaler, "-i", input_path, "-o", output_path, "-n", "realesrgan-x4plus", "-s", "4", "-g", "-1"]
    
    start_cpu = time.time()
    process_cpu = subprocess.run(cmd_cpu, capture_output=True, text=True, encoding='utf-8', errors='ignore')
    
    if process_cpu.returncode == 0 and os.path.exists(output_path):
        log(f"[UPSCALE] CPU Upscale Done in {round(time.time() - start_cpu, 1)}s")
        return True
    else:
        log(f"[CRITICAL] CPU Upscale also failed: {process_cpu.stderr[:400]}")
        emit({"type": "error", "message": "AI Upscaling failed on both GPU and CPU."})
        return False

# ──────────────────────────────────────────────
# Main Execution
# ──────────────────────────────────────────────
def main():
    # Inject the true engine directory into the system PATH
    true_engine_dir = get_engine_dir()
    os.environ["PATH"] = true_engine_dir + os.pathsep + os.environ.get("PATH", "")

    parser = argparse.ArgumentParser(description="Image Studio Backend Processing Engine")
    parser.add_argument("--action", type=str, choices=["analyze", "compress", "upscale", "target"], required=True)
    parser.add_argument("--input", type=str, required=True)
    parser.add_argument("--output", type=str)
    parser.add_argument("--tempdir", type=str)
    parser.add_argument("--format", type=str, choices=["jpg", "webp", "avif"], default="webp")
    parser.add_argument("--quality", type=int, default=80)
    parser.add_argument("--target-kb", type=int)
    parser.add_argument("--strip-exif", action="store_true")
    parser.add_argument("--metadata-json", type=str, default=None,
                        help="JSON string of metadata key-value pairs to write into the output file")
    
    args = parser.parse_args()

    # Parse metadata JSON if provided
    metadata_dict = None
    if args.metadata_json:
        try:
            metadata_dict = json.loads(args.metadata_json)
            log(f"[META] Received {len(metadata_dict)} custom metadata fields: {list(metadata_dict.keys())}")
        except json.JSONDecodeError as e:
            log(f"[META] WARNING: Failed to parse --metadata-json: {e}. Skipping metadata write.")

    # ── Action: Analyze ──
    if args.action == "analyze":
        dna = extract_image_dna(args.input)
        print(json.dumps({"type": "analyze_complete", "data": dna}))
        sys.exit(0)

    # ── Validate outputs for processing actions ──
    if not args.output or not args.tempdir:
        log("[CRITICAL] --output and --tempdir are required for processing actions.")
        sys.exit(1)

    emit({"type": "telemetry", "progress": 10, "eta": "Starting…"})
    success = False

    # ── Route Actions ──
    if args.action == "upscale":
        success = api_upscale(args.input, args.output)

    elif args.action == "target":
        if not args.target_kb:
            log("[CRITICAL] --target-kb required for target action.")
            sys.exit(1)
        success = process_target_size(
            args.input, args.output, args.format,
            args.target_kb, args.strip_exif, args.tempdir, metadata_dict
        )

    elif args.action == "compress":
        cmd = build_ffmpeg_args(args.input, args.output, args.format,
                                args.quality, args.strip_exif, metadata_dict)
        log(f"[COMPRESS] Running: {' '.join(cmd)}")
        emit({"type": "telemetry", "progress": 40, "eta": "Compressing…"})
        
        proc = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                              text=True, encoding='utf-8', errors='ignore')
        if proc.returncode != 0:
            log(f"[COMPRESS] FFmpeg stderr: {proc.stderr[:400]}")
        success = (proc.returncode == 0)

    # ── Final Telemetry Emission ──
    if success and os.path.exists(args.output):
        orig_bytes = os.path.getsize(args.input)
        new_bytes = os.path.getsize(args.output)
        
        # Guard against zero-byte original files avoiding division by zero
        if orig_bytes > 0:
            savings = max(0, int((1 - (new_bytes / orig_bytes)) * 100))
        else:
            savings = 0

        log(f"[DONE] {orig_bytes//1024} KB → {new_bytes//1024} KB ({savings}% saved) → {args.output}")
        emit({
            "type": "complete",
            "progress": 100,
            "original_bytes": orig_bytes,
            "new_bytes": new_bytes,
            "savings_percent": savings,
            "outputPath": args.output
        })
    else:
        log(f"[FAILED] Output not produced. success={success}, path={args.output}")
        sys.exit(1)

if __name__ == "__main__":
    main()