'use strict';

// ================= 리얼라이너 수가 계산 =================
// 수가(금액)는 코드에 넣지 않고, 로그인 후 Supabase 의 price_table 에서 받아옵니다.
// (공개 저장소에 수가가 노출되지 않도록)
//
// price_table.data 형식:
// {
//   "grades": { "gold": { "lite": 0, "moderate": 0, "advanced": 0, "comprehensive": 0, "additional": 0 }, ... },
//   "grade_names": { "family": "Family", "gold": "Gold", "platinum": "Platinum" },
//   "unit_price": 0,          // Unit 편악 단가
//   "single_arch_rate": 0.6,  // 편악 진행 시 패키지가 비율
//   "packages": { "lite": { "warranty": "", "refinement": "" }, ... }
// }

let priceTable = null;
function setPriceTable(data) {
  priceTable = data && data.grades ? data : null;
}

const STAGES_PER_UNIT = 3; // 3 stage = 1 unit (악별로 산정)

// 패키지 적용 기준 (상·하악 중 많은 쪽 stage)
const PACKAGE_RULES = {
  unit:          { name: 'Unit',              base: 0 },
  lite:          { name: 'Lite PKG',          base: 10 },
  moderate:      { name: 'Moderate PKG',      base: 20 },
  advanced:      { name: 'Advanced PKG',      base: Infinity },
  comprehensive: { name: 'Comprehensive PKG', base: Infinity },
};

const won = (n) => `${Math.round(n).toLocaleString('ko-KR')}`;

// 상악/하악 stage 와 등급으로 청구액 계산
// upper/lower: 진행 stage (0 또는 빈 값 = 그 악은 진행 안 함)
// 반환: null(입력 없음 또는 수가표 없음) 또는
//   { maxStage, single, main, alternative, choices }
//   main        : 기준표에 따른 패키지 견적
//   alternative : 더 저렴한 상위/대체 패키지가 있으면 그 견적 (없으면 null)
//   choices     : 40 stage 이상일 때 Advanced/Comprehensive 두 가지
function realignerQuote(grade, upper, lower, table = priceTable) {
  if (!table) return null;
  const P = table.grades[grade];
  if (!P) return null;
  const arches = [['상악', upper], ['하악', lower]]
    .map(([label, n]) => [label, Math.max(0, Math.floor(Number(n) || 0))])
    .filter(([, n]) => n > 0);
  if (!arches.length) return null;

  const single = arches.length === 1;
  const maxStage = Math.max(...arches.map(([, n]) => n));
  const info = (key) => ({ key, ...PACKAGE_RULES[key], ...(table.packages?.[key] || {}) });

  const unitQuote = () => {
    const parts = arches.map(([label, n]) => [label, Math.ceil(n / STAGES_PER_UNIT)]);
    const units = parts.reduce((s, [, u]) => s + u, 0);
    return {
      ...info('unit'),
      price: units * table.unit_price,
      units,
      additional: 0,
      formula: `${won(table.unit_price)} × ${units} unit (${parts.map(([l, u]) => `${l} ${u}`).join(' + ')})`,
    };
  };

  const pkgQuote = (key) => {
    const pkg = info(key);
    const pkgPrice = P[key] * (single ? table.single_arch_rate : 1);
    const additional = arches.reduce((s, [, n]) => s + Math.max(0, n - pkg.base), 0);
    const price = pkgPrice + additional * P.additional;
    return {
      ...pkg,
      price,
      pkgPrice,
      additional,
      formula: additional
        ? `${won(pkgPrice)} + ${won(P.additional)} × ${additional} (Additional)`
        : `${won(pkgPrice)}${key === 'advanced' || key === 'comprehensive' ? ' (추가 비용 없음)' : ''}`,
    };
  };

  let main;
  let alt = null;
  let choices = null;
  if (maxStage <= 9) {
    main = unitQuote();
    alt = pkgQuote('lite');        // Unit → Lite 전환 구간
  } else if (maxStage <= 19) {
    main = pkgQuote('lite');
  } else if (maxStage <= 39) {
    main = pkgQuote('moderate');
    alt = pkgQuote('advanced');    // Moderate → Advanced 전환 구간
  } else {
    main = pkgQuote('advanced');
    choices = [main, pkgQuote('comprehensive')];
  }

  return {
    grade: table.grade_names?.[grade] || grade,
    maxStage,
    single,
    arches,
    main,
    alternative: alt && alt.price < main.price ? { ...alt, saving: main.price - alt.price } : null,
    choices,
  };
}
