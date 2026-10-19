// @ts-check
/** xmeml v4 (Final Cut Pro 7 XML), consumed by Premiere Pro and DaVinci Resolve. */
import { pathToFileURL } from 'node:url';
import { xmlEscape } from './nle-xml.mjs';

/**
 * @typedef {import('./nle.mjs').NleRate} NleRate
 * @typedef {import('./nle.mjs').NleFile} NleFile
 * @typedef {import('./nle.mjs').NleClip} NleClip
 * @typedef {import('./nle.mjs').NleTrack} NleTrack
 * @typedef {import('./nle.mjs').NleTimeline} NleTimeline
 */
const round6 = (/** @type {number} */ n) => { const r = Math.round(n * 1e6) / 1e6; return Object.is(r, -0) ? 0 : r; };

/** An absolute path as xmeml writes it: `file://localhost/Users/…`, each part percent-encoded. @param {string} path */
export const nlePathUrl = (path) => pathToFileURL(path).href.replace(/^file:\/\/\//, 'file://localhost/');

const bool = (/** @type {boolean} */ v) => (v ? 'TRUE' : 'FALSE');
const num = (/** @type {number} */ n) => String(round6(n));
const rateXml = (/** @type {NleRate} */ rate, /** @type {string} */ pad) => `${pad}<rate>\n${pad}  <timebase>${rate.timebase}</timebase>\n${pad}  <ntsc>${bool(rate.ntsc)}</ntsc>\n${pad}</rate>`;
const timecodeXml = (/** @type {NleRate} */ rate, /** @type {string} */ pad) => [
  `${pad}<timecode>`, rateXml(rate, `${pad}  `), `${pad}  <string>00:00:00:00</string>`, `${pad}  <frame>0</frame>`,
  `${pad}  <displayformat>NDF</displayformat>`, `${pad}</timecode>`,
].join('\n');

/** @param {NleFile} file @param {NleRate} rate @param {string} pad */
function fileXml(file, rate, pad) {
  const lines = [
    `${pad}<file id="${xmlEscape(file.id)}">`,
    `${pad}  <name>${xmlEscape(file.name)}</name>`,
    `${pad}  <pathurl>${xmlEscape(nlePathUrl(file.path))}</pathurl>`,
    rateXml(rate, `${pad}  `),
    `${pad}  <duration>${file.durationFrames}</duration>`,
    timecodeXml(rate, `${pad}  `),
    `${pad}  <media>`,
  ];
  if (file.video) {
    lines.push(`${pad}    <video>`, `${pad}      <samplecharacteristics>`, rateXml(rate, `${pad}        `),
      `${pad}        <width>${file.video.w}</width>`, `${pad}        <height>${file.video.h}</height>`,
      `${pad}        <anamorphic>FALSE</anamorphic>`, `${pad}        <pixelaspectratio>square</pixelaspectratio>`,
      `${pad}        <fielddominance>none</fielddominance>`, `${pad}      </samplecharacteristics>`, `${pad}    </video>`);
  }
  if (file.audio) {
    lines.push(`${pad}    <audio>`, `${pad}      <samplecharacteristics>`, `${pad}        <depth>16</depth>`,
      `${pad}        <samplerate>${file.audio.sampleRate}</samplerate>`, `${pad}      </samplecharacteristics>`,
      `${pad}      <channelcount>${file.audio.channels}</channelcount>`, `${pad}    </audio>`);
  }
  lines.push(`${pad}  </media>`, `${pad}</file>`);
  return lines.join('\n');
}

/**
 * Audio Levels: a sound clip's level, linear, and its keyframes (its fades) when it has them.
 * @param {number} gain @param {string} pad @param {NleClip['levels']} [keys]
 */
const levelXml = (gain, pad, keys) => [
  `${pad}<filter>`, `${pad}  <effect>`, `${pad}    <name>Audio Levels</name>`, `${pad}    <effectid>audiolevels</effectid>`,
  `${pad}    <effectcategory>audiolevels</effectcategory>`, `${pad}    <effecttype>audiolevels</effecttype>`, `${pad}    <mediatype>audio</mediatype>`,
  `${pad}    <parameter>`, `${pad}      <parameterid>level</parameterid>`, `${pad}      <name>Level</name>`,
  `${pad}      <valuemin>0</valuemin>`, `${pad}      <valuemax>3.98109</valuemax>`, `${pad}      <value>${num(gain)}</value>`,
  ...(keys ?? []).flatMap((k) => [`${pad}      <keyframe>`, `${pad}        <when>${k.when}</when>`, `${pad}        <value>${num(k.value)}</value>`, `${pad}      </keyframe>`]),
  `${pad}    </parameter>`, `${pad}  </effect>`, `${pad}</filter>`,
].join('\n');

/** Basic Motion: scale and center. @param {NonNullable<NleClip['motion']>} m @param {string} pad */
const motionXml = (m, pad) => [
  `${pad}<filter>`, `${pad}  <effect>`, `${pad}    <name>Basic Motion</name>`, `${pad}    <effectid>basic</effectid>`,
  `${pad}    <effectcategory>motion</effectcategory>`, `${pad}    <effecttype>motion</effecttype>`, `${pad}    <mediatype>video</mediatype>`,
  `${pad}    <parameter>`, `${pad}      <parameterid>scale</parameterid>`, `${pad}      <name>Scale</name>`,
  `${pad}      <valuemin>0</valuemin>`, `${pad}      <valuemax>1000</valuemax>`, `${pad}      <value>${num(m.scale)}</value>`, `${pad}    </parameter>`,
  `${pad}    <parameter>`, `${pad}      <parameterid>center</parameterid>`, `${pad}      <name>Center</name>`,
  `${pad}      <value>`, `${pad}        <horiz>${num(m.center.h)}</horiz>`, `${pad}        <vert>${num(m.center.v)}</vert>`, `${pad}      </value>`,
  `${pad}    </parameter>`, `${pad}  </effect>`, `${pad}</filter>`,
].join('\n');

/**
 * The timeline as an xmeml v4 document. A file is written whole the first time a clip uses it and referred to after
 * (one source used three times is one source in the editor, not three); links name the other clip's track and place
 * (both from 1), so all clips are placed before any is written.
 * @param {NleTimeline} timeline
 */
export function xmemlDocument(timeline) {
  const files = new Map(timeline.files.map((f) => [f.id, f]));
  const written = new Set();
  /** @type {Map<string, { clip: NleClip, media: 'video' | 'audio', track: number, index: number }[]>} */
  const groups = new Map();
  const place = (/** @type {NleTrack[]} */ tracks, /** @type {'video' | 'audio'} */ media) => tracks.forEach((t, ti) => t.clips.forEach((clip, ci) => {
    if (clip.linkGroup) groups.set(clip.linkGroup, [...(groups.get(clip.linkGroup) ?? []), { clip, media, track: ti + 1, index: ci + 1 }]);
  }));
  place(timeline.video, 'video');
  place(timeline.audio, 'audio');
  const rate = timeline.rate;

  const clipXml = (/** @type {NleClip} */ clip, /** @type {'video' | 'audio'} */ media, /** @type {string} */ pad) => {
    const file = files.get(clip.fileId);
    if (!file) throw new Error(`clip ${clip.id} points at a missing file ${clip.fileId}`);
    const lines = [
      `${pad}<clipitem id="${xmlEscape(clip.id)}">`, `${pad}  <name>${xmlEscape(clip.name)}</name>`,
      `${pad}  <enabled>${bool(clip.enabled)}</enabled>`, `${pad}  <duration>${file.durationFrames}</duration>`,
      rateXml(rate, `${pad}  `),
      `${pad}  <start>${clip.start}</start>`, `${pad}  <end>${clip.end}</end>`, `${pad}  <in>${clip.in}</in>`, `${pad}  <out>${clip.out}</out>`,
    ];
    if (media === 'video') {
      lines.push(`${pad}  <alphatype>${file.video?.alpha ? 'straight' : 'none'}</alphatype>`, `${pad}  <pixelaspectratio>square</pixelaspectratio>`, `${pad}  <anamorphic>FALSE</anamorphic>`);
    }
    if (written.has(file.id)) lines.push(`${pad}  <file id="${xmlEscape(file.id)}"/>`);
    else { written.add(file.id); lines.push(fileXml(file, rate, `${pad}  `)); }
    if (media === 'audio') {
      lines.push(`${pad}  <sourcetrack>`, `${pad}    <mediatype>audio</mediatype>`, `${pad}    <trackindex>1</trackindex>`, `${pad}  </sourcetrack>`);
      if (clip.gain != null || clip.levels) lines.push(levelXml(clip.gain ?? 1, `${pad}  `, clip.levels));
    } else if (clip.motion) lines.push(motionXml(clip.motion, `${pad}  `));
    const group = clip.linkGroup ? groups.get(clip.linkGroup) : undefined;
    if (group && group.length > 1) {
      for (const p of group) {
        lines.push(`${pad}  <link>`, `${pad}    <linkclipref>${xmlEscape(p.clip.id)}</linkclipref>`, `${pad}    <mediatype>${p.media}</mediatype>`,
          `${pad}    <trackindex>${p.track}</trackindex>`, `${pad}    <clipindex>${p.index}</clipindex>`,
          ...(p.media === 'audio' ? [`${pad}    <groupindex>1</groupindex>`] : []), `${pad}  </link>`);
      }
    }
    lines.push(`${pad}</clipitem>`);
    return lines.join('\n');
  };

  const trackXml = (/** @type {NleTrack} */ track, /** @type {'video' | 'audio'} */ media, /** @type {string} */ pad) => [
    media === 'audio' ? `${pad}<track premiereTrackType="Stereo">` : `${pad}<track>`,
    ...track.clips.map((c) => clipXml(c, media, `${pad}  `)),
    `${pad}  <enabled>${bool(track.enabled)}</enabled>`, `${pad}  <locked>FALSE</locked>`, `${pad}</track>`,
  ].join('\n');

  const p = '        ';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE xmeml>', '<xmeml version="4">', '  <sequence id="sequence-1">',
    `    <name>${xmlEscape(timeline.name)}</name>`, `    <duration>${timeline.durationFrames}</duration>`,
    rateXml(rate, '    '), timecodeXml(rate, '    '), '    <in>-1</in>', '    <out>-1</out>', '    <media>', '      <video>',
    `${p}<format>`, `${p}  <samplecharacteristics>`, rateXml(rate, `${p}    `),
    `${p}    <width>${timeline.width}</width>`, `${p}    <height>${timeline.height}</height>`,
    `${p}    <anamorphic>FALSE</anamorphic>`, `${p}    <pixelaspectratio>square</pixelaspectratio>`, `${p}    <fielddominance>none</fielddominance>`,
    `${p}  </samplecharacteristics>`, `${p}</format>`,
    ...timeline.video.map((t) => trackXml(t, 'video', p)),
    '      </video>', '      <audio>', `${p}<numOutputChannels>2</numOutputChannels>`,
    `${p}<format>`, `${p}  <samplecharacteristics>`, `${p}    <depth>16</depth>`, `${p}    <samplerate>48000</samplerate>`, `${p}  </samplecharacteristics>`, `${p}</format>`,
    ...timeline.audio.map((t) => trackXml(t, 'audio', p)),
    '      </audio>', '    </media>', '  </sequence>', '</xmeml>', '',
  ].join('\n');
}
