// @ts-check
/**
 * Encoding profiles are internal adapter data, passed unchanged to media jobs. Codec arguments exclude the
 * codec, output path and sample rate; the executor supplies those from the plan. They must not change
 * dimensions, channel count or timing, which are already represented in the timeline.
 * @typedef {{ kind: 'audio', extension: string, codec: string, args: readonly string[], sampleRate: number }} NleAudioEncoding
 * @typedef {{ kind: 'video', extension: 'mov' | 'webm' | 'mp4', codec: string, args: readonly string[], pixelFormat: string,
 *   alpha: boolean, audio: NleAudioEncoding }} NleVideoEncoding
 * @typedef {NleAudioEncoding | NleVideoEncoding} NleEncoding
 * @typedef {{ videoTranscode: ReadonlySet<string>, stillCopy: ReadonlySet<string>, audioCopy: ReadonlySet<string>,
 *   video: NleVideoEncoding, alphaVideo: NleVideoEncoding, audio: NleAudioEncoding }} NleMediaPolicy
 */

/** @type {NleAudioEncoding} */
const audio = { kind: 'audio', extension: 'wav', codec: 'pcm_s16le', args: [], sampleRate: 48_000 };

/** The existing formats retain their original source compatibility and output encodings. @type {NleMediaPolicy} */
export const NLE_MEDIA_POLICY = {
  videoTranscode: new Set(['webm', 'mkv', 'ogv', 'flv']),
  stillCopy: new Set(['png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'psd']),
  audioCopy: new Set(['wav', 'aif', 'aiff', 'mp3', 'm4a', 'aac', 'mp4', 'mov', 'm4v']),
  video: { kind: 'video', extension: 'mov', codec: 'prores_ks', args: ['-profile:v', '3', '-vendor', 'apl0'],
    pixelFormat: 'yuv422p10le', alpha: false, audio },
  alphaVideo: { kind: 'video', extension: 'mov', codec: 'prores_ks', args: ['-profile:v', '4444', '-vendor', 'apl0'],
    pixelFormat: 'yuva444p10le', alpha: true, audio },
  audio,
};

/** The same audio output parameters for source conversion and mixed stems. @param {NleAudioEncoding} encoding */
export const nleAudioArgs = (encoding) => ['-c:a', encoding.codec, ...encoding.args, '-ar', String(encoding.sampleRate)];
