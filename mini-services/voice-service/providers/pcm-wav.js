/**
 * pcm-wav.js - pure PCM16 -> WAV assembler (feature 12 ASR stage).
 *
 * The client VAD (public/js/vad.js, feature 10) streams 16 kHz mono PCM16
 * utterances as base64 chunks (each capped at 24000 decoded bytes before
 * base64, well under the socket's 32768-char frame cap). This module
 * concatenates one utterance's chunks and wraps them in a canonical RIFF
 * WAVE container (44-byte header, PCM 16-bit mono, 16000 Hz) so ASR
 * providers receive ONE well-formed wav file.
 *
 * PURE util: no I/O, no env reads, no logging, no state. Base64 codecs are
 * the Web-standard atob/btoa (globals in Bun and browsers) applied in
 * 8 KB sub-slices (String.fromCharCode spread is stack-limited).
 */

/** Locked utterance sample rate (architecture.md "Voice Socket Protocol"). */
const SAMPLE_RATE = 16000;

/** Bytes per PCM16 sample. */
const BYTES_PER_SAMPLE = 2;

/** Canonical RIFF WAVE header size for PCM (fmt chunk = 16 bytes). */
const WAV_HEADER_BYTES = 44;

/** Sub-slice size for the base64 string builders (see header note). */
const B64_SLICE_BYTES = 8192;

/**
 * Decode one base64 string into bytes (Web-standard atob; the binary string
 * is consumed with direct indexing).
 *
 * @param {string} base64
 * @returns {Uint8Array}
 */
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** @param {number} value unsigned 16-bit little-endian write */
function writeUint16LE(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}

/** @param {number} value unsigned 32-bit little-endian write */
function writeUint32LE(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
  bytes[offset + 3] = (value >> 24) & 0xff;
}

function asciiBytes(bytes, offset, text) {
  for (let i = 0; i < text.length; i += 1) {
    bytes[offset + i] = text.charCodeAt(i);
  }
}

/**
 * Build the 44-byte canonical PCM WAV header for one data size.
 *
 * @param {number} dataBytes PCM payload size (bytes)
 * @returns {Uint8Array}
 */
function buildWavHeader(dataBytes) {
  const header = new Uint8Array(WAV_HEADER_BYTES);
  const byteRate = SAMPLE_RATE * BYTES_PER_SAMPLE; // 32000
  asciiBytes(header, 0, "RIFF");
  writeUint32LE(header, 4, 36 + dataBytes); // RIFF chunk size
  asciiBytes(header, 8, "WAVE");
  asciiBytes(header, 12, "fmt ");
  writeUint32LE(header, 16, 16); // fmt chunk size (PCM)
  writeUint16LE(header, 20, 1); // audio format: PCM
  writeUint16LE(header, 22, 1); // channels: mono
  writeUint32LE(header, 24, SAMPLE_RATE); // 16000 Hz
  writeUint32LE(header, 28, byteRate); // byte rate
  writeUint16LE(header, 32, BYTES_PER_SAMPLE); // block align
  writeUint16LE(header, 34, 16); // bits per sample
  asciiBytes(header, 36, "data");
  writeUint32LE(header, 40, dataBytes);
  return header;
}

/**
 * Assemble one canonical WAV file from an utterance's base64 PCM16 chunks
 * (ordered oldest-to-newest, the socket's per-socket delivery order).
 *
 * @param {string[]} base64Chunks base64 PCM16 (little-endian) chunk strings
 * @returns {{buffer: Uint8Array, toBase64: () => string, durationMs: number,
 *            sampleRate: number, channels: number, pcmBytes: number}}
 */
export function assembleWav(base64Chunks) {
  const chunks = Array.isArray(base64Chunks) ? base64Chunks : [];
  const parts = [];
  let pcmBytes = 0;
  for (const chunk of chunks) {
    if (typeof chunk !== "string" || chunk.length === 0) continue;
    const bytes = base64ToBytes(chunk);
    parts.push(bytes);
    pcmBytes += bytes.length;
  }
  const wav = new Uint8Array(WAV_HEADER_BYTES + pcmBytes);
  wav.set(buildWavHeader(pcmBytes), 0);
  let offset = WAV_HEADER_BYTES;
  for (const part of parts) {
    wav.set(part, offset);
    offset += part.length;
  }
  const totalSamples = Math.floor(pcmBytes / BYTES_PER_SAMPLE);
  return {
    buffer: wav,
    toBase64: () => {
      let binary = "";
      for (let i = 0; i < wav.length; i += B64_SLICE_BYTES) {
        const slice = wav.subarray(i, Math.min(i + B64_SLICE_BYTES, wav.length));
        binary += String.fromCharCode(...slice);
      }
      return btoa(binary);
    },
    durationMs: Math.round(totalSamples / (SAMPLE_RATE / 1000)),
    sampleRate: SAMPLE_RATE,
    channels: 1,
    pcmBytes,
  };
}
