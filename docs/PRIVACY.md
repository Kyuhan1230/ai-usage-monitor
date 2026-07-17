# 개인정보 처리방침

최종 수정일: 2026-07-18

Codex Claude Usage는 사용자의 PC에서 동작하는 로컬 사용량 모니터다. 자체 분석 서버, 광고, 원격 텔레메트리를 운영하지 않으며 OpenAI 또는 Anthropic 인증 토큰과 브라우저 쿠키를 수집하지 않는다.

## 로컬에서 읽고 저장하는 정보

앱은 다음 로컬 정보만 처리한다.

- 앱 시작 또는 사용자의 새로고침 때 이미 설치되고 로그인된 Codex CLI app-server가 반환한 계정 한도와 사용량
- Claude Code가 statusLine 이벤트로 전달한 사용량 및 앱 시작·수동 새로고침 때 한 번 실행한 `/usage` 출력
- 사용량 집계를 위한 `~\.codex\sessions` 및 `~\.claude\projects`의 로컬 세션 JSONL
- 앱 설정, 최신 상태, 집계 캐시와 로그

앱이 만든 데이터는 기본적으로 `~\.codex-usage-wrapper`에 저장된다. 사용자는 앱을 제거한 뒤 이 폴더를 직접 삭제해 로컬 데이터를 지울 수 있다.

## 네트워크 통신

- 앱은 새 버전을 확인하기 위해 GitHub의 `Kyuhan1230/ai-usage-monitor` 공개 Release 서비스에 접속한다. 업데이트 파일은 사용자가 다운로드에 동의한 경우에만 내려받는다.
- Codex와 Claude 사용량을 새로 확인할 때 각 CLI가 해당 공급자의 서비스와 통신할 수 있다. 이 통신과 인증 정보는 Codex CLI 및 Claude Code가 관리한다.
- 앱은 사용량 수집을 위해 CLI 자식 프로세스를 상주시켜 두거나 1분 주기로 호출하지 않는다. 앱 시작과 사용자의 새로고침 때만 원샷 호출한다.
- Claude statusLine 이벤트는 Claude Code가 statusLine을 갱신할 때 로컬 프로세스로 전달되며 별도 네트워크 수집기를 만들지 않는다.
- 웹 대시보드는 `127.0.0.1`에만 바인딩되며 외부 네트워크 인터페이스에 공개하지 않는다.
- 앱은 사용량 또는 세션 내용을 개발자나 별도의 분석 서비스로 전송하지 않는다.

GitHub, OpenAI 및 Anthropic 서비스에는 각 공급자의 개인정보 처리방침이 적용된다.

## 시스템 변경

- Windows 로그인 시 자동 실행은 Setup 화면에서 사용자가 선택한 경우에만 등록한다.
- Claude statusLine hook은 사용자가 설치 버튼을 누른 경우에만 설정한다. 다른 명령이 있으면 그대로 보존하며, 사용자가 교체를 확인하면 원본 설정을 먼저 백업한다.
- 앱은 Windows의 앱 제거 기능으로 제거할 수 있다.

## 문의

개인정보 또는 보안 관련 문의는 저장소의 GitHub Issues를 이용한다: <https://github.com/Kyuhan1230/ai-usage-monitor/issues>
