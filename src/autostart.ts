declare const process: any;
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import * as chromiumModule from './lib/chromium';
import * as promiseModule from './lib/promise';
import { spawn } from 'child_process';
import { GoogleMeetBot } from './bots/GoogleMeetBot';
import { MicrosoftTeamsBot } from './bots/MicrosoftTeamsBot';
import { ZoomBot } from './bots/ZoomBot';
import { FFmpegRecorder } from './lib/ffmpegRecorder';
import DiskUploader, { IUploader } from './middleware/disk-uploader';
import { loggerFactory, createCorrelationId } from './util/logger';
import { encodeFileNameSafebase64 } from './util/strings';
import { getRecordingNamePrefix } from './util/recordingName';
import { JoinParams } from './bots/AbstractMeetBot';
import config from './config';

/**
 * WebhookUploader: A custom uploader for One-Shot delivery.
 */
class WebhookUploader implements IUploader {
  private userId: string;
  private tempFileId: string;
  private logger: any;
  private videoUrl: string;
  public skipTrimSilence: boolean = false;
  public saveDataToTempFile: (chunk: Buffer) => Promise<boolean> = async () => true;

  constructor(userId: string, tempFileId: string, logger: any, videoUrl: string) {
    this.userId = userId;
    this.tempFileId = tempFileId;
    this.logger = logger;
    this.videoUrl = videoUrl;
  }

  private async trimSilence(filePath: string): Promise<void> {
    const trimmedPath = filePath.replace('.webm', '.trimmed.webm');
    this.logger.info(`[TRIM] Squeezing silence from audio: ${path.basename(filePath)}`);
    return new Promise((resolve, reject) => {
      const ffmpegArgs = [
        '-y', '-i', filePath,
        '-af', 'silenceremove=stop_periods=-1:stop_duration=1.5:stop_threshold=-45dB',
        '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '1'
      ];

      // STRIP VIDEO IF AUDIO_ONLY IS ENABLED
      if (process.env.AUDIO_ONLY === 'true') {
        ffmpegArgs.push('-vn');
      }

      ffmpegArgs.push(trimmedPath);

      const ffmpeg = spawn('ffmpeg', ffmpegArgs);
      ffmpeg.on('close', (code) => {
        if (code === 0 && fs.existsSync(trimmedPath)) {
          const originalSize = fs.statSync(filePath).size;
          const trimmedSize = fs.statSync(trimmedPath).size;
          const savedPerc = Math.round((1 - trimmedSize / originalSize) * 100);
          this.logger.info(`[TRIM] Success. Saved ~${savedPerc}% of file size.`);
          fs.renameSync(trimmedPath, filePath);
          resolve();
        } else {
          this.logger.warn(`[TRIM] Failed or produced no file (code ${code}). Keeping original.`);
          resolve(); // Resolve anyway to not block upload
        }
      });
      ffmpeg.on('error', (err) => {
        this.logger.error(`[TRIM] FFmpeg error: ${err.message}`);
        resolve();
      });
    });
  }

  async uploadRecordingToRemoteStorage(): Promise<boolean> {
    const notifyUrl = process.env.NOTIFY_WEBHOOK_URL;
    if (!notifyUrl || notifyUrl.includes('your-api')) return true;
    try {
      const filePath = path.join(process.cwd(), 'dist', '_tempvideo', this.userId, `${this.tempFileId}.webm`);
      if (!fs.existsSync(filePath)) return false;

      // PERFORM SILENCE TRIMMING (skip if raw capture already handled it)
      if (!this.skipTrimSilence) {
        await this.trimSilence(filePath);
      } else {
        this.logger.info('[TRIM] Skipped — raw capture already applied silence removal');
      }

      const form = new FormData();
      form.append('recording', fs.createReadStream(filePath));
      form.append('userId', this.userId);
      form.append('botId', (process.env.DEFAULT_BOT_ID || 'autostart-bot'));
      form.append('videoUrl', this.videoUrl);
      await axios.post(notifyUrl, form, {
        headers: { ...form.getHeaders(), 'x-webhook-secret': (process.env.NOTIFY_WEBHOOK_SECRET || '') },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });
      return true;
    } catch (error) { return false; }
  }
}

// --- REPO-OWNER COMPATIBILITY & SPEED PATCHES ---

// 1. Force the Timer to stay alive (God-Mode)
const originalGetWaitingPromise = (promiseModule as any).getWaitingPromise;
(promiseModule as any).getWaitingPromise = function(ms: number) {
  const envDuration = parseInt(process.env.MAX_RECORDING_DURATION_MINUTES || '40', 10) * 60 * 1000;
  if (!ms || ms < 60000) ms = envDuration;
  return originalGetWaitingPromise(ms);
};

