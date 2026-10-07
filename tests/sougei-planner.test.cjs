// 実行: npm test
const test = require('node:test');
const assert = require('node:assert');
const P = require('../public/sougei/planner.js');
const S = require('../public/sougei/sample.js');

const fac = { lat: S.settings.facilityLat, lng: S.settings.facilityLng };
const byId = (id) => S.users.find((u) => u.id === id);

function run(users, crews, mode) {
  return P.optimize({ users, vehicles: S.vehicles, staff: S.staff, crews: crews || S.defaultCrews, settings: S.settings, facility: fac, mode: mode || 'pickup' });
}

function vehicleOf(plan, uid) {
  return Object.keys(plan.assignments).find((v) => plan.assignments[v].includes(uid));
}

test('月曜のサンプルは全員割り当てられ、条件違反がない', () => {
  const users = S.users.filter((u) => u.days.includes(1));
  for (const mode of ['pickup', 'dropoff']) {
    const plan = run(users, null, mode);
    assert.deepStrictEqual(plan.unassigned, []);
    for (const v of S.vehicles) {
      const route = plan.assignments[v.id].map(byId);
      const c = P.checkRoute(route, v, P.crewInfo(S.defaultCrews[v.id], S.staff), S.settings, mode, fac);
      assert.deepStrictEqual(c.problems, [], v.name + ' ' + mode);
    }
  }
});

test('看護師同乗・2名体制・新人単独不可・車椅子枠・同乗NGを守る', () => {
  const plan = run(S.users.filter((u) => u.days.includes(1)));
  assert.strictEqual(vehicleOf(plan, 'u3'), 'v1'); // 看護師は1号車のみ
  assert.notStrictEqual(vehicleOf(plan, 'u4'), 'v2'); // 2号車は新人のみ
  assert.notStrictEqual(vehicleOf(plan, 'u10'), 'v2');
  for (const id of ['u1', 'u13']) assert.notStrictEqual(vehicleOf(plan, id), 'v3'); // セダンに車椅子枠なし
  assert.notStrictEqual(vehicleOf(plan, 'u4'), vehicleOf(plan, 'u9')); // 同乗NG
});

test('条件を満たす車両がなければ理由つきで未割当にする', () => {
  const crews = { v1: ['s1'], v2: ['s2'], v3: ['s4'] }; // 看護師なし
  const plan = run([byId('u3'), byId('u2')], crews);
  const x = plan.unassigned.find((y) => y.userId === 'u3');
  assert.ok(x && x.reasons.some((r) => r.includes('看護師')));
  assert.ok(vehicleOf(plan, 'u2'));
});

test('運転手のいない車両は使わない', () => {
  const plan = run([byId('u2')], { v1: ['s3'], v3: ['s4'] });
  assert.deepStrictEqual(plan.unusedVehicles.map((x) => x.vehicleId).sort(), ['v1', 'v2']);
  assert.strictEqual(vehicleOf(plan, 'u2'), 'v3');
});

test('迎えは到着目標から逆算し、希望時刻より早い迎えを警告する', () => {
  const settings = Object.assign({}, S.settings, { arriveBy: '09:30' });
  const u = Object.assign({}, byId('u2'), { pickupEarliest: '09:29' });
  const sch = P.schedule([u], 'pickup', settings, fac);
  assert.strictEqual(P.fmtHM(sch.endTime), '09:30');
  assert.ok(sch.violations.length === 1);
});

test('送りは希望時刻まで待ってから到着する', () => {
  const u = Object.assign({}, byId('u2'), { dropEarliest: '17:00' });
  const sch = P.schedule([u], 'dropoff', S.settings, fac);
  assert.strictEqual(P.fmtHM(sch.stops[0].arrive), '17:00');
  assert.ok(sch.stops[0].wait > 0);
});
