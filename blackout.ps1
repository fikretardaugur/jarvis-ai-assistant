Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = "JARVIS_BLACKOUT"
$form.BackColor = [System.Drawing.Color]::Black
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.WindowState = [System.Windows.Forms.FormWindowState]::Maximized
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.KeyPreview = $true

[System.Windows.Forms.Cursor]::Hide()

$form.Add_KeyDown({
    param($sender, $e)
    if ($e.KeyCode -eq 'Escape' -or $e.KeyCode -eq 'Return') {
        [System.Windows.Forms.Cursor]::Show()
        try {
            $m = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction SilentlyContinue
            if ($m) { Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{Timeout=1; Brightness=70} | Out-Null }
        } catch {}
        $form.Close()
    }
})

[void]$form.ShowDialog()
