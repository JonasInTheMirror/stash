import videojs, { VideoJsPlayer } from "video.js";

export interface ISource extends videojs.Tech.SourceObject {
  label?: string;
  errored?: boolean;
}

class SourceMenuItem extends videojs.getComponent("MenuItem") {
  public source: ISource;
  public isSelected = false;

  constructor(parent: SourceMenuButton, source: ISource) {
    const options = {} as videojs.MenuItemOptions;
    options.selectable = true;
    options.multiSelectable = false;
    options.label = source.label || source.type;

    super(parent.player(), options);

    this.source = source;

    this.addClass("vjs-source-menu-item");
  }

  selected(selected: boolean): void {
    super.selected(selected);
    this.isSelected = selected;
  }

  handleClick() {
    if (this.isSelected) return;

    this.trigger("selected");
  }
}

class SourceMenuButton extends videojs.getComponent("MenuButton") {
  private items: SourceMenuItem[] = [];
  private selectedSource: ISource | null = null;

  constructor(player: VideoJsPlayer) {
    super(player);

    player.on("loadstart", () => {
      this.update();
    });
  }

  public setSources(sources: ISource[]) {
    this.selectedSource = null;

    this.items = sources.map((source, i) => {
      if (i === 0) {
        this.selectedSource = source;
      }

      const item = new SourceMenuItem(this, source);

      item.on("selected", () => {
        this.selectedSource = source;

        this.trigger("sourceselected", source);
      });

      return item;
    });
  }

  createEl() {
    return videojs.dom.createEl("div", {
      className:
        "vjs-source-selector vjs-menu-button vjs-menu-button-popup vjs-control vjs-button",
    });
  }

  createItems() {
    if (this.items === undefined) return [];

    for (const item of this.items) {
      item.selected(item.source === this.selectedSource);
    }

    return this.items;
  }

  setSelectedSource(source: ISource) {
    this.selectedSource = source;
    if (this.items === undefined) return;

    for (const item of this.items) {
      item.selected(item.source === this.selectedSource);
    }
  }

  markSourceErrored(source: ISource) {
    const item = this.items.find((i) => i.source.src === source.src);
    if (item === undefined) return;

    item.addClass("vjs-source-menu-item-error");
  }
}

// Dropped-frame watchdog tuning. Some files direct-play but decode poorly in
// the browser (dropped frames) while re-encoded streams play smoothly.
const QUALITY_SAMPLE_INTERVAL = 2000; // ms between quality samples
const QUALITY_WINDOW_SAMPLES = 4; // rolling window = 4 samples (~8s)
const QUALITY_WARMUP_SAMPLES = 2; // ignore initial samples (~4s)
const QUALITY_DROP_THRESHOLD = 0.1; // switch when >10% frames dropped
const QUALITY_MIN_WINDOW_FRAMES = 60; // require enough frames to judge
const QUALITY_MAX_AUTO_SWITCHES = 2; // stop trying after this many switches

class SourceSelectorPlugin extends videojs.getPlugin("plugin") {
  private menu: SourceMenuButton;
  private sources: ISource[] = [];
  private selectedIndex = -1;
  private cleanupTextTracks: HTMLTrackElement[] = [];
  private manualTextTracks: HTMLTrackElement[] = [];

  // don't auto play next source if user manually selected a source
  private manuallySelected = false;

  // dropped-frame watchdog state
  private qualityTimer: number | undefined;
  private qualitySamples: { total: number; dropped: number }[] = [];
  private autoQualitySwitches = 0;

