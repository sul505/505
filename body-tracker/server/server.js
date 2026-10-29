/* ================= سيرفر جسمي (Google Apps Script) =================
   سيري يرسل كلامك هنا، السيرفر يفهمه (Brain فوق)، يسجله في Google Sheets، ويرد بجملة تقولها سيري.
   الروابط:
     ?q=اكلت 3 بيضات        يسجل ويرد (نص لسيري)
     ?q=...&hint=food        نفس الشي، وإذا ما عرف الأكلة يقدرها بدل ما يقول ما فهمت
     ?action=status          وش وضعي اليوم
     ?action=nudge           تنبيه إذا فيه شي يستاهل (فاضي إذا ما فيه) — للأتمتة في الاختصارات
     ?action=week            تقرير الأسبوع
     ?action=suggest         وش آكل الحين
     ?action=data            كل البيانات (للتطبيق)
   أضف &fmt=json أو &callback=fn للتطبيق. */

var SHEET_NAME = 'السجل';
var COLS = ['id', 'grp', 'ts', 'date', 'time', 'type', 'name', 'qty', 'kcal', 'p', 'c', 'f', 'ml', 'val', 'reps', 'sets', 'min', 'est', 'src', 'text'];
var HEAD = ['المعرف', 'المجموعة', 'الطابع', 'التاريخ', 'الوقت', 'النوع', 'الوصف', 'الكمية', 'سعرات', 'بروتين', 'كارب', 'دهون', 'ماي (مل)', 'القيمة', 'تكرارات', 'جولات', 'دقائق', 'تقدير', 'المصدر', 'اللي قلته'];
var SETTING_KEYS = ['kcal', 'protein', 'carbs', 'fat', 'water', 'height', 'weight', 'age', 'act', 'wake', 'sleep', 'start', 'tz'];
var _sheet = null;

function doGet(e) { return respond_(e && e.parameter ? e.parameter : {}); }
function doPost(e) {
  var p = {}, src = (e && e.parameter) || {}, k;
  for (k in src) p[k] = src[k];
  try { if (e && e.postData && e.postData.contents) { var j = JSON.parse(e.postData.contents); for (k in j) p[k] = j[k]; } } catch (err) { /* نص عادي */ }
  return respond_(p);
}

