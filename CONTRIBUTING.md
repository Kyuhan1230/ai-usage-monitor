# Contributing

Codex Claude Usage에 관심을 가져주셔서 감사합니다. 버그 수정, 기능 개선, 문서 보완과 테스트 추가를 환영합니다.

## Before you start

- 큰 기능이나 동작 변경은 먼저 GitHub Issue에서 방향을 논의해 주세요.
- 보안 취약점은 공개 Issue 대신 [SECURITY.md](SECURITY.md)의 비공개 신고 절차를 사용해 주세요.
- 실제 세션 JSONL, 인증 정보, 사용자 홈 경로가 포함된 로그는 커밋하거나 Issue에 첨부하지 마세요.

## Development setup

필요 환경:

- Windows 10 이상
- Node.js 22.12 이상

```powershell
git clone https://github.com/Kyuhan1230/ai-usage-monitor.git
cd ai-usage-monitor
npm ci
npm run app
```

## Making changes

1. 최신 `main`에서 작업 브랜치를 만듭니다.
2. 변경 범위를 작게 유지하고 관련 테스트를 함께 추가합니다.
3. 사용자에게 보이는 동작이나 설정이 바뀌면 README 또는 관련 문서를 갱신합니다.
4. Pull request 전에 전체 검증을 실행합니다.

```powershell
npm test
npm run dist
```

UI 문서를 변경했다면 실제 renderer 기반 스크린샷도 확인합니다.

```powershell
npm run docs:screenshots
```

## Pull requests

PR 설명에는 다음 내용을 포함해 주세요.

- 무엇을 왜 변경했는지
- 사용자에게 미치는 영향
- 실행한 테스트와 수동 검증
- 자동 업데이트, 설치 또는 개인정보 처리에 미치는 영향

리뷰 가능한 크기로 유지하고, 관련 없는 포맷 변경이나 생성 파일을 함께 넣지 않는 것을 권장합니다.
