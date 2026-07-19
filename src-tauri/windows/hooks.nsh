!macro NSIS_HOOK_POSTINSTALL
  Push $0

  ; 무인 설치는 질문이나 네트워크 요청 없이 끝내야 합니다.
  IfSilent cli_offer_done

  ; OpenAI 독립 실행 설치본과 npm 전역 설치본 중 하나라도 있으면 다시 묻지 않습니다.
  IfFileExists "$LOCALAPPDATA\Programs\OpenAI\Codex\bin\codex.exe" claude_cli_check
  IfFileExists "$APPDATA\npm\codex.cmd" claude_cli_check
  IfFileExists "$PROFILE\.local\bin\codex.exe" claude_cli_check

  MessageBox MB_ICONQUESTION|MB_YESNO|MB_DEFBUTTON2 \
    "Codex CLI가 설치되어 있지 않습니다.$\r$\n$\r$\nOpenAI 공식 설치 프로그램으로 지금 설치할까요?$\r$\n인터넷에서 OpenAI 설치 스크립트와 CLI를 내려받습니다.$\r$\n$\r$\n아니요를 눌러도 Codex Claude Usage 설치는 계속됩니다." \
    IDNO claude_cli_check

  DetailPrint "OpenAI 공식 설치 프로그램으로 Codex CLI를 설치하는 중..."
  nsExec::ExecToLog 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy ByPass -Command "irm https://chatgpt.com/codex/install.ps1 | iex"'
  Pop $0
  StrCmp $0 "0" codex_cli_succeeded codex_cli_failed

  codex_cli_succeeded:
    DetailPrint "Codex CLI 설치가 완료되었습니다. 첫 실행 Setup에서 로그인 상태를 확인합니다."
    MessageBox MB_ICONINFORMATION|MB_OK \
      "Codex CLI 설치가 완료되었습니다.$\r$\n첫 실행 Setup에서 Codex 로그인을 확인할 수 있습니다."
    Goto claude_cli_check

  codex_cli_failed:
    DetailPrint "Codex CLI 설치가 완료되지 않았습니다. PowerShell 종료 코드: $0"
    MessageBox MB_ICONEXCLAMATION|MB_OK \
      "Codex CLI 설치를 완료하지 못했습니다. (종료 코드: $0)$\r$\n$\r$\n모니터 설치는 정상적으로 계속됩니다.$\r$\n첫 실행 Setup에서 다시 설치할 수 있습니다."

  claude_cli_check:
    ; Anthropic 권장 네이티브 설치, WinGet 링크, npm 및 레거시 설치를 확인합니다.
    IfFileExists "$PROFILE\.local\bin\claude.exe" cli_offer_done
    IfFileExists "$LOCALAPPDATA\Microsoft\WinGet\Links\claude.exe" cli_offer_done
    IfFileExists "$APPDATA\npm\claude.cmd" cli_offer_done
    IfFileExists "$PROFILE\.claude\local\claude.exe" cli_offer_done

  MessageBox MB_ICONQUESTION|MB_YESNO|MB_DEFBUTTON2 \
    "Claude Code가 설치되어 있지 않습니다.$\r$\n$\r$\nAnthropic 공식 설치 프로그램으로 지금 설치할까요?$\r$\n인터넷에서 Anthropic 설치 스크립트와 CLI를 내려받습니다.$\r$\n$\r$\n아니요를 눌러도 Codex Claude Usage 설치는 계속됩니다." \
    IDNO cli_offer_done

  DetailPrint "Anthropic 공식 설치 프로그램으로 Claude Code를 설치하는 중..."
  nsExec::ExecToLog 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy ByPass -Command "irm https://claude.ai/install.ps1 | iex"'
  Pop $0
  StrCmp $0 "0" claude_cli_succeeded claude_cli_failed

  claude_cli_succeeded:
    DetailPrint "Claude Code 설치가 완료되었습니다. 첫 실행 Setup에서 로그인 상태를 확인합니다."
    MessageBox MB_ICONINFORMATION|MB_OK \
      "Claude Code 설치가 완료되었습니다.$\r$\n첫 실행 Setup에서 Claude 로그인을 확인할 수 있습니다."
    Goto cli_offer_done

  claude_cli_failed:
    DetailPrint "Claude Code 설치가 완료되지 않았습니다. PowerShell 종료 코드: $0"
    MessageBox MB_ICONEXCLAMATION|MB_OK \
      "Claude Code 설치를 완료하지 못했습니다. (종료 코드: $0)$\r$\n$\r$\n모니터 설치는 정상적으로 계속됩니다.$\r$\n첫 실행 Setup에서 다시 설치할 수 있습니다."

  cli_offer_done:
    Pop $0
!macroend