// 2. Wrap the REPO OWNER'S browser context creation (Keeps their Stealth Plugin)
const originalCreateBrowserContext = (chromiumModule as any).default;
(chromiumModule as any).default = async function(url: string, correlationId: string, botType: any) {
  // We utilize the repo owner's original logic which includes StealthPlugin automatically
  const page = await originalCreateBrowserContext(url, correlationId, botType);
  
  // STEALTH: Remove the Automation Flag and emulate human environment
  await page.addInitScript(() => {
    // Hide WebDriver
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // Emulate Languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    // Emulate Plugins
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    // Permissions Query Masking
    const nav: any = navigator;
    if (nav.permissions && nav.permissions.query) {
      const originalQuery = nav.permissions.query;
      nav.permissions.query = (parameters: any) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );
    }
  });
  
  // SPEED OPTIMIZATION: Overwrite page.waitForTimeout
  const originalWait = page.waitForTimeout.bind(page);
  page.waitForTimeout = (ms: number) => {
    // Shave off the 10-second idle waits to speed up join/admission
    if (ms === 10000) return originalWait(2000);
    return originalWait(ms);
  };

  return page;
};

// 3. Force FFmpeg to use Clean Audio Only
const originalFFmpegStart = FFmpegRecorder.prototype.start;
FFmpegRecorder.prototype.start = async function(): Promise<void> {
  const self = this as any;
  if (process.env.AUDIO_ONLY !== 'true') return originalFFmpegStart.apply(this);

  return new Promise((resolve, reject) => {
    try {
      const ffmpegArgs = [
        '-y', '-loglevel', 'info',
        '-f', 'pulse', '-ac', '1', '-ar', '48000', '-i', 'virtual_output.monitor',
        '-c:a', (self.outputPath.endsWith('.webm') ? 'libopus' : 'aac'),
        '-b:a', '128k', '-ar', '48000', '-ac', '1',
        self.outputPath
      ];
      self.ffmpegProcess = spawn('ffmpeg', ffmpegArgs, { 
        stdio: ['pipe', 'pipe', 'pipe'], 
        env: { ...process.env, XDG_RUNTIME_DIR: '/run/user/1001', DISPLAY: ':99' } 
      });
      setTimeout(() => resolve(), 2000);
    } catch (err) { reject(err); }
  });
};

// 4. Wrap recordMeetingPage for Config Sync
const originalGoogleMeetRecord = GoogleMeetBot.prototype['recordMeetingPage'];
(GoogleMeetBot as any).prototype.recordMeetingPage = async function(args: any) {
  config.maxRecordingDuration = parseInt(process.env.MAX_RECORDING_DURATION_MINUTES || '40', 10);
  config.inactivityLimit = parseInt(process.env.MEETING_INACTIVITY_MINUTES || '2', 10);
  config.activateInactivityDetectionAfter = parseInt(process.env.INACTIVITY_DETECTION_START_DELAY_MINUTES || '5', 10);
  return originalGoogleMeetRecord.apply(this, [args]);
};

