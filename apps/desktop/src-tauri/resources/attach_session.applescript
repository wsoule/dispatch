-- Invoked as `osascript - <project_path> <resume_session_id_or_empty> <prompt_shell_arg>`
-- with this script piped to stdin.
--
-- `prompt_shell_arg` is a ready-to-use shell token built by terminal::attach_or_launch
-- (bash/zsh ANSI-C `$'...'` quoting, all newlines escaped to a literal `\n`), so it can be
-- appended to the `claude` command on a single physical line — a bare newline in the text
-- would otherwise be executed as a premature Return by `do script`. Empty means "no prompt".
--
-- Two delivery paths, because a prompt can only be passed as a CLI argument to a *fresh*
-- `claude` process:
--   * new / resumed window  -> `cd <path> && claude [--resume <id>] <prompt_arg>`, which
--     seeds the interactive session with the prompt directly (no paste, no boot race).
--   * already-running tab    -> the prompt is on the clipboard; pasted with Cmd+V, since we
--     can't hand an argument to a process that's already up.
--
-- Returns one of: "attached_existing_tab" | "resumed_in_new_window" | "started_new_window".

on run argv
	set targetPath to item 1 of argv
	set resumeId to item 2 of argv
	set promptArg to ""
	if (count of argv) ≥ 3 then set promptArg to item 3 of argv

	set foundTab to my findClaudeTab(targetPath)
	if foundTab is not missing value then
		my pasteIntoFrontmost()
		return "attached_existing_tab"
	end if

	my openNewWindowAndRun(targetPath, resumeId, promptArg)

	if resumeId is not "" then
		return "resumed_in_new_window"
	else
		return "started_new_window"
	end if
end run

-- Scans every open Terminal.app tab for one whose foreground process is `claude` with a
-- cwd matching targetPath. Each tab is checked in its own `try` so one tab we can't
-- introspect (permission denied, process just exited, etc.) doesn't abort the whole scan.
-- On a match, brings that tab's window to front and selects the tab before returning it.
on findClaudeTab(targetPath)
	tell application "Terminal"
		repeat with w in windows
			repeat with t in tabs of w
				try
					set tabTty to tty of t
					set ttyName to do shell script "basename " & quoted form of tabTty
					set psOut to do shell script "ps -t " & ttyName & " -o pid=,comm= | grep -m1 -w claude"
					set pidStr to word 1 of psOut
					set cwdOut to do shell script "lsof -a -p " & pidStr & " -d cwd -Fn 2>/dev/null | tail -1 | cut -c2-"
					if cwdOut is equal to targetPath then
						set index of w to 1
						set selected tab of w to t
						activate
						return t
					end if
				end try
			end repeat
		end repeat
	end tell
	return missing value
end findClaudeTab

on openNewWindowAndRun(targetPath, resumeId, promptArg)
	set claudeCmd to "claude"
	if resumeId is not "" then
		set claudeCmd to "claude --resume " & quoted form of resumeId
	end if
	if promptArg is not "" then
		set claudeCmd to claudeCmd & " " & promptArg
	end if
	set shellCmd to "cd " & quoted form of targetPath & " && " & claudeCmd

	tell application "Terminal"
		activate
		do script shellCmd
	end tell
end openNewWindowAndRun

on pasteIntoFrontmost()
	tell application "Terminal" to activate
	delay 0.3
	tell application "System Events" to keystroke "v" using command down
end pasteIntoFrontmost
