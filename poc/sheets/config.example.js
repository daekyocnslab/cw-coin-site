// 로컬에서 시험할 때만: 이 파일을 config.js 로 복사해 값을 채우세요 (config.js 는 git 에 올리지 않음)
// 배포 사이트의 config.js 는 GitHub Actions 가 저장소 변수로 만듭니다 (deploy/SHEETS_POC.md)
// 세 값 모두 브라우저에 공개되는 값입니다 — 비밀값(클라이언트 보안 비밀번호 등)은 넣지 마세요
window.POC_CONFIG = {
  clientId: '000000000000-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.apps.googleusercontent.com', // OAuth 클라이언트 ID
  apiKey: 'AIza...',          // API 키 (앱 주소로 제한)
  appId: '000000000000',      // Google Cloud 프로젝트 번호
};
