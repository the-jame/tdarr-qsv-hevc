# the-jame QSV HEVC Standardizer

A [Tdarr](https://tdarr.io) plugin that standardizes video libraries to HEVC (H.265)
using Intel Quick Sync Video — Intel Arc GPUs or 8th-gen+ Core iGPUs.

> **Note:** this plugin is **not yet in the official Tdarr plugin hub**, so it installs
> as a **local plugin** (see Installation below). This repo is the source of truth —
> check back here for updates.

## Why

I couldn't find a Tdarr plugin that did Intel QSV HEVC transcoding the way I wanted:
most were either too heavy, too generic, or didn't handle the specific details I care about
like correct 10-bit handling,  skips for content QSV can't deal with, and preserving 
everything except the video stream. So I wrote my own.

It's deliberately specific: **one job, done well** — get a mixed library to
consistent HEVC at your target resolution, without re-encoding things that don't
need it.

## AI use disclosure

AI tools were used to create this project: **Google Gemini** and **GLM**
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

Because this plugin isn't in the official plugin hub, Tdarr loads it from the
**local** plugins folder. Local plugins live on your machine, survive Tdarr updates,
and are never overwritten by plugin-hub syncs.

It's a three-step job: create the file, paste the code in, restart Tdarr.

### 1. Create the plugin file

The file goes in the node's `Tdarr/Plugins/Local/` folder — on Docker, that's inside
whatever host folder you mapped to `/app/server`. With a bind mount like
`- ${CONFIG_ROOT}/tdarr/server:/app/server`, the plugins folder on the host is
`${CONFIG_ROOT}/tdarr/server/Tdarr/Plugins/Local`:

```bash
mkdir -p ${CONFIG_ROOT}/tdarr/server/Tdarr/Plugins/Local
touch ${CONFIG_ROOT}/tdarr/server/Tdarr/Plugins/Local/Tdarr_Plugin_the_jame_QSV_HEVC_Standardizer.js
```

The filename must match the plugin id exactly — Tdarr registers local plugins by
their filename. (Native installs are the same idea: `Tdarr/Plugins/Local/` inside
your Tdarr data directory. Alternatively, place the file via
`docker exec -it <container> sh` using the in-container path
`/app/server/Tdarr/Plugins/Local/`.)

### 2. Paste the plugin code in

Copy the full contents of `Tdarr_Plugin_the_jame_QSV_HEVC_Standardizer.js` from this
repo (**Code → Download ZIP**, or open the raw file and copy) and paste it into the
file you just created. Save.

> Keep it out of the `community` folder — that one is managed by Tdarr's plugin-hub
> sync and can be overwritten.

### 3. Restart Tdarr

Restart the container (or restart the node from the **Nodes** page). Plugins are
only scanned at startup, so nothing shows up until Tdarr restarts. If your transcode
nodes run on separate machines, place the same file in each node's plugins folder.

### 4. Confirm it loaded

In the web UI, open **Classic → Plugins → Local** — you should see
**the-jame QSV HEVC Standardizer (10-bit)** listed. Add it to your flow
(**Flows** → drag in a **Plugin** element → select it → configure the inputs below).

### Updating

Paste the new code over the old and restart Tdarr again. Your configured inputs are
kept, since the plugin id doesn't change.

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
```
