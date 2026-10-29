// يبني Code.gs (الملف اللي تلصقه في Google Apps Script) من brain.js + server.js
const fs = require('fs'), path = require('path');
const brain = fs.readFileSync(path.join(__dirname, '..', 'brain.js'), 'utf8').replace(/\nif \(typeof module[^\n]*\n?$/, '\n');
const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const head = '/* جسمي — ملف السيرفر الكامل لـ Google Apps Script.\n   هذا الملف مولّد من body-tracker/brain.js و body-tracker/server/server.js (شغّل node body-tracker/server/build.js). */\n\n';
fs.writeFileSync(path.join(__dirname, 'Code.gs'), head + brain + '\n' + server);
console.log('Code.gs', fs.statSync(path.join(__dirname, 'Code.gs')).size, 'bytes');
