'use strict';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Identity strings and bus name fragments that indicate YouTube Music
// regardless of which browser is hosting it.
const YTMUSIC_IDENTITY_PATTERNS = [
    'youtube music',
];

const YTMUSIC_BUS_PATTERNS = [
    'youtubemusic',
    'youtube-music',
    'youtube_music',
];

// Bus names that are never music players (system services, etc.)
const IGNORED_BUS_PATTERNS = [
    'gnome.settings',
    'kdeconnect',
];

// ---------------------------------------------------------------------------
// Async D-Bus helpers
// ---------------------------------------------------------------------------

function dbusCall(busName, objectPath, iface, method, params, signature) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(
            busName,
            objectPath,
            iface,
            method,
            params ? new GLib.Variant(signature, params) : null,
            null,
            Gio.DBusCallFlags.NONE,
            2000,
            null,
            (_conn, res) => {
                try {
                    const reply = Gio.DBus.session.call_finish(res);
                    resolve(reply.recursiveUnpack());
                } catch (e) {
                    reject(e);
                }
            }
        );
    });
}

function getProperty(busName, objectPath, iface, prop) {
    return dbusCall(
        busName, objectPath,
        'org.freedesktop.DBus.Properties', 'Get',
        [iface, prop], '(ss)'
    ).then(result => result[0]);
}

function getAllProperties(busName, objectPath, iface) {
    return dbusCall(
        busName, objectPath,
        'org.freedesktop.DBus.Properties', 'GetAll',
        [iface], '(s)'
    ).then(result => result[0]);
}

// ---------------------------------------------------------------------------
// MprisPlayer
// ---------------------------------------------------------------------------

export class MprisPlayer {
    constructor(busName) {
        this._busName = busName;
        this._signalId = null;
        this._metadata = null;
        this._playbackStatus = 'Stopped';
        this._position = 0;
        this._canGoNext = false;
        this._canGoPrevious = false;
        this._identity = '';

        this.onMetadataChanged = null;
        this.onPlaybackStatusChanged = null;
    }

    async init() {
        try {
            // Load initial properties
            const props = await getAllProperties(
                this._busName,
                '/org/mpris/MediaPlayer2',
                'org.mpris.MediaPlayer2.Player'
            );

            this._applyProps(props);

            // Also grab the player identity
            try {
                const rootProps = await getAllProperties(
                    this._busName,
                    '/org/mpris/MediaPlayer2',
                    'org.mpris.MediaPlayer2'
                );
                this._identity = rootProps['Identity'] ?? '';
            } catch (_e) {}

            // Subscribe to PropertiesChanged
            this._signalId = Gio.DBus.session.signal_subscribe(
                this._busName,
                'org.freedesktop.DBus.Properties',
                'PropertiesChanged',
                '/org/mpris/MediaPlayer2',
                null,
                Gio.DBusSignalFlags.NONE,
                this._onPropertiesChanged.bind(this)
            );

            return true;
        } catch (e) {
            logError(e, `MprisPlayer.init: ${this._busName}`);
            return false;
        }
    }

    destroy() {
        if (this._signalId !== null) {
            Gio.DBus.session.signal_unsubscribe(this._signalId);
            this._signalId = null;
        }
    }

    _applyProps(props) {
        if ('Metadata' in props) {
            const m = props['Metadata'];
            this._metadata = {
                title: m['xesam:title'] ?? '',
                artist: Array.isArray(m['xesam:artist'])
                    ? m['xesam:artist'].join(', ')
                    : (m['xesam:artist'] ?? ''),
                album: m['xesam:album'] ?? '',
                artUrl: m['mpris:artUrl'] ?? null,
                length: m['mpris:length'] ?? 0,
                trackId: m['mpris:trackid'] ?? null,
            };
        }
        if ('PlaybackStatus' in props)
            this._playbackStatus = props['PlaybackStatus'];
        if ('CanGoNext' in props)
            this._canGoNext = props['CanGoNext'];
        if ('CanGoPrevious' in props)
            this._canGoPrevious = props['CanGoPrevious'];
        if ('Position' in props)
            this._position = props['Position'];
    }

    _onPropertiesChanged(_conn, _sender, _path, _iface, _signal, params) {
        try {
            const [, changedProps] = params.recursiveUnpack();
            const hadMetadata = !!this._metadata?.title;
            this._applyProps(changedProps);

            if ('Metadata' in changedProps)
                this.onMetadataChanged?.(this._metadata);
            if ('PlaybackStatus' in changedProps)
                this.onPlaybackStatusChanged?.(this._playbackStatus);
        } catch (e) {
            logError(e, 'MprisPlayer._onPropertiesChanged');
        }
    }

    // --- Controls ---

    _callPlayer(method) {
        Gio.DBus.session.call(
            this._busName,
            '/org/mpris/MediaPlayer2',
            'org.mpris.MediaPlayer2.Player',
            method,
            null, null,
            Gio.DBusCallFlags.NONE,
            -1, null, null
        );
    }

    playPause() { this._callPlayer('PlayPause'); }
    next()      { this._callPlayer('Next'); }
    previous()  { this._callPlayer('Previous'); }

    raise() {
        Gio.DBus.session.call(
            this._busName,
            '/org/mpris/MediaPlayer2',
            'org.mpris.MediaPlayer2',
            'Raise',
            null, null,
            Gio.DBusCallFlags.NONE,
            -1, null, null
        );
    }

