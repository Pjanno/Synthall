'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const allowed = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'] };
http.createServer((req, res) => {
  const entry = allowed[req.url.split('?')[0]];
  if (!entry) { res.writeHead(404); res.end('Not found'); return; }
  fs.readFile(path.join(__dirname, entry[0]), (error, data) => {
    if (error) { res.writeHead(500); res.end('File unavailable'); return; }
    res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-store' }); res.end(data);
  });
}).listen(8080, '127.0.0.1', () => console.log('Spectral Resynth: http://localhost:8080'));
