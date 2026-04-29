const fs = require('fs');
const path = require('path');
const { chromium } = require(path.resolve(__dirname, '..', 'ui', 'node_modules', 'playwright'));

const resultPath = path.resolve(__dirname, 'cdp-result.json');
const inputPath = path.resolve(__dirname, 'input.mp4');
const outputPath = path.resolve(__dirname, 'portable-export.mp4');

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  const context = browser.contexts()[0];
  const page = context.pages().find((p) => p.url().startsWith('file://')) || context.pages()[0];

  await page.waitForFunction(
    () => window.xleth && window.xleth.project && window.xleth.timeline && window.xleth.audio,
    null,
    { timeout: 30000 },
  );

  const result = await page.evaluate(async ({ inputPath, outputPath }) => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const xleth = window.xleth;
    const projectDir = `C:\\Temp\\xleth-portable-test\\verify-project-${Date.now()}`;
    const ppq = 960;
    const out = {
      locationHref: window.location.href,
      projectDir,
      inputPath,
      outputPath,
    };

    out.projectCreated = await xleth.project.create(projectDir, 'PortableVerify');
    out.projectInfo = await xleth.project.getInfo();
    out.sourceId = await xleth.project.importSource(inputPath);
    out.sourcesAfterImport = await xleth.timeline.getSources();

    const source = out.sourcesAfterImport.find((item) => item.id === out.sourceId) || out.sourcesAfterImport.at(-1);
    const duration = Math.max(1, Math.min(4, source?.duration || 4));

    out.trackIds = {
      chorus: await xleth.timeline.addTrack({ name: 'Chorus', volume: 1, order: 0 }),
      pitch: await xleth.timeline.addTrack({ name: 'Pitch', volume: 1, order: 1 }),
      percussion: await xleth.timeline.addTrack({ name: 'Percussion', volume: 1, order: 2 }),
    };
    if (xleth.timeline.setChorusTrack) {
      await xleth.timeline.setChorusTrack(out.trackIds.chorus);
    }

    out.regionId = await xleth.timeline.addRegion({
      sourceId: out.sourceId,
      name: 'Quote 1',
      label: 'Pitch',
      startTime: 0,
      endTime: duration,
    });

    out.clipIds = [
      await xleth.timeline.addClip({
        trackId: out.trackIds.chorus,
        regionId: out.regionId,
        positionTicks: 0,
        durationTicks: 4 * ppq,
        velocity: 1,
      }),
      await xleth.timeline.addClip({
        trackId: out.trackIds.pitch,
        regionId: out.regionId,
        positionTicks: 0,
        durationTicks: 4 * ppq,
        velocity: 1,
      }),
      await xleth.timeline.addClip({
        trackId: out.trackIds.percussion,
        regionId: out.regionId,
        positionTicks: 0,
        durationTicks: 4 * ppq,
        velocity: 1,
      }),
    ];

    for (let i = 0; i < 90; i += 1) {
      const regions = await xleth.timeline.getRegions();
      out.regionAfterProxyWait = regions.find((item) => item.id === out.regionId);
      if (out.regionAfterProxyWait?.proxyReady) break;
      await sleep(1000);
    }

    await xleth.timeline.setPreviewEffectsBypass(false);
    await xleth.play();
    await sleep(1800);
    out.transportWhilePlaying = await xleth.getTransportState();
    out.syncStats = await xleth.getSyncStats().catch((error) => ({ error: String(error?.message || error) }));
    out.frameSample = await xleth.getCurrentFrame()
      .then((frame) => {
        if (!frame) return null;
        if (typeof frame === 'string') return frame.slice(0, 64);
        return { type: typeof frame, keys: Object.keys(frame).slice(0, 12) };
      })
      .catch((error) => ({ error: String(error?.message || error) }));
    await xleth.stop();

    out.volumeSet = await xleth.audio.setTrackVolume(out.trackIds.pitch, 0.5);
    out.effect = {};
    try {
      const added = await xleth.audio.addEffect(out.trackIds.pitch, 'xletheq', 0);
      out.effect.nodeId = added?.nodeId ?? added;
      out.effect.chainAfterAdd = await xleth.audio.getEffectChain(out.trackIds.pitch);
      out.effect.bypassSet = await xleth.audio.setEffectBypass(out.trackIds.pitch, out.effect.nodeId, true);
      out.effect.chainAfterBypass = await xleth.audio.getEffectChain(out.trackIds.pitch);
    } catch (error) {
      out.effect.error = String(error?.message || error);
    }

    const bpm = await xleth.timeline.getBPM();
    out.exportConfig = {
      outputPath,
      videoCodec: 'h264',
      hwEncoder: '',
      width: 1280,
      height: 720,
      fpsNum: 30,
      fpsDen: 1,
      audioCodec: 'aac',
      sampleRate: 44100,
      audioBitrate: 192,
      startBeat: 0,
      endBeat: bpm * (5 / 60),
      crf: 23,
    };
    out.exportStarted = await xleth.videoExport.exportStart(out.exportConfig);
    for (let i = 0; i < 180; i += 1) {
      out.exportProgress = await xleth.videoExport.exportGetProgress();
      if (!out.exportProgress || out.exportProgress.running === false) break;
      await sleep(1000);
    }

    out.finalSources = await xleth.timeline.getSources();
    out.finalRegions = await xleth.timeline.getRegions();
    out.finalTracks = await xleth.timeline.getTracks();
    out.finalClips = await xleth.timeline.getClips();
    return out;
  }, { inputPath, outputPath });

  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
  console.log(`[BUILD_VERIFY_CDP] result=${resultPath}`);
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
}

main().catch((error) => {
  console.error('[BUILD_VERIFY_CDP_ERROR]', error);
  process.exitCode = 1;
});
