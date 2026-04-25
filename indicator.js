'use strict';

import St from 'gi://St';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import Cogl from 'gi://Cogl';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Promisify Gio async file loading
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(GdkPixbuf.Pixbuf, 'new_from_stream_at_scale_async', 'new_from_stream_at_scale_finish');

const MARQUEE_SPEED = 40;         // pixels per second
const MARQUEE_PAUSE_MS = 2000;    // pause at each end before scrolling back
const MAX_TITLE_WIDTH = 200;      // px, clips title before scrolling kicks in
const PROGRESS_UPDATE_MS = 1000;  // how often we refresh the progress bar
const ART_SIZE = 80;              // album art size in px

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(str, maxLen) {
    if (!str) return '';
    return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
}

function microsToSeconds(micros) {
    return micros / 1_000_000;
}

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// AlbumArt widget
// ---------------------------------------------------------------------------

const AlbumArt = GObject.registerClass(
class AlbumArt extends St.Bin {
    _init() {
        super._init({
            width: ART_SIZE,
            height: ART_SIZE,
            style_class: 'ytmusic-album-art',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._currentUrl = null;
        this._placeholder();
    }

    _placeholder() {
        this.child = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_size: ART_SIZE / 2,
            style_class: 'ytmusic-album-art-placeholder',
        });
    }

    async setUrl(url) {
        if (url === this._currentUrl) return;
        this._currentUrl = url;

        if (!url) {
            this._placeholder();
            return;
        }

        try {
            const file = Gio.File.new_for_uri(url);

            // Load raw bytes
            const [contents] = await file.load_contents_async(null);
            const bytes = GLib.Bytes.new(contents);

            // Decode into pixbuf via async stream
            const stream = Gio.MemoryInputStream.new_from_bytes(bytes);
            const pixbuf = await GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
                stream, ART_SIZE, ART_SIZE, true, null
            );

            if (!pixbuf) {
                this._placeholder();
                return;
            }

            // Build a Clutter.Image and display it
            const image = new Clutter.Image();
            image.set_bytes(
                pixbuf.get_pixels(),
                pixbuf.get_has_alpha()
                    ? Cogl.PixelFormat.RGBA_8888
                    : Cogl.PixelFormat.RGB_888,
                pixbuf.get_width(),
                pixbuf.get_height(),
                pixbuf.get_rowstride()
            );

            const canvas = new Clutter.Actor({
                width: ART_SIZE,
                height: ART_SIZE,
                content: image,
            });

            this.child = canvas;
        } catch (e) {
            logError(e, 'AlbumArt.setUrl');
            this._placeholder();
        }
    }
});

// ---------------------------------------------------------------------------
// ProgressBar
// ---------------------------------------------------------------------------

const ProgressBar = GObject.registerClass(
class ProgressBar extends St.Widget {
    _init() {
        super._init({ style_class: 'ytmusic-progress-container' });

        this._track = new St.Widget({ style_class: 'ytmusic-progress-track' });
        this._fill = new St.Widget({ style_class: 'ytmusic-progress-fill' });
        this._track.add_child(this._fill);
        this.add_child(this._track);

        this._fraction = 0;
        this._track.connect('notify::width', () => this._update());
    }

    setFraction(f) {
        this._fraction = Math.max(0, Math.min(1, f));
        this._update();
    }

    _update() {
        const w = this._track.width;
        this._fill.width = w * this._fraction;
    }
});

// ---------------------------------------------------------------------------
// PopupCard: the dropdown menu content
// ---------------------------------------------------------------------------