  constructor(player: VideoJsPlayer) {
    super(player);

    this.menu = new SourceMenuButton(player);

    this.menu.on("sourceselected", (_, source: ISource) => {
      this.selectedIndex = this.sources.indexOf(source);
      if (this.selectedIndex === -1) return;

      this.manuallySelected = true;

      const loadSrc = this.sources[this.selectedIndex];

      const currentTime = player.currentTime();
      const paused = player.paused();

      player.src(loadSrc);
      player.one("canplay", () => {
        if (paused) {
          player.pause();
        }
        player.currentTime(currentTime);
      });
      player.play();
    });

    player.on("ready", () => {
      const { controlBar } = player;
      const fullscreenToggle = controlBar.getChild("fullscreenToggle")!.el();
      controlBar.addChild(this.menu);
      controlBar.el().insertBefore(this.menu.el(), fullscreenToggle);
    });

    player.on("loadedmetadata", () => {
      if (!player.videoWidth() && !player.videoHeight()) {
        // Occurs during preload when videos with supported audio/unsupported video are preloaded.
        // Treat this as a decoding error and try the next source without playing.
        // However on Safari we get an media event when m3u8 or mpd is loaded which needs to be ignored.
        if (player.error() !== null) return;

        const currentSrc = player.currentSrc();
        if (currentSrc === null) return;

        if (currentSrc.includes(".m3u8") || currentSrc.includes(".mpd")) {
          player.play();
        } else {
          player.error(MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED);
          return;
        }
      }
    });

    player.on("error", () => {
      const error = player.error();
      if (!error) return;

      // Only try next source if media was unsupported
      if (
        error.code !== MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED &&
        error.code !== MediaError.MEDIA_ERR_DECODE
      )
        return;

      const currentSource = player.currentSource() as ISource;
      console.log(`Source '${currentSource.label}' is unsupported`);

      // mark current source as errored
      currentSource.errored = true;
      this.menu.markSourceErrored(currentSource);

      // don't auto play next source if user manually selected a source
      if (this.manuallySelected) {
        return;
      }

      // TODO - make auto play next source configurable
      // try the next source in the list
      if (
        this.selectedIndex !== -1 &&
        this.selectedIndex + 1 < this.sources.length
      ) {
        this.selectedIndex += 1;
        const newSource = this.sources[this.selectedIndex];
        console.log(`Trying next source in playlist: '${newSource.label}'`);
        this.menu.setSelectedSource(newSource);

        const currentTime = player.currentTime();
        player.src(newSource);
        player.load();
        player.one("canplay", () => {
          player.currentTime(currentTime);
        });
        player.play();
      } else {
        console.log("No more sources in playlist");
      }
    });

    player.on("playing", () => this.startQualityWatchdog());
    player.on(["pause", "seeking", "waiting", "loadstart"], () =>
      this.resetQualityWatchdog()
    );
    player.on("dispose", () => this.stopQualityWatchdog());
  }

  // The dropped-frame watchdog detects sources that the browser decodes
  // poorly (e.g. bitstreams that break hardware decoding) and switches to a
  // re-encoded stream, which plays smoothly.
  private startQualityWatchdog() {
    if (this.qualityTimer !== undefined) return;
    if (this.autoQualitySwitches >= QUALITY_MAX_AUTO_SWITCHES) return;
    // respect explicit user choice, same as the error fallback
    if (this.manuallySelected) return;

    this.qualitySamples = [];
    this.qualityTimer = window.setInterval(
      () => this.checkQuality(),
      QUALITY_SAMPLE_INTERVAL
    );
  }

  private resetQualityWatchdog() {
    // discard samples spanning a seek/stall/source change, they misreport
    this.stopQualityWatchdog();
    if (!this.player.paused()) {
      this.startQualityWatchdog();
    }
  }

  private stopQualityWatchdog() {
    if (this.qualityTimer !== undefined) {
      window.clearInterval(this.qualityTimer);
      this.qualityTimer = undefined;
    }
    this.qualitySamples = [];
  }

  private currentVideoElement(): HTMLVideoElement | null {
    return this.player.el()?.querySelector("video") ?? null;
  }

  private checkQuality() {
    const video = this.currentVideoElement();
    if (!video || typeof video.getVideoPlaybackQuality !== "function") {
      this.stopQualityWatchdog();
      return;
    }

    const q = video.getVideoPlaybackQuality();
    this.qualitySamples.push({
      total: q.totalVideoFrames,
      dropped: q.droppedVideoFrames,
    });

    if (this.qualitySamples.length < QUALITY_WARMUP_SAMPLES + 2) return;
    if (
      this.qualitySamples.length >
      QUALITY_WARMUP_SAMPLES + QUALITY_WINDOW_SAMPLES
    ) {
      this.qualitySamples.splice(
        0,
        this.qualitySamples.length -
          (QUALITY_WARMUP_SAMPLES + QUALITY_WINDOW_SAMPLES)
      );
    }

    const first = this.qualitySamples[0];
    const last = this.qualitySamples[this.qualitySamples.length - 1];
    const windowTotal = last.total - first.total;
    const windowDropped = last.dropped - first.dropped;

    if (windowTotal < QUALITY_MIN_WINDOW_FRAMES) return;

    const dropRatio = windowDropped / windowTotal;
    if (dropRatio <= QUALITY_DROP_THRESHOLD) return;

    console.log(
      `Playback dropping frames (${(dropRatio * 100).toFixed(1)}% over last ${
        windowTotal
      } frames), switching to a transcoded stream`
    );
    this.switchForQuality();
  }

