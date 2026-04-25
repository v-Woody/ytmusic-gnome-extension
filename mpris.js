'use strict';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const MPRIS_IFACE = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/>
    <method name="Play"/>
    <method name="Pause"/>
    <method name="Stop"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Seek">
      <arg type="x" direction="in" name="Offset"/>
    </method>
    <method name="SetPosition">
      <arg type="o" direction="in" name="TrackId"/>
      <arg type="x" direction="in" name="Position"/>
    </method>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Volume" type="d" access="readwrite"/>
    <property name="Position" type="x" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <signal name="Seeked">
      <arg type="x" name="Position"/>
    </signal>
  </interface>
</node>`;

const MPRIS_ROOT_IFACE = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <method name="Quit"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
  </interface>
</node>`;

const DBUS_IFACE = `
<node>
  <interface name="org.freedesktop.DBus">
    <method name="ListNames">
      <arg type="as" direction="out" name="names"/>
    </method>
    <signal name="NameOwnerChanged">
      <arg type="s" name="name"/>
      <arg type="s" name="oldOwner"/>
      <arg type="s" name="newOwner"/>
    </signal>
  </interface>
</node>`;

// Known bus name fragments for youtube-music desktop app and browser players
const YTMUSIC_BUS_PATTERNS = [
    'YoutubeMusic',
    'youtube-music',
    'YouTube Music',
    'youtubemusic',
];

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(MPRIS_IFACE);
const RootProxy = Gio.DBusProxy.makeProxyWrapper(MPRIS_ROOT_IFACE);
const DBusProxy = Gio.DBusProxy.makeProxyWrapper(DBUS_IFACE);

export class MprisPlayer {
    constructor(busName) {
        this._busName = busName;
        this._playerProxy = null;
        this._rootProxy = null;
        this._propertiesChangedId = null;
        this._seekedId = null;

        this.onMetadataChanged = null;
        this.onPlaybackStatusChanged = null;
        this.onPositionChanged = null;
    }

    async init() {
        try {
            this._playerProxy = new PlayerProxy(
                Gio.DBus.session,
                this._busName,
                '/org/mpris/MediaPlayer2',
                null
            );

            this._rootProxy = new RootProxy(
                Gio.DBus.session,
                this._busName,
                '/org/mpris/MediaPlayer2',
                null
            );

            this._propertiesChangedId = this._playerProxy.connect(
                'g-properties-changed',
                this._onPropertiesChanged.bind(this)
            );

            this._seekedId = this._playerProxy.connectSignal(
                'Seeked',
                (_proxy, _sender, [position]) => {
                    this.onPositionChanged?.(position);
                }
            );

            return true;
        } catch (e) {
            logError(e, `MprisPlayer: failed to init ${this._busName}`);
            return false;
        }
    }

    destroy() {
        if (this._propertiesChangedId && this._playerProxy) {
            this._playerProxy.disconnect(this._propertiesChangedId);
        }
        if (this._seekedId && this._playerProxy) {
            this._playerProxy.disconnectSignal(this._seekedId);
        }
        this._playerProxy = null;
        this._rootProxy = null;
    }

    _onPropertiesChanged(_proxy, changed, _invalidated) {
        const props = changed.recursiveUnpack();

        if ('Metadata' in props)
            this.onMetadataChanged?.(this.metadata);

        if ('PlaybackStatus' in props)
            this.onPlaybackStatusChanged?.(this.playbackStatus);
    }

    // --- Playback controls ---

    playPause() {
        this._playerProxy?.PlayPauseRemote();
    }

    next() {
        this._playerProxy?.NextRemote();
    }

    previous() {
        this._playerProxy?.PreviousRemote();
    }

    seek(offsetMicroseconds) {
        this._playerProxy?.SeekRemote(offsetMicroseconds);
    }

    setPosition(trackId, positionMicroseconds) {
        this._playerProxy?.SetPositionRemote(trackId, positionMicroseconds);
    }

    raise() {
        this._rootProxy?.RaiseRemote();
    }

