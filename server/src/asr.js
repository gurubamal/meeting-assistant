import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { decode as decodeWav } from 'node-wav';

const FFMPEG_BIN = ffmpegStatic || process.env.FFMPEG_BIN || 'ffmpeg';
const WHISPER_BIN = process.env.WHISPER_BIN || process.env.WHISPERCPP_BIN || process.env.WHISPERCPP_EXE || '';

let transformersPipePromise = null;
async function getTransformersPipe() {
  if (!transformersPipePromise) {
    transformersPipePromise = (async () => {
      const { pipeline } = await import('@xenova/transformers');
      // Use tiny.en by default for speed and low memory
      return pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
    })();
  }
  return transformersPipePromise;
}

export function asrConfigured() {
  // Configured if whisper.cpp binary is set or we can load transformers
  return Boolean(WHISPER_BIN) || true;
}

function tmpPath(prefix, ext) {
  const rnd = Math.random().toString(36).slice(2);
  return path.join(os.tmpdir(), `${prefix}-${rnd}.${ext}`);
}

async function run(cmd, args, { cwd, stdin, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    if (stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
    child.stdout.on('data', d => (out += d.toString()));
    child.stderr.on('data', d => (err += d.toString()));
    let to;
    if (timeoutMs) to = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.on('error', reject);
    child.on('close', code => {
      if (to) clearTimeout(to);
      if (code !== 0) return reject(new Error(`${cmd} exit ${code}: ${err || out}`));
      resolve({ out, err });
    });
  });
}

export async function transcribeWebmOpus(buffer, { language = 'en' } = {}) {
  const inWebm = tmpPath('asr-in', 'webm');
  const wav = tmpPath('asr-audio', 'wav');
  try {
    await fs.writeFile(inWebm, buffer);
    await run(FFMPEG_BIN, ['-y', '-i', inWebm, '-ar', '16000', '-ac', '1', '-f', 'wav', wav], { timeoutMs: 60000 });

    if (WHISPER_BIN) {
      const outPrefix = tmpPath('asr-out', 'txt').replace(/\.txt$/, '');
      const outTxt = `${outPrefix}.txt`;
      const args = ['-f', wav, '-otxt', '-of', outPrefix, '-l', language];
      await run(WHISPER_BIN, args, { timeoutMs: 300000 });
      const txt = await fs.readFile(outTxt, 'utf8').catch(() => '');
      return (txt || '').trim();
    } else {
      // Transformers fallback (no external binaries)
      const audioBuf = await fs.readFile(wav);
      const wavData = decodeWav(audioBuf);
      const pcm = wavData.channelData[0]; // Float32Array
      const pipe = await getTransformersPipe();
      const out = await pipe(pcm, { chunk_length_s: 30, return_timestamps: false });
      return (out?.text || '').trim();
    }
  } finally {
    for (const p of [inWebm, wav]) {
      if (!p) continue;
      fs.unlink(p).catch(() => {});
    }
  }
}
