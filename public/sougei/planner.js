/*
 * 送迎ルート計画ロジック（画面に依存しない純粋な計算部分）
 * ブラウザでは window.Planner、Node では require() で使えます。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Planner = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CARE_LEVELS = ['自立', '要支援1', '要支援2', '要介護1', '要介護2', '要介護3', '要介護4', '要介護5'];
  const ASSIST_LEVELS = ['自立', '見守り', '一部介助', '全介助'];
  const EQUIPMENT = ['車椅子（自走）', '車椅子（介助型）', 'リクライニング車椅子', '歩行器', 'シルバーカー', '杖', '酸素ボンベ'];
  const WHEELCHAIRS = EQUIPMENT.slice(0, 3);
  const ENTRANCES = ['段差なし', 'スロープあり', '段差あり（スロープなし）'];
  const EXPERIENCE = ['新人', '一般', 'ベテラン'];
  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

  const DEFAULT_SETTINGS = {
    arriveBy: '09:30',
    departAt: '16:00',
    maxRideMin: 60,
    speedKmh: 25,
    roadFactor: 1.4,
    baseStopMin: 3,
    fullAssistNeedsTwo: true,
  };

  // ---------- 利用者の条件 → 必要な体制 ----------

  function usesWheelchairSlot(u) {
    return !!u.rideInWheelchair && (u.equipment || []).some((e) => WHEELCHAIRS.includes(e));
  }

  function twoStaffReasons(u, settings) {
    const reasons = [];
    if (settings.fullAssistNeedsTwo && u.assistLevel === '全介助') reasons.push('全介助');
    if (usesWheelchairSlot(u) && u.entrance === '段差あり（スロープなし）') reasons.push('車椅子＋段差');
    if (u.needsTwoStaff) reasons.push('2名介助指定');
    return reasons;
  }

  function requirements(u, settings) {
    return {
      wheelchair: usesWheelchairSlot(u),
      twoStaff: twoStaffReasons(u, settings),
      nurse: !!u.needsNurse,
      experienced: !!u.noNewcomerAlone,
    };
  }

  function requirementLabels(u, settings) {
    const r = requirements(u, settings);
    const out = [];
    if (r.wheelchair) out.push('車椅子枠');
    if (r.twoStaff.length) out.push('2名体制（' + r.twoStaff.join('・') + '）');
    if (r.nurse) out.push('看護師同乗');
    if (r.experienced) out.push('新人単独不可');
    return out;
  }

  // ---------- 車両の乗務員 ----------

  function crewInfo(staffIds, staffList) {
    const members = (staffIds || [])
      .map((id) => staffList.find((s) => s.id === id))
      .filter(Boolean);
    return {
      members,
      size: members.length,
      hasDriver: members.some((s) => s.canDrive),
      hasNurse: members.some((s) => s.nurse),
      hasExperienced: members.some((s) => s.experience !== '新人'),
    };
  }

  // 利用者をこの車両に乗せられない理由（乗せられるなら null）
  function staticBlock(u, vehicle, crew, settings) {
    const r = requirements(u, settings);
    const out = [];
    if (r.wheelchair && !(vehicle.wheelchairSlots > 0)) out.push('車椅子枠がない');
    if (!r.wheelchair && !(vehicle.seats > 0)) out.push('座席がない');
    if (r.twoStaff.length && crew.size < 2) out.push('2名体制が必要（' + r.twoStaff.join('・') + '）');
    if (r.nurse && !crew.hasNurse) out.push('看護師の同乗が必要');
    if (r.experienced && !crew.hasExperienced) out.push('新人だけの車両には乗せられない');
    return out.length ? out.join('、') : null;
  }

  function isNgPair(a, b) {
    return (a.ngWith || []).includes(b.id) || (b.ngWith || []).includes(a.id);
  }

  // 定員・同乗NG（時間以外の、ルートに対する制約）
  function capacityProblems(route, vehicle) {
    const problems = [];
    const wc = route.filter(usesWheelchairSlot).length;
    const seats = route.length - wc;
    if (wc > (vehicle.wheelchairSlots || 0)) problems.push('車椅子枠を超過（' + wc + '/' + (vehicle.wheelchairSlots || 0) + '）');
    if (seats > (vehicle.seats || 0)) problems.push('座席数を超過（' + seats + '/' + (vehicle.seats || 0) + '）');
    for (let i = 0; i < route.length; i++) {
      for (let j = i + 1; j < route.length; j++) {
        if (isNgPair(route[i], route[j])) problems.push('同乗NG：' + route[i].name + '・' + route[j].name);
      }
    }
    return problems;
  }

  // ---------- 距離・時間 ----------

  function haversineKm(a, b) {
    const R = 6371;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // 直線距離 × 道のり係数 ÷ 平均速度 で移動時間（分）を見積もる
  function estimateLeg(a, b, settings) {
    const km = haversineKm(a, b) * settings.roadFactor;
    const min = km < 0.01 ? 0 : Math.max(1, (km / settings.speedKmh) * 60);
    return { km, min };
  }

  function stopMinutes(u, settings) {
    let m = Number(settings.baseStopMin) || 0;
    if (usesWheelchairSlot(u)) m += 4;
    if (u.assistLevel === '一部介助') m += 2;
    if (u.assistLevel === '全介助') m += 5;
    if (u.entrance === '段差あり（スロープなし）') m += 5;
    else if (u.entrance === 'スロープあり') m += 2;
    return m;
  }

  function parseHM(s) {
    if (!s) return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  function fmtHM(min) {
    if (min == null || !isFinite(min)) return '--:--';
    const t = Math.round(min);
    const h = Math.floor(t / 60);
    const m = ((t % 60) + 60) % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }

  /*
   * 1台分の時刻表を作る。
   * mode 'pickup'  : 事業所 → 各家 → 事業所。到着目標から逆算する。
   * mode 'dropoff' : 事業所 → 各家 → 事業所。出発時刻から順に計算する。
   * legsOverride   : Google などで取得した実際の区間時間（分）があれば使う。
   */
  function schedule(route, mode, settings, facility, legsOverride) {
    const points = [facility].concat(route, [facility]);
    const legs = [];
    let km = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const est = estimateLeg(points[i], points[i + 1], settings);
      const ov = legsOverride && legsOverride[i];
      legs.push(ov ? ov.min : est.min);
      km += ov && ov.km != null ? ov.km : est.km;
    }
    const n = route.length;
    const stops = new Array(n);
    const violations = [];
    let excess = 0; // 時間条件を超えた分（分）の合計
    const maxRide = Number(settings.maxRideMin) || Infinity;
    let startTime, endTime;

    if (n === 0) return { stops: [], legs, startTime: null, endTime: null, totalMin: 0, distanceKm: 0, violations, excess };

    if (mode === 'pickup') {
      const T = parseHM(settings.arriveBy);
      let t = T;
      for (let i = n - 1; i >= 0; i--) {
        const depart = t - legs[i + 1];
        const arrive = depart - stopMinutes(route[i], settings);
        stops[i] = { user: route[i], arrive, depart, ride: T - depart, wait: 0 };
        t = arrive;
      }
      startTime = t - legs[0];
      endTime = T;
      stops.forEach((s) => {
        const earliest = parseHM(s.user.pickupEarliest);
        if (earliest != null && s.arrive < earliest) {
          excess += earliest - s.arrive;
          violations.push(s.user.name + '：迎えが希望（' + fmtHM(earliest) + '以降）より早い');
        }
      });
    } else {
      const D = parseHM(settings.departAt);
      let t = D;
      for (let i = 0; i < n; i++) {
        let arrive = t + legs[i];
        let wait = 0;
        const earliest = parseHM(route[i].dropEarliest);
        if (earliest != null && arrive < earliest) {
          wait = earliest - arrive;
          arrive = earliest;
        }
        const depart = arrive + stopMinutes(route[i], settings);
        stops[i] = { user: route[i], arrive, depart, ride: arrive - D, wait };
        t = depart;
      }
      startTime = D;
      endTime = t + legs[n];
    }
    stops.forEach((s) => {
      if (s.ride > maxRide) excess += s.ride - maxRide;
      if (s.ride > maxRide) violations.push(s.user.name + '：乗車時間 ' + Math.round(s.ride) + '分（上限' + maxRide + '分）');
    });
    return { stops, legs, startTime, endTime, totalMin: endTime - startTime, distanceKm: km, violations, excess };
  }

  // ---------- 最適化 ----------

  /*
   * 挿入法でルートを作り、入れ替え・2-opt で改善するヒューリスティック。
   * 車両・職員・座席・車椅子枠・同乗NG は必ず守り、時間条件だけは
   * どうしても満たせない場合に「警告つき」で割り当てる。
   */
  function optimize(input) {
    const settings = Object.assign({}, DEFAULT_SETTINGS, input.settings);
    const { facility, mode } = input;
    const unusedVehicles = [];
    const vehicles = [];
    for (const v of input.vehicles) {
      if (v.active === false) continue;
      const crew = crewInfo((input.crews || {})[v.id], input.staff || []);
      if (!crew.size) unusedVehicles.push({ vehicle: v, reason: '乗務員が未設定' });
      else if (!crew.hasDriver) unusedVehicles.push({ vehicle: v, reason: '運転できる職員がいない' });
      else vehicles.push({ vehicle: v, crew });
    }

    const routes = new Map(vehicles.map((x) => [x.vehicle.id, []]));
    const unassigned = [];
    const allowed = new Map();
    const users = [];

    for (const u of input.users) {
      if (!isFinite(u.lat) || !isFinite(u.lng) || u.lat === null || u.lng === null) {
        unassigned.push({ user: u, reasons: ['住所の位置（緯度経度）が未登録'] });
        continue;
      }
      const ok = [];
      const reasons = new Set();
      for (const x of vehicles) {
        const block = staticBlock(u, x.vehicle, x.crew, settings);
        if (block) reasons.add(x.vehicle.name + '：' + block);
        else ok.push(x);
      }
      if (!ok.length) {
        unassigned.push({ user: u, reasons: vehicles.length ? Array.from(reasons) : ['使える車両がない'] });
        continue;
      }
      allowed.set(u.id, ok);
      users.push(u);
    }

    const cache = new Map();
    function evaluate(vid, route) {
      const key = vid + '|' + route.map((u) => u.id).join(',');
      if (cache.has(key)) return cache.get(key);
      const x = vehicles.find((y) => y.vehicle.id === vid);
      const cap = capacityProblems(route, x.vehicle);
      const sch = schedule(route, mode, settings, facility);
      const res = { feasible: cap.length === 0, violations: sch.excess, cost: sch.totalMin };
      cache.set(key, res);
      return res;
    }

    // u を入れられる最良の位置。strict なら時間違反を増やさない位置に限る。
    function bestInsertion(u, strict) {
      let best = null;
      for (const x of allowed.get(u.id)) {
        const vid = x.vehicle.id;
        const route = routes.get(vid);
        const before = evaluate(vid, route);
        for (let pos = 0; pos <= route.length; pos++) {
          const next = route.slice(0, pos).concat([u], route.slice(pos));
          const after = evaluate(vid, next);
          if (!after.feasible) continue;
          const addedViolations = after.violations - before.violations;
          if (strict && addedViolations > 0.01) continue;
          const score = Math.max(0, addedViolations) * 100 + (after.cost - before.cost);
          if (!best || score < best.score - 1e-9) best = { vid, pos, score };
        }
      }
      return best;
    }

    // 条件の厳しい人・遠い人から先に入れる
    users.sort((a, b) => {
      const d = allowed.get(a.id).length - allowed.get(b.id).length;
      if (d) return d;
      return haversineKm(facility, b) - haversineKm(facility, a);
    });

    const relaxed = new Set();
    for (const u of users) {
      let best = bestInsertion(u, true);
      if (!best) {
        best = bestInsertion(u, false);
        if (best) relaxed.add(u.id);
      }
      if (!best) {
        unassigned.push({ user: u, reasons: ['座席・車椅子枠・同乗NGの条件で空きがない'] });
        continue;
      }
      routes.get(best.vid).splice(best.pos, 0, u);
    }

    function totalScore() {
      let s = 0;
      for (const [vid, route] of routes) {
        const e = evaluate(vid, route);
        s += e.violations * 100 + e.cost;
      }
      return s;
    }

    // 改善：1人ずつ抜いて入れ直す＋車両内 2-opt
    for (let iter = 0; iter < 30; iter++) {
      let improved = false;
      for (const u of users) {
        const vid = Array.from(routes.keys()).find((k) => routes.get(k).includes(u));
        if (vid == null) continue;
        const before = totalScore();
        const route = routes.get(vid);
        const idx = route.indexOf(u);
        route.splice(idx, 1);
        const best = bestInsertion(u, false);
        routes.get(best.vid).splice(best.pos, 0, u);
        if (totalScore() < before - 0.01) improved = true;
        else {
          routes.get(best.vid).splice(routes.get(best.vid).indexOf(u), 1);
          route.splice(idx, 0, u);
        }
      }
      // 別の車両の利用者どうしを入れ替える（満席の車両間でも動かせるように）
      const vids = Array.from(routes.keys());
      const canRide = (u, vid) => allowed.get(u.id).some((x) => x.vehicle.id === vid);
      const scoreOf = (vid, route) => {
        const e = evaluate(vid, route);
        return e.feasible ? e.violations * 100 + e.cost : Infinity;
      };
      for (let p = 0; p < vids.length; p++) {
        for (let q = p + 1; q < vids.length; q++) {
          const r1 = routes.get(vids[p]);
          const r2 = routes.get(vids[q]);
          for (let i = 0; i < r1.length; i++) {
            for (let j = 0; j < r2.length; j++) {
              const a = r1[i];
              const b = r2[j];
              if (!canRide(a, vids[q]) || !canRide(b, vids[p])) continue;
              const n1 = r1.slice();
              const n2 = r2.slice();
              n1[i] = b;
              n2[j] = a;
              const before = scoreOf(vids[p], r1) + scoreOf(vids[q], r2);
              if (scoreOf(vids[p], n1) + scoreOf(vids[q], n2) < before - 0.01) {
                r1[i] = b;
                r2[j] = a;
                improved = true;
              }
            }
          }
        }
      }
      for (const [vid, route] of routes) {
        for (let i = 0; i < route.length - 1; i++) {
          for (let j = i + 1; j < route.length; j++) {
            const cand = route.slice(0, i).concat(route.slice(i, j + 1).reverse(), route.slice(j + 1));
            const a = evaluate(vid, route);
            const b = evaluate(vid, cand);
            if (b.feasible && b.violations * 100 + b.cost < a.violations * 100 + a.cost - 0.01) {
              route.splice(0, route.length, ...cand);
              improved = true;
            }
          }
        }
      }
      if (!improved) break;
    }

    const assignments = {};
    for (const [vid, route] of routes) assignments[vid] = route.map((u) => u.id);
    return {
      mode,
      assignments,
      unassigned: unassigned.map((x) => ({ userId: x.user.id, reasons: x.reasons })),
      unusedVehicles: unusedVehicles.map((x) => ({ vehicleId: x.vehicle.id, reason: x.reason })),
    };
  }

  // 手修正後も含めて、1台分のルートを検証する
  function checkRoute(route, vehicle, crew, settings, mode, facility, legsOverride) {
    settings = Object.assign({}, DEFAULT_SETTINGS, settings);
    const sch = schedule(route, mode, settings, facility, legsOverride);
    const problems = capacityProblems(route, vehicle);
    route.forEach((u) => {
      const b = staticBlock(u, vehicle, crew, settings);
      if (b) problems.push(u.name + '：' + b);
    });
    if (route.length && !crew.hasDriver) problems.push('運転できる職員がいない');
    return { schedule: sch, problems: problems.concat(sch.violations) };
  }

  return {
    CARE_LEVELS,
    ASSIST_LEVELS,
    EQUIPMENT,
    WHEELCHAIRS,
    ENTRANCES,
    EXPERIENCE,
    WEEKDAYS,
    DEFAULT_SETTINGS,
    usesWheelchairSlot,
    requirements,
    requirementLabels,
    crewInfo,
    staticBlock,
    capacityProblems,
    haversineKm,
    estimateLeg,
    stopMinutes,
    parseHM,
    fmtHM,
    schedule,
    optimize,
    checkRoute,
  };
});
