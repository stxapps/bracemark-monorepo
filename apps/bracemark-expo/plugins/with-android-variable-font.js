const fs = require('fs/promises');
const path = require('path');
const {
  CodeGenerator,
  withDangerousMod,
  withFinalizedMod,
  withMainApplication,
} = require('expo/config-plugins');

/**
 * Registers a variable TTF as an Android font FAMILY, one `<font>` per weight,
 * each pinning the `wght` axis — so `fontWeight` actually changes the glyphs.
 *
 * Why not the expo-font plugin's plain path form (still used for iOS): on
 * Android it copies the file to `assets/fonts/`, and React Native resolves an
 * asset font by FILE NAME — `fontFamily: 'Inter'` looks for
 * `assets/fonts/Inter.ttf` (and `Inter_bold.ttf` for weight ≥ 700), never
 * `InterVariable.ttf`. The miss is silent: `Typeface.create('Inter', style)`
 * hands back the system face, which has only regular and bold, so every
 * `font-medium`/`font-semibold` rendered at 400 and Inter itself never drew.
 * Renaming the asset to `Inter.ttf` would not have helped either: the asset
 * path collapses every weight to `Typeface.NORMAL` or `BOLD` (a separate
 * `_bold` file), so 500 and 600 can never differ from 400.
 *
 * The weight-aware path is `ReactFontManager.addCustomFont` with a `res/font`
 * XML family: RN then calls `Typeface.create(family, weight, italic)` (API 28+)
 * and Android picks the closest `<font>` entry. expo-font's object form writes
 * that XML, but only `font`/`fontStyle`/`fontWeight` — with no
 * `fontVariationSettings`, every entry would still draw at wght 400 — so this
 * plugin writes it instead.
 *
 * expo-font still receives the same file under its top-level `fonts` key, because
 * expo-share-extension reads that key to embed Inter in the iOS share extension
 * (app.config.ts says so at the entry). On Android that key leaves an unusable
 * second copy in `assets/fonts/` — nothing resolves a family called
 * "InterVariable" — so this plugin deletes it in a `finalized` mod, which runs
 * after every other mod whatever the plugin order.
 *
 * `android/` is CNG output (`prebuild --clean`), so everything here is
 * regenerated on each prebuild. → docs/expo-dependencies.md, _font — Inter_.
 */
const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];

// Resource names: lowercase a-z, 0-9 and underscore only. `inter.xml` is the
// family (R.font.inter), `inter_variable.ttf` the file every entry points at.
const toResName = (s) =>
  s
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_');

const withAndroidVariableFont = (config, { fontFamily, path: fontPath }) => {
  const familyRes = toResName(fontFamily);
  const fileRes = toResName(path.parse(fontPath).name);

  config = withDangerousMod(config, [
    'android',
    async (cfg) => {
      const fontsDir = path.join(cfg.modRequest.platformProjectRoot, 'app/src/main/res/font');
      await fs.mkdir(fontsDir, { recursive: true });
      await fs.copyFile(
        path.resolve(cfg.modRequest.projectRoot, fontPath),
        path.join(fontsDir, `${fileRes}${path.extname(fontPath)}`),
      );
      // `app:` attributes, as expo-font writes them: addCustomFont loads the
      // XML through androidx's ResourcesCompat.getFont.
      const fonts = WEIGHTS.map(
        (w) =>
          `    <font app:font="@font/${fileRes}" app:fontStyle="normal" app:fontWeight="${w}" app:fontVariationSettings="'wght' ${w}" />`,
      ).join('\n');
      await fs.writeFile(
        path.join(fontsDir, `${familyRes}.xml`),
        `<?xml version="1.0" encoding="utf-8"?>\n<font-family xmlns:app="http://schemas.android.com/apk/res-auto">\n${fonts}\n</font-family>\n`,
      );
      return cfg;
    },
  ]);

  config = withFinalizedMod(config, [
    'android',
    async (cfg) => {
      const asset = path.join(
        cfg.modRequest.platformProjectRoot,
        'app/src/main/assets/fonts',
        path.basename(fontPath),
      );
      await fs.rm(asset, { force: true });
      return cfg;
    },
  ]);

  return withMainApplication(config, (cfg) => {
    const { modResults } = cfg;
    if (modResults.language !== 'kt') {
      throw new Error('with-android-variable-font: expected a Kotlin MainApplication');
    }
    const fontManager = 'com.facebook.react.common.assets.ReactFontManager';
    if (!modResults.contents.includes(`import ${fontManager}`)) {
      modResults.contents = modResults.contents.replace(
        /^(package .*\n)/m,
        `$1import ${fontManager}\n`,
      );
    }
    // Throws ERR_NO_MATCH itself if the template loses `super.onCreate()`.
    modResults.contents = CodeGenerator.mergeContents({
      src: modResults.contents,
      newSrc: `    ReactFontManager.getInstance().addCustomFont(this, ${JSON.stringify(fontFamily)}, R.font.${familyRes})`,
      tag: 'variable-font-init',
      anchor: /super\.onCreate\(\)/,
      offset: 1,
      comment: '    //',
    }).contents;
    return cfg;
  });
};

module.exports = withAndroidVariableFont;
