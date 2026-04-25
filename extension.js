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

        const position = this._settings.get_string('panel-position');
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, position);

        this._watcher.onPlayerAdded = (_player) => {
            this._indicator.setPlayer(this._watcher.activePlayer);
        };

        this._indicator._card.onVolume = (level) => {
            this._watcher.activePlayer?.setVolume(level);
        };

        this._watcher.onPlayerRemoved = (_busName) => {
            this._indicator.setPlayer(this._watcher.activePlayer);
        };

        this._watcher.init().then(() => {
            this._indicator.setPlayer(this._watcher.activePlayer);
        }).catch(e => console.error('YTMusicExtension init error:', e));
    }

    disable() {
        this._watcher?.destroy();
        this._watcher = null;

        this._indicator?.destroy();
        this._indicator = null;

        this._settings = null;
    }
}
