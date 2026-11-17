Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\fikre\.gemini\antigravity\scratch\jarvis"
WshShell.Run "node server.js", 0, False
