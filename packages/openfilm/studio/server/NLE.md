# Editing-project exports

`film.html` is the film format, defined in `SPEC.md` and read by `src/film-doc.mjs`. It remains the source of truth.
The export structures below are internal JavaScript contracts, not a second file format or a public versioned protocol.

The shared path is:

```text
film.html + resolved clip spans + source facts
  → NleFilm (seconds, source track indices, picture/sound relationships)
  → planNleTimeline
  → NleTimeline (frame-aligned clips, tracks, files and media jobs)
  → media preparation
  → format.serialize(timeline, options)
  → staged documents and media, then one folder rename
```

`exports.mjs` owns the queue, cancellation, source-path checks, browser timing, ffprobe, rendering, copying,
transcoding, stem mixing, progress, staging, publication and cleanup. These are shared by every editing-project format.
The planner in `nle.mjs` owns edge rounding, lane allocation, media reuse, transforms, gain/fade keyframes and
picture/sound link groups. A format must not repeat those steps.

## Adapter contract

`nle-formats.mjs` is the server's catalog. Each adapter provides:

- `folderSuffix`: the existing export folder's naming suffix.
- `mediaPolicy`: source-container compatibility (`videoTranscode`, `stillCopy`, `audioCopy` extension sets).
  The existing adapters share `NLE_MEDIA_POLICY` from `nle-media.mjs`; an adapter can supply different sets without
  changing the planner or media executor. Extensions are lowercase, without a leading dot.
  Output profiles `video`, `alphaVideo` and `audio` select the extension, codec and codec arguments; video profiles
  also declare pixel format, alpha support and the embedded audio profile. Audio profiles declare sample rate.
  The same profiles travel in media jobs for source conversion, rendered pages, trimmed/speed-adjusted audio and
  mixed stems. File names and plan metadata follow those profiles. Defaults remain ProRes 422 HQ/4444 and 48 kHz WAV.
  Rendered pages require an alpha profile with MOV or WebM; source video conversion can also use MP4.
  Unsupported encoders or muxing combinations fail through ffmpeg; declaring a profile does not install an encoder.
  Still rasterization remains transparent PNG, matching Chromium's capture output.
- `audioTracks`: role grouping or original source rows, passed to the shared planner. Source mode also retains
  Studio row names and footage link groups, including rendered pictures and processed audio. FCPXML nests footage
  audio under its own video and preserves distinct dialogue roles for voice and footage stems (PR #90).
- `strictSubtitles`: whether an unreadable subtitle source fails the export. This preserves the current behavior:
  FCPXML fails; the older formats continue without cues. Choosing not to export subtitles never reads them.
- `draftApp`, only for Jianying/CapCut: select that app's drafts directory when found, otherwise use the export folder.
- `serialize(timeline, { title, folder, root, cues })`: return a nonempty array of `{ name, text }` documents. Names are
  file names in the export folder; the first document is the editor's entry point for Reveal/Open. No file I/O occurs here.
  Before writing, `checkedNleDocuments` validates the entire result: no paths, duplicate names (case insensitive),
  reserved desktop file names or collision with the `media` directory. Invalid output fails with staging cleanup.
  Built-in XML adapters prefix reserved project file names (for example `CON.xml` becomes `_CON.xml`).

`folder` is the final folder, never the temporary staging folder; `root` is its parent. All media paths in the plan
already point to their final locations. Leave the plan and cues unchanged. Times in `NleTimeline` are integer frames
at `timeline.rate`; `NleFile.video.fps` carries source frame rates. Cues retain milliseconds until serialized. The
serializer alone maps these to xmeml frames, FCPXML rational seconds or draft microseconds.

The serializers are `xmemlDocument` in `xmeml.mjs`, `fcpxmlDocument` in `fcpxml.mjs`, and `jianyingDraft` in
`jianying.mjs`. `nle.mjs` owns the shared plan and source probing; XML escaping lives in `nle-xml.mjs`.
Editor XML is xmeml for both Premiere and DaVinci Resolve; they are not separate formats. Jianying and CapCut share a draft schema with different
app identities. FCPXML retains its own storyline, connections, titles and role mapping.

## Adding a format

Implement a serializer consuming `NleTimeline`, add its adapter to `NLE_FORMATS`, and test its output through that
adapter. Server request validation and format selection follow the catalog; media preparation does not change.
A new visible export choice still needs a UI entry and translated instructions in each supported language.
Do not invent a new generic option for a format that does not need it.

Run `nle-media.test.mjs` for media policy and encoding selection, `nle-formats.test.mjs` for the document contract,
each serializer's tests for its target schema, and `exports.test.mjs` for rendered/copied/linked media, subtitles,
atomic publication and cancellation. The adapter integration test verifies H.264 source conversion, transparent
VP9 rendering, AIFF conversion and stems at 44.1 kHz with ffprobe, plus invalid-document cleanup.
A serializer refactor must retain existing outputs; a new format also needs an import check in its real editor. A valid document alone does not prove native import.
