// ═══════════════════════════════════════════════════════════════════════
//  the-jame · QSV HEVC Standardizer
// ───────────────────────────────────────────────────────────────────────
//  Standardizes video to HEVC (H.265) using Intel Quick Sync Video —
//  Intel Arc GPUs or 8th-gen+ Intel Core iGPUs.
//
//  · Full-GPU pipeline: QSV decode → optional QSV scale → QSV encode
//  · ICQ (Intelligent Constant Quality) — no target-bitrate math
//  · Separate minimum-bitrate gates for HEVC vs non-HEVC sources
//  · Never upscales — only downscales above the target resolution
//  · Outputs 10-bit HEVC Main10 (p010le) for all encodes to prevent banding.
//  · Skips HDR (PQ/HLG/Dolby Vision) — output would be flattened to SDR
//  · Skips profiles QSV cannot decode (Hi10P, 4:2:2/4:4:4, 12-bit)
//  · Strips PGS/VobSub image subtitles; converts mp4 text subs to SRT
//  · Keeps audio, text subtitles, attachments, metadata and chapters
//
//  © the-jame · MIT License
// ═══════════════════════════════════════════════════════════════════════

const details = () => ({
  id: 'Tdarr_Plugin_the_jame_QSV_HEVC_Standardizer',
  Stage: 'Pre-processing',
  Name: 'the-jame QSV HEVC Standardizer (10-bit)',
  Type: 'Video',
  Operation: 'Transcode',
  Description: `Encodes video to HEVC using Intel Quick Sync Video (QSV).
    \n\n==LOGIC==
    \n• Already HEVC in the target resolution class → SKIP
    \n• Below the target resolution class (any codec) → SKIP (no upscaling)
    \n• Non-HEVC bitrate below its minimum → SKIP
    \n• Existing HEVC bitrate below its separate minimum → SKIP
    \n• Non-HEVC in the target resolution class → re-encode only if reencode_at_target is on
    \n• Above the target resolution class → downscale + HEVC encode
    \n• Letterboxed/cropped files (e.g. 1920x800) are classified by width — never stretched to the target height
    \n• PGS and VobSub subtitles are removed; mp4-style text subs are converted to SRT
    \n• Audio, text subtitles, supported attachments, metadata, and chapters are preserved
    \n• Extra video/cover-art streams and unsupported data streams are dropped
    \n• 10-bit SDR sources are re-encoded as HEVC Main10 to preserve bit depth
    \n• HDR (PQ/HLG/Dolby Vision) is skipped - it cannot be preserved by this SDR encoder
    \n• Outputs 10-bit HEVC Main10 (p010le) for all encodes to prevent banding.
    \n\nUses ICQ (Intelligent Constant Quality) — no target bitrate math required.
    \nRequires Intel Arc GPU or 8th-gen+ iGPU with QSV support.
    \n\nMaintained by the-jame.`,
  Version: '2.1.0',
  Tags: 'the_jame,pre-processing,ffmpeg,video,qsv,h265,hevc,10bit,icq,configurable',
  Inputs: [
    {
      name: 'target_resolution',
      type: 'number',
      defaultValue: 720,
      inputUI: {
        type: 'dropdown',
        options: [
          '480',
          '720',
          '1080',
        ],
      },
      tooltip: `Target resolution class (480/720/1080).
        Files above the class are downscaled with aspect ratio preserved.
        Letterboxed/cropped files are classified by width
        (e.g. 1920x800 counts as 1080p-class) and are never stretched
        to the target height.
        Files already HEVC in the target class are skipped.
        Genuinely smaller files are skipped — no upscaling.`,
    },
    {
      name: 'minimum_bitrate',
      type: 'number',
      defaultValue: 1800,
      inputUI: {
        type: 'text',
      },
      tooltip: `Minimum video bitrate in kbps for non-HEVC sources.
        Non-HEVC files below this bitrate are skipped.
        Set to 0 to disable this check.
        Recommended: 1800 for general libraries.`,
    },
    {
      name: 'minimum_hevc_bitrate',
      type: 'number',
      defaultValue: 3000,
      inputUI: {
        type: 'text',
      },
      tooltip: `Minimum video bitrate in kbps for existing HEVC sources.
        HEVC files below this bitrate are skipped to avoid an unnecessary
        second lossy encode with limited likely size savings.
        Set to 0 to disable this separate HEVC check.
        Recommended: 3000 for 1080p HEVC sources.`,
    },
    {
      name: 'reencode_at_target',
      type: 'boolean',
      defaultValue: true,
      inputUI: {
        type: 'dropdown',
        options: [
          'false',
          'true',
        ],
      },
      tooltip: `Re-encode non-HEVC files already at the target resolution.
        false: Only downscale files above the target resolution.
        true: Also re-encode non-HEVC files at the target resolution to HEVC.
        Files above the target resolution are processed regardless.
        (Renamed from reencode_720p in v1.x — applies at any target.)`,
    },
    {
      name: 'icq_quality',
      type: 'string',
      defaultValue: '20',
      inputUI: {
        type: 'dropdown',
        options: [
          'Reference (15)',
          'Excellent (18)',
          'Very Good (19)',
          'Very High (20)',
          'High (21)',
          'Balanced (22)',
          'Size Savings (24)',
          'Compact (27)',
        ],
      },
      tooltip: `ICQ quality level for HEVC QSV encoding.
        Lower number = higher quality and larger files.
        \n15: Reference — archival/remux only; massive files, often bloats Web-DLs
        \n18: Excellent — near-lossless grain retention; heavy bitrate penalty
        \n19: Very Good — transparent for high-bitrate 1080p Blu-rays; limited savings on Web-DLs
        \n20: Very High — great for clean 1080p movies (default)
        \n21: High — sweet spot for 1080p movies; cuts noise bloat while keeping sharp detail
        \n22: Balanced — ideal for 720p/1080p TV shows; strong compression with minimal loss
        \n24: Size Savings — good for 4K content or aggressive 1080p space saving
        \n27: Compact — smallest files; noticeable softening/banding on dark scenes
        \nNote: unlike x265 CRF, ICQ results are not standardized.
        The same value can produce different sizes/quality across driver versions
        and GPU generations (Gen9.5 iGPU vs Intel Arc).`,
    },
    {
      name: 'encoder_preset',
      type: 'string',
      defaultValue: 'slow',
      inputUI: {
        type: 'dropdown',
        options: [
          'veryfast',
          'faster',
          'fast',
          'medium',
          'slow',
          'slower',
          'veryslow',
        ],
      },
      tooltip: `Encoder speed preset.
        Slower presets may improve compression at the same quality.
        'slow' is a good balance for an Intel Arc A380.`,
    },
    {
      name: 'enable_lookahead',
      type: 'boolean',
      defaultValue: true,
      inputUI: {
        type: 'dropdown',
        options: [
          'false',
          'true',
        ],
      },
      tooltip: `Enable LookAhead + EXTBRC rate-control refinement.
        Recommended on Intel Arc. Some 8th/9th-gen iGPU drivers do not
        support these options — set to false if encodes fail with
        look_ahead/extbrc driver errors.`,
    },
  ],
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const plugin = (file, librarySettings, inputs, otherArguments) => {
  const lib = require('../methods/lib')();
  const os = require('os');

  // eslint-disable-next-line no-param-reassign
  inputs = lib.loadDefaultValues(inputs, details);

  const response = {
    processFile: false,
    preset: '',
    handBrakeMode: false,
    FFmpegMode: true,
    reQueueAfter: false,
    infoLog: '',
    container: '.mkv',
  };

  // ── Validate FFprobe stream data ────────────────────────────────
  const streams = (
    file
    && file.ffProbeData
    && Array.isArray(file.ffProbeData.streams)
  )
    ? file.ffProbeData.streams
    : [];

  if (streams.length === 0) {
    response.infoLog += '☒ No FFprobe stream data found. Skipping.\n';
    return response;
  }

  // ── Load input settings ─────────────────────────────────────────
  const targetHeight = Number(inputs.target_resolution);
  const minBitrate = Number(inputs.minimum_bitrate);
  const minHevcBitrate = Number(inputs.minimum_hevc_bitrate);

  const reencodeAtTarget = inputs.reencode_at_target === true
    || inputs.reencode_at_target === 'true';

  const enableLookahead = inputs.enable_lookahead === true
    || inputs.enable_lookahead === 'true';

  const icqQuality = Number(
    String(inputs.icq_quality).match(/\d+/)?.[0] || 20,
  );

  const encoderPreset = inputs.encoder_preset;

  if (!Number.isFinite(targetHeight) || targetHeight <= 0) {
    response.infoLog += '☒ Invalid target resolution. Skipping.\n';
    return response;
  }

  // ── Find the main video stream ──────────────────────────────────
  const videoStreamIndex = streams.findIndex(
    (stream) => stream.codec_type
      && stream.codec_type.toLowerCase() === 'video'
      && stream.codec_name
      && !['mjpeg', 'png'].includes(stream.codec_name.toLowerCase())
      && !(stream.disposition && stream.disposition.attached_pic === 1),
  );

  if (videoStreamIndex === -1) {
    response.infoLog += '☒ No valid video stream found. Skipping.\n';
    return response;
  }

  const videoStream = streams[videoStreamIndex];

  const inputVideoIndex = Number.isInteger(videoStream.index)
    ? videoStream.index
    : videoStreamIndex;

  const codec = (videoStream.codec_name || '').toLowerCase();
  const width = Number(videoStream.width || 0);
  const height = Number(videoStream.height || 0);

  if (
    !Number.isFinite(width)
    || !Number.isFinite(height)
    || width <= 0
    || height <= 0
  ) {
    response.infoLog += `☒ Invalid source dimensions: `
      + `${width}x${height}. Skipping.\n`;
    return response;
  }

  response.infoLog += `Input: ${codec} ${width}x${height}.\n`;

  // ── HDR detection ───────────────────────────────────────────────
  // 8-bit SDR HEVC to 10-bit SDR HEVC
  // transfers or Dolby Vision metadata. Encoding an HDR source would
  // flatten it to SDR and strip colour metadata, so HDR is skipped.
  const colorTransfer = (videoStream.color_transfer || '').toLowerCase();
  const colorPrimaries = (videoStream.color_primaries || '').toLowerCase();

  const isHdrTransfer = colorTransfer === 'smpte2084'
    || colorTransfer === 'arib-std-b67';

  // Dolby Vision side data can exist even when colour tags are absent.
  const hasDolbyVision = (videoStream.side_data_list || []).some(
    (sideData) => sideData
      && typeof sideData.side_data_type === 'string'
      && sideData.side_data_type.toLowerCase().includes('dovi'),
  );

  if (isHdrTransfer || hasDolbyVision) {
    response.infoLog += '☑ HDR detected ('
      + (hasDolbyVision ? 'Dolby Vision' : `transfer=${colorTransfer}`)
      + (colorPrimaries ? `, primaries=${colorPrimaries}` : '')
      + '). This SDR QSV encode cannot preserve HDR - skipping '
      + 'to avoid flattening colours.\n';

    return response;
  }

  // ── Bit depth / decodability checks ─────────────────────────────
  const profile = (videoStream.profile || '').toLowerCase();
  const pixFmt = (videoStream.pix_fmt || '').toLowerCase();
  const bitsPerRawSample = String(videoStream.bits_per_raw_sample || '');

  const is10bit = profile === 'main 10'
    || profile === 'high 10'
    || profile === 'profile 2'
    || bitsPerRawSample === '10'
    || pixFmt.includes('10le')
    || pixFmt.includes('10be');

  // QSV cannot hardware-decode 10-bit H.264 (High 10 / Hi10P).
  if (codec === 'h264' && (profile.startsWith('high 10') || is10bit)) {
    response.infoLog += '☑ 10-bit H.264 (Hi10P) source. QSV cannot '
      + 'hardware-decode this codec, and this plugin has no software-decode '
      + 'path. Skipping to avoid a failed encode.\n';
    return response;
  }

  // QSV cannot decode 4:2:2 / 4:4:4 chroma sampling.
  if (
    profile.includes('4:2:2')
    || profile.includes('4:4:4')
    || pixFmt.includes('422')
    || pixFmt.includes('444')
  ) {
    response.infoLog += `☑ ${profile || pixFmt || '4:2:2/4:4:4'} source. QSV cannot `
      + 'hardware-decode this profile. Skipping to avoid a failed encode.\n';
    return response;
  }

  // 12-bit has no suitable QSV encode path here (Main10 only).
  if (
    profile.includes('main 12')
    || bitsPerRawSample === '12'
    || pixFmt.includes('12le')
    || pixFmt.includes('12be')
  ) {
    response.infoLog += '☑ 12-bit source. This plugin targets 8/10-bit '
      + 'QSV paths only. Skipping to avoid a failed encode.\n';
    return response;
  }

  response.infoLog += `${is10bit ? '10-bit' : '8-bit'} source detected - `
    + 'encoding to 10-bit HEVC Main10.\n';


  // ── Determine video bitrate ─────────────────────────────────────
  let videoBitrate = 0;

  // Attempt 1: MediaInfo video track (matched by type, not index,
  // so stream-order differences cannot break the lookup).
  try {
    const tracks = (
      file.mediaInfo
      && Array.isArray(file.mediaInfo.track)
    )
      ? file.mediaInfo.track
      : [];

    const miVideo = tracks.find(
      (track) => track
        && (track['@type'] === 'Video' || track.type === 'Video'),
    );

    const br = Number(
      miVideo ? (miVideo.BitRate || miVideo.BitRate_Nominal || 0) : 0,
    );

    if (br > 0) {
      videoBitrate = Math.round(br / 1000);
    }
  } catch (e) {
    // Ignore MediaInfo bitrate lookup failure.
  }

  // Attempt 2: FFprobe direct stream bit_rate (MP4/MOV/TS) or BPS tag (MKV).
  if (videoBitrate <= 0) {
    try {
      const directBr = Number(videoStream.bit_rate || 0);
      const tags = videoStream.tags || {};
      const tagBps = Number(tags.BPS || tags['BPS-eng'] || 0);
      const br = directBr > 0 ? directBr : tagBps;

      if (br > 0) {
        videoBitrate = Math.round(br / 1000);
      }
    } catch (e) {
      // Ignore stream bitrate lookup failure.
    }
  }

  // Attempt 3: Estimate from container bit_rate or file size and duration.
  if (videoBitrate <= 0) {
    try {
      const format = (file.ffProbeData && file.ffProbeData.format) || {};
      const formatBr = Number(format.bit_rate || 0);

      if (formatBr > 0) {
        videoBitrate = Math.round(formatBr / 1000);
      } else {
        const probeDuration = Number(format.duration || 0);
        const metaDuration = (file.meta && file.meta.Duration)
          ? (new Date(`1970-01-01T${file.meta.Duration}Z`).getTime()) / 1000
          : 0;
        const durationSec = probeDuration > 0 ? probeDuration : metaDuration;

        if (Number.isFinite(durationSec) && durationSec > 0 && file.file_size > 0) {
          videoBitrate = Math.round(
            (file.file_size * 8) / durationSec / 1000,
          );
        }
      }
    } catch (e) {
      // Ignore estimated bitrate lookup failure.
    }
  }

  if (videoBitrate > 0) {
    response.infoLog += `Video bitrate: ${videoBitrate} kbps.\n`;
  } else {
    response.infoLog += '⚠ Could not determine video bitrate. '
      + 'Proceeding without bitrate checks.\n';
  }

  // ═════════════════════════════════════════════════════════════════
  // GATE 1: Codec-specific minimum bitrate
  // ═════════════════════════════════════════════════════════════════
  const applicableMinBitrate = codec === 'hevc'
    ? minHevcBitrate
    : minBitrate;

  const thresholdName = codec === 'hevc'
    ? 'HEVC minimum'
    : 'non-HEVC minimum';

  if (
    Number.isFinite(applicableMinBitrate)
    && applicableMinBitrate > 0
    && videoBitrate > 0
    && videoBitrate < applicableMinBitrate
  ) {
    response.infoLog += `☑ Bitrate ${videoBitrate} kbps < `
      + `${thresholdName} ${applicableMinBitrate} kbps. Skipping.\n`;

    return response;
  }

  if (
    videoBitrate > 0
    && Number.isFinite(applicableMinBitrate)
    && applicableMinBitrate > 0
  ) {
    response.infoLog += `Bitrate meets ${thresholdName}: `
      + `${videoBitrate} ≥ ${applicableMinBitrate} kbps.\n`;
  }

  // ═════════════════════════════════════════════════════════════════
  // Check Effective Resolution Class
  // (Accounts for cropped/letterboxed movies like 1920x800)
  // ═════════════════════════════════════════════════════════════════
  let isTargetResolution = false;
  let isBelowTarget = false;

  if (targetHeight === 1080) {
    isTargetResolution = (height >= 1040 && height <= 1080 && width <= 1920)
      || (width >= 1900 && width <= 1920 && height <= 1080);
    isBelowTarget = !isTargetResolution && height < 1080 && width < 1920;
  } else if (targetHeight === 720) {
    isTargetResolution = (height >= 690 && height <= 720 && width <= 1280)
      || (width >= 1260 && width <= 1280 && height <= 720);
    isBelowTarget = !isTargetResolution && height < 720 && width < 1280;
  } else if (targetHeight === 480) {
    isTargetResolution = (height >= 460 && height <= 480 && width <= 854)
      || (width >= 700 && width <= 854 && height <= 480);
    isBelowTarget = !isTargetResolution && height < 480 && width < 854;
  } else {
    // Fallback for custom heights
    isTargetResolution = height === targetHeight;
    isBelowTarget = height < targetHeight;
  }

  // ═════════════════════════════════════════════════════════════════
  // GATE 2: Already HEVC at the target resolution
  // ═════════════════════════════════════════════════════════════════
  if (codec === 'hevc' && isTargetResolution) {
    response.infoLog += `☑ Already HEVC at target resolution `
      + `(Width: ${width}). Skipping.\n`;

    return response;
  }

  // ═════════════════════════════════════════════════════════════════
  // GATE 3: Below target resolution — never upscale
  // ═════════════════════════════════════════════════════════════════
  if (isBelowTarget) {
    response.infoLog += `☑ Resolution (W:${width} x H:${height}) is below `
      + `target ${targetHeight}p class. Skipping (no upscaling).\n`;

    return response;
  }

  // ═════════════════════════════════════════════════════════════════
  // GATE 4: At target resolution but not HEVC
  // ═════════════════════════════════════════════════════════════════
  if (isTargetResolution && codec !== 'hevc' && !reencodeAtTarget) {
    response.infoLog += `☑ ${codec} at target resolution — `
      + 'reencode_at_target is off. Skipping.\n';

    return response;
  }

  // ── Supported QSV input decoders ────────────────────────────────
  const qsvDecoders = {
    mpeg2: 'mpeg2_qsv',
    mpeg2video: 'mpeg2_qsv',
    vc1: 'vc1_qsv',
    h264: 'h264_qsv',
    hevc: 'hevc_qsv',
    vp9: 'vp9_qsv',
    av1: 'av1_qsv',
  };

  const inputDecoder = qsvDecoders[codec];

  if (!inputDecoder) {
    response.infoLog += `☑ No configured QSV decoder for ${codec}. `
      + 'Skipping to avoid an unreliable encode.\n';

    return response;
  }

  // ═════════════════════════════════════════════════════════════════
  // Proceed with encoding
  // ═════════════════════════════════════════════════════════════════
  const needsResize = !isTargetResolution && !isBelowTarget;

  if (needsResize) {
    response.infoLog += `☒ ${codec} ${width}x${height} → downscaling to `
      + `target ${targetHeight}p class HEVC.\n`;
  } else {
    response.infoLog += `☒ ${codec} at target resolution class → `
      + 're-encoding to HEVC.\n';
  }

  // Calculate new dimensions preserving exact aspect ratio.
  // Bound by both max width (16:9 box) and max height so 4:3 content
  // (e.g. 1440x1080 -> 960x720) scales down properly without stretching.
  const baseTargetWidth = targetHeight === 1080 ? 1920
    : targetHeight === 720 ? 1280
      : targetHeight === 480 ? 854
        : Math.round(targetHeight * (16 / 9));

  const scaleFactor = needsResize
    ? Math.min(baseTargetWidth / width, targetHeight / height, 1)
    : 1;

  const rawTargetWidth = width * scaleFactor;
  const rawTargetHeight = height * scaleFactor;

  // QSV requires even output dimensions (round to nearest even integer).
  const evenTargetWidth = Math.round(rawTargetWidth / 2) * 2;
  const evenTargetHeight = Math.round(rawTargetHeight / 2) * 2;

  if (evenTargetWidth <= 0 || evenTargetHeight <= 0) {
    response.infoLog += `☒ Invalid calculated output dimensions: `
      + `${evenTargetWidth}x${evenTargetHeight}. Skipping.\n`;

    return response;
  }

  // ── Build FFmpeg preset ─────────────────────────────────────────
  // Requires FFmpeg 5+ (bundled with current Tdarr nodes).
  const platform = os.platform();

  response.preset = '-fflags +genpts ';

  if (platform === 'linux') {
    response.preset += '-hwaccel qsv '
      + '-hwaccel_output_format qsv '
      + '-init_hw_device qsv:hw_any,child_device_type=vaapi ';
  } else if (platform === 'win32') {
    response.preset += '-hwaccel qsv '
      + '-hwaccel_output_format qsv '
      + '-init_hw_device qsv:hw,child_device_type=d3d11va ';
  } else {
    response.preset += '-hwaccel qsv '
      + '-hwaccel_output_format qsv '
      + '-init_hw_device qsv:hw_any ';
  }

  // Decoder must appear before Tdarr inserts the input.
  response.preset += `-c:v ${inputDecoder} `;
  response.preset += '<io> ';

  // Map only the selected main video stream.
  response.preset += `-map 0:${inputVideoIndex} `;

  // Preserve non-video streams except image-based subtitles.
  const strippedSubtitleCodecs = [
    'hdmv_pgs_subtitle',
    'dvd_subtitle',
  ];

  const subtitleCodecOverrides = [];
  let strippedCount = 0;
  let droppedExtraVideoCount = 0;
  let subtitleOutIndex = 0;

  streams.forEach((stream, arrayIndex) => {
    const streamType = (stream.codec_type || '').toLowerCase();
    const streamCodec = (stream.codec_name || '').toLowerCase();

    const streamIndex = Number.isInteger(stream.index)
      ? stream.index
      : arrayIndex;

    // Main video was already mapped above.
    if (streamIndex === inputVideoIndex) {
      return;
    }

    // Avoid accidentally encoding cover art or secondary video tracks.
    if (streamType === 'video') {
      droppedExtraVideoCount += 1;
      return;
    }

    const isStrippedSubtitle = streamType === 'subtitle'
      && strippedSubtitleCodecs.includes(streamCodec);

    if (isStrippedSubtitle) {
      strippedCount += 1;
      return;
    }

    // Matroska output cannot safely accept arbitrary data streams.
    // Keep audio, subtitles, and supported attachments only.
    const isAllowedStream = [
      'audio',
      'subtitle',
      'attachment',
    ].includes(streamType);

    if (!isAllowedStream) {
      response.infoLog += `Dropping unsupported stream 0:${streamIndex} `
        + `(${streamType || 'unknown'}${streamCodec ? `/${streamCodec}` : ''}).\n`;
      return;
    }

    response.preset += `-map 0:${streamIndex} `;

    if (streamType === 'subtitle') {
      // mov_text/tx3g has no Matroska equivalent — convert to SRT.
      // Overrides are emitted after '-c copy' so they take effect.
      if (streamCodec === 'mov_text' || streamCodec === 'tx3g') {
        subtitleCodecOverrides.push(`-c:s:${subtitleOutIndex} srt `);
      }

      subtitleOutIndex += 1;
    }
  });

  // Preserve container metadata and chapters.
  response.preset += '-map_metadata 0 -map_chapters 0 ';

  // Copy all mapped streams, then override the main video encoder to 10-bit Main10.
  response.preset += '-c copy '
    + '-c:v:0 hevc_qsv '
    + '-profile:v:0 main10 '
    + `-global_quality:v:0 ${icqQuality} `
    + `-preset:v:0 ${encoderPreset} `;

  if (enableLookahead) {
    response.preset += '-look_ahead:v:0 1 '
      + '-look_ahead_depth:v:0 40 '
      + '-extbrc:v:0 1 ';
  }

  // Per-stream subtitle codec overrides (must follow '-c copy').
  response.preset += subtitleCodecOverrides.join('');

  // Hardware frames come from the QSV decoder.
  // scale_qsv converts 8-bit NV12 surfaces to 10-bit p010le on the GPU
  // (and resizes when needed) so the encoder always outputs 10-bit Main10.
  if (needsResize) {
    response.preset += `-filter:v:0 scale_qsv=`
      + `w=${evenTargetWidth}:h=${evenTargetHeight}:format=p010le `;
  } else if (!is10bit) {
    response.preset += '-filter:v:0 scale_qsv=format=p010le ';
  }

  response.preset += '-max_muxing_queue_size 9999 '
    + '-f matroska';

  if (strippedCount > 0) {
    response.infoLog += `Stripping ${strippedCount} image-based `
      + 'subtitle track(s).\n';
  }

  if (droppedExtraVideoCount > 0) {
    response.infoLog += `Dropping ${droppedExtraVideoCount} additional `
      + 'video or cover-art stream(s); only the main video is retained.\n';
  }

  response.processFile = true;
  // Re-queue so plugins later in the flow run against the new file.
  response.reQueueAfter = true;

  response.infoLog += `Encoding: ICQ ${icqQuality}, preset `
    + `${encoderPreset}, → HEVC Main10 `
    + `${evenTargetWidth}x${evenTargetHeight}.\n`;

  return response;
};

module.exports.details = details;
module.exports.plugin = plugin;
