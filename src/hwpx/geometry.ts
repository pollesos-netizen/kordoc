/**
 * HWPX 생성 지오메트리·단위 상수 SSOT (v4.0.5 P0-3).
 *
 * 종전에는 A4 크기·mm→HWPUNIT 환산·본문폭·표 id 베이스가 gaejosik/gongmun/
 * chart-gen/gen-section/gen-table 등에 3중 이상 중복 인코딩돼 있었다.
 * 여기 값을 바꾸면 시각 baseline(한컴 실렌더 해시) 재박제가 필요하다 — 신중히.
 */

// ─── 용지 (A4 세로, HWPUNIT) ─────────────────────────
// 210mm × 297mm. 1 HWPUNIT = 1/7200 inch → 1mm = 7200/25.4 ≈ 283.46 HU.

export const A4_W_HU = 59528
export const A4_H_HU = 84188

/** 1mm당 HWPUNIT (7200/25.4 ≈ 283.4646) — 반올림 없는 원시 배율 */
export const HU_PER_MM = 7200 / 25.4

/**
 * 1mm → HWPUNIT (정수 반올림).
 * 주의: 수식 형태(`(mm*7200)/25.4`)를 바꾸지 말 것 — `mm*HU_PER_MM`과 부동소수점
 * 결합 순서가 달라 경계값에서 반올림이 갈릴 수 있다 (기존 산출물 바이트 보존).
 */
export function mmToHwpunit(mm: number): number {
  return Math.round((mm * 7200) / 25.4)
}

// ─── 본문폭 ──────────────────────────────────────────

/**
 * 여백 좌우 20mm A4 본문폭 = mmToHwpunit(170) = 48189 (계산값).
 * 실측 개조식 장식표 기하(gaejosik.ts CHAPTER_GEOM 등)의 기준 폭.
 */
export const BODY_WIDTH_20MM = mmToHwpunit(170)

/**
 * 표지·본문 제목박스 실측 폭 48180 (실물 t2 「2_보고서 양식」 저장값).
 * 계산 본문폭(48189)보다 9HU 좁다 — 한컴이 저장 시 스냅한 실측값이므로
 * 계산값으로 "정정"하면 실물과 달라진다. 구분 보존이 의도다.
 */
export const COVER_MEASURED_W = 48180

// ─── 표 id 네임스페이스 ──────────────────────────────
// <hp:tbl id>는 문서 내 유일하면 되지만, 모듈별 카운터가 겹치지 않게 구간을 파티션.
// 각 모듈은 blocksToSectionXml 시작 시 reset되는 자기 카운터로 base부터 발급한다.

/** 데이터 표(GFM·HTML) — gen-table */
export const DATA_TABLE_ID_BASE = 1000
/** 차트 개체 — chart-gen (base + blockIdx, 카운터 아님) */
export const CHART_TABLE_ID_BASE = 9_100_000
/** 개조식 장식표(표지·목차·장헤더·제목박스) — gen-gaejosik */
export const GJ_TABLE_ID_BASE = 9_200_000
/** 공문서 부속표(결재란·제목박스) — gen-gongmun-extra */
export const EXTRA_TABLE_ID_BASE = 9_300_000
/** 이미지 placeholder <hp:pic> — gen-image */
export const PIC_ID_BASE = 9_400_000
