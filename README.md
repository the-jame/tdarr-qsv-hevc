# the-jame QSV HEVC Standardizer

A [Tdarr](https://tdarr.io) plugin that standardizes video libraries to HEVC (H.265)
using Intel Quick Sync Video — Intel Arc GPUs or 8th-gen+ Core iGPUs.

> **Note:** this plugin is **not yet in the official Tdarr plugin hub**, so it installs
> as a **local plugin** (see Installation below). This repo is the source of truth —
> check back here for updates.

## Why

I couldn't find a Tdarr plugin that did Intel QSV HEVC transcoding the way I wanted:
most were either too heavy, too generic, or didn't handle the details I care about —
true full-GPU pipelines, correct 10-bit handling, safe skips for content QSV can't
deal with, and preserving everything except the video stream. So I wrote my own.

It's deliberately opinionated: **one job, done well** — get a mixed library to
consistent HEVC at your target resolution, without re-encoding things that don't
need it.

## AI use disclosure

AI tools were used to create this project — **Google Gemini** and **GLM**
assisted with generating the plugin code and writing this documentation.
Everything has been reviewed and tested by me before release.

## Features

- **Full-GPU pipeline** — QSV decode → (optional) QSV scale → QSV encode. No CPU round-trips.
- **ICQ (Intelligent Constant Quality)** — pick a quality level, no bitrate math.
- **Never upscales** — files below the target resolution are left alone.
- **Two bitrate gates** — separate minimums for non-HEVC and existing HEVC, so you
  don't waste a lossy generation on files that won't shrink.
- **10-bit aware** — 10-bit SDR sources are re-encoded as HEVC Main10 to preserve bit depth.
- **HDR-safe** — HDR (PQ/HLG) and Dolby Vision sources are skipped rather than flattened to SDR.
- **Clean skips** — Hi10P, 4:2:2/4:4:4, 12-bit and other profiles QSV can't decode are
  skipped instead of failing jobs.
- **Keeps everything else** — audio, text subtitles, attachments, metadata and chapters
  are preserved; PGS/VobSub image subs are stripped; extra video/cover-art and data
  streams are dropped.
- Output is remuxed to **MKV**.

## Decision logic

| Condition | Action |
|---|---|
| Already HEVC at or below target | Skip |
| Below target (any codec) | Skip — no upscaling |
| Bitrate below its codec's minimum | Skip |
| Non-HEVC at target | Re-encode only if `reencode_at_target` is on |
| Above target | Downscale + encode to HEVC |

## Requirements

- Tdarr node with Intel QSV hardware: **Intel Arc** (A/E/D series) or **8th-gen+ Core iGPU**
- FFmpeg 5+ (bundled with current Tdarr nodes)
- Linux: QSV/VAAPI drivers installed and the Tdarr user in the `render`/`video` groups

## Installation (local plugin)

Because this plugin isn't in the official plugin hub, Tdarr loads it from the node's
**local** plugins folder. Local plugins live on your machine, survive Tdarr updates,
and are never overwritten by plugin-hub syncs.

### 1. Download the plugin file

Download `Tdarr_Plugin_the_jame_QSV_HEVC_Standardizer.js` from this repo
(**Code → Download ZIP**, or save the raw file directly). Make sure the filename
stays exactly as-is — it must match the plugin id.

### 2. Find your Tdarr **node**'s Plugins folder

The plugin runs on the **node** (the machine doing the transcoding), so the file
goes there — not on the server if they're separate machines.

- **Native install:** look next to your Tdarr node's data folder for: "Tdarr/Plugins/local/"

e.g. `C:\Tdarr\Plugins\local` on Windows or `/opt/Tdarr/Plugins/local` on Linux.
Create the `local` folder if it doesn't exist.
- **Docker:** the same folder is inside your mounted config volume — on the common
images that's under `.../server/Tdarr/Plugins/local` on the host. Use
`docker exec -it <container> sh` or a bind mount to place the file.

> Use the `local` folder, not `community`. The `community` folder is managed by
> Tdarr's plugin-hub sync and can be overwritten.

### 3. Restart the Tdarr node

Restart from the **Nodes** page in the web UI, or restart the container/service.
Plugins are only scanned at node startup.

### 4. Verify it loaded

In the web UI, open the **Plugins** page and search for `the-jame` or `QSV`.
You should see **the-jame QSV HEVC Standardizer (10-bit)** listed.

### 5. Add it to your flow

1. Open **Flows** and edit (or create) the flow attached to your library.
2. Drag in a **Plugin** element and select
 *the-jame QSV HEVC Standardizer (10-bit)*.
3. Configure the inputs (see below) and save the flow.

(If you use the older stack-based libraries instead of flows: **Libraries → your
library → Transcode options → Add plugin**, and pick it from the list.)

### Updating

Overwrite the `.js` file with the new version, then restart the node again. Your
configured inputs are kept, since the plugin id doesn't change.

## Configuration

| Input | Default | Description |
|---|---|---|
| `target_resolution` | 720 | Max output height (480/720/1080). Taller files are downscaled, aspect preserved. |
| `minimum_bitrate` | 1800 | Skip non-HEVC sources below this bitrate (kbps). `0` disables. |
| `minimum_hevc_bitrate` | 3000 | Skip existing HEVC below this bitrate (kbps). `0` disables. |
| `reencode_at_target` | true | Also re-encode non-HEVC files already at the target resolution. |
| `icq_quality` | 20 | ICQ level (15 = reference … 27 = small files). |
| `encoder_preset` | slow | QSV speed preset (`veryfast` … `veryslow`). |
| `enable_lookahead` | true | LookAhead + EXTBRC. Disable on older iGPUs if encodes fail with driver errors. |

## Example generated command

2160p H.264 source → 1080p HEVC, ICQ 18:

```bash
ffmpeg -y -fflags +genpts -hwaccel qsv -hwaccel_output_format qsv \
-init_hw_device qsv:hw_any,child_device_type=vaapi -c:v h264_qsv \
-i "input.mkv" -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 \
-c copy -c:v:0 hevc_qsv -profile:v:0 main10 -global_quality:v:0 18 \
-preset:v:0 slow -look_ahead:v:0 1 -look_ahead_depth:v:0 40 -extbrc:v:0 1 \
-filter:v:0 scale_qsv=w=1920:h=1080:format=p010le \
-max_muxing_queue_size 9999 -f matroska "output.mkv"
