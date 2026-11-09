@echo off
setlocal
REM dsCli: Claude Code compatible entry over the DSH dscli profile.
REM Bridges ANTHROPIC_* only when the DSH variable is unset; never stores keys.
if not defined DEEPSEEK_API_KEY if defined ANTHROPIC_AUTH_TOKEN set "DEEPSEEK_API_KEY=%ANTHROPIC_AUTH_TOKEN%"
if not defined DEEPSEEK_API_KEY if defined ANTHROPIC_API_KEY set "DEEPSEEK_API_KEY=%ANTHROPIC_API_KEY%"
if not defined DEEPSEEK_BASE_URL if defined ANTHROPIC_BASE_URL set "DEEPSEEK_BASE_URL=%ANTHROPIC_BASE_URL%"
if not defined DSCLI_MODEL if defined ANTHROPIC_MODEL set "DSCLI_MODEL=%ANTHROPIC_MODEL%"
if defined DSCLI_PATCH (
  node "%~dp0..\apps\cli\lib\bin.js" --profile dscli --patch "%DSCLI_PATCH%" %*
) else (
  node "%~dp0..\apps\cli\lib\bin.js" --profile dscli %*
)
exit /b %errorlevel%
