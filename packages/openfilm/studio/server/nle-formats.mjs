// @ts-check
/** Editing-project adapters. Media preparation and file I/O belong to exports.mjs, not to a format. */
import { basename } from 'node:path';
import { fcpxmlDocument } from './fcpxml.mjs';
import { jianyingDraft } from './jianying.mjs';
import { xmemlDocument } from './xmeml.mjs';
import { NLE_MEDIA_POLICY } from './nle-media.mjs';
import { filmSubtitleSrt } from './film-subtitle.mjs';

/**
 * @typedef {import('./nle.mjs').NleTimeline} NleTimeline
 * @typedef {import('./film-subtitle.mjs').FilmSubtitleCue} Cue
 * @typedef {import('./jianying.mjs').DraftApp} DraftApp
 * @typedef {{ title: string, folder: string, root: string, cues: readonly Cue[] }} DocumentOptions
 * @typedef {{ name: string, text: string }} NleDocument
 *   File names are relative to the export folder. The first document is the editor's entry point.
 * @typedef {{ mediaPolicy: import('./nle-media.mjs').NleMediaPolicy, folderSuffix: string, audioTracks: 'roles' | 'source', strictSubtitles: boolean, draftApp?: DraftApp,
 *   serialize: (timeline: NleTimeline, options: DocumentOptions) => NleDocument[] }} NleFormat
 */

const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/** XML timelines share an optional SRT sidecar. @param {string} name @param {string} text @param {DocumentOptions} options */
function xmlDocuments(name, text, { title, cues }) {
  const srt = filmSubtitleSrt(cues);
  return [{ name, text }, ...(srt ? [{ name: `${title}.srt`, text: srt }] : [])]
    .map((document) => RESERVED_NAME.test(document.name) ? { ...document, name: `_${document.name}` } : document);
}

/** The same draft schema, with each app's identity and destination. @param {DraftApp} app @returns {NleFormat} */
function draftFormat(app) {
  return {
    mediaPolicy: NLE_MEDIA_POLICY, folderSuffix: '', audioTracks: 'roles', strictSubtitles: false, draftApp: app,
    serialize(timeline, { folder, root, cues }) {
      // The Windows and macOS names contain exactly the same draft.
      const draft = jianyingDraft(timeline, { app, name: basename(folder), folder, root, cues });
      const info = JSON.stringify(draft.info);
      return [
        { name: 'draft_info.json', text: info },
        { name: 'draft_content.json', text: info },
        { name: 'draft_meta_info.json', text: JSON.stringify(draft.meta) },
      ];
    },
  };
}

/** @satisfies {Record<string, NleFormat>} */
export const NLE_FORMATS = {
  xml: {
    mediaPolicy: NLE_MEDIA_POLICY, folderSuffix: ' · Editor XML', audioTracks: 'roles', strictSubtitles: false,
    serialize: (timeline, options) => xmlDocuments(`${options.title}.xml`, xmemlDocument(timeline), options),
  },
  fcpxml: {
    mediaPolicy: NLE_MEDIA_POLICY, folderSuffix: ' · Final Cut Pro', audioTracks: 'source', strictSubtitles: true,
    serialize: (timeline, options) => xmlDocuments(`${options.title}.fcpxml`, fcpxmlDocument(timeline, { cues: options.cues }), options),
  },
  jianying: draftFormat('jianying'),
  capcut: draftFormat('capcut'),
};

/** A missing format means the existing Editor XML default; reject unknown and inherited names.
 * @param {unknown} [id] @returns {NleFormat | undefined}
 */
export function nleFormat(id = 'xml') {
  return typeof id === 'string' && Object.hasOwn(NLE_FORMATS, id) ? NLE_FORMATS[/** @type {keyof typeof NLE_FORMATS} */ (id)] : undefined;
}

/** Validate the whole set before writing any document. Names must work on every supported desktop platform.
 * @param {readonly NleDocument[]} documents
 */
export function checkedNleDocuments(documents) {
  if (!Array.isArray(documents) || !documents.length) throw new Error('editing-project format produced no entry document');
  const names = new Set();
  for (const document of documents) {
    const name = document?.name;
    if (typeof name !== 'string' || !name || /[\\/:*?"<>|\u0000-\u001f]/.test(name) || /[. ]$/.test(name)
      || /^media$/i.test(name) || RESERVED_NAME.test(name)) {
      throw new Error(`invalid editing-project document name: ${String(name)}`);
    }
    if (names.has(name.toLowerCase())) throw new Error(`duplicate editing-project document name: ${name}`);
    if (typeof document.text !== 'string') throw new Error(`editing-project document has no text: ${name}`);
    names.add(name.toLowerCase());
  }
  return documents;
}
