declare const process: any;
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import * as chromiumModule from './lib/chromium';
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
import { spawn } from 'child_process';

/**
 * WebhookUploader: A custom uploader that skips S3 and sends 
 * the file directly to a webhook.
 */
class WebhookUploader implements IUploader {
  private _userId: string;
  private _tempFileId: string;
  private _logger: any;
  private _url: string;

  constructor(userId: string, tempFileId: string, logger: any, url: string) {
    this._userId = userId;
    this._tempFileId = tempFileId;
    this._logger = logger;
    this._url = url;
  }

  async saveDataToTempFile(data: Buffer): Promise<boolean> {
      return true;
  }

  async uploadRecordingToRemoteStorage(): Promise<boolean> {
    const webhookUrl = process.env.NOTIFY_WEBHOOK_URL;
    if (!webhookUrl) {
      this._logger.error('NOTIFY_WEBHOOK_URL is not set for WebhookUploader');
      return false;
    }

    const fileExt = process.env.AUDIO_ONLY === 'true' ? '.webm' : config.uploaderFileExtension;
    const filePath = path.join(process.cwd(), 'dist', '_tempvideo', this._userId, `${this._tempFileId}${fileExt}`);
    
    if (!fs.existsSync(filePath)) {
      this._logger.error(`Recording file not found at ${filePath}. Check if AUDIO_ONLY affected extension.`);
      return false;
    }

    this._logger.info(`Direct Webhook Upload: Sending ${filePath} to ${webhookUrl}`);
    
    const form = new FormData();
    form.append('recording', fs.createReadStream(filePath));
    form.append('recordingId', this._tempFileId);
    form.append('userId', this._userId);
    form.append('meetingLink', this._url);
    form.append('timestamp', new Date().toISOString());

    try {
      const response = await axios.post(webhookUrl, form, {
        headers: {
          ...form.getHeaders(),
          'X-Webhook-Secret': process.env.NOTIFY_WEBHOOK_SECRET || '',
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
      this._logger.info('Webhook file delivery successful', { status: response.status });
      return true;
    } catch (error: any) {
      this._logger.error('Webhook file delivery failed', { 
          message: error.message,
          response: error.response?.data
      });
      return false;
    }
  }
}

// --- ZERO-COLLISION API INTERCEPTION ---

// Monkey-patch the browser context creation to inject the Audio-Only API interceptor
const originalCreateBrowserContext = (chromiumModule as any).default;
(chromiumModule as any).default = async function(url: string, correlationId: string, botType: any) {
  const page = await originalCreateBrowserContext(url, correlationId, botType);
  
  if (process.env.AUDIO_ONLY === 'true' && botType !== 'microsoft') {
    console.log('💉 Injecting Audio-Only API Interceptor into browser context...');
    await page.addInitScript(() => {
      // 1. Intercept getDisplayMedia to return an audio-only stream
      const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
      
      (navigator.mediaDevices as any).getDisplayMedia = async (constraints: any) => {
        console.log('🎬 Bot requested getDisplayMedia. Stripping video tracks for Audio-Only mode...');
        const stream = await originalGetDisplayMedia(constraints);
        
        // Return a stream that only contains the audio tracks
        const audioOnlyStream = new MediaStream(stream.getAudioTracks());
        
        // Stop any captured video tracks immediately to protect privacy and save CPU
        stream.getVideoTracks().forEach((track: any) => {
          track.stop();
          console.log('🚫 Video track stopped immediately.');
        });
        
        return audioOnlyStream;
      };

      // 2. Intercept MediaRecorder to match the new audio-only stream
      const OriginalMediaRecorder = window.MediaRecorder;
      (window as any).MediaRecorder = class extends OriginalMediaRecorder {
        constructor(stream: MediaStream, options: any) {
          if (options && options.mimeType && options.mimeType.includes('video')) {
            console.log(`🎥 MediaRecorder: Overriding ${options.mimeType} with audio/webm because stream is audio-only.`);
            options.mimeType = 'audio/webm;codecs=opus';
          }
          super(stream, options);
        }
        
        static isTypeSupported(type: string) {
          // If we're forcing audio-only, tell the bot that video types aren't supported
          // so it falls back to common types or our chosen type.
          if (type.includes('video')) {
            return false;
          }
          return OriginalMediaRecorder.isTypeSupported(type);
        }
      };
    });
  }

  // Apply speed optimizations to the page instance
  applyTimingOptimizations(page);

  return page;
};

// 3. Patch FFmpegRecorder (for Teams)
if (process.env.AUDIO_ONLY === 'true') {
  console.log('🎙️ Patching FFmpegRecorder for Teams Audio-Only mode...');
  FFmpegRecorder.prototype.start = async function(): Promise<void> {
    const self = this as any;
    return new Promise((resolve, reject) => {
      try {
        self.logger.info('[PATCH] Starting FFmpeg in AUDIO-ONLY mode');
        const ffmpegArgs = [
          '-y',
          '-loglevel', 'info',
          // Only Audio input (PulseAudio)
          '-f', 'pulse',
          '-ac', '2',
          '-ar', '44100',
          '-i', 'virtual_output.monitor',
          // Audio encoding
          '-c:a', 'aac',
          '-b:a', '128k',
          '-ar', '44100',
          '-ac', '2',
          self.outputPath // Keep original extension for internal simplicity
        ];

        self.ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '/run/user/1001' }
        });

        self.ffmpegProcess.on('exit', (code: any) => {
            if (self.exitCallback) self.exitCallback(code);
            if (code !== 0) self.logger.error('FFmpeg exited with error', code);
        });

        setTimeout(() => resolve(), 2000);
      } catch (e) { reject(e); }
    });
  };
}