const PopupCard = GObject.registerClass(
class PopupCard extends PopupMenu.PopupBaseMenuItem {
    _init() {
        super._init({ reactive: false, can_focus: false });

        // Root container
        const box = new St.BoxLayout({
            vertical: true,
            style_class: 'ytmusic-card',
            x_expand: true,
        });

        // --- Top row: art + track info ---
        const topRow = new St.BoxLayout({
            style_class: 'ytmusic-card-top',
            x_expand: true,
        });

        this._art = new AlbumArt();
        topRow.add_child(this._art);

        const info = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'ytmusic-card-info',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._titleLabel = new St.Label({
            style_class: 'ytmusic-card-title',
            x_expand: true,
        });
        this._titleLabel.clutter_text.ellipsize = 3; // PANGO_ELLIPSIZE_END

        this._artistLabel = new St.Label({
            style_class: 'ytmusic-card-artist',
            x_expand: true,
        });

        info.add_child(this._titleLabel);
        info.add_child(this._artistLabel);
        topRow.add_child(info);
        box.add_child(topRow);

        // --- Progress bar + time ---
        const progressRow = new St.BoxLayout({
            style_class: 'ytmusic-progress-row',
            x_expand: true,
        });

        this._progressBar = new ProgressBar();
        this._progressBar.x_expand = true;
        progressRow.add_child(this._progressBar);
        box.add_child(progressRow);

        const timeRow = new St.BoxLayout({
            style_class: 'ytmusic-time-row',
            x_expand: true,
        });
        this._posLabel = new St.Label({ style_class: 'ytmusic-time-label', text: '0:00' });
        this._durLabel = new St.Label({ style_class: 'ytmusic-time-label', text: '0:00' });
        const spacer = new St.Widget({ x_expand: true });
        timeRow.add_child(this._posLabel);
        timeRow.add_child(spacer);
        timeRow.add_child(this._durLabel);
        box.add_child(timeRow);

        // --- Controls row ---
        const controls = new St.BoxLayout({
            style_class: 'ytmusic-controls',
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });

        this._prevBtn = this._makeButton('media-skip-backward-symbolic', 'Previous');
        this._playBtn = this._makeButton('media-playback-start-symbolic', 'Play/Pause');
        this._nextBtn = this._makeButton('media-skip-forward-symbolic', 'Next');

        controls.add_child(this._prevBtn);
        controls.add_child(this._playBtn);
        controls.add_child(this._nextBtn);
        box.add_child(controls);

        this.add_child(box);

        // Callbacks wired by extension.js
        this.onPlayPause = null;
        this.onNext = null;
        this.onPrevious = null;

        this._prevBtn.connect('clicked', () => this.onPrevious?.());
        this._playBtn.connect('clicked', () => this.onPlayPause?.());
        this._nextBtn.connect('clicked', () => this.onNext?.());
    }

    _makeButton(iconName, tooltip) {
        const btn = new St.Button({
            style_class: 'ytmusic-control-btn',
            can_focus: true,
            reactive: true,
            accessible_name: tooltip,
            child: new St.Icon({
                icon_name: iconName,
                icon_size: 20,
            }),
        });
        return btn;
    }

    update(metadata, playbackStatus, positionMicros) {
        if (!metadata) {
            this._titleLabel.text = 'Not playing';
            this._artistLabel.text = '';
            this._art.setUrl(null);
            this._progressBar.setFraction(0);
            this._posLabel.text = '0:00';
            this._durLabel.text = '0:00';
            this._setPlayIcon(false);
            return;
        }

        this._titleLabel.text = metadata.title || 'Unknown title';
        this._artistLabel.text = metadata.artist || '';
        this._art.setUrl(metadata.artUrl);

        const dur = microsToSeconds(metadata.length);
        const pos = microsToSeconds(positionMicros);
        this._durLabel.text = formatTime(dur);
        this._posLabel.text = formatTime(pos);
        this._progressBar.setFraction(dur > 0 ? pos / dur : 0);

        this._setPlayIcon(playbackStatus === 'Playing');
    }

    _setPlayIcon(isPlaying) {
        this._playBtn.child.icon_name = isPlaying
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
    }
});

// ---------------------------------------------------------------------------
// YTMusicIndicator: the panel button
// ---------------------------------------------------------------------------