function respond_(p) {
  var res;
  try { res = route_(p); }
  catch (err) { res = { ok: false, error: String(err && err.message || err), reply: 'صار خطأ في السيرفر: ' + (err && err.message || err) }; }
  var cb = p.callback && /^[A-Za-z_$][\w$.]{0,60}$/.test(p.callback) ? p.callback : '';
  if (cb) return ContentService.createTextOutput(cb + '(' + JSON.stringify(res) + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
  if (p.fmt === 'json') return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
  return ContentService.createTextOutput(res.reply != null ? String(res.reply) : '').setMimeType(ContentService.MimeType.TEXT);
}

function route_(p) {
  var props = PropertiesService.getScriptProperties();
  var S = getJSON_(props, 'settings', {}), now = Date.now();
  var tz = S.tz || Session.getScriptTimeZone() || 'Asia/Riyadh';
  var clock = function (ts) {
    var d = new Date(ts);
    return { date: Utilities.formatDate(d, tz, 'yyyy-MM-dd'), time: Utilities.formatDate(d, tz, 'HH:mm'), h: +Utilities.formatDate(d, tz, 'H') + Utilities.formatDate(d, tz, 'm') / 60 };
  };
  if (!S.start) { S.start = clock(now).date; props.setProperty('settings', JSON.stringify(S)); }
  var foods = getJSON_(props, 'foods', []);
  var action = p.action || (p.q != null ? 'log' : 'info');
  var recent = function () { return readRows_(now - 70 * 864e5, tz); };

  switch (action) {
    case 'info':
      var ss = sheet_().getParent();
      return { ok: true, reply: 'السيرفر شغال. سجلك محفوظ في Google Sheets باسم: ' + ss.getName(), sheetUrl: ss.getUrl(), version: Brain.version, tz: tz };
    case 'log':
      var lock = LockService.getScriptLock();
      lock.waitLock(20000);
      try {
        var r = Brain.handle(String(p.q || ''), { now: now, clock: clock, settings: S, rows: recent(), foods: foods, hint: p.hint || '', src: p.src || 'siri' });
        if (r.del) deleteGroup_(r.del);
        if (r.add && r.add.length) appendRows_(r.add);
        return { ok: true, reply: r.reply, add: r.add || [], del: r.del || null, intent: r.intent };
      } finally { lock.releaseLock(); }
    case 'status':
      return { ok: true, reply: Brain.status(recent(), S, now, clock, p.focus || '') };
    case 'week':
      return { ok: true, reply: Brain.weekly(recent(), S, now, clock).spoken };
    case 'suggest':
      return { ok: true, reply: Brain.suggest(recent(), S, now, clock) };
    case 'nudge':
      var sent = getJSON_(props, 'nudges', {}), n = Brain.nudge(recent(), S, now, clock, sent);
      if (n.keys.length) props.setProperty('nudges', JSON.stringify(n.sent));
      return { ok: true, reply: n.text, keys: n.keys };
    case 'data':
      var days = Math.min(400, Math.max(1, +p.days || 120));
      return { ok: true, rows: readRows_(now - days * 864e5, tz), settings: Brain.settings(S), foods: foods, sheetUrl: sheet_().getParent().getUrl(), now: now, tz: tz };
    case 'del':
      var lk = LockService.getScriptLock();
      lk.waitLock(20000);
      try { return { ok: true, removed: deleteGroup_(String(p.grp || '')) }; } finally { lk.releaseLock(); }
    case 'settings':
      SETTING_KEYS.forEach(function (k) {
        if (p[k] == null || p[k] === '') return;
        S[k] = /^(wake|sleep|start|tz)$/.test(k) ? String(p[k]) : +p[k];
      });
      props.setProperty('settings', JSON.stringify(S));
      return { ok: true, settings: Brain.settings(S), reply: 'حفظت الإعدادات.' };
    case 'learn':
      var name = String(p.name || '').trim();
      if (!name) return { ok: false, reply: 'اكتب اسم الأكلة.' };
      var food = { name: name, k: +p.kcal || 0, p: +p.protein || 0, c: +p.carbs || 0, f: +p.fat || 0, aliases: String(p.aliases || '').split(/[,،]/).map(function (a) { return a.trim(); }).filter(Boolean) };
      foods = foods.filter(function (x) { return x.name !== name; }).concat([food]);
      props.setProperty('foods', JSON.stringify(foods));
      return { ok: true, foods: foods, reply: 'تعلمت ' + name + ': ' + food.k + ' سعرة و' + food.p + ' غرام بروتين.' };
    case 'unlearn':
      foods = foods.filter(function (x) { return x.name !== String(p.name || ''); });
      props.setProperty('foods', JSON.stringify(foods));
      return { ok: true, foods: foods };
    default:
      return { ok: false, reply: 'ما أعرف هالطلب.' };
  }
}

function getJSON_(props, key, fallback) {
  try { var v = props.getProperty(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
}

function sheet_() {
  if (_sheet) return _sheet;
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('sheetId'), ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('جسمي — سجل الأكل والماي والتمرين');
    var sh = ss.getSheets()[0];
    sh.setName(SHEET_NAME);
    sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('D:E').setNumberFormat('@');
    sh.setRightToLeft(true);
    sh.hideColumns(1, 3);
    props.setProperty('sheetId', ss.getId());
  }
  _sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
  return _sheet;
}

function readRows_(since, tz) {
  var sh = sheet_(), n = sh.getLastRow();
  if (n < 2) return [];
  var vals = sh.getRange(2, 1, n - 1, COLS.length).getValues(), out = [];
  for (var i = 0; i < vals.length; i++) {
    var v = vals[i], o = {};
    for (var c = 0; c < COLS.length; c++) o[COLS[c]] = v[c];
    if (!o.id) continue;
    o.ts = +o.ts;
    if (since && o.ts < since) continue;
    if (o.date instanceof Date) o.date = Utilities.formatDate(o.date, tz, 'yyyy-MM-dd');
    if (o.time instanceof Date) o.time = Utilities.formatDate(o.time, tz, 'HH:mm');
    out.push(o);
  }
  return out;
}

function appendRows_(rows) {
  var sh = sheet_();
  var data = rows.map(function (r) {
    return COLS.map(function (k) {
      var v = r[k] == null ? '' : r[k];
      return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v;
    });
  });
  sh.getRange(sh.getLastRow() + 1, 1, data.length, COLS.length).setValues(data);
}

function deleteGroup_(grp) {
  if (!grp) return 0;
  var sh = sheet_(), n = sh.getLastRow(), removed = 0;
  if (n < 2) return 0;
  var ids = sh.getRange(2, 1, n - 1, 2).getValues();
  for (var i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i][1]) === grp || String(ids[i][0]) === grp) { sh.deleteRow(i + 2); removed++; }
  }
  return removed;
}

// شغّل هذي مرة من المحرر إذا تبي تشوف رابط جدولك أو تجرب بدون سيري.
function setup() { Logger.log('جدولك: ' + sheet_().getParent().getUrl()); }
function tryIt() { Logger.log(route_({ q: 'اكلت 3 بيضات وشربت كوب ماي' }).reply); }
