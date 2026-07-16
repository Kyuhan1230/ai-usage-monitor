# Windows 코드 서명 설정

## 권장 경로: SignPath Foundation

이 프로젝트는 MIT 오픈소스이며 SignPath Foundation의 무료 오픈소스 코드 서명 프로그램에 신청서를 제출했다. 현재는 심사 결과를 기다리고 있다.

신청 및 승인 후 확인 사항:

1. GitHub와 SignPath 계정에 다중 인증을 켠다.
2. 이 저장소의 Release에서 현재 형태의 Windows 설치 파일을 최소 한 번 공개한다.
3. README의 기능·설치·제거 설명, `Code signing policy`, 개인정보 처리방침을 공개 상태로 유지한다.
4. SignPath 신청서에는 저장소, 릴리스 URL, MIT 라이선스, 담당자 `Kyuhan1230`을 적는다.
5. 승인 후 SignPath GitHub App을 이 저장소에 연결하고 프로젝트·artifact configuration·signing policy를 만든다.
6. GitHub Actions secret `SIGNPATH_API_TOKEN`을 등록한다. 조직 ID와 각 slug는 승인된 SignPath 프로젝트 값으로 설정한다.
7. unsigned artifact를 `actions/upload-artifact`로 먼저 올린 뒤 `signpath/github-action-submit-signing-request@v2`에 그 artifact ID를 전달한다.
8. 서명된 설치 파일로 `.blockmap`과 `latest.yml`을 다시 만든 뒤에만 GitHub Release를 공개한다.

SignPath 설정값은 계정 승인 뒤 발급되므로 저장소에 가짜 ID나 토큰을 넣지 않는다. Release workflow는 설정값이 모두 있을 때만 SignPath 단계를 실행하고, 일부 값만 있으면 잘못된 설정으로 판단해 실패한다.

승인 후 GitHub 저장소의 Actions secret에 다음 값을 등록한다.

- `SIGNPATH_API_TOKEN`

Actions variable에는 다음 값을 등록한다.

- `SIGNPATH_ORGANIZATION_ID`
- `SIGNPATH_PROJECT_SLUG`
- `SIGNPATH_SIGNING_POLICY_SLUG`
- `SIGNPATH_APP_ARTIFACT_CONFIGURATION_SLUG`
- `SIGNPATH_INSTALLER_ARTIFACT_CONFIGURATION_SLUG`

앱 실행 파일용 artifact configuration의 root는 GitHub artifact ZIP이므로 다음 구조를 사용한다.

```xml
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <zip-file>
    <pe-file path="Codex Claude Usage.exe">
      <authenticode-sign/>
    </pe-file>
  </zip-file>
</artifact-configuration>
```

설치 파일용 artifact configuration은 버전이 달라져도 정확히 한 파일만 선택하도록 다음 구조를 사용한다.

```xml
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <zip-file>
    <pe-file path="Codex-Claude-Usage-Setup-*.exe" min-matches="1" max-matches="1">
      <authenticode-sign/>
    </pe-file>
  </zip-file>
</artifact-configuration>
```

첫 서명 릴리스를 수동 확인한 뒤 Actions variable `REQUIRE_CODE_SIGNING=true`를 추가한다. 이후에는 SignPath 설정이나 토큰이 빠지면 Release가 중단된다. workflow는 앱 실행 파일과 최종 NSIS 설치 파일을 각각 서명하고, 최종 설치 파일의 바이트를 기준으로 `.blockmap`과 `latest.yml`을 다시 생성한다.

## 대안: OV/EV 인증서

상용 Authenticode 인증서를 사용하는 경우 GitHub Actions secret에 다음 값을 저장한다.

- `WIN_CSC_LINK`: `.pfx`의 안전한 URL, 경로 또는 base64 값
- `WIN_CSC_KEY_PASSWORD`: `.pfx` 암호

electron-builder가 빌드 중 앱과 NSIS 설치 파일을 서명하므로, 저장소나 workflow 파일에 인증서와 암호를 직접 기록하지 않는다. 서명 적용 후에는 `build.forceCodeSigning: true`를 켜서 unsigned Release가 만들어지지 않게 한다.
