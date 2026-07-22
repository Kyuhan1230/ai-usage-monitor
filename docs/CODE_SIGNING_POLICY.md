# Code signing policy

Codex Claude Usage의 공식 Windows 설치 파일은 이 저장소의 GitHub Actions Release 워크플로에서 생성하고 GitHub Releases에 게시한다. 릴리스 태그는 `package.json`의 버전과 일치해야 하며, 테스트와 Windows 패키징이 모두 성공한 산출물만 배포한다.

## Tauri updater 서명

자동 업데이트용 Tauri minisign 서명은 Authenticode와 별개이며 모든 updater 릴리스에 필수다.

- 공개키만 `src-tauri/tauri.conf.json`에 포함한다. 개인키와 선택적 비밀번호는 `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` GitHub Actions secret으로만 관리한다.
- Release workflow는 최종 NSIS installer, 같은 파일의 `.exe.sig`, 그 서명 내용을 포함한 `latest.json` 세 asset을 같은 Release에 게시한다.
- 게시 전 공개키로 installer의 `.sig`를 암호학적으로 검증하고, manifest의 버전·URL·signature·asset 이름·크기가 실제 산출물과 일치하는지 확인한다.
- 사용자의 앱은 manifest에 지정된 파일을 내려받은 뒤 Tauri 서명 검증이 성공한 경우에만 설치한다. updater 서명 검증은 끌 수 없다.
- 개인키를 잃으면 기존 설치본에 신뢰되는 업데이트를 더 배포할 수 없으므로 GitHub secret 외에 접근 통제된 별도 백업을 유지한다.

서명 인증서가 승인된 뒤에는 다음 정책을 적용한다.

- Free code signing provided by SignPath.io, certificate by SignPath Foundation.
- 공식 소스 저장소: <https://github.com/Kyuhan1230/ai-usage-monitor>
- 공식 다운로드 위치: <https://github.com/Kyuhan1230/ai-usage-monitor/releases>
- Committer 및 reviewer: [Kyuhan1230](https://github.com/Kyuhan1230)
- Signing approver: [Kyuhan1230](https://github.com/Kyuhan1230)
- 개인정보 처리방침: [PRIVACY.md](PRIVACY.md)

현재 SignPath Foundation 승인 전 릴리스는 Authenticode 코드 서명이 적용되지 않을 수 있다. Tauri updater 서명은 승인 여부와 무관하게 필수다. Authenticode 적용 전에는 릴리스 설명에 게시자 서명 여부를 명시하며, 승인 후 Release 워크플로의 Authenticode 단계가 실패하면 배포도 실패하도록 전환한다.

## 릴리스 통제

- 앱, 설치 프로그램, updater signature와 `latest.json`은 같은 GitHub Actions 실행에서 만든다.
- 서명 요청은 GitHub가 검증한 워크플로 산출물만 대상으로 한다.
- 서명 승인은 릴리스마다 수동으로 확인한다.
- 인증서나 API 토큰은 저장소에 커밋하지 않고 GitHub Actions secret으로만 관리한다.
- GitHub 및 SignPath 계정에는 다중 인증을 사용한다.
- 제3자 실행 파일에는 이 프로젝트의 서명을 임의로 적용하지 않는다.

SignPath를 연결하면 Tauri updater signature는 Authenticode 서명 뒤에 만들어야 한다. SignPath가 installer 바이트를 변경한 뒤 최종 `.exe`를 다시 Tauri 개인키로 서명하고, 새 `.sig` 내용을 `latest.json`에 넣는다. 순서를 바꾸면 updater signature가 무효가 된다.

서명된 파일의 게시자와 유효성은 Windows 파일 속성의 `디지털 서명` 탭 또는 다음 명령으로 확인할 수 있다.

```powershell
Get-AuthenticodeSignature '.\Codex-Claude-Usage-Setup-<version>.exe' | Format-List
```