    // Refresh position on demand (not cached by signal)
    async refreshPosition() {
        try {
            const val = await getProperty(
                this._busName,
                '/org/mpris/MediaPlayer2',
                'org.mpris.MediaPlayer2.Player',
                'Position'
            );
            this._position = val ?? 0;
        } catch (_e) {}
    }

    // --- Getters ---

    get playbackStatus()  { return this._playbackStatus; }
    get isPlaying()       { return this._playbackStatus === 'Playing'; }
    get metadata()        { return this._metadata; }
    get position()        { return this._position; }
    get canGoNext()       { return this._canGoNext; }
    get canGoPrevious()   { return this._canGoPrevious; }
    get identity()        { return this._identity; }
    get busName()         { return this._busName; }
}

// ---------------------------------------------------------------------------
// MprisWatcher
// ---------------------------------------------------------------------------

export class MprisWatcher {
    constructor() {
        this._players = new Map();
        this._nameWatcherId = null;

        this.onPlayerAdded = null;
        this.onPlayerRemoved = null;
    }

    async init() {
        // Watch for bus name changes
        this._nameWatcherId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus',
            'org.freedesktop.DBus',
            'NameOwnerChanged',
            '/org/freedesktop/DBus',
            null,
            Gio.DBusSignalFlags.NONE,
            this._onNameOwnerChanged.bind(this)
        );

        // Scan names already on the bus
        try {
            const result = await dbusCall(
                'org.freedesktop.DBus',
                '/org/freedesktop/DBus',
                'org.freedesktop.DBus',
                'ListNames',
                null, null
            );
            const names = result[0];
            log(`[ytmusic] ListNames found ${names.length} names`);
            for (const name of names) {
                log(`[ytmusic] checking: ${name} -> supported=${this._isSupportedBus(name)}`);
                if (this._isSupportedBus(name))
                    await this._addPlayer(name);
            }
            log(`[ytmusic] players after scan: ${[...this._players.keys()].join(', ') || 'none'}`);
        } catch (e) {
            logError(e, 'MprisWatcher.init');
        }
    }

    destroy() {
        if (this._nameWatcherId !== null) {
            Gio.DBus.session.signal_unsubscribe(this._nameWatcherId);
            this._nameWatcherId = null;
        }
        for (const player of this._players.values())
            player.destroy();
        this._players.clear();
    }

    get players() {
        return [...this._players.values()];
    }

    get activePlayer() {
        const all = [...this._players.values()];

        // 1. A YTMusic player that is currently playing
        const ytPlaying = all.find(p => this._isYTMusicPlayer(p) && p.isPlaying);
        if (ytPlaying) return ytPlaying;

        // 2. Any YTMusic player (paused but present)
        const ytAny = all.find(p => this._isYTMusicPlayer(p));
        if (ytAny) return ytAny;

        // 3. Any player that is currently playing (fallback for non-YTMusic use)
        const anyPlaying = all.find(p => p.isPlaying);
        if (anyPlaying) return anyPlaying;

        // 4. First available player
        return all[0] ?? null;
    }

    _isSupportedBus(name) {
        if (!name.startsWith('org.mpris.MediaPlayer2.'))
            return false;
        const lower = name.toLowerCase();
        return !IGNORED_BUS_PATTERNS.some(p => lower.includes(p.toLowerCase()));
    }

    // A player is considered YouTube Music if its identity or bus name
    // matches known patterns, covering the desktop app, PWA installs,
    // and any browser hosting music.youtube.com.
    _isYTMusicPlayer(player) {
        const identity = player.identity.toLowerCase();
        if (YTMUSIC_IDENTITY_PATTERNS.some(p => identity.includes(p)))
            return true;
        const bus = player.busName.toLowerCase();
        if (YTMUSIC_BUS_PATTERNS.some(p => bus.includes(p)))
            return true;
        return false;
    }

    async _addPlayer(busName) {
        if (this._players.has(busName)) return;
        const player = new MprisPlayer(busName);
        const ok = await player.init();
        log(`[ytmusic] _addPlayer ${busName} -> ok=${ok} status=${player.playbackStatus} identity="${player.identity}" title="${player.metadata?.title}"`);
        if (!ok) return;

        // Re-notify when metadata changes so the indicator can re-evaluate
        // which player should be active (identity may arrive after init).
        const origMeta = player.onMetadataChanged;
        player.onMetadataChanged = (meta) => {
            origMeta?.(meta);
            this.onPlayerAdded?.(player);
        };

        this._players.set(busName, player);
        this.onPlayerAdded?.(player);
    }

    _removePlayer(busName) {
        const player = this._players.get(busName);
        if (!player) return;
        player.destroy();
        this._players.delete(busName);
        this.onPlayerRemoved?.(busName);
    }

    _onNameOwnerChanged(_conn, _sender, _path, _iface, _signal, params) {
        const [name, oldOwner, newOwner] = params.recursiveUnpack();
        if (!this._isSupportedBus(name)) return;

        if (newOwner && !oldOwner)
            this._addPlayer(name).catch(e => logError(e));
        else if (oldOwner && !newOwner)
            this._removePlayer(name);
    }
}