async function run() {
  const url = process.env.MEETING_URL;
  if (!url) process.exit(1);

  const userId = (process.env.DEFAULT_USER_ID || 'autostart-user');
  const teamId = (process.env.DEFAULT_TEAM_ID || 'autostart-team');
  const botId = (process.env.DEFAULT_BOT_ID || `bot-${Date.now()}`);
  const eventId = (process.env.DEFAULT_EVENT_ID || undefined);
  const name = (process.env.DEFAULT_BOT_NAME || 'Meeting Notetaker');
  const providerRaw = getProvider(url);
  const provider = (providerRaw as string) as any;

  if (!provider) process.exit(1);

  const correlationId = createCorrelationId({ teamId, userId, botId, url, eventId });
  const logger = loggerFactory(correlationId, provider);

  try {
    const tempFileId = encodeFileNameSafebase64(`${userId}${botId}0`);
    const namePrefix = getRecordingNamePrefix(provider);
    let uploader: IUploader;

    if (process.env.UPLOAD_TO_WEBHOOK === 'true') {
      uploader = new WebhookUploader(userId, tempFileId, logger, url);
      const diskWriter = await DiskUploader.initialize('', teamId, 'UTC', userId, botId, namePrefix, tempFileId, logger, url);
      const originalUpload = uploader.uploadRecordingToRemoteStorage.bind(uploader);
      uploader.saveDataToTempFile = diskWriter.saveDataToTempFile.bind(diskWriter);
      uploader.uploadRecordingToRemoteStorage = async () => { await (diskWriter as any).finalizeDiskWriting(); return originalUpload(); };
    } else {
      uploader = await DiskUploader.initialize('', teamId, 'UTC', userId, botId, namePrefix, tempFileId, logger, url);
    }

    // --- RAW AUDIO CAPTURE MODE (AUDIO_ONLY) ---
    // Instead of encoding in real-time (Chrome MediaRecorder → Opus → IPC → Node.js → disk),
    // we capture raw PCM directly from PulseAudio with ZERO encoding CPU.
    // After the meeting, we do a single-pass FFmpeg encode + silence removal.
    let rawCaptureProcess: ReturnType<typeof spawn> | null = null;
    const rawFilePath = path.join(process.cwd(), 'dist', '_tempvideo', userId, `${tempFileId}.wav`);
    const webmFilePath = path.join(process.cwd(), 'dist', '_tempvideo', userId, `${tempFileId}.webm`);

    if (process.env.AUDIO_ONLY === 'true') {
      // Ensure output directory exists
      fs.mkdirSync(path.dirname(rawFilePath), { recursive: true });

      // Start raw PCM capture from PulseAudio's virtual sink monitor.
      // pcm_s16le = raw 16-bit samples, no compression, no CPU.
      rawCaptureProcess = spawn('ffmpeg', [
        '-y',
        '-f', 'pulse',
        '-ac', '1',
        '-ar', '48000',
        '-i', 'virtual_output.monitor',
        '-c:a', 'pcm_s16le',
        rawFilePath
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, XDG_RUNTIME_DIR: '/run/user/1001', DISPLAY: ':99' }
      });

      rawCaptureProcess.on('error', (err) => {
        logger.error('[RAW CAPTURE] FFmpeg error:', err.message);
      });

      logger.info('[RAW CAPTURE] Started zero-CPU raw PCM capture from PulseAudio');

      // No-op saveDataToTempFile — raw capture writes directly to disk
      uploader.saveDataToTempFile = async () => true;

      // Wrap the upload chain to: stop capture → convert raw→webm → upload
      const existingUpload = uploader.uploadRecordingToRemoteStorage.bind(uploader);
      uploader.uploadRecordingToRemoteStorage = async () => {
        // 1. Stop the raw capture gracefully
        if (rawCaptureProcess && !rawCaptureProcess.killed) {
          logger.info('[RAW CAPTURE] Stopping raw capture...');
          try {
            rawCaptureProcess.stdin?.write('q\n');
            rawCaptureProcess.stdin?.end();
          } catch {
            rawCaptureProcess.kill('SIGTERM');
          }
          await new Promise(r => setTimeout(r, 3000));
          if (!rawCaptureProcess.killed) rawCaptureProcess.kill('SIGKILL');
        }

        // 2. Convert raw WAV → WebM/Opus with silence removal in ONE pass
        if (fs.existsSync(rawFilePath)) {
          const rawSize = fs.statSync(rawFilePath).size;
          logger.info(`[RAW CAPTURE] Converting ${(rawSize / 1024 / 1024).toFixed(1)}MB raw audio → WebM/Opus`);

          await new Promise<void>((resolve, reject) => {
            const convertProcess = spawn('ffmpeg', [
              '-y', '-i', rawFilePath,
              '-af', 'silenceremove=stop_periods=-1:stop_duration=1.5:stop_threshold=-45dB',
              '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '1',
              '-vn',
              webmFilePath
            ]);

            convertProcess.stderr?.on('data', (data: Buffer) => {
              const output = data.toString();
              if (output.includes('error') || output.includes('Error')) {
                logger.error('[RAW CAPTURE] Convert error:', output);
              }
            });

            convertProcess.on('close', (code) => {
              if (code === 0 && fs.existsSync(webmFilePath)) {
                const webmSize = fs.statSync(webmFilePath).size;
                const ratio = Math.round((1 - webmSize / rawSize) * 100);
                logger.info(`[RAW CAPTURE] Conversion done. ${(webmSize / 1024).toFixed(0)}KB (${ratio}% compression)`);
                // Clean up the large raw file
                try { fs.unlinkSync(rawFilePath); } catch {}
                resolve();
              } else {
                logger.error(`[RAW CAPTURE] Conversion failed with code ${code}`);
                reject(new Error(`FFmpeg conversion failed: ${code}`));
              }
            });

            convertProcess.on('error', (err) => {
              logger.error('[RAW CAPTURE] Convert process error:', err.message);
              reject(err);
            });
          });

          // The webm file is now at the expected path. Call the existing upload chain.
          // Mark skipTrimSilence since we already did silence removal during conversion.
          if ((uploader as any).skipTrimSilence !== undefined) {
            (uploader as any).skipTrimSilence = true;
          }
          return existingUpload();
        } else {
          logger.warn('[RAW CAPTURE] No raw file found, falling back to existing upload');
          return existingUpload();
        }
      };
    }

    const joinParams: JoinParams = { url, name, bearerToken: '', teamId, timezone: 'UTC', userId, eventId, botId, uploader };
    switch (provider) {
      case 'google': await new GoogleMeetBot(logger, correlationId).join(joinParams); break;
      case 'microsoft': await new MicrosoftTeamsBot(logger, correlationId).join(joinParams); break;
      case 'zoom': await new ZoomBot(logger, correlationId).join(joinParams); break;
    }
    process.exit(0);
  } catch (error) { process.exit(1); }

}

function getProvider(url: string): 'google' | 'microsoft' | 'zoom' | null {
  if (url.includes('meet.google.com')) return 'google';
  if (url.includes('teams.microsoft.com') || url.includes('teams.live.com')) return 'microsoft';
  if (url.includes('zoom.us')) return 'zoom';
  return null;
}

run().catch(() => process.exit(1));
