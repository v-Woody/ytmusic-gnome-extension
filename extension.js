'use strict';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { MprisWatcher } from './mpris.js';
import { YTMusicIndicator } from './indicator.js';

export default class YTMusicExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._watcher = new MprisWatcher();
        this._indicator = new YTMusicIndicator(this._settings);

        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._watcher.onPlayerAdded = (player) => {
            // Always prefer the most recently appeared player
            this._indicator.setPlayer(player);
        };

        this._watcher.onPlayerRemoved = (_busName) => {
            // Fall back to next available player (or null)
            this._indicator.setPlayer(this._watcher.activePlayer);
        };

        this._watcher.init().then(() => {
            // Set initial player if one is already running
            this._indicator.setPlayer(this._watcher.activePlayer);
        }).catch(e => logError(e, 'YTMusicExtension'));

        this._bindMediaKeys();
    }

    disable() {
        this._unbindMediaKeys();

        this._watcher?.destroy();
        this._watcher = null;

        this._indicator?.destroy();
        this._indicator = null;

        this._settings = null;
    }

    // -------------------------------------------------------------------------
    // Media key bindings via GNOME Shell keybindings
    // -------------------------------------------------------------------------

    _bindMediaKeys() {
        this._keyBindings = [
            ['media-play', () => this._watcher?.activePlayer?.playPause()],
            ['media-pause', () => this._watcher?.activePlayer?.playPause()],
            ['media-next', () => this._watcher?.activePlayer?.next()],
            ['media-prev', () => this._watcher?.activePlayer?.previous()],
        ];

        for (const [action, handler] of this._keyBindings) {
            try {
                Main.wm.addKeybinding(
                    action,
                    this._settings,
                    // Shell.ActionMode.ALL
                    ~0,
                    // Meta.KeyBindingFlags.NONE
                    0,
                    handler
                );
            } catch (_e) {
                // Keybinding may already be claimed by another extension; skip silently
            }
        }
    }

    _unbindMediaKeys() {
        if (!this._keyBindings) return;
        for (const [action] of this._keyBindings) {
            try {
                Main.wm.removeKeybinding(action);
            } catch (_e) {
                // ignore
            }
        }
        this._keyBindings = null;
    }
}