  // Whether the current source serves the original video bitstream: the
  // direct stream, or an MP4/WebM "transcode" that stream-copies when the
  // codec already matches (no reencode flag).
  private servesOriginalBitstream(src: string): boolean {
    try {
      const url = new URL(src, window.location.origin);
      if (url.pathname.endsWith("/stream")) return true;
      if (
        url.pathname.endsWith("/stream.mp4") ||
        url.pathname.endsWith("/stream.webm")
      ) {
        return url.searchParams.get("reencode") !== "true";
      }
    } catch {
      // ignore unparsable URLs
    }
    return false;
  }

  private switchForQuality() {
    this.stopQualityWatchdog();

    const currentSource = this.player.currentSource() as ISource;
    if (!this.servesOriginalBitstream(currentSource.src)) {
      // already on a re-encoded stream and still dropping frames -
      // switching again won't help
      this.autoQualitySwitches = QUALITY_MAX_AUTO_SWITCHES;
      return;
    }

    // prefer HLS/DASH (always re-encoded, segment-cached and seekable),
    // then fall back to a forced re-encode of the piped MP4 stream
    let newSource = this.sources.find(
      (s) =>
        !s.errored &&
        s.src !== currentSource.src &&
        (s.src.includes(".m3u8") || s.src.includes(".mpd"))
    );

    if (!newSource) {
      const mp4 = this.sources.find(
        (s) => !s.errored && s.src.includes("stream.mp4")
      );
      if (mp4) {
        const url = new URL(mp4.src, window.location.origin);
        url.searchParams.set("reencode", "true");
        newSource = { ...mp4, src: url.toString() };
      }
    }

    if (!newSource) {
      console.log("No re-encoded source available to switch to");
      this.autoQualitySwitches = QUALITY_MAX_AUTO_SWITCHES;
      return;
    }

    this.autoQualitySwitches += 1;

    const newIndex = this.sources.indexOf(newSource);
    if (newIndex !== -1) {
      this.selectedIndex = newIndex;
      this.menu.setSelectedSource(newSource);
    }

    console.log(`Switching to source: '${newSource.label}'`);

    const player = this.player;
    const currentTime = player.currentTime();
    player.src(newSource);
    player.load();
    player.one("canplay", () => {
      player.currentTime(currentTime);
    });
    player.play();
  }

  setSources(sources: ISource[]) {
    const cleanupTracks = this.cleanupTextTracks.splice(0);
    for (const track of cleanupTracks) {
      this.player.removeRemoteTextTrack(track);
    }

    this.stopQualityWatchdog();
    this.autoQualitySwitches = 0;
    this.manuallySelected = false;

    this.menu.setSources(sources);
    if (sources.length !== 0) {
      this.selectedIndex = 0;
    } else {
      this.selectedIndex = -1;
    }

    this.sources = sources;
    this.player.src(sources[0]);
  }

  get textTracks(): HTMLTrackElement[] {
    return [...this.cleanupTextTracks, ...this.manualTextTracks];
  }

  addTextTrack(options: videojs.TextTrackOptions, manualCleanup: boolean) {
    const track = this.player.addRemoteTextTrack(options, true);
    if (manualCleanup) {
      this.manualTextTracks.push(track);
    } else {
      this.cleanupTextTracks.push(track);
    }
    return track;
  }

  removeTextTrack(track: HTMLTrackElement) {
    this.player.removeRemoteTextTrack(track);
    let index = this.manualTextTracks.indexOf(track);
    if (index !== -1) {
      this.manualTextTracks.splice(index, 1);
    }
    index = this.cleanupTextTracks.indexOf(track);
    if (index !== -1) {
      this.cleanupTextTracks.splice(index, 1);
    }
  }
}

// Register the plugin with video.js.
videojs.registerComponent("SourceMenuButton", SourceMenuButton);
videojs.registerPlugin("sourceSelector", SourceSelectorPlugin);

declare module "video.js" {
  interface VideoJsPlayer {
    sourceSelector: () => SourceSelectorPlugin;
  }
  interface VideoJsPlayerPluginOptions {
    sourceSelector?: object;
  }
}

export default SourceSelectorPlugin;
