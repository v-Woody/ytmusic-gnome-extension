# YouTube Music Controls

A GNOME Shell extension that adds a YouTube Music panel indicator with playback controls, album art, and a progress bar.

## Features

- Panel indicator showing current track (artist and title)
- Inline prev / play-pause / next buttons in the panel
- Popup card with album art, track info, progress bar and time
- Media key support (play, pause, next, previous)
- Works with the [youtube-music](https://github.com/th-ch/youtube-music) desktop app via MPRIS
- Preferences: toggle panel label, toggle panel buttons, choose panel position, set title truncation length

## Requirements

- GNOME Shell 45, 46, or 47
- [youtube-music](https://github.com/th-ch/youtube-music) desktop app (free and open source)

## Installation

### From source

```bash
# Clone the repo
git clone https://github.com/v-Woody/ytmusic-gnome-extension
cd ytmusic-gnome-extension

# Compile the GSettings schema
glib-compile-schemas schemas/

# Copy to your local extensions directory
cp -r . ~/.local/share/gnome-shell/extensions/ytmusic-controls@v-Woody

# Restart GNOME Shell (X11: Alt+F2 -> r -> Enter; Wayland: log out and back in)
# Then enable the extension
gnome-extensions enable ytmusic-controls@v-Woody
```

### Install youtube-music desktop app

```bash
# Arch
yay -S youtube-music-bin

# Debian/Ubuntu (.deb from releases page)
# https://github.com/th-ch/youtube-music/releases

# Flatpak
flatpak install flathub th.co.craftz.youtube-music
```

Make sure youtube-music is running before enabling the extension.

## Project structure

```
ytmusic-gnome-extension/
  extension.js        Main entry point. Wires watcher, indicator, media keys
  indicator.js        Panel button and popup card UI
  mpris.js            MPRIS D-Bus watcher and player proxy
  prefs.js            Preferences window (Adwaita)
  stylesheet.css      Styles for all UI elements
  metadata.json       Extension metadata
  schemas/            GSettings schema
```

## Development

```bash
# Watch GNOME Shell logs
journalctl -f -o cat /usr/bin/gnome-shell

# Reload extension without restarting (X11 only)
gnome-extensions disable ytmusic-controls@v-Woody
gnome-extensions enable ytmusic-controls@v-Woody
```

## Contributing

Pull requests are welcome. Please open an issue first for larger changes.

## License

MIT
