"use client";

/**
 * Browser-side media helpers.
 *  - Voice: record with MediaRecorder (webm on Chrome, mp4 on Safari), then
 *    decode and re-encode as 16 kHz mono WAV — a format every model accepts.
 *  - Photos: downscale to ≤1280px JPEG to keep uploads and AI tokens small.
 */

export type Recorder = { stop: () => Promise<Blob>; cancel: () => void };

export async function startRecording(): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.start();
  const release = () => stream.getTracks().forEach((t) => t.stop());

  return {
    stop: () =>
      new Promise((resolve, reject) => {
        recorder.onstop = async () => {
          release();
          try {
            resolve(await toWav(new Blob(chunks, { type: recorder.mimeType })));
          } catch (e) {
            reject(e);
          }
        };
        recorder.stop();
      }),
    cancel: () => {
      recorder.onstop = release;
      if (recorder.state !== "inactive") recorder.stop();
    },
  };
}

const TARGET_RATE = 16_000;

async function toWav(blob: Blob): Promise<Blob> {
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const frames = Math.ceil(decoded.duration * TARGET_RATE);
    const offline = new OfflineAudioContext(1, frames, TARGET_RATE);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    return encodeWav(rendered.getChannelData(0), TARGET_RATE);
  } finally {
    void ctx.close();
  }
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export async function downscaleImage(file: File, maxSide = 1280): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode photo"))), "image/jpeg", 0.85),
  );
}

/** Map a language name from the model to a BCP-47 tag for speechSynthesis. */
const LANG_TAGS: Record<string, string> = {
  hindi: "hi-IN",
  tamil: "ta-IN",
  bengali: "bn-IN",
  bangla: "bn-IN",
  telugu: "te-IN",
  marathi: "mr-IN",
  gujarati: "gu-IN",
  kannada: "kn-IN",
  malayalam: "ml-IN",
  punjabi: "pa-IN",
  urdu: "ur-IN",
  english: "en-IN",
};

export function speak(text: string, language: string): boolean {
  if (!("speechSynthesis" in window) || !text) return false;
  const tag = LANG_TAGS[language.trim().toLowerCase()] ?? "hi-IN";
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = tag;
  const voice = speechSynthesis.getVoices().find((v) => v.lang.replace("_", "-").startsWith(tag.slice(0, 2)));
  if (voice) utter.voice = voice;
  utter.rate = 0.95;
  speechSynthesis.cancel();
  speechSynthesis.speak(utter);
  return true;
}
