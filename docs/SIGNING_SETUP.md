# Windows 코드 서명 설정

## 권장 경로: SignPath Foundation

이 프로젝트는 MIT 오픈소스이므로 첫 공개 릴리스 이후 SignPath Foundation의 무료 오픈소스 코드 서명을 신청한다.

신청 전 확인 사항:

1. GitHub와 SignPath 계정에 다중 인증을 켠다.
2. 이 저장소의 Release에서 현재 형태의 Windows 설치 파일을 최소 한 번 공개한다.
3. README의 기능·설치·제거 설명, `Code signing policy`, 개인정보 처리방침을 공개 상태로 유지한다.
4. SignPath 신청서에는 저장소, 릴리스 URL, MIT 라이선스, 담당자 `Kyuhan1230`을 적는다.
5. 승인 후 SignPath GitHub App을 이 저장소에 연결하고 프로젝트·artifact configuration·signing policy를 만든다.
6. GitHub Actions secret `SIGNPATH_API_TOKEN`을 등록한다. 조직 ID와 각 slug는 승인된 SignPath 프로젝트 값으로 설정한다.
7. unsigned artifact를 `actions/upload-artifact`로 먼저 올린 뒤 `signpath/github-action-submit-signing-request@v2`에 그 artifact ID를 전달한다.
8. 서명된 설치 파일로 `.blockmap`과 `latest.yml`을 다시 만든 뒤에만 GitHub Release를 공개한다.

SignPath 설정값은 계정 승인 뒤 발급되므로 저장소에 가짜 ID나 토큰을 넣지 않는다. 통합 완료 후에는 서명이 없으면 Release가 실패하도록 강제한다.

## 대안: OV/EV 인증서

상용 Authenticode 인증서를 사용하는 경우 GitHub Actions secret에 다음 값을 저장한다.

- `WIN_CSC_LINK`: `.pfx`의 안전한 URL, 경로 또는 base64 값
- `WIN_CSC_KEY_PASSWORD`: `.pfx` 암호

electron-builder가 빌드 중 앱과 NSIS 설치 파일을 서명하므로, 저장소나 workflow 파일에 인증서와 암호를 직접 기록하지 않는다. 서명 적용 후에는 `build.forceCodeSigning: true`를 켜서 unsigned Release가 만들어지지 않게 한다.
