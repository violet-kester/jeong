# Jeong (정) for Obsidian

Record your thoughts and see them on a timeline, all on your own computer. This is the first, early version of the plugin.

## Develop

1. `npm install`
2. Create `local.json` (not committed) pointing at your vault's plugin folder:
   ```json
   { "pluginDir": "/path/to/vault/.obsidian/plugins/jeong" }
   ```
   Without it, builds go to `build/`.
3. `npm run dev` rebuilds on every change. With the [Hot Reload](https://github.com/pjeby/hot-reload) plugin enabled, Obsidian reloads Jeong automatically.
4. `npm run build` makes a production build. `npm run lint` checks the code.

## Notes

- All on-screen text goes through `src/i18n` so Jeong can be translated. Never hard-code words in the UI.
- License: MIT (see the repo root). Started from the official [Obsidian sample plugin](https://github.com/obsidianmd/obsidian-sample-plugin) (0BSD).
