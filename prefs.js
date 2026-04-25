'use strict';

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class YTMusicPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        // ---- Panel group ----
        const panelGroup = new Adw.PreferencesGroup({ title: 'Panel' });
        page.add(panelGroup);

        // Show track label
        const showLabelRow = new Adw.SwitchRow({
            title: 'Show track name in panel',
            subtitle: 'Displays artist and title next to the icon',
        });
        settings.bind('show-track-label', showLabelRow, 'active', 0);
        panelGroup.add(showLabelRow);

        // Show panel controls
        const showControlsRow = new Adw.SwitchRow({
            title: 'Show playback buttons in panel',
            subtitle: 'Adds previous, play/pause, and next buttons inline',
        });
        settings.bind('show-panel-controls', showControlsRow, 'active', 0);
        panelGroup.add(showControlsRow);

        // Panel position
        const positionRow = new Adw.ComboRow({
            title: 'Panel position',
            model: Gtk.StringList.new(['Left', 'Center', 'Right']),
        });
        const positions = ['left', 'center', 'right'];
        positionRow.selected = positions.indexOf(settings.get_string('panel-position'));
        positionRow.connect('notify::selected', () => {
            settings.set_string('panel-position', positions[positionRow.selected]);
        });
        panelGroup.add(positionRow);

        // ---- Display group ----
        const displayGroup = new Adw.PreferencesGroup({ title: 'Display' });
        page.add(displayGroup);

        // Max title length
        const titleLenRow = new Adw.SpinRow({
            title: 'Maximum title length',
            subtitle: 'Characters shown in the panel before truncating',
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 100,
                step_increment: 5,
            }),
        });
        settings.bind('max-title-length', titleLenRow, 'value', 0);
        displayGroup.add(titleLenRow);
    }
}