export const YTMusicIndicator = GObject.registerClass(
class YTMusicIndicator extends PanelMenu.Button {
    _init(settings) {
        super._init(0.0, 'YouTube Music Controls');
        this._settings = settings;
        this._player = null;
        this._progressTimer = null;

        // --- Panel button contents ---
        const hbox = new St.BoxLayout({ style_class: 'panel-status-menu-box' });

        this._panelIcon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            style_class: 'system-status-icon ytmusic-panel-icon',
        });

        this._panelLabel = new St.Label({
            text: 'YouTube Music',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ytmusic-panel-label',
        });

        this._panelPrev = this._makePanelBtn('media-skip-backward-symbolic');
        this._panelPlay = this._makePanelBtn('media-playback-start-symbolic');
        this._panelNext = this._makePanelBtn('media-skip-forward-symbolic');

        hbox.add_child(this._panelIcon);
        hbox.add_child(this._panelLabel);
        hbox.add_child(this._panelPrev);
        hbox.add_child(this._panelPlay);
        hbox.add_child(this._panelNext);
        this.add_child(hbox);

        // Wire panel button clicks (stop event so menu doesn't open)
        this._panelPrev.connect('clicked', (btn) => {
            btn.get_event_for_action('clicked');
            this._player?.previous();
        });
        this._panelPlay.connect('clicked', () => this._player?.playPause());
        this._panelNext.connect('clicked', () => this._player?.next());

        // --- Popup card ---
        this._card = new PopupCard();
        this._card.onPlayPause = () => this._player?.playPause();
        this._card.onNext = () => this._player?.next();
        this._card.onPrevious = () => this._player?.previous();
        this.menu.addMenuItem(this._card);

        // Separator + raise window item
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._openItem = new PopupMenu.PopupMenuItem('Open YouTube Music');
        this._openItem.connect('activate', () => this._player?.raise());
        this.menu.addMenuItem(this._openItem);

        this._refresh();
    }

    _makePanelBtn(iconName) {
        return new St.Button({
            style_class: 'ytmusic-panel-btn',
            can_focus: false,
            reactive: true,
            child: new St.Icon({ icon_name: iconName, icon_size: 16 }),
        });
    }

    setPlayer(player) {
        // Disconnect old player signals
        if (this._metaChangedId && this._player) {
            this._player.onMetadataChanged = null;
            this._player.onPlaybackStatusChanged = null;
        }

        this._player = player;

        if (player) {
            player.onMetadataChanged = () => this._refresh();
            player.onPlaybackStatusChanged = () => this._refresh();
        }

        this._refresh();
        this._startProgressTimer();
    }

    _refresh() {
        const player = this._player;

        if (!player) {
            this._panelLabel.text = 'YouTube Music';
            this._setPlayIcon(false);
            this._card.update(null, 'Stopped', 0);
            return;
        }

        const meta = player.metadata;
        const status = player.playbackStatus;
        const pos = player.position;

        // Panel label: "Artist - Title"
        const title = meta?.title ?? '';
        const artist = meta?.artist ?? '';
        const labelText = artist && title
            ? `${truncate(artist, 20)} - ${truncate(title, 25)}`
            : truncate(title || artist || 'YouTube Music', 40);

        this._panelLabel.text = labelText;
        this._setPlayIcon(status === 'Playing');
        this._card.update(meta, status, pos);
    }

    _setPlayIcon(isPlaying) {
        const iconName = isPlaying
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
        this._panelPlay.child.icon_name = iconName;
    }

    _startProgressTimer() {
        this._stopProgressTimer();
        this._progressTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            PROGRESS_UPDATE_MS,
            () => {
                if (this._player?.isPlaying)
                    this._card.update(
                        this._player.metadata,
                        this._player.playbackStatus,
                        this._player.position
                    );
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopProgressTimer() {
        if (this._progressTimer) {
            GLib.source_remove(this._progressTimer);
            this._progressTimer = null;
        }
    }

    destroy() {
        this._stopProgressTimer();
        super.destroy();
    }
});
