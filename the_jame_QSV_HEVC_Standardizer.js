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
//  · Preserves 10-bit SDR sources as HEVC Main10 (p010le)
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
    \n• Already HEVC at or below target resolution → SKIP
    \n• Below target resolution (any codec) → SKIP (no upscaling)
    \n• Non-HEVC bitrate below its minimum → SKIP
    \n• Existing HEVC bitrate below its separate minimum → SKIP
    \n• Non-HEVC at target resolution → re-encode only if reencode_at_target is on
    \n• Anything above target resolution → downscale + HEVC encode
    \n• PGS and VobSub subtitles are removed; mp4-style text subs are converted to SRT
    \n• Audio, text subtitles, supported attachments, metadata, and chapters are preserved
    \n• Extra video/cover-art streams and unsupported data streams are dropped
    \n• 10-bit SDR sources are re-encoded as HEVC Main10 to preserve bit depth
    \n• HDR (PQ/HLG/Dolby Vision) is skipped - it cannot be preserved by this SDR encoder
    \n• Hi10P, 4:2:2/4:4:4 and 12-bit sources are skipped (QSV cannot decode them)
    \n\nUses ICQ (Intelligent Constant Quality) — no target bitrate math required.
    \nRequires Intel Arc GPU or 8th-gen+ iGPU with QSV support.
    \n\nMaintained by the-jame.`,
  Version: '2.0.0',
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
      tooltip: `Target maximum video height in pixels.
        Files taller than this are downscaled with aspect ratio preserved.
        Files already HEVC at or below this resolution are skipped.
        Files below this resolution are skipped — no upscaling.`,
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
          'Very High (20)',
          'Balanced (24)',
          'Compact (27)',
        ],
      },
      tooltip: `ICQ quality level for HEVC QSV encoding.
        Lower number = higher quality and larger files.
        \n15: Reference — highest quality, largest files
        \n18: Excellent
        \n20: Very High (default)
        \n24: Balanced
        \n27: Compact — smallest files
        \nNote: unlike x265 CRF, ICQ results are not standardized.
        The same value can produce slightly different sizes/quality
        across driver versions and GPU generations (Gen9.5 iGPU vs Arc).`,
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
  // This encoder produces 8-bit SDR HEVC. It cannot carry PQ/HLG
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
  const bitsPerRawSample = String(videoStream.bits_per_raw_sample || '');

  const is10bit = profile === 'main 10'
    || profile === 'high 10'
    || bitsPerRawSample === '10';

  // QSV cannot hardware-decode 10-bit H.264 (High 10 / Hi10P).
  if (codec === 'h264' && profile.startsWith('high 10')) {
    response.infoLog += '☑ 10-bit H.264 (Hi10P) source. QSV cannot '
      + 'hardware-decode this codec, and this plugin has no software-decode '
      + 'path. Skipping to avoid a failed encode.\n';
    return response;
  }

  // QSV cannot decode 4:2:2 / 4:4:4 chroma sampling.
  if (profile.includes('4:2:2') || profile.includes('4:4:4')) {
    response.infoLog += `☑ ${profile || '4:2:2/4:4:4'} source. QSV cannot `
      + 'hardware-decode this profile. Skipping to avoid a failed encode.\n';
    return response;
  }

  // 12-bit has no suitable QSV encode path here (Main10 only).
  if (profile.includes('main 12') || bitsPerRawSample === '12') {
    response.infoLog += '☑ 12-bit source. This plugin targets 8/10-bit '
      + 'QSV paths only. Skipping to avoid a failed encode.\n';
    return response;
  }

  if (is10bit) {
    response.infoLog += '10-bit source detected - encoding to HEVC Main10 '
      + 'to preserve bit depth.\n';
  }

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

  // Attempt 2: FFprobe stream BPS tag.
  if (videoBitrate <= 0) {
    try {
      const tags = videoStream.tags || {};
      const bps = tags.BPS || tags['BPS-eng'];

      if (bps && Number(bps) > 0) {
        videoBitrate = Math.round(Number(bps) / 1000);
      }
    } catch (e) {
      // Ignore stream-tag bitrate lookup failure.
    }
  }

  // Attempt 3: Estimate from file size and duration.
  // file.file_size is BYTES: kbps = bytes * 8 / seconds / 1000.
  // Note: the estimate includes audio + container overhead, so it
  // errs high (permissive) compared to the true video bitrate.
  if (videoBitrate <= 0) {
    try {
      if (file.meta && file.meta.Duration && file.file_size > 0) {
        const durationSec = (
          new Date(`1970-01-01T${file.meta.Duration}Z`).getTime()
        ) / 1000;

        if (Number.isFinite(durationSec) && durationSec > 0) {
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
  // GATE 2: Already HEVC at the target resolution
  // (below target is handled by Gate 3, above by downscaling)
  // ═════════════════════════════════════════════════════════════════
  if (codec === 'hevc' && height === targetHeight) {
    response.infoLog += `☑ Already HEVC at ${height}p `
      + `(= target ${targetHeight}p). Skipping.\n`;

    return response;
  }

  // ═════════════════════════════════════════════════════════════════
  // GATE 3: Below target resolution — never upscale
  // ═════════════════════════════════════════════════════════════════
  if (height < targetHeight) {
    response.infoLog += `☑ Resolution ${height}p < target `
      + `${targetHeight}p. Skipping (no upscaling).\n`;

    return response;
  }

  // ═════════════════════════════════════════════════════════════════
  // GATE 4: At target resolution but not HEVC
  // ═════════════════════════════════════════════════════════════════
  if (
    height === targetHeight
    && codec !== 'hevc'
    && !reencodeAtTarget
  ) {
    response.infoLog += `☑ ${codec} at ${targetHeight}p — `
      + 'reencode_at_target is off. Skipping.\n';

    return response;
  }

  // ── Supported QSV input decoders ────────────────────────────────
  const qsvDecoders = {
    mpeg2: 'mpeg2_qsv',
    mpeg2video: 'mpeg2_qsv',
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
  const needsResize = height > targetHeight;

  if (needsResize) {
    response.infoLog += `☒ ${codec} ${height}p → downscaling to `
      + `${targetHeight}p HEVC.\n`;
  } else {
    response.infoLog += `☒ ${codec} at ${targetHeight}p → `
      + 're-encoding to HEVC.\n';
  }

  const rawTargetWidth = needsResize
    ? width * (targetHeight / height)
    : width;

  // QSV requires even output dimensions.
  const evenTargetWidth = Math.floor(rawTargetWidth / 2) * 2;
  const evenTargetHeight = Math.floor(targetHeight / 2) * 2;

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

  // Copy all mapped streams, then override the main video encoder.
  const profileFlag = is10bit ? '-profile:v:0 main10 ' : '';

  response.preset += '-c copy '
    + '-c:v:0 hevc_qsv '
    + profileFlag
    + `-global_quality:v:0 ${icqQuality} `
    + `-preset:v:0 ${encoderPreset} `;

  if (enableLookahead) {
    response.preset += '-look_ahead:v:0 1 '
      + '-look_ahead_depth:v:0 40 '
      + '-extbrc:v:0 1 ';
  }

  // Per-stream subtitle codec overrides (must follow '-c copy').
  response.preset += subtitleCodecOverrides.join('');

  // Hardware frames already come from the QSV decoder.
  // Add a filter only when resizing is needed.
  if (needsResize) {
    const formatSuffix = is10bit ? ':format=p010le' : '';
    response.preset += `-filter:v:0 scale_qsv=`
      + `w=${evenTargetWidth}:h=${evenTargetHeight}${formatSuffix} `;
  }

  response.preset += '-max_muxing_queue_size 9999 '
    + '-f matroska';

  if (strippedCount > 0) {
    response.infoLog += `Stripping ${strippedCount} PGS/VobSub `
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
    + `${encoderPreset}, → HEVC `
    + `${evenTargetWidth}x${evenTargetHeight}`
    + (is10bit ? ' Main10' : '')
    + '.\n';

  return response;
};

module.exports.details = details;
module.exports.plugin = plugin;
