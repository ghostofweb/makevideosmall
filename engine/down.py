import os
import sys
import zipfile
import urllib.request
import subprocess
import shutil

# ================= CONFIGURATION =================
INPUT_FILE = "input.mp4"
OUTPUT_FILE = "final_professional.mkv"
# This is a permanent link to the latest Windows build of Av1an
AV1AN_URL = "https://nightly.link/rust-av/av1an/workflows/ci/master/av1an-x86_64-pc-windows-msvc.zip"
# =================================================

def log(msg):
    print(f">>> {msg}")

def check_tool(name):
    """Checks if a tool is available in PATH or current folder."""
    if shutil.which(name) or os.path.exists(name) or os.path.exists(name + ".exe"):
        return True
    return False

def get_av1an():
    """Downloads and installs Av1an locally if missing."""
    if os.path.exists("av1an.exe"):
        log("Av1an is already installed locally.")
        return

    log("Av1an not found. Downloading via Python...")
    zip_name = "av1an_temp.zip"
    
    try:
        # 1. Download
        log(f"Downloading from: {AV1AN_URL}")
        urllib.request.urlretrieve(AV1AN_URL, zip_name)
        
        # 2. Extract
        log("Extracting...")
        with zipfile.ZipFile(zip_name, 'r') as zip_ref:
            # Look for the .exe inside the zip (it might be in a subfolder)
            exe_name = None
            for file in zip_ref.namelist():
                if file.endswith("av1an.exe"):
                    exe_name = file
                    break
            
            if not exe_name:
                raise Exception("av1an.exe not found in the downloaded zip!")
                
            # Extract just that file
            zip_ref.extract(exe_name)
            
            # Move it to current dir if it was in a subfolder
            if exe_name != "av1an.exe":
                shutil.move(exe_name, "av1an.exe")
                # Clean up empty folders if any
                if "/" in exe_name or "\\" in exe_name:
                    folder = os.path.dirname(exe_name)
                    if os.path.exists(folder):
                        shutil.rmtree(folder)

        # 3. Cleanup
        os.remove(zip_name)
        log("Av1an successfully installed.")

    except Exception as e:
        log(f"ERROR: Could not download Av1an. \n{e}")
        if os.path.exists(zip_name): os.remove(zip_name)
        sys.exit(1)

def run_av1an():
    # 1. Check Dependencies
    get_av1an() # Ensure Av1an is here
    
    if not check_tool("ffmpeg"):
        log("ERROR: FFmpeg is missing. Please install it or put ffmpeg.exe here.")
        return

    if not check_tool("mkvmerge"):
        log("WARNING: mkvmerge (MKVToolNix) might be missing.")
        log("If the script fails at the end, install MKVToolNix: 'winget install MKVToolNix.MKVToolNix'")

    # 2. Construct Command
    # We use .\av1an.exe to force using the local copy we just downloaded
    cmd = [
        ".\\av1an.exe",
        "-i", INPUT_FILE,
        "-y",               # Overwrite output
        "--verbose",        # Show progress
        "-e", "svt-av1",    # Use SVT-AV1 encoder
        "--target-quality", "95", # VMAF 95 (Visually near-lossless)
        "-v", " --preset 4 --film-grain 10 --tune 0 ", # Encoder settings
        "-w", "4",          # 4 Workers (Split video into 4 parts)
        "--split-method", "av-scenechange", # Smart scene splitting
        "-o", OUTPUT_FILE
    ]

    log("Starting Professional Compression...")
    log("This will chop the video into chunks and encode them in parallel.")
    
    try:
        # Run and stream output to console
        process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True)
        for line in process.stdout:
            print(line, end='')
        process.wait()
        
        if process.returncode == 0:
            log(f"DONE! File saved to: {OUTPUT_FILE}")
        else:
            log("Av1an finished with an error.")
            
    except Exception as e:
        log(f"Execution failed: {e}")

if __name__ == "__main__":
    run_av1an()