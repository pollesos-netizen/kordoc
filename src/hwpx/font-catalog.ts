/**
 * 폰트 카탈로그 — fonts 오버라이드 오타·미설치 경고용 (A2).
 *
 * 생성은 항상 진행하고 경고만 낸다: HWPX는 폰트명을 문자열로 참조하므로
 * 미설치 폰트를 지정해도 파일은 유효하지만, 한컴이 무경고로 기본 폰트로
 * 대체 렌더해 "지정한 폰트가 안 먹는" 원인 파악이 어렵다.
 * 여기 목록은 한컴오피스 번들 + Windows 한글판 기본 + 통상 설치 무료 폰트.
 * 목록에 없다고 오류는 아니다 — 경고 문구도 그렇게 안내한다.
 */

/** 한컴오피스 번들 폰트 (2018~2024 공통 코어) */
const HANCOM_BUNDLED = [
  "함초롬바탕", "함초롬돋움",
  "한컴바탕", "한컴돋움", "한컴 고딕", "한컴고딕", "한컴 말랑말랑", "한컴산뜻돋움", "한컴솔잎",
  "HY헤드라인M", "HY견고딕", "HY견명조", "HY중고딕", "HY신명조", "HY명조",
  "HY그래픽M", "HY궁서", "HY강M", "HY강B", "HY울릉도M", "HY울릉도B",
  "HY태백B", "HY수평선M", "HY수평선B", "HY센스L", "HY얕은샘물M", "HY목판L", "HY엽서M", "HY엽서L", "HY동녘M", "HY동녘B",
  "한양신명조", "한양중고딕", "한양견명조", "한양견고딕", "한양궁서", "한양그래픽",
  "휴먼명조", "휴먼고딕", "휴먼굵은팸체", "휴먼가는팸체", "휴먼굵은샘체", "휴먼가는샘체",
  "휴먼옛체", "휴먼아미체", "휴먼편지체", "휴먼둥근헤드라인", "휴먼모음T",
  "태 나무", "태 그늘", "양재깨비체B", "양재난초체M", "양재둘기체M", "양재블럭체",
  "문체부 궁체 정자체", "문체부 궁체 흘림체", "문체부 돋움체", "문체부 바탕체", "문체부 쓰기 정체", "문체부 제목 돋움체", "문체부 제목 바탕체",
  "신명 신명조", "신명 신신명조", "신명 견명조", "신명 중고딕", "신명 태고딕", "신명 견고딕", "신명 신문명조",
  "MD개성체", "MD아롱체", "MD솔체", "MD이솝체", "MD아트체",
  "가는안상수체", "중간안상수체", "굵은안상수체",
  "HCI Poppy", "HCI Tulip", "-아이리스M",
]

/** Windows 한글판 기본 폰트 */
const WINDOWS_DEFAULT = [
  "맑은 고딕", "맑은고딕", "Malgun Gothic",
  "굴림", "굴림체", "돋움", "돋움체", "바탕", "바탕체", "궁서", "궁서체",
  "Arial", "Arial Black", "Times New Roman", "Courier New", "Consolas",
  "Calibri", "Cambria", "Segoe UI", "Tahoma", "Verdana", "Georgia", "Symbol",
]

/** 통상 설치 무료 한글 폰트 (관공서·기관 PC에 흔함) */
const COMMON_FREE = [
  "나눔고딕", "나눔명조", "나눔바른고딕", "나눔스퀘어", "나눔손글씨 붓", "나눔손글씨 펜",
  "NanumGothic", "NanumMyeongjo",
  "Noto Sans KR", "Noto Serif KR", "본고딕", "본명조",
  "Pretendard", "프리텐다드",
  "KoPub돋움", "KoPub바탕", "KoPubWorld돋움", "KoPubWorld바탕",
  "에스코어 드림", "S-Core Dream", "G마켓 산스", "Gmarket Sans",
  "윤고딕", "윤고딕320", "윤고딕330", "윤고딕340", "윤명조",
]

/** 비교 정규화 — 공백 제거 + 소문자화 ("맑은 고딕"="맑은고딕", "noto sans kr"="Noto Sans KR") */
function norm(name: string): string {
  return name.normalize("NFC").replace(/\s+/g, "").toLowerCase()
}

const KNOWN = new Set([...HANCOM_BUNDLED, ...WINDOWS_DEFAULT, ...COMMON_FREE].map(norm))

/** 카탈로그에 있는 폰트인가 */
export function isKnownFont(name: string): boolean {
  return KNOWN.has(norm(name))
}

/**
 * fonts 오버라이드 경고 목록 — 카탈로그에 없는 폰트명마다 경고 1건.
 * 빈 배열이면 전부 알려진 폰트. 경고는 생성을 막지 않는다.
 */
export function unknownFontWarnings(fonts: Record<string, string | undefined>): string[] {
  const warnings: string[] = []
  for (const [role, name] of Object.entries(fonts)) {
    if (!name || isKnownFont(name)) continue
    warnings.push(
      `폰트 경고: ${role}="${name}" — 한컴 번들·통상 설치 목록에 없는 폰트명입니다. `
      + `오타이거나 대상 PC에 미설치면 한글이 기본 폰트로 대체 렌더합니다 (생성은 진행됨)`,
    )
  }
  return warnings
}
