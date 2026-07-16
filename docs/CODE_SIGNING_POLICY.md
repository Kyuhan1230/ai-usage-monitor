# Code signing policy

Codex Claude Usage의 공식 Windows 설치 파일은 이 저장소의 GitHub Actions Release 워크플로에서 생성하고 GitHub Releases에 게시한다. 릴리스 태그는 `package.json`의 버전과 일치해야 하며, 테스트와 Windows 패키징이 모두 성공한 산출물만 배포한다.

서명 인증서가 승인된 뒤에는 다음 정책을 적용한다.

- Free code signing provided by SignPath.io, certificate by SignPath Foundation.
- 공식 소스 저장소: <https://github.com/Kyuhan1230/ai-usage-monitor>
- 공식 다운로드 위치: <https://github.com/Kyuhan1230/ai-usage-monitor/releases>
- Committer 및 reviewer: [Kyuhan1230](https://github.com/Kyuhan1230)
- Signing approver: [Kyuhan1230](https://github.com/Kyuhan1230)
- 개인정보 처리방침: [PRIVACY.md](PRIVACY.md)

현재 SignPath Foundation 승인 전 릴리스는 서명되지 않을 수 있다. 서명 적용 전에는 릴리스 설명에 서명 여부를 명시하며, 승인 후 Release 워크플로의 서명 단계가 실패하면 배포도 실패하도록 전환한다.

## 릴리스 통제

- 앱, 설치 프로그램, 업데이트 메타데이터는 같은 GitHub Actions 실행에서 만든다.
- 서명 요청은 GitHub가 검증한 워크플로 산출물만 대상으로 한다.
- 서명 승인은 릴리스마다 수동으로 확인한다.
- 인증서나 API 토큰은 저장소에 커밋하지 않고 GitHub Actions secret으로만 관리한다.
- GitHub 및 SignPath 계정에는 다중 인증을 사용한다.
- 제3자 실행 파일에는 이 프로젝트의 서명을 임의로 적용하지 않는다.

서명된 파일의 게시자와 유효성은 Windows 파일 속성의 `디지털 서명` 탭 또는 다음 명령으로 확인할 수 있다.

```powershell
Get-AuthenticodeSignature '.\Codex Claude Usage-Setup-<version>.exe' | Format-List
```
