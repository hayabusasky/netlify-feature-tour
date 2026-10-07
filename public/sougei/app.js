/* 送迎ルート作成アプリ（画面部分）。データはこのブラウザの中だけに保存します。 */
(function () {
  'use strict';

  const P = window.Planner;
  const STORAGE_KEY = 'sougei-data-v1';
  const KEY_STORAGE = 'sougei-google-key';
  const COLORS = ['#1a6fd1', '#d9480f', '#2b8a3e', '#9c36b5', '#c2255c', '#0b7285', '#e67700', '#5c940d'];
  const MODE_LABEL = { pickup: '迎え', dropoff: '送り' };

  // ---------- 保存 ----------

  function emptyState() {
    return {
      settings: Object.assign(
        { facilityName: '', facilityAddress: '', facilityLat: null, facilityLng: null },
        P.DEFAULT_SETTINGS
      ),
      users: [],
      vehicles: [],
      staff: [],
      defaultCrews: {},
      days: {},
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return Object.assign(emptyState(), JSON.parse(raw));
    } catch (e) {
      console.warn(e);
    }
    return null;
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      toast('保存できませんでした（ブラウザの設定を確認してください）');
    }
  }

  function getApiKey() {
    try {
      return localStorage.getItem(KEY_STORAGE) || '';
    } catch (e) {
      return '';
    }
  }

  function setApiKey(v) {
    try {
      if (v) localStorage.setItem(KEY_STORAGE, v);
      else localStorage.removeItem(KEY_STORAGE);
    } catch (e) {
      /* 保存できなくても続行 */
    }
  }

  let state = load() || emptyState();
  const ui = {
    tab: 'today',
    date: todayStr(),
    mode: 'pickup',
    filters: new Set(),
    weekday: '',
    search: '',
  };
  const googleRoutes = new Map(); // ルートごとの Google 実測結果（メモリのみ）

  // ---------- 小物 ----------

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function uid(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function weekdayOf(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d).getDay();
  }

  let toastTimer;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
  }

  function facility() {
    const s = state.settings;
    if (s.facilityLat == null || s.facilityLng == null || s.facilityLat === '' || s.facilityLng === '') return null;
    return { lat: Number(s.facilityLat), lng: Number(s.facilityLng), name: s.facilityName || '事業所' };
  }

  function userById(id) {
    return state.users.find((u) => u.id === id);
  }

  function hasLocation(u) {
    return u.lat != null && u.lng != null && u.lat !== '' && u.lng !== '' && isFinite(u.lat) && isFinite(u.lng);
  }

  function num(v) {
    if (v === '' || v == null) return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
  }

  // 「35.86, 139.64」のような貼り付けを緯度・経度に分ける
  function parseLatLng(text) {
    const m = /(-?\d+(?:\.\d+)?)\s*[,，、\s]\s*(-?\d+(?:\.\d+)?)/.exec(String(text));
    return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
  }

  // ---------- 日ごとのデータ ----------

  function day(dateStr) {
    if (!state.days[dateStr]) {
      const wd = weekdayOf(dateStr);
      const attend = {};
      state.users.forEach((u) => {
        attend[u.id] = (u.days || []).includes(wd);
      });
      const crews = JSON.parse(JSON.stringify(state.defaultCrews || {}));
      state.days[dateStr] = {
        attend,
        crews: { pickup: crews, dropoff: JSON.parse(JSON.stringify(crews)) },
        plans: {},
      };
    }
    const d = state.days[dateStr];
    // 後から追加された利用者は曜日で出欠を決める
    const wd = weekdayOf(dateStr);
    state.users.forEach((u) => {
      if (!(u.id in d.attend)) d.attend[u.id] = (u.days || []).includes(wd);
    });
    return d;
  }

  function attendees(d) {
    return state.users.filter((u) => d.attend[u.id]);
  }

  // ---------- 地図 ----------

  const MapView = {
    kind: null,
    loading: null,
    ensure() {
      if (this.loading) return this.loading;
      const key = getApiKey();
      this.loading = (key ? loadGoogle(key) : loadLeaflet())
        .then((kind) => (this.kind = kind))
        .catch((err) => {
          console.warn(err);
          this.kind = 'svg';
          this.error = key
            ? 'Google マップを読み込めませんでした（APIキーと許可設定を確認してください）。簡易表示にしています。'
            : '地図を読み込めませんでした。簡易表示にしています。';
          return 'svg';
        });
      return this.loading;
    },
  };

  function loadScript(src, timeoutMs) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      const timer = setTimeout(() => reject(new Error('timeout: ' + src)), timeoutMs || 10000);
      s.onload = () => {
        clearTimeout(timer);
        resolve();
      };
      s.onerror = () => {
        clearTimeout(timer);
        reject(new Error('load error: ' + src));
      };
      document.head.appendChild(s);
    });
  }

  function loadGoogle(key) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('google timeout')), 10000);
      window.gm_authFailure = () => {
        MapView.kind = 'svg';
        MapView.error = 'Google マップの認証に失敗しました（APIキー・リファラー制限・課金設定を確認してください）。';
        renderAll();
      };
      window.__sougeiGoogleReady = () => {
        clearTimeout(timer);
        resolve('google');
      };
      loadScript(
        'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) +
          '&language=ja&region=JP&loading=async&callback=__sougeiGoogleReady',
        10000
      ).catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  function loadLeaflet() {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);
    return loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', 8000).then(() => 'leaflet');
  }

  /*
   * layers: [{ color, points: [{lat,lng,label,title}], path?: [{lat,lng}] }]
   * path が無いときは点を直線でつなぐ（実際の道順ではない）。
   */
  function drawMap(el, center, layers, opts) {
    opts = opts || {};
    const all = [];
    if (center) all.push(center);
    layers.forEach((l) => l.points.forEach((p) => all.push(p)));
    if (!all.length) {
      el.innerHTML = '<p class="muted" style="padding:1rem">表示できる地点がありません。</p>';
      return;
    }
    const kind = MapView.kind || 'svg';
    if (kind === 'google') return drawGoogle(el, center, layers, all, opts);
    if (kind === 'leaflet') return drawLeaflet(el, center, layers, all, opts);
    return drawSvg(el, center, layers, all, opts);
  }

  function drawGoogle(el, center, layers, all, opts) {
    const g = window.google.maps;
    if (el._gmap) el._gmapOverlays.forEach((o) => o.setMap(null));
    else {
      el.innerHTML = '';
      el._gmap = new g.Map(el, { center: all[0], zoom: 13, mapTypeControl: false, streetViewControl: false });
    }
    const map = el._gmap;
    const overlays = [];
    const bounds = new g.LatLngBounds();
    if (center) {
      overlays.push(new g.Marker({ position: center, map, title: center.name, label: { text: '★', color: '#fff' } }));
      bounds.extend(center);
    }
    layers.forEach((l) => {
      if (opts.lines !== false) {
        const path = l.path || (center ? [center].concat(l.points, [center]) : l.points);
        overlays.push(new g.Polyline({ path, map, strokeColor: l.color, strokeOpacity: 0.85, strokeWeight: 4 }));
      }
      l.points.forEach((p) => {
        overlays.push(
          new g.Marker({
            position: p,
            map,
            title: p.title,
            label: { text: String(p.label), color: '#fff', fontWeight: '700' },
            icon: { path: g.SymbolPath.CIRCLE, scale: 11, fillColor: l.color, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 },
          })
        );
        bounds.extend(p);
      });
    });
    el._gmapOverlays = overlays;
    if (all.length > 1) map.fitBounds(bounds, 40);
  }

  function drawLeaflet(el, center, layers, all, opts) {
    const L = window.L;
    if (!el._lmap) {
      el.innerHTML = '';
      el._lmap = L.map(el);
      L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>',
      }).addTo(el._lmap);
      el._lgroup = L.layerGroup().addTo(el._lmap);
    }
    const group = el._lgroup;
    group.clearLayers();
    const pin = (color, text) =>
      L.divIcon({
        className: '',
        html: '<span class="num-pin" style="--vcolor:' + color + '">' + esc(text) + '</span>',
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });
    if (center) L.marker([center.lat, center.lng], { icon: pin('#1f2933', '★'), title: center.name }).addTo(group);
    layers.forEach((l) => {
      if (opts.lines !== false) {
        const path = center ? [center].concat(l.points, [center]) : l.points;
        L.polyline(path.map((p) => [p.lat, p.lng]), { color: l.color, weight: 4, opacity: 0.8, dashArray: '6 6' }).addTo(group);
      }
      l.points.forEach((p) => L.marker([p.lat, p.lng], { icon: pin(l.color, p.label), title: p.title }).addTo(group));
    });
    el._lmap.fitBounds(all.map((p) => [p.lat, p.lng]), { padding: [30, 30], maxZoom: 16 });
    setTimeout(() => el._lmap.invalidateSize(), 0);
  }

  // 地図が読めない環境用の簡易表示（位置関係だけ）
  function drawSvg(el, center, layers, all, opts) {
    const W = 800;
    const H = 460;
    const pad = 30;
    const lats = all.map((p) => p.lat);
    const lngs = all.map((p) => p.lng);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const kx = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
    const spanX = Math.max((maxLng - minLng) * kx, 1e-4);
    const spanY = Math.max(maxLat - minLat, 1e-4);
    const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
    const ox = (W - spanX * scale) / 2;
    const oy = (H - spanY * scale) / 2;
    const xy = (p) => [ox + (p.lng - minLng) * kx * scale, H - (oy + (p.lat - minLat) * scale)];
    let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="送迎ルートの位置関係">';
    layers.forEach((l) => {
      if (opts.lines === false) return;
      const path = center ? [center].concat(l.points, [center]) : l.points;
      svg += '<polyline fill="none" stroke="' + l.color + '" stroke-width="3" stroke-dasharray="6 5" points="' +
        path.map((p) => xy(p).map((v) => v.toFixed(1)).join(',')).join(' ') + '" />';
    });
    layers.forEach((l) =>
      l.points.forEach((p) => {
        const [x, y] = xy(p);
        svg += '<g><title>' + esc(p.title) + '</title><circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) +
          '" r="11" fill="' + l.color + '" stroke="#fff" stroke-width="2"/><text x="' + x.toFixed(1) + '" y="' + (y + 4).toFixed(1) +
          '" text-anchor="middle" font-size="11" font-weight="700" fill="#fff">' + esc(p.label) + '</text></g>';
      })
    );
    if (center) {
      const [x, y] = xy(center);
      svg += '<g><title>' + esc(center.name) + '</title><rect x="' + (x - 11).toFixed(1) + '" y="' + (y - 11).toFixed(1) +
        '" width="22" height="22" rx="4" fill="#1f2933"/><text x="' + x.toFixed(1) + '" y="' + (y + 5).toFixed(1) +
        '" text-anchor="middle" font-size="13" fill="#fff">★</text></g>';
    }
    svg += '</svg>';
    el.innerHTML = svg;
  }

  // ---------- 住所 → 緯度経度 ----------

  async function geocode(address) {
    if (!address) throw new Error('住所が空です');
    await MapView.ensure();
    if (MapView.kind === 'google') {
      const res = await new window.google.maps.Geocoder().geocode({ address, region: 'JP' });
      const loc = res.results[0] && res.results[0].geometry.location;
      if (!loc) throw new Error('見つかりませんでした');
      return { lat: loc.lat(), lng: loc.lng(), source: 'Google' };
    }
    // APIキーが無いときは国土地理院の住所検索（無料）を使う
    const r = await fetch('https://msearch.gsi.go.jp/address-search/AddressSearch?q=' + encodeURIComponent(address));
    if (!r.ok) throw new Error('検索に失敗しました（' + r.status + '）');
    const list = await r.json();
    if (!list.length) throw new Error('見つかりませんでした');
    const [lng, lat] = list[0].geometry.coordinates;
    return { lat, lng, source: '国土地理院' };
  }

  // ---------- Google Routes API で実際の道路距離・時間を取る ----------

  function decodePolyline(str) {
    const out = [];
    let i = 0, lat = 0, lng = 0;
    while (i < str.length) {
      for (const which of [0, 1]) {
        let result = 0, shift = 0, b;
        do {
          b = str.charCodeAt(i++) - 63;
          result |= (b & 0x1f) << shift;
          shift += 5;
        } while (b >= 0x20);
        const delta = result & 1 ? ~(result >> 1) : result >> 1;
        if (which === 0) lat += delta;
        else lng += delta;
      }
      out.push({ lat: lat / 1e5, lng: lng / 1e5 });
    }
    return out;
  }

  function routeKey(mode, vid, ids) {
    return mode + '|' + vid + '|' + ids.join(',');
  }

  async function fetchGoogleRoute(fac, route) {
    const ll = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
    const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': getApiKey(),
        'X-Goog-FieldMask': 'routes.legs.duration,routes.legs.distanceMeters,routes.polyline.encodedPolyline',
      },
      body: JSON.stringify({
        origin: ll(fac),
        destination: ll(fac),
        intermediates: route.map(ll),
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_UNAWARE',
        languageCode: 'ja',
        regionCode: 'JP',
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body.error && body.error.message) || 'HTTP ' + res.status);
    const r = body.routes && body.routes[0];
    if (!r) throw new Error('ルートが見つかりませんでした');
    return {
      legs: r.legs.map((l) => ({ min: parseInt(l.duration, 10) / 60, km: (l.distanceMeters || 0) / 1000 })),
      path: r.polyline ? decodePolyline(r.polyline.encodedPolyline) : null,
    };
  }

  // ---------- タブ ----------

  function setTab(tab) {
    ui.tab = tab;
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    document.querySelectorAll('.tab-panel').forEach((p) => (p.hidden = p.id !== 'tab-' + tab));
    renderAll();
  }

  function renderAll() {
    document.getElementById('facility-label').textContent = state.settings.facilityName || '';
    if (ui.tab === 'today') renderToday();
    if (ui.tab === 'users') renderUsers();
    if (ui.tab === 'fleet') renderFleet();
    if (ui.tab === 'settings') renderSettings();
  }

  // ---------- 本日の送迎 ----------

  function crewSelects(vid, crew, usedElsewhere) {
    const ids = crew[vid] || [];
    let html = '';
    for (let i = 0; i < 3; i++) {
      const cur = ids[i] || '';
      html += '<select data-action="crew" data-vid="' + esc(vid) + '" data-slot="' + i + '" aria-label="乗務員' + (i + 1) + '">';
      html += '<option value="">' + (i === 0 ? '運転手' : '添乗') + '：なし</option>';
      state.staff.forEach((s) => {
        const tags = [s.experience, s.nurse ? '看護師' : '', s.canDrive ? '' : '運転不可'].filter(Boolean).join('・');
        const dup = usedElsewhere.has(s.id) && s.id !== cur ? '（他車）' : '';
        html += '<option value="' + esc(s.id) + '"' + (s.id === cur ? ' selected' : '') + '>' + esc(s.name) + '（' + esc(tags) + '）' + dup + '</option>';
      });
      html += '</select>';
    }
    return html;
  }

  function renderToday() {
    const el = document.getElementById('tab-today');
    const fac = facility();
    const d = day(ui.date);
    const wd = weekdayOf(ui.date);
    const mode = ui.mode;
    const crews = d.crews[mode] || (d.crews[mode] = {});
    const plan = d.plans[mode];
    const att = attendees(d);
    const activeVehicles = state.vehicles.filter((v) => v.active !== false);

    let html = '';
    const setup = [];
    if (!fac) setup.push('「設定」で事業所の位置を登録してください。');
    if (!state.users.length) setup.push('「利用者・条件整理」で利用者を登録してください（「設定」からサンプルデータも読み込めます）。');
    if (!activeVehicles.length) setup.push('「車両・職員」で車両を登録してください。');
    if (setup.length) html += '<div class="notice warn">まず準備が必要です<ul>' + setup.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ul></div>';

    html += '<div class="card no-print"><div class="row">' +
      '<label class="field">日付<input type="date" data-action="date" value="' + esc(ui.date) + '"></label>' +
      '<div class="chips" role="group" aria-label="迎え・送り">' +
      ['pickup', 'dropoff'].map((m) => '<button class="chip" data-action="mode" data-mode="' + m + '" aria-pressed="' + (m === mode) + '">' + MODE_LABEL[m] + '</button>').join('') +
      '</div>' +
      '<span class="muted">' + P.WEEKDAYS[wd] + '曜日 ／ ' + MODE_LABEL[mode] + '：' +
      (mode === 'pickup' ? '事業所に ' + esc(state.settings.arriveBy) + ' 到着目標' : '事業所を ' + esc(state.settings.departAt) + ' 出発') + '</span>' +
      '</div></div>';

    // 出欠
    html += '<div class="grid-2 no-print"><div class="card"><h3>出欠（' + att.length + '名）</h3>' +
      '<p class="muted">曜日の登録から自動でチェックしています。休みの人はチェックを外してください。</p><div class="attend-list">';
    state.users.forEach((u) => {
      html += '<label class="check"><input type="checkbox" data-action="attend" data-uid="' + esc(u.id) + '"' + (d.attend[u.id] ? ' checked' : '') + '>' +
        esc(u.name) + (hasLocation(u) ? '' : ' <span class="badge med">位置なし</span>') + '</label>';
    });
    html += '</div></div>';

    // 乗務員
    html += '<div class="card"><h3>乗務員（' + MODE_LABEL[mode] + '）</h3><p class="muted">1人目を運転手、2人目以降を添乗として扱います。</p>';
    activeVehicles.forEach((v, i) => {
      const elsewhere = new Set();
      Object.keys(crews).forEach((k) => k !== v.id && (crews[k] || []).forEach((s) => s && elsewhere.add(s)));
      html += '<div style="margin-bottom:.6rem"><div><span class="num-pin" style="--vcolor:' + COLORS[i % COLORS.length] + '">' + (i + 1) + '</span> ' +
        esc(v.name) + ' <span class="muted">座席' + v.seats + '・車椅子' + v.wheelchairSlots + '</span></div><div class="row">' + crewSelects(v.id, crews, elsewhere) + '</div></div>';
    });
    const dupStaff = duplicateStaff(crews);
    if (dupStaff.length) html += '<div class="notice danger">同じ職員が複数の車両に入っています：' + esc(dupStaff.join('、')) + '</div>';
    html += '</div></div>';

    html += '<div class="row no-print" style="margin-bottom:1rem">' +
      '<button class="primary" data-action="plan"' + (fac && att.length ? '' : ' disabled') + '>ルートを自動作成</button>' +
      (plan && getApiKey() ? '<button data-action="google-routes">Googleで実際の道路の時間を取得</button>' : '') +
      (plan ? '<button data-action="print">印刷</button>' : '') +
      '</div>';

    if (plan) html += renderPlan(d, plan, fac, mode, att);
    el.innerHTML = html;

    if (plan && fac) {
      const mapEl = el.querySelector('#route-map');
      MapView.ensure().then(() => {
        if (!mapEl.isConnected) return;
        drawMap(mapEl, fac, planLayers(plan, mode), {});
        const note = el.querySelector('#map-note');
        if (note) note.textContent = mapNote(plan, mode);
      });
    }
  }

  function duplicateStaff(crews) {
    const seen = new Map();
    const dup = new Set();
    Object.values(crews).forEach((ids) =>
      (ids || []).forEach((id) => {
        if (!id) return;
        if (seen.has(id)) dup.add(id);
        seen.set(id, true);
      })
    );
    return Array.from(dup).map((id) => (state.staff.find((s) => s.id === id) || {}).name || id);
  }

  function vehicleRoute(plan, vid) {
    return (plan.assignments[vid] || []).map(userById).filter(Boolean);
  }

  function planLayers(plan, mode) {
    return state.vehicles
      .filter((v) => v.active !== false)
      .map((v, i) => {
        const route = vehicleRoute(plan, v.id).filter(hasLocation);
        const g = googleRoutes.get(routeKey(mode, v.id, route.map((u) => u.id)));
        return {
          color: COLORS[i % COLORS.length],
          points: route.map((u, k) => ({ lat: Number(u.lat), lng: Number(u.lng), label: k + 1, title: (k + 1) + '. ' + u.name })),
          path: MapView.kind === 'google' && g ? g.path : null,
        };
      })
      .filter((l) => l.points.length);
  }

  function mapNote(plan, mode) {
    if (MapView.error) return MapView.error;
    const anyGoogle = state.vehicles.some((v) => googleRoutes.has(routeKey(mode, v.id, plan.assignments[v.id] || [])));
    if (MapView.kind === 'google' && anyGoogle) return 'Google の道路ルートを表示しています。';
    return '線は訪問の順番を示す直線です（実際の道順ではありません）。番号は' + MODE_LABEL[mode] + 'の順番です。';
  }

  function renderPlan(d, plan, fac, mode, att) {
    const crews = d.crews[mode] || {};
    const attIds = new Set(att.map((u) => u.id));
    const planned = new Set();
    Object.values(plan.assignments).forEach((ids) => ids.forEach((id) => planned.add(id)));
    plan.unassigned.forEach((x) => planned.add(x.userId));
    const stale = att.some((u) => !planned.has(u.id)) || Array.from(planned).some((id) => !attIds.has(id) && userById(id));

    let html = '';
    if (stale) html += '<div class="notice warn no-print">出欠が作成時から変わっています。「ルートを自動作成」で作り直すか、下の「未割当」から手で追加してください。</div>';

    const activeVehicles = state.vehicles.filter((v) => v.active !== false);
    const newcomers = att.filter((u) => !planned.has(u.id));
    let totalKm = 0;
    let problemCount = 0;
    const cards = [];

    activeVehicles.forEach((v, i) => {
      const color = COLORS[i % COLORS.length];
      const route = vehicleRoute(plan, v.id).filter((u) => attIds.has(u.id));
      const crew = P.crewInfo(crews[v.id], state.staff);
      const g = googleRoutes.get(routeKey(mode, v.id, route.map((u) => u.id)));
      const located = route.every(hasLocation);
      const check = located ? P.checkRoute(route, v, crew, state.settings, mode, fac, g && g.legs) : null;
      const unused = (plan.unusedVehicles || []).find((x) => x.vehicleId === v.id);
      let c = '<div class="card vehicle-card" style="--vcolor:' + color + '"><div class="vehicle-head"><h3><span class="num-pin" style="--vcolor:' + color + '">' + (i + 1) + '</span> ' + esc(v.name) + '</h3>';
      if (!route.length) {
        c += '<span class="stat">' + (unused ? '使用しない（' + esc(unused.reason) + '）' : '乗車なし') + '</span></div></div>';
        cards.push(c);
        return;
      }
      const wcCount = route.filter(P.usesWheelchairSlot).length;
      const sch = check && check.schedule;
      if (sch) totalKm += sch.distanceKm;
      c += '<span class="stat">' + (sch ? P.fmtHM(sch.startTime) + ' 出発 → ' + P.fmtHM(sch.endTime) + ' 帰着 ／ 約' + sch.distanceKm.toFixed(1) + 'km ／ ' : '') +
        '座席 ' + (route.length - wcCount) + '/' + v.seats + '・車椅子 ' + wcCount + '/' + v.wheelchairSlots +
        (g ? ' ／ <strong>Google実測</strong>' : ' ／ 概算') + '</span></div>';
      c += '<div class="stat">乗務員：' + (crew.members.length ? crew.members.map((s) => esc(s.name)).join('、') : 'なし') + '</div>';
      c += '<div class="table-wrap"><table><thead><tr><th>順</th><th>' + (mode === 'pickup' ? '迎え' : '到着') + '</th><th>氏名</th><th>住所</th><th>必要な対応</th><th>乗車</th><th class="no-print">修正</th></tr></thead><tbody>';
      route.forEach((u, k) => {
        const s = sch && sch.stops[k];
        const labels = P.requirementLabels(u, state.settings);
        c += '<tr><td>' + (k + 1) + '</td><td>' + (s ? P.fmtHM(s.arrive) + (s.wait ? '<br><span class="muted">待' + Math.round(s.wait) + '分</span>' : '') : '--') + '</td><td>' + esc(u.name) + '</td><td>' + esc(u.address) + '</td><td>' +
          labels.map((t) => '<span class="badge req">' + esc(t) + '</span>').join('') +
          (u.medical ? '<span class="badge med">医療：' + esc(u.medicalNote || 'あり') + '</span>' : '') +
          ((u.equipment || []).length ? '<span class="badge">' + esc(u.equipment.join('・')) + '</span>' : '') +
          (u.note ? '<div class="muted">' + esc(u.note) + '</div>' : '') +
          '</td><td>' + (s ? Math.round(s.ride) + '分' : '--') + '</td><td class="no-print" style="white-space:nowrap">' +
          '<button class="small" data-action="move-up" data-vid="' + esc(v.id) + '" data-uid="' + esc(u.id) + '"' + (k === 0 ? ' disabled' : '') + ' aria-label="上へ">↑</button> ' +
          '<button class="small" data-action="move-down" data-vid="' + esc(v.id) + '" data-uid="' + esc(u.id) + '"' + (k === route.length - 1 ? ' disabled' : '') + ' aria-label="下へ">↓</button> ' +
          moveSelect(u.id, v.id, activeVehicles) + '</td></tr>';
      });
      c += '</tbody></table></div>';
      const problems = check ? check.problems : ['位置が未登録の利用者がいるため時刻を計算できません'];
      problemCount += problems.length;
      if (problems.length) c += '<div class="notice danger"><strong>要確認</strong><ul>' + problems.map((p) => '<li>' + esc(p) + '</li>').join('') + '</ul></div>';
      c += '</div>';
      cards.push(c);
    });

    const unassigned = plan.unassigned.filter((x) => attIds.has(x.userId) && userById(x.userId));
    html += '<div class="card"><div class="vehicle-head"><h3>' + esc(ui.date) + '（' + P.WEEKDAYS[weekdayOf(ui.date)] + '）' + MODE_LABEL[mode] + 'ルート</h3>' +
      '<span class="stat">合計 約' + totalKm.toFixed(1) + 'km ／ ' + (problemCount || unassigned.length || newcomers.length ? '<span style="color:var(--danger)">要確認あり</span>' : '条件はすべて満たしています') + '</span></div>' +
      '<div id="route-map" class="map"></div><div id="map-note" class="map-note"></div></div>';

    if (unassigned.length || newcomers.length) {
      html += '<div class="card"><h3>未割当</h3><div class="table-wrap"><table><tbody>';
      unassigned.forEach((x) => {
        const u = userById(x.userId);
        html += '<tr><td>' + esc(u.name) + '</td><td><ul style="margin:0;padding-left:1.1rem">' + x.reasons.map((r) => '<li>' + esc(r) + '</li>').join('') + '</ul></td><td class="no-print">' + moveSelect(u.id, '', activeVehicles) + '</td></tr>';
      });
      newcomers.forEach((u) => {
        html += '<tr><td>' + esc(u.name) + '</td><td class="muted">作成後に出席になった利用者</td><td class="no-print">' + moveSelect(u.id, '', activeVehicles) + '</td></tr>';
      });
      html += '</tbody></table></div><p class="muted">車両・乗務員・座席が足りない場合は、乗務員を変える、車両を追加する、2便に分けるなどを検討してください。</p></div>';
    }
    return html + cards.join('');
  }

  function moveSelect(uidv, currentVid, vehicles) {
    let s = '<select class="small" data-action="move-to" data-uid="' + esc(uidv) + '" aria-label="車両を変更"><option value="">' + (currentVid ? '車両変更…' : '車両に追加…') + '</option>';
    vehicles.forEach((v) => {
      if (v.id !== currentVid) s += '<option value="' + esc(v.id) + '">' + esc(v.name) + '</option>';
    });
    if (currentVid) s += '<option value="__none">未割当に戻す</option>';
    return s + '</select>';
  }

  function makePlan() {
    const fac = facility();
    const d = day(ui.date);
    const att = attendees(d);
    const users = att.map((u) => Object.assign({}, u, { lat: num(u.lat), lng: num(u.lng) }));
    const plan = P.optimize({
      users,
      vehicles: state.vehicles,
      staff: state.staff,
      crews: d.crews[ui.mode],
      settings: state.settings,
      facility: fac,
      mode: ui.mode,
    });
    d.plans[ui.mode] = plan;
    save();
    renderToday();
    toast(MODE_LABEL[ui.mode] + 'のルートを作成しました');
  }

  function moveUser(uidv, toVid, delta) {
    const d = day(ui.date);
    const plan = d.plans[ui.mode];
    if (!plan) return;
    let fromVid = null;
    Object.keys(plan.assignments).forEach((k) => {
      if (plan.assignments[k].includes(uidv)) fromVid = k;
    });
    if (delta) {
      const list = plan.assignments[fromVid];
      const i = list.indexOf(uidv);
      const j = i + delta;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
    } else {
      if (fromVid) plan.assignments[fromVid] = plan.assignments[fromVid].filter((x) => x !== uidv);
      plan.unassigned = plan.unassigned.filter((x) => x.userId !== uidv);
      if (toVid === '__none') plan.unassigned.push({ userId: uidv, reasons: ['手動で未割当に戻した'] });
      else (plan.assignments[toVid] = plan.assignments[toVid] || []).push(uidv);
    }
    save();
    renderToday();
  }

  async function fetchAllGoogleRoutes() {
    const fac = facility();
    const d = day(ui.date);
    const plan = d.plans[ui.mode];
    const attIds = new Set(attendees(d).map((u) => u.id));
    const jobs = state.vehicles
      .filter((v) => v.active !== false)
      .map((v) => ({ v, route: vehicleRoute(plan, v.id).filter((u) => attIds.has(u.id) && hasLocation(u)) }))
      .filter((x) => x.route.length);
    if (jobs.some((x) => x.route.length > 10)) {
      if (!confirm('経由地が11か所以上の車両があり、Google の料金区分が上がります（Routes API Pro）。続けますか？')) return;
    }
    toast('Google に問い合わせています…');
    let ok = 0;
    const errors = [];
    for (const { v, route } of jobs) {
      const key = routeKey(ui.mode, v.id, route.map((u) => u.id));
      if (googleRoutes.has(key)) {
        ok++;
        continue;
      }
      try {
        googleRoutes.set(key, await fetchGoogleRoute(fac, route.map((u) => ({ lat: Number(u.lat), lng: Number(u.lng) }))));
        ok++;
      } catch (e) {
        errors.push(v.name + '：' + e.message);
      }
    }
    renderToday();
    toast(errors.length ? '取得できなかった車両があります：' + errors.join(' ／ ') : ok + '台分の実際の道路時間を反映しました');
  }

  // ---------- 利用者・条件整理 ----------

  const FILTERS = [
    { key: 'wheelchair', label: '車椅子のまま乗車', test: (u) => P.usesWheelchairSlot(u) },
    { key: 'two', label: '2名体制が必要', test: (u) => P.requirements(u, state.settings).twoStaff.length > 0 },
    { key: 'nurse', label: '看護師同乗', test: (u) => !!u.needsNurse },
    { key: 'medical', label: '医療的配慮', test: (u) => !!u.medical },
    { key: 'newcomer', label: '新人単独不可', test: (u) => !!u.noNewcomerAlone },
    { key: 'step', label: '段差あり（スロープなし）', test: (u) => u.entrance === '段差あり（スロープなし）' },
    { key: 'full', label: '全介助', test: (u) => u.assistLevel === '全介助' },
    { key: 'ng', label: '同乗NGあり', test: (u) => (u.ngWith || []).length > 0 || state.users.some((o) => (o.ngWith || []).includes(u.id)) },
    { key: 'time', label: '時間指定あり', test: (u) => !!(u.pickupEarliest || u.dropEarliest) },
    { key: 'noloc', label: '位置未登録', test: (u) => !hasLocation(u) },
  ];

  function renderUsers() {
    const el = document.getElementById('tab-users');
    const pool = state.users.filter((u) => ui.weekday === '' || (u.days || []).includes(Number(ui.weekday)));
    const list = pool.filter(
      (u) =>
        Array.from(ui.filters).every((k) => FILTERS.find((f) => f.key === k).test(u)) &&
        (!ui.search || (u.name + u.address + (u.note || '')).includes(ui.search))
    );

    // 介護度ごとの人数
    const careCounts = P.CARE_LEVELS.map((c) => [c, pool.filter((u) => u.careLevel === c).length]).filter((x) => x[1]);

    let html = '<div class="card no-print"><div class="row" style="justify-content:space-between">' +
      '<div class="row"><label class="field">曜日<select data-action="weekday"><option value="">すべて</option>' +
      [1, 2, 3, 4, 5, 6, 0].map((w) => '<option value="' + w + '"' + (String(w) === ui.weekday ? ' selected' : '') + '>' + P.WEEKDAYS[w] + '曜日</option>').join('') +
      '</select></label><label class="field">検索<input type="search" data-action="search" value="' + esc(ui.search) + '" placeholder="氏名・住所・備考"></label></div>' +
      '<div class="row"><button data-action="print">印刷</button><button class="primary" data-action="add-user">＋ 利用者を追加</button></div></div>' +
      '<h2>条件で絞り込み</h2><div class="chips">' +
      FILTERS.map((f) => '<button class="chip" data-action="filter" data-key="' + f.key + '" aria-pressed="' + ui.filters.has(f.key) + '">' + f.label + '<span class="count">' + pool.filter(f.test).length + '</span></button>').join('') +
      '</div>' +
      (careCounts.length ? '<p class="muted">介護度：' + careCounts.map((x) => esc(x[0]) + ' ' + x[1] + '名').join('　') + '</p>' : '') +
      '</div>';

    html += '<div class="card"><h3>利用者一覧（' + list.length + '名' + (list.length !== state.users.length ? ' / 全' + state.users.length + '名' : '') + '）</h3>' +
      '<p class="muted no-print">行をクリックすると編集できます。「必要な体制」は条件から自動で判定しています。</p>' +
      '<div class="table-wrap"><table><thead><tr><th>氏名</th><th>介護度</th><th>介助量</th><th>福祉用具</th><th>玄関</th><th>医療的配慮</th><th>必要な体制</th><th>同乗NG</th><th>曜日・時間</th><th>備考</th></tr></thead><tbody>';
    list.forEach((u) => {
      const ng = (u.ngWith || []).map(userById).filter(Boolean).map((x) => x.name);
      state.users.forEach((o) => {
        if ((o.ngWith || []).includes(u.id) && !ng.includes(o.name)) ng.push(o.name);
      });
      html += '<tr class="clickable" data-action="edit-user" data-uid="' + esc(u.id) + '"><td><strong>' + esc(u.name) + '</strong>' + (hasLocation(u) ? '' : '<br><span class="badge med">位置未登録</span>') + '</td>' +
        '<td>' + esc(u.careLevel) + '</td><td>' + esc(u.assistLevel) + '</td><td>' +
        (u.equipment || []).map((e) => '<span class="badge">' + esc(e) + '</span>').join('') + (P.usesWheelchairSlot(u) ? '<div class="muted">車椅子のまま乗車</div>' : '') +
        '</td><td>' + esc(u.entrance) + '</td><td>' + (u.medical ? '<span class="badge med">' + esc(u.medicalNote || 'あり') + '</span>' : '') + '</td><td>' +
        P.requirementLabels(u, state.settings).map((t) => '<span class="badge req">' + esc(t) + '</span>').join('') + '</td><td>' + esc(ng.join('、')) + '</td><td>' +
        esc((u.days || []).slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((w) => P.WEEKDAYS[w]).join('')) +
        (u.pickupEarliest ? '<div class="muted">迎え' + esc(u.pickupEarliest) + '〜</div>' : '') +
        (u.dropEarliest ? '<div class="muted">送り' + esc(u.dropEarliest) + '〜</div>' : '') +
        '</td><td>' + esc(u.note) + '</td></tr>';
    });
    if (!list.length) html += '<tr><td colspan="10" class="muted">該当する利用者はいません。</td></tr>';
    html += '</tbody></table></div></div>';

    html += '<div class="card no-print"><h3>利用者の位置</h3><div id="users-map" class="map" style="height:360px"></div><div id="users-map-note" class="map-note"></div></div>';
    el.innerHTML = html;

    const mapEl = el.querySelector('#users-map');
    MapView.ensure().then(() => {
      if (!mapEl.isConnected) return;
      const pts = list.filter(hasLocation).map((u, i) => ({ lat: Number(u.lat), lng: Number(u.lng), label: i + 1, title: (i + 1) + '. ' + u.name }));
      drawMap(mapEl, facility(), [{ color: '#1a6fd1', points: pts }], { lines: false });
      el.querySelector('#users-map-note').textContent = MapView.error || '番号は一覧の上からの順番です。';
    });
  }

  function openUserDialog(u) {
    const isNew = !u;
    u = u || {
      id: uid('u'),
      name: '',
      address: '',
      lat: null,
      lng: null,
      careLevel: '要介護1',
      assistLevel: '見守り',
      equipment: [],
      rideInWheelchair: false,
      entrance: '段差なし',
      medical: false,
      medicalNote: '',
      needsNurse: false,
      needsTwoStaff: false,
      noNewcomerAlone: false,
      days: [],
      pickupEarliest: '',
      dropEarliest: '',
      ngWith: [],
      note: '',
    };
    const opt = (list, cur) => list.map((x) => '<option' + (x === cur ? ' selected' : '') + '>' + esc(x) + '</option>').join('');
    const chk = (name, checked, label, value) =>
      '<label class="check"><input type="checkbox" name="' + name + '"' + (value != null ? ' value="' + esc(value) + '"' : '') + (checked ? ' checked' : '') + '>' + esc(label) + '</label>';
    const others = state.users.filter((o) => o.id !== u.id);

    const form = document.getElementById('user-form');
    form.dataset.uid = u.id;
    form.dataset.isNew = isNew ? '1' : '';
    form.innerHTML =
      '<h2 style="margin-top:0">' + (isNew ? '利用者を追加' : '利用者を編集') + '</h2>' +
      '<fieldset><legend>基本情報</legend><div class="form-grid">' +
      '<label class="field">氏名<input name="name" required value="' + esc(u.name) + '"></label>' +
      '<label class="field wide">住所<input name="address" value="' + esc(u.address) + '"></label>' +
      '<div class="wide row"><button type="button" data-action="geocode">住所から位置を取得</button>' +
      '<label class="field">緯度<input name="lat" inputmode="decimal" value="' + esc(u.lat == null ? '' : u.lat) + '" size="12"></label>' +
      '<label class="field">経度<input name="lng" inputmode="decimal" value="' + esc(u.lng == null ? '' : u.lng) + '" size="12"></label></div>' +
      '<p class="muted wide" style="margin:0">取得できない時は、Googleマップで家の場所を右クリック → 一番上の数字（緯度, 経度）をクリックしてコピーし、「緯度」欄に貼り付けてください。自動で分けます。</p>' +
      '<div class="wide"><span class="muted">利用曜日</span><div class="chips">' +
      [1, 2, 3, 4, 5, 6, 0].map((w) => chk('days', (u.days || []).includes(w), P.WEEKDAYS[w], w)).join('') + '</div></div>' +
      '</div></fieldset>' +
      '<fieldset><legend>介護・移動</legend><div class="form-grid">' +
      '<label class="field">介護度<select name="careLevel">' + opt(P.CARE_LEVELS, u.careLevel) + '</select></label>' +
      '<label class="field">介助量<select name="assistLevel">' + opt(P.ASSIST_LEVELS, u.assistLevel) + '</select></label>' +
      '<label class="field">自宅の玄関<select name="entrance">' + opt(P.ENTRANCES, u.entrance) + '</select></label>' +
      '<div class="wide"><span class="muted">使用する福祉用具</span><div class="chips">' +
      P.EQUIPMENT.map((e) => chk('equipment', (u.equipment || []).includes(e), e, e)).join('') + '</div></div>' +
      '<div class="wide">' + chk('rideInWheelchair', u.rideInWheelchair, '車椅子のまま乗車する（車椅子枠を使う）') + '</div>' +
      '</div></fieldset>' +
      '<fieldset><legend>医療的な配慮</legend><div class="form-grid">' +
      '<div>' + chk('medical', u.medical, '医療的な配慮が必要') + '</div>' +
      '<label class="field">内容（例：吸引・在宅酸素・インスリン）<input name="medicalNote" value="' + esc(u.medicalNote) + '"></label>' +
      '<div>' + chk('needsNurse', u.needsNurse, '送迎に看護師の同乗が必要') + '</div>' +
      '</div></fieldset>' +
      '<fieldset><legend>送迎の条件</legend><div class="form-grid">' +
      '<div>' + chk('noNewcomerAlone', u.noNewcomerAlone, '新人単独不可（新人だけの車両に乗せない）') + '</div>' +
      '<div>' + chk('needsTwoStaff', u.needsTwoStaff, '2名介助が必要（その他の理由）') + '</div>' +
      '<label class="field">迎えは何時以降<input type="time" name="pickupEarliest" value="' + esc(u.pickupEarliest) + '"></label>' +
      '<label class="field">送りは何時以降に到着<input type="time" name="dropEarliest" value="' + esc(u.dropEarliest) + '"></label>' +
      '<div class="wide"><span class="muted">同じ車に乗せない人（同乗NG）</span><div class="chips">' +
      (others.length ? others.map((o) => chk('ngWith', (u.ngWith || []).includes(o.id) || (o.ngWith || []).includes(u.id), o.name, o.id)).join('') : '<span class="muted">他の利用者がいません</span>') +
      '</div></div>' +
      '<label class="field wide">備考（送迎時の注意など）<textarea name="note">' + esc(u.note) + '</textarea></label>' +
      '</div></fieldset>' +
      '<p class="muted">全介助の方・車椅子で段差（スロープなし）の方は、自動で「2名体制」の車両に割り当てます（設定で変更できます）。</p>' +
      '<div class="dialog-actions"><div>' + (isNew ? '' : '<button type="button" class="danger" data-action="delete-user">削除</button>') + '</div>' +
      '<div class="row"><button type="button" data-action="close-dialog">キャンセル</button><button type="submit" class="primary">保存</button></div></div>';
    document.getElementById('user-dialog').showModal();
  }

  function saveUserForm(form) {
    const f = new FormData(form);
    const id = form.dataset.uid;
    const u = {
      id,
      name: String(f.get('name') || '').trim(),
      address: String(f.get('address') || '').trim(),
      lat: num(f.get('lat')),
      lng: num(f.get('lng')),
      careLevel: f.get('careLevel'),
      assistLevel: f.get('assistLevel'),
      entrance: f.get('entrance'),
      equipment: f.getAll('equipment'),
      rideInWheelchair: f.has('rideInWheelchair'),
      medical: f.has('medical'),
      medicalNote: String(f.get('medicalNote') || '').trim(),
      needsNurse: f.has('needsNurse'),
      needsTwoStaff: f.has('needsTwoStaff'),
      noNewcomerAlone: f.has('noNewcomerAlone'),
      days: f.getAll('days').map(Number),
      pickupEarliest: f.get('pickupEarliest') || '',
      dropEarliest: f.get('dropEarliest') || '',
      ngWith: f.getAll('ngWith'),
      note: String(f.get('note') || '').trim(),
    };
    if (!u.name) return toast('氏名を入力してください');
    if (u.rideInWheelchair && !u.equipment.some((e) => P.WHEELCHAIRS.includes(e))) {
      return toast('「車椅子のまま乗車」の場合は福祉用具で車椅子を選んでください');
    }
    // 同乗NGは片方に登録すれば両方に効くので、この人の側にまとめて相手側からは消す
    state.users.forEach((o) => {
      if (o.id !== id) o.ngWith = (o.ngWith || []).filter((x) => x !== id);
    });
    const i = state.users.findIndex((x) => x.id === id);
    if (i >= 0) state.users[i] = u;
    else state.users.push(u);
    save();
    document.getElementById('user-dialog').close();
    renderAll();
    toast('保存しました');
  }

  // ---------- 車両・職員 ----------

  function renderFleet() {
    const el = document.getElementById('tab-fleet');
    let html = '<div class="card"><div class="vehicle-head"><h3>車両</h3><button data-action="add-vehicle">＋ 車両を追加</button></div>' +
      '<p class="muted">座席数は「車椅子のまま乗らない利用者」が座れる席の数です（職員の席は除く）。</p>' +
      '<div class="table-wrap"><table><thead><tr><th>使用</th><th>車両名</th><th>座席数</th><th>車椅子枠</th><th>いつもの乗務員（運転手・添乗）</th><th></th></tr></thead><tbody>';
    state.vehicles.forEach((v) => {
      const elsewhere = new Set();
      html += '<tr><td><input type="checkbox" data-action="vehicle-field" data-id="' + esc(v.id) + '" data-field="active"' + (v.active !== false ? ' checked' : '') + ' aria-label="使用"></td>' +
        '<td><input data-action="vehicle-field" data-id="' + esc(v.id) + '" data-field="name" value="' + esc(v.name) + '" aria-label="車両名"></td>' +
        '<td><input type="number" min="0" max="20" style="width:5rem" data-action="vehicle-field" data-id="' + esc(v.id) + '" data-field="seats" value="' + esc(v.seats) + '" aria-label="座席数"></td>' +
        '<td><input type="number" min="0" max="6" style="width:5rem" data-action="vehicle-field" data-id="' + esc(v.id) + '" data-field="wheelchairSlots" value="' + esc(v.wheelchairSlots) + '" aria-label="車椅子枠"></td>' +
        '<td><div class="row">' + crewSelects(v.id, state.defaultCrews, elsewhere).replace(/data-action="crew"/g, 'data-action="default-crew"') + '</div></td>' +
        '<td><button class="small danger" data-action="delete-vehicle" data-id="' + esc(v.id) + '">削除</button></td></tr>';
    });
    if (!state.vehicles.length) html += '<tr><td colspan="6" class="muted">車両が登録されていません。</td></tr>';
    html += '</tbody></table></div><p class="muted">「いつもの乗務員」は新しい日付を開いたときの初期値です。日ごとの変更は「本日の送迎」で行います。</p></div>';

    html += '<div class="card"><div class="vehicle-head"><h3>職員</h3><button data-action="add-staff">＋ 職員を追加</button></div>' +
      '<div class="table-wrap"><table><thead><tr><th>氏名</th><th>経験</th><th>看護師</th><th>運転できる</th><th></th></tr></thead><tbody>';
    state.staff.forEach((s) => {
      html += '<tr><td><input data-action="staff-field" data-id="' + esc(s.id) + '" data-field="name" value="' + esc(s.name) + '" aria-label="氏名"></td>' +
        '<td><select data-action="staff-field" data-id="' + esc(s.id) + '" data-field="experience" aria-label="経験">' +
        P.EXPERIENCE.map((x) => '<option' + (x === s.experience ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></td>' +
        '<td><input type="checkbox" data-action="staff-field" data-id="' + esc(s.id) + '" data-field="nurse"' + (s.nurse ? ' checked' : '') + ' aria-label="看護師"></td>' +
        '<td><input type="checkbox" data-action="staff-field" data-id="' + esc(s.id) + '" data-field="canDrive"' + (s.canDrive ? ' checked' : '') + ' aria-label="運転できる"></td>' +
        '<td><button class="small danger" data-action="delete-staff" data-id="' + esc(s.id) + '">削除</button></td></tr>';
    });
    if (!state.staff.length) html += '<tr><td colspan="5" class="muted">職員が登録されていません。</td></tr>';
    html += '</tbody></table></div><p class="muted">「新人」だけが乗っている車両には、「新人単独不可」の利用者を割り当てません。</p></div>';
    el.innerHTML = html;
  }

  // ---------- 設定 ----------

  function renderSettings() {
    const el = document.getElementById('tab-settings');
    const s = state.settings;
    const field = (name, label, type, extra) =>
      '<label class="field">' + label + '<input name="' + name + '" type="' + (type || 'text') + '" value="' + esc(s[name] == null ? '' : s[name]) + '"' + (extra || '') + '></label>';
    el.innerHTML =
      '<form id="settings-form" class="card"><h3>事業所</h3><div class="form-grid">' +
      field('facilityName', '事業所名') +
      '<label class="field wide">住所<input name="facilityAddress" value="' + esc(s.facilityAddress) + '"></label>' +
      '<div class="wide row"><button type="button" data-action="geocode-facility">住所から位置を取得</button>' +
      field('facilityLat', '緯度', 'text', ' inputmode="decimal" size="12"') + field('facilityLng', '経度', 'text', ' inputmode="decimal" size="12"') + '</div>' +
      '</div><h3 style="margin-top:1rem">送迎の基準</h3><div class="form-grid">' +
      field('arriveBy', '迎え：事業所の到着目標', 'time') +
      field('departAt', '送り：事業所の出発時刻', 'time') +
      field('maxRideMin', '乗車時間の上限（分）', 'number', ' min="10" max="180"') +
      field('baseStopMin', '1軒あたりの基本乗降時間（分）', 'number', ' min="0" max="30"') +
      field('speedKmh', '平均速度（km/h）', 'number', ' min="5" max="60"') +
      field('roadFactor', '道のり係数（直線距離の何倍か）', 'number', ' min="1" max="3" step="0.1"') +
      '<div class="wide"><label class="check"><input type="checkbox" name="fullAssistNeedsTwo"' + (s.fullAssistNeedsTwo ? ' checked' : '') + '>全介助の方は2名体制の車両に乗せる</label></div>' +
      '</div><p class="muted">Google の APIキーが無いときは、直線距離×道のり係数÷平均速度 で時間を見積もります。乗降時間は車椅子・介助量・玄関の段差に応じて自動で加算します。</p>' +
      '<button type="submit" class="primary">設定を保存</button></form>' +

      '<form id="key-form" class="card"><h3>Google マップ連携（任意）</h3>' +
      '<p class="muted">APIキーを入れると、地図が Google マップになり、住所検索と「実際の道路の時間」の取得に Google を使います。入れなくても、地理院地図と国土地理院の住所検索（無料）で使えます。</p>' +
      '<label class="field">APIキー<input name="apiKey" type="password" autocomplete="off" value="' + esc(getApiKey()) + '"></label>' +
      '<div class="notice info">キーはこのブラウザにだけ保存されます。Google Cloud で必ず「HTTPリファラー制限（このサイトのURLのみ）」と「API制限（Maps JavaScript API・Geocoding API・Routes API のみ）」を設定し、1日あたりの上限（割り当て）と予算アラートを設定してください。</div>' +
      '<div class="row"><button type="submit" class="primary">キーを保存</button><button type="button" data-action="clear-key">キーを削除</button></div></form>' +

      '<div class="card"><h3>データ</h3><p class="muted">データはこのブラウザの中だけに保存され、サーバーには送信されません（住所検索・ルート取得の時に、住所や座標だけが地図サービスに送られます）。別のパソコンで使う時や念のための保存には、バックアップを使ってください。</p>' +
      '<div class="row"><button data-action="export">バックアップを保存（JSON）</button>' +
      '<label class="button">バックアップから復元<input type="file" accept="application/json,.json" data-action="import" hidden></label>' +
      '<button data-action="load-sample">サンプルデータを読み込む</button>' +
      '<button class="danger" data-action="reset">すべてのデータを削除</button></div></div>';
  }

  // ---------- イベント ----------

  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-action], .tabs button');
    if (!t) return;
    if (t.dataset.tab) return setTab(t.dataset.tab);
    const a = t.dataset.action;
    if (a === 'mode') {
      ui.mode = t.dataset.mode;
      renderToday();
    } else if (a === 'plan') makePlan();
    else if (a === 'print') window.print();
    else if (a === 'google-routes') fetchAllGoogleRoutes();
    else if (a === 'move-up') moveUser(t.dataset.uid, null, -1);
    else if (a === 'move-down') moveUser(t.dataset.uid, null, 1);
    else if (a === 'filter') {
      const k = t.dataset.key;
      ui.filters.has(k) ? ui.filters.delete(k) : ui.filters.add(k);
      renderUsers();
    } else if (a === 'add-user') openUserDialog(null);
    else if (a === 'edit-user') openUserDialog(userById(t.dataset.uid));
    else if (a === 'close-dialog') document.getElementById('user-dialog').close();
    else if (a === 'delete-user') {
      const id = document.getElementById('user-form').dataset.uid;
      const u = userById(id);
      if (!confirm((u ? u.name : '') + ' さんを削除しますか？')) return;
      state.users = state.users.filter((x) => x.id !== id);
      state.users.forEach((o) => (o.ngWith = (o.ngWith || []).filter((x) => x !== id)));
      save();
      document.getElementById('user-dialog').close();
      renderAll();
    } else if (a === 'geocode' || a === 'geocode-facility') {
      const form = t.closest('form');
      const addr = form.elements[a === 'geocode' ? 'address' : 'facilityAddress'].value.trim();
      t.disabled = true;
      try {
        const r = await geocode(addr);
        form.elements[a === 'geocode' ? 'lat' : 'facilityLat'].value = r.lat.toFixed(6);
        form.elements[a === 'geocode' ? 'lng' : 'facilityLng'].value = r.lng.toFixed(6);
        toast(r.source + 'で位置を取得しました。地図で確認してください。');
      } catch (err) {
        toast('位置を取得できませんでした：' + err.message + '。緯度・経度を直接入力してください。');
      } finally {
        t.disabled = false;
      }
    } else if (a === 'add-vehicle') {
      state.vehicles.push({ id: uid('v'), name: (state.vehicles.length + 1) + '号車', seats: 4, wheelchairSlots: 0, active: true });
      save();
      renderFleet();
    } else if (a === 'delete-vehicle') {
      const v = state.vehicles.find((x) => x.id === t.dataset.id);
      if (!confirm(v.name + ' を削除しますか？')) return;
      state.vehicles = state.vehicles.filter((x) => x.id !== v.id);
      delete state.defaultCrews[v.id];
      save();
      renderFleet();
    } else if (a === 'add-staff') {
      state.staff.push({ id: uid('s'), name: '新しい職員', experience: '一般', nurse: false, canDrive: true });
      save();
      renderFleet();
    } else if (a === 'delete-staff') {
      const s = state.staff.find((x) => x.id === t.dataset.id);
      if (!confirm(s.name + ' さんを削除しますか？')) return;
      state.staff = state.staff.filter((x) => x.id !== s.id);
      Object.keys(state.defaultCrews).forEach((k) => (state.defaultCrews[k] = state.defaultCrews[k].filter((x) => x !== s.id)));
      save();
      renderFleet();
    } else if (a === 'clear-key') {
      setApiKey('');
      toast('キーを削除しました。地図を切り替えるため再読み込みします。');
      setTimeout(() => location.reload(), 800);
    } else if (a === 'export') {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'sougei-backup-' + todayStr() + '.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } else if (a === 'load-sample') {
      if (state.users.length && !confirm('今のデータをサンプルで置き換えます。よろしいですか？')) return;
      const s = JSON.parse(JSON.stringify(window.SAMPLE_DATA));
      state = Object.assign(emptyState(), { settings: Object.assign(emptyState().settings, s.settings), users: s.users, vehicles: s.vehicles, staff: s.staff, defaultCrews: s.defaultCrews });
      save();
      toast('サンプルデータを読み込みました（氏名・住所は架空です）');
      setTab('today');
    } else if (a === 'reset') {
      if (!confirm('利用者・車両・職員・送迎記録をすべて削除します。元に戻せません。よろしいですか？')) return;
      state = emptyState();
      save();
      renderAll();
    }
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    const a = t.dataset.action;
    if (!a) return;
    if (a === 'date') {
      ui.date = t.value || todayStr();
      renderToday();
    } else if (a === 'attend') {
      day(ui.date).attend[t.dataset.uid] = t.checked;
      save();
      renderToday();
    } else if (a === 'crew' || a === 'default-crew') {
      const crews = a === 'crew' ? day(ui.date).crews[ui.mode] : state.defaultCrews;
      const list = (crews[t.dataset.vid] || []).slice();
      list[Number(t.dataset.slot)] = t.value;
      crews[t.dataset.vid] = list.filter(Boolean);
      save();
      a === 'crew' ? renderToday() : renderFleet();
    } else if (a === 'move-to') {
      if (t.value) moveUser(t.dataset.uid, t.value, 0);
    } else if (a === 'weekday') {
      ui.weekday = t.value;
      renderUsers();
    } else if (a === 'vehicle-field' || a === 'staff-field') {
      const list = a === 'vehicle-field' ? state.vehicles : state.staff;
      const item = list.find((x) => x.id === t.dataset.id);
      const f = t.dataset.field;
      item[f] = t.type === 'checkbox' ? t.checked : t.type === 'number' ? Math.max(0, Number(t.value) || 0) : t.value;
      save();
    } else if (a === 'import') {
      const file = t.files[0];
      if (!file) return;
      file.text().then((txt) => {
        try {
          const data = JSON.parse(txt);
          if (!Array.isArray(data.users) || !Array.isArray(data.vehicles)) throw new Error('形式が違います');
          if (!confirm('今のデータをバックアップの内容で置き換えます。よろしいですか？')) return;
          state = Object.assign(emptyState(), data);
          save();
          toast('復元しました');
          setTab('today');
        } catch (err) {
          toast('読み込めませんでした：' + err.message);
        }
      });
    }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.action === 'search') {
      ui.search = t.value;
      clearTimeout(t._timer);
      t._timer = setTimeout(() => {
        renderUsers();
        const s = document.querySelector('[data-action="search"]');
        s.focus();
        s.setSelectionRange(s.value.length, s.value.length);
      }, 250);
    }
    // 「35.86, 139.64」を緯度欄に貼り付けたら分ける
    if (t.name === 'lat' || t.name === 'facilityLat') {
      const p = parseLatLng(t.value);
      if (p && /[,，、\s]/.test(t.value.trim())) {
        t.value = p.lat;
        t.form.elements[t.name === 'lat' ? 'lng' : 'facilityLng'].value = p.lng;
      }
    }
  });

  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (form.id === 'user-form') {
      e.preventDefault();
      saveUserForm(form);
    } else if (form.id === 'settings-form') {
      e.preventDefault();
      const f = new FormData(form);
      const s = state.settings;
      s.facilityName = String(f.get('facilityName') || '').trim();
      s.facilityAddress = String(f.get('facilityAddress') || '').trim();
      s.facilityLat = num(f.get('facilityLat'));
      s.facilityLng = num(f.get('facilityLng'));
      s.arriveBy = f.get('arriveBy') || P.DEFAULT_SETTINGS.arriveBy;
      s.departAt = f.get('departAt') || P.DEFAULT_SETTINGS.departAt;
      ['maxRideMin', 'baseStopMin', 'speedKmh', 'roadFactor'].forEach((k) => {
        const v = num(f.get(k));
        s[k] = v != null && v >= 0 ? v : P.DEFAULT_SETTINGS[k];
      });
      if (!(s.speedKmh > 0)) s.speedKmh = P.DEFAULT_SETTINGS.speedKmh;
      if (!(s.roadFactor >= 1)) s.roadFactor = 1;
      s.fullAssistNeedsTwo = f.has('fullAssistNeedsTwo');
      save();
      renderAll();
      toast('設定を保存しました');
    } else if (form.id === 'key-form') {
      e.preventDefault();
      setApiKey(String(new FormData(form).get('apiKey') || '').trim());
      toast('キーを保存しました。地図を切り替えるため再読み込みします。');
      setTimeout(() => location.reload(), 800);
    }
  });

  setTab(state.users.length ? 'today' : 'settings');
})();