    // --- Properties ---

    get playbackStatus() {
        return this._playerProxy?.PlaybackStatus ?? 'Stopped';
    }

    get isPlaying() {
        return this.playbackStatus === 'Playing';
    }

    get metadata() {
        const raw = this._playerProxy?.Metadata;
        if (!raw) return null;

        const m = raw.recursiveUnpack();
        return {
            title: m['xesam:title'] ?? '',
            artist: (m['xesam:artist'] ?? []).join(', '),
            album: m['xesam:album'] ?? '',
            artUrl: m['mpris:artUrl'] ?? null,
            length: m['mpris:length'] ?? 0,   // microseconds
            trackId: m['mpris:trackid'] ?? null,
        };
    }

    get position() {
        // Position is not cached by the proxy; we read it directly
        try {
            const val = this._playerProxy?.get_cached_property('Position');
            return val ? val.get_int64() : 0;
        } catch (_e) {
            return 0;
        }
    }

    get volume() {
        return this._playerProxy?.Volume ?? 1.0;
    }

    set volume(v) {
        if (this._playerProxy)
            this._playerProxy.Volume = Math.max(0, Math.min(1, v));
    }

    get canGoNext() {
        return this._playerProxy?.CanGoNext ?? false;
    }

    get canGoPrevious() {
        return this._playerProxy?.CanGoPrevious ?? false;
    }

    get identity() {
        return this._rootProxy?.Identity ?? '';
    }

    get busName() {
        return this._busName;
    }
}

export class MprisWatcher {
    constructor() {
        this._dbusProxy = null;
        this._nameOwnerChangedId = null;
        this._players = new Map(); // busName -> MprisPlayer

        this.onPlayerAdded = null;
        this.onPlayerRemoved = null;
    }

    async init() {
        this._dbusProxy = new DBusProxy(
            Gio.DBus.session,
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            null
        );

        this._nameOwnerChangedId = this._dbusProxy.connectSignal(
            'NameOwnerChanged',
            this._onNameOwnerChanged.bind(this)
        );

        // Scan existing names
        try {
            const [names] = await new Promise((resolve, reject) => {
                this._dbusProxy.ListNamesRemote((result, error) => {
                    if (error) reject(error);
                    else resolve(result);
                });
            });

            for (const name of names) {
                if (this._isYTMusicBus(name))
                    await this._addPlayer(name);
            }
        } catch (e) {
            logError(e, 'MprisWatcher: failed to list D-Bus names');
        }
    }

    destroy() {
        if (this._nameOwnerChangedId && this._dbusProxy)
            this._dbusProxy.disconnectSignal(this._nameOwnerChangedId);

        for (const player of this._players.values())
            player.destroy();

        this._players.clear();
        this._dbusProxy = null;
    }

    get players() {
        return [...this._players.values()];
    }

    get activePlayer() {
        // Prefer a playing player; fall back to first available
        for (const p of this._players.values()) {
            if (p.isPlaying) return p;
        }
        return this._players.values().next().value ?? null;
    }

    _isYTMusicBus(name) {
        if (!name.startsWith('org.mpris.MediaPlayer2.'))
            return false;
        const suffix = name.slice('org.mpris.MediaPlayer2.'.length).toLowerCase();
        return YTMUSIC_BUS_PATTERNS.some(p => suffix.includes(p.toLowerCase()));
    }

    async _addPlayer(busName) {
        if (this._players.has(busName)) return;

        const player = new MprisPlayer(busName);
        const ok = await player.init();
        if (!ok) return;

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

    _onNameOwnerChanged(_proxy, _sender, [name, oldOwner, newOwner]) {
        if (!name.startsWith('org.mpris.MediaPlayer2.')) return;
        if (!this._isYTMusicBus(name)) return;

        if (newOwner && !oldOwner) {
            // New player appeared
            this._addPlayer(name).catch(e => logError(e));
        } else if (oldOwner && !newOwner) {
            // Player disappeared
            this._removePlayer(name);
        }
    }
}
