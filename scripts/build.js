// Bundles the engine, the UI runtime and the four screens into one self-contained index.html.
// Usage: node scripts/build.js            (writes ./index.html)
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const SCREENS = ['welcome', 'world', 'showdown', 'lab'];

const screens = {};
for (const name of SCREENS) {
  const src = fs.readFileSync(path.join(root, 'src', 'screens', name + '.html'), 'utf8');
  const title = (src.match(/<title>([\s\S]*?)<\/title>/) || [, 'NashNet'])[1].trim();
  const a = src.indexOf('<x-screen>');
  const b = src.lastIndexOf('</x-screen>');
  if (a < 0 || b < 0) throw new Error('missing <x-screen> in ' + name);
  const template = src.slice(a + '<x-screen>'.length, b);
  const style = (template.match(/<x-head>[\s\S]*?<style>([\s\S]*?)<\/style>/) || [, ''])[1];
  const sm = src.match(/<script type="text\/x-screen">([\s\S]*?)<\/script>/);
  if (!sm) throw new Error('missing component script in ' + name);
  screens[name] = { title, template, style, script: sm[1] };
}

// keep "</script>" sequences from closing the inline script tag
const safe = s => JSON.stringify(s).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');
const engine = fs.readFileSync(path.join(root, 'engine', 'engine.js'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'src', 'runtime.js'), 'utf8');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NashNet</title>
<meta name="description" content="NashNet: The Compute Commons. A game-theoretic multi-agent simulation of a shared cloud, running entirely in the browser.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;600&family=Space+Grotesk:wght@500;700&display=swap">
<style>
html{color-scheme:dark}
html,body{margin:0;background:#0B0E14;color:#E6EAF2}
*{scrollbar-width:thin;scrollbar-color:#2A3242 transparent}
</style>
<style id="screen-style"></style>
</head>
<body>
<div id="app"><div style="padding:48px;font-family:system-ui,sans-serif;color:#AEB6C6">Loading NashNet…</div></div>
<noscript><div style="padding:48px;font-family:system-ui,sans-serif;color:#E6EAF2">NashNet needs JavaScript. Please enable it and reload.</div></noscript>
<script>
${engine.replace(/<\/script/gi, '<\\/script')}
</script>
<script>
window.NASHNET_SCREENS = ${safe(screens)};
</script>
<script>
${runtime}
</script>
</body>
</html>
`;
fs.writeFileSync(path.join(root, 'index.html'), html);
console.log('built index.html (' + (html.length / 1024).toFixed(0) + ' KB)');