/**
 * Optimization Interceptor: Speeds up the bot joining process by 
 * reducing hardcoded safety delays in the main bot class.
 */
function applyTimingOptimizations(page: any) {
  // 1. Speed up hardcoded 10-second safety waits (GoogleMeetBot.ts uses these frequently)
  const originalWaitForTimeout = page.waitForTimeout.bind(page);
  page.waitForTimeout = (ms: number) => {
    if (ms === 10000) return originalWaitForTimeout(1500); 
    return originalWaitForTimeout(ms);
  };

  // 2. Speed up the 15-second "Got it" button search
  const originalWaitForSelector = page.waitForSelector.bind(page);
  page.waitForSelector = (selector: string, options?: any) => {
    if (options && options.timeout === 15000) options.timeout = 3000;
    if (options && options.timeout === 10000) options.timeout = 2000;
    return originalWaitForSelector(selector, options);
  };

  // 3. Speed up the 20-second Lobby Admission check
  const originalSetInterval = globalThis.setInterval;
  (globalThis as any).setInterval = (handler: any, timeout?: number, ...args: any[]) => {
    if (timeout === 20000) timeout = 4000; // 20s -> 4s
    return originalSetInterval(handler, timeout, ...args);
  };
}

async function run() {
  // Set safer defaults for silence detection if not provided
  process.env.MEETING_INACTIVITY_MINUTES = process.env.MEETING_INACTIVITY_MINUTES || '10';
  process.env.INACTIVITY_DETECTION_START_DELAY_MINUTES = process.env.INACTIVITY_DETECTION_START_DELAY_MINUTES || '5';

  const url = process.env.MEETING_URL;
  if (!url) {
    console.error('MEETING_URL environment variable is required for autostart');
    process.exit(1);
  }

  const userId = process.env.DEFAULT_USER_ID || 'autostart-user';
  const teamId = process.env.DEFAULT_TEAM_ID || 'autostart-team';
  const botId = process.env.DEFAULT_BOT_ID || `bot-${Date.now()}`;
  const eventId = process.env.DEFAULT_EVENT_ID;
  const name = process.env.DEFAULT_BOT_NAME || 'Meeting Notetaker';
  const bearerToken = process.env.DEFAULT_BEARER_TOKEN || 'no-token';
  const timezone = process.env.DEFAULT_TIMEZONE || 'UTC';

  const provider = getProvider(url);
  if (!provider) {
    console.error(`Unsupported platform for URL: ${url}`);
    process.exit(1);
    return;
  }

  const correlationId = createCorrelationId({ teamId, userId, botId, eventId, url });
  const logger = loggerFactory(correlationId, provider);

  logger.info('Starting autostart meeting recorder...', { url, provider });

  try {
    const entityId = botId ?? eventId;
    const tempId = `${userId}${entityId}0`;
    const tempFileId = encodeFileNameSafebase64(tempId);
    const namePrefix = getRecordingNamePrefix(provider);

    let uploader: IUploader;

    if (process.env.UPLOAD_TO_WEBHOOK === 'true') {
      logger.info('One-Shot: Using Direct Webhook Uploader');
      uploader = new WebhookUploader(userId, tempFileId, logger, url);
      
      // We also need to "tap" into DiskUploader to handle the local writing part
      const diskWriter = await DiskUploader.initialize(bearerToken, teamId, timezone, userId, botId ?? '', namePrefix, tempFileId, logger, url);
      
      const originalUpload = uploader.uploadRecordingToRemoteStorage.bind(uploader);
      uploader.saveDataToTempFile = diskWriter.saveDataToTempFile.bind(diskWriter);
      uploader.uploadRecordingToRemoteStorage = async () => {
          await (diskWriter as any).finalizeDiskWriting();
          return originalUpload();
      };
    } else {
      uploader = await DiskUploader.initialize(bearerToken, teamId, timezone, userId, botId ?? '', namePrefix, tempFileId, logger, url);
    }

    const joinParams: JoinParams = { url, name, bearerToken, teamId, timezone, userId, eventId, botId, uploader };

    switch (provider) {
      case 'google':
        await new GoogleMeetBot(logger, correlationId).join(joinParams);
        break;
      case 'microsoft':
        await new MicrosoftTeamsBot(logger, correlationId).join(joinParams);
        break;
      case 'zoom':
        await new ZoomBot(logger, correlationId).join(joinParams);
        break;
    }

    logger.info('Success. Exiting container.');
    process.exit(0);
  } catch (error) {
    logger.error('Autostart failed:', error);
    process.exit(1);
  }
}

function getProvider(url: string): 'google' | 'microsoft' | 'zoom' | null {
  if (url.includes('meet.google.com')) return 'google';
  if (url.includes('teams.microsoft.com') || url.includes('teams.live.com')) return 'microsoft';
  if (url.includes('zoom.us')) return 'zoom';
  return null;
}

run().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
