/* 動作確認用のサンプルデータ（氏名・住所はすべて架空です） */
(function (root, factory) {
  const data = factory();
  if (typeof module === 'object' && module.exports) module.exports = data;
  else root.SAMPLE_DATA = data;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function user(id, name, lat, lng, extra) {
    return Object.assign(
      {
        id,
        name,
        address: 'サンプル市' + name.slice(0, 1) + '町' + id.replace('u', '') + '-1',
        lat,
        lng,
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
        days: [1, 2, 3, 4, 5, 6],
        pickupEarliest: '',
        dropEarliest: '',
        ngWith: [],
        note: '',
      },
      extra
    );
  }

  return {
    settings: {
      facilityName: 'サンプルデイサービス',
      facilityAddress: 'サンプル市中央1-1',
      facilityLat: 35.8617,
      facilityLng: 139.6455,
      arriveBy: '09:30',
      departAt: '16:00',
      maxRideMin: 60,
      speedKmh: 25,
      roadFactor: 1.4,
      baseStopMin: 3,
      fullAssistNeedsTwo: true,
    },
    users: [
      user('u1', '青木 春子', 35.8752, 139.6301, { careLevel: '要介護3', assistLevel: '一部介助', equipment: ['車椅子（介助型）'], rideInWheelchair: true, entrance: 'スロープあり', days: [1, 3, 5] }),
      user('u2', '石井 一郎', 35.8701, 139.6612, { careLevel: '要支援2', assistLevel: '自立', equipment: ['杖'], days: [1, 2, 4] }),
      user('u3', '上野 和子', 35.8489, 139.6377, { careLevel: '要介護4', assistLevel: '全介助', equipment: ['リクライニング車椅子'], rideInWheelchair: true, entrance: '段差あり（スロープなし）', medical: true, medicalNote: '吸引あり', needsNurse: true, days: [1, 2, 3, 4, 5] }),
      user('u4', '遠藤 勝', 35.8555, 139.6721, { careLevel: '要介護2', assistLevel: '見守り', equipment: ['歩行器'], noNewcomerAlone: true, note: '認知症あり。慣れた職員が対応', ngWith: ['u9'] }),
      user('u5', '大野 静江', 35.8820, 139.6488, { careLevel: '要介護1', equipment: ['シルバーカー'], pickupEarliest: '08:50' }),
      user('u6', '加藤 茂', 35.8399, 139.6560, { careLevel: '要介護3', assistLevel: '一部介助', equipment: ['車椅子（自走）'], rideInWheelchair: false, entrance: 'スロープあり', note: '車内では座席に移乗' }),
      user('u7', '木村 よし', 35.8668, 139.6205, { careLevel: '要介護2', medical: true, medicalNote: 'インスリン（昼）', dropEarliest: '16:40' }),
      user('u8', '小林 正', 35.8460, 139.6150, { careLevel: '要介護5', assistLevel: '全介助', equipment: ['車椅子（介助型）'], rideInWheelchair: true, entrance: '段差なし', medical: true, medicalNote: '在宅酸素', needsNurse: true, days: [2, 4, 6] }),
      user('u9', '斎藤 千代', 35.8590, 139.6790, { careLevel: '要支援1', assistLevel: '自立', equipment: ['杖'] }),
      user('u10', '清水 武', 35.8905, 139.6602, { careLevel: '要介護1', noNewcomerAlone: true, note: '道順にこだわりあり' }),
      user('u11', '杉山 ミツ', 35.8732, 139.6855, { careLevel: '要介護2', assistLevel: '一部介助', equipment: ['歩行器'], entrance: '段差あり（スロープなし）' }),
      user('u12', '高田 誠', 35.8358, 139.6402, { careLevel: '要介護1', equipment: [] }),
      user('u13', '中村 トシ', 35.8640, 139.6950, { careLevel: '要介護3', assistLevel: '一部介助', equipment: ['車椅子（介助型）'], rideInWheelchair: true, entrance: 'スロープあり' }),
      user('u14', '野口 稔', 35.8805, 139.6150, { careLevel: '要支援2', assistLevel: '自立' }),
    ],
    vehicles: [
      { id: 'v1', name: '1号車（ハイエース・リフト付）', seats: 6, wheelchairSlots: 2, active: true },
      { id: 'v2', name: '2号車（軽スロープ車）', seats: 2, wheelchairSlots: 1, active: true },
      { id: 'v3', name: '3号車（セダン）', seats: 4, wheelchairSlots: 0, active: true },
    ],
    staff: [
      { id: 's1', name: '佐藤', experience: 'ベテラン', nurse: false, canDrive: true },
      { id: 's2', name: '鈴木', experience: '新人', nurse: false, canDrive: true },
      { id: 's3', name: '高橋', experience: '一般', nurse: true, canDrive: false },
      { id: 's4', name: '田中', experience: '一般', nurse: false, canDrive: true },
      { id: 's5', name: '伊藤', experience: '新人', nurse: false, canDrive: true },
    ],
    defaultCrews: { v1: ['s1', 's3'], v2: ['s2'], v3: ['s4'] },
  };
});
